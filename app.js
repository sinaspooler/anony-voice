'use strict';

/* ================= config ================= */

const API = 'api.php';

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // If both callers sit behind strict (symmetric) NATs, add a TURN server here:
    // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
  ],
};

const POLL_WAIT = 600;  // queued
const POLL_FAST = 400;  // negotiating the peer connection
const POLL_CALL = 1000; // in a call

/* ================= state ================= */

let clientId = sessionStorage.getItem('vl_client_id');
if (!clientId) {
  clientId = (crypto.randomUUID ? crypto.randomUUID() : 'cid-' + Date.now() + '-' + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
  sessionStorage.setItem('vl_client_id', clientId);
}

let phase = 'idle'; // idle | waiting | connecting | incall | ended
let role = null; // initiator | responder
let partnerId = null;
let pc = null;
let localStream = null;
let remoteStream = null;
let pendingCandidates = [];
let lastMsgId = 0;
let pollHandle = null;
let pollBusy = false;
let muted = false;
let callTimer = null;
let connectWatchdog = null;
let audioCtx = null;
let localMeter = null;
let remoteMeter = null;
let meterRaf = 0;
let chatOpen = false;
let heartbeat = null;
let sigSent = 0;
let sigGot = 0;

/* ================= elements ================= */

const $ = (sel) => document.querySelector(sel);

const el = {
  screens: {
    start: $('#screen-start'),
    waiting: $('#screen-waiting'),
    call: $('#screen-call'),
    ended: $('#screen-ended'),
  },
  btnStart: $('#btn-start'),
  startError: $('#start-error'),
  btnCancel: $('#btn-cancel'),
  callStatus: $('#call-status'),
  timer: $('#call-timer'),
  ringLocal: $('#ring-local'),
  ringRemote: $('#ring-remote'),
  btnChat: $('#btn-chat'),
  unreadDot: $('#btn-chat .unread-dot'),
  btnMute: $('#btn-mute'),
  btnEnd: $('#btn-end'),
  endedTitle: $('#ended-title'),
  endedSub: $('#ended-sub'),
  btnAgain: $('#btn-again'),
  btnHome: $('#btn-home'),
  chatPanel: $('#chat-panel'),
  chatClose: $('#btn-chat-close'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  remoteAudio: $('#remote-audio'),
};

/* ================= api ================= */

async function api(action, payload) {
  const res = await fetch(`${API}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new Error((data && data.error) ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

function leaveBeacon() {
  navigator.sendBeacon(`${API}?action=leave`, new URLSearchParams({ clientId }));
}

/* ================= screens ================= */

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('hidden', key !== name);
  }
}

function showError(message) {
  el.startError.textContent = message;
  el.startError.classList.remove('hidden');
}

function isActivePhase() {
  return phase === 'waiting' || phase === 'connecting' || phase === 'incall';
}

/* ================= flow: start / wait / cancel ================= */

async function start() {
  if (isActivePhase()) return;
  el.startError.classList.add('hidden');
  el.btnStart.disabled = true;
  el.btnAgain.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    el.btnStart.disabled = false;
    el.btnAgain.disabled = false;
    showError('Microphone access is required to voice chat. Allow the mic permission and try again.');
    return;
  }

  try {
    const resp = await api('join', { clientId });
    el.btnStart.disabled = false;
    el.btnAgain.disabled = false;
    startHeartbeat();
    if (resp.status === 'paired') {
      enterSession(resp);
    } else {
      enterWaiting();
    }
  } catch {
    el.btnStart.disabled = false;
    el.btnAgain.disabled = false;
    stopMic();
    stopHeartbeat();
    showError('Could not reach the server. Is Apache running?');
  }
}

function enterWaiting() {
  phase = 'waiting';
  show('waiting');
  startPolling();
}

function cancelWaiting() {
  leaveBeacon();
  phase = 'idle';
  stopPolling();
  stopHeartbeat();
  stopMic();
  show('start');
}

/* ================= polling ================= */

function startPolling() {
  if (pollHandle !== null) return;
  const tick = async () => {
    if (pollHandle === null) return;
    if (!pollBusy) {
      pollBusy = true;
      try {
        const res = await fetch(`${API}?action=poll&clientId=${encodeURIComponent(clientId)}&since=${lastMsgId}`);
        const resp = await res.json();
        if (pollHandle !== null) applyPoll(resp);
      } catch {
        // transient hiccup — retry on the next tick
      }
      pollBusy = false;
    }
    if (pollHandle !== null) {
      const delay = phase === 'connecting' ? POLL_FAST : phase === 'incall' ? POLL_CALL : POLL_WAIT;
      pollHandle = setTimeout(tick, delay);
    }
  };
  pollHandle = setTimeout(tick, 0);
}

function stopPolling() {
  if (pollHandle !== null) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
  pollBusy = false;
}

function applyPoll(resp) {
  if (resp.status === 'ended') {
    endCall(resp.reason === 'partner_left' ? 'Stranger left' : 'Call ended',
      resp.reason === 'partner_left' ? 'Your partner ended the call or closed the tab.' : '');
    return;
  }
  if (resp.status === 'idle') {
    if (isActivePhase()) {
      endCall('Disconnected', 'Lost contact with the server.');
    }
    return;
  }
  if (resp.status === 'paired') {
    if (phase === 'waiting') {
      enterSession(resp); // creates the peer connection before any queued messages are handled
    }
    if (phase !== 'connecting' && phase !== 'incall') return;
    for (const m of resp.messages || []) {
      lastMsgId = Math.max(lastMsgId, m.id);
      if (m.kind === 'signal') {
        try { handleSignal(JSON.parse(m.payload)); } catch { /* malformed signal */ }
      } else if (m.kind === 'chat') {
        addChatMessage('stranger', m.payload);
      }
    }
  }
  // status 'waiting' while queued: nothing to do
}

/* ================= webRTC session ================= */

function enterSession(resp) {
  phase = 'connecting';
  role = resp.role;
  partnerId = resp.partnerId;
  sigSent = 0;
  sigGot = 0;
  show('call');
  setCallStatus('Connecting…');
  el.timer.textContent = '00:00';
  el.chatLog.innerHTML = '';
  addChatPlaceholder();
  createPeerConnection();
  startMeters();
  // ICE gets its full native failure timeline (~30s); the watchdog below is
  // only a backstop for the case where connection state never resolves
  connectWatchdog = setTimeout(() => {
    if (phase === 'connecting') {
      endCall('Connection failed', 'Could not establish a direct audio connection — the other side may have vanished, or a strict firewall/NAT is blocking peer-to-peer traffic.');
    }
  }, 30000);
  if (role === 'initiator') {
    makeOffer();
  }
  // the initiator learns of the pairing from its join response and has no
  // polling loop yet — the responder arrives here from applyPoll, where the
  // loop is already running (startPolling is a no-op then)
  startPolling();
}

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);
  pendingCandidates = [];

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = (ev) => {
    remoteStream = ev.streams[0];
    el.remoteAudio.srcObject = remoteStream;
    el.remoteAudio.play().catch(() => { /* autoplay guard */ });
    attachRemoteMeter(remoteStream);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal({ type: 'candidate', candidate: ev.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      onConnected();
    } else if (pc.connectionState === 'failed') {
      endCall('Connection failed', 'The peer connection could not be established — a strict firewall or NAT may be blocking peer-to-peer audio.');
    } else if (pc.connectionState === 'disconnected') {
      setCallStatus('Reconnecting…');
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc && pc.iceConnectionState === 'failed') {
      endCall('Connection failed', 'The peer connection could not be established — a strict firewall or NAT may be blocking peer-to-peer audio.');
    }
  };
}

async function makeOffer() {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({ type: 'offer', sdp: pc.localDescription.sdp });
  } catch (err) {
    console.error('offer failed', err);
  }
}

async function handleSignal(sig) {
  if (!sig || typeof sig !== 'object') return;
  sigGot++;
  try {
    if (sig.type === 'offer' || sig.type === 'answer') {
      if (!pc) return;
      await pc.setRemoteDescription({ type: sig.type, sdp: sig.sdp });
      const queued = pendingCandidates;
      pendingCandidates = [];
      for (const c of queued) {
        try { await pc.addIceCandidate(c); } catch { /* stale candidate */ }
      }
      if (sig.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ type: 'answer', sdp: pc.localDescription.sdp });
      }
    } else if (sig.type === 'candidate' && sig.candidate) {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(sig.candidate); } catch { /* stale candidate */ }
      } else {
        pendingCandidates.push(sig.candidate);
      }
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function sendSignal(data) {
  sigSent++;
  return api('signal', { clientId, data: JSON.stringify(data) })
    .catch((err) => console.error('signal send failed', err));
}

function onConnected() {
  if (phase !== 'connecting') return;
  phase = 'incall';
  if (connectWatchdog) {
    clearTimeout(connectWatchdog);
    connectWatchdog = null;
  }
  setCallStatus('Connected — say hi!');
  startCallTimer();
}

function setCallStatus(text) {
  el.callStatus.textContent = text;
}

function startCallTimer() {
  const startedAt = Date.now();
  el.timer.textContent = '00:00';
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.timer.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 500);
}

function stopCallTimer() {
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
}

/* ================= teardown ================= */

function endCall(title, subtitle) {
  if (phase === 'ended') return;
  phase = 'ended';
  stopPolling();
  stopHeartbeat();
  teardownRTC();
  el.endedTitle.textContent = title;
  el.endedSub.textContent = subtitle || 'The call is over.';
  show('ended');
}

function teardownRTC() {
  stopMeters();
  stopCallTimer();
  if (connectWatchdog) {
    clearTimeout(connectWatchdog);
    connectWatchdog = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
    pc = null;
  }
  el.remoteAudio.srcObject = null;
  remoteStream = null;
  role = null;
  partnerId = null;
  lastMsgId = 0;
  pendingCandidates = [];
  closeChat();
  el.chatLog.innerHTML = '';
  el.unreadDot.classList.add('hidden');
  stopMic();
}

function stopMic() {
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => { /* already closed */ });
    audioCtx = null;
  }
  localMeter = null;
  remoteMeter = null;
  if (muted) {
    muted = false;
    updateMuteButton();
  }
}

/* ================= mic-level meters ================= */

function startMeters() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(localStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    localMeter = { analyser, data: new Uint8Array(analyser.fftSize) };
  }
  if (!meterRaf) meterRaf = requestAnimationFrame(meterLoop);
}

function attachRemoteMeter(stream) {
  if (!audioCtx) return;
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  remoteMeter = { analyser, data: new Uint8Array(analyser.fftSize) };
}

function levelOf(meter) {
  if (!meter) return 0;
  meter.analyser.getByteTimeDomainData(meter.data);
  let sum = 0;
  for (let i = 0; i < meter.data.length; i++) {
    const v = (meter.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / meter.data.length) * 4);
}

function meterLoop() {
  meterRaf = requestAnimationFrame(meterLoop);
  paintRing(el.ringLocal, muted ? 0 : levelOf(localMeter));
  paintRing(el.ringRemote, levelOf(remoteMeter));
}

function paintRing(node, level) {
  node.style.boxShadow =
    `0 0 ${(6 + level * 30).toFixed(1)}px ${(level * 7).toFixed(1)}px ` +
    `rgba(56, 224, 198, ${(0.15 + level * 0.8).toFixed(2)})`;
}

function stopMeters() {
  if (meterRaf) {
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }
  paintRing(el.ringLocal, 0);
  paintRing(el.ringRemote, 0);
}

/* ================= mute ================= */

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  for (const t of localStream.getAudioTracks()) t.enabled = !muted;
  updateMuteButton();
}

function updateMuteButton() {
  el.btnMute.textContent = muted ? '🔇' : '🎙️';
  el.btnMute.classList.toggle('active', muted);
  el.btnMute.title = muted ? 'Unmute microphone' : 'Mute microphone';
}

/* ================= text chat ================= */

function toggleChat(force) {
  const open = force !== undefined ? force : !chatOpen;
  if (open === chatOpen) return;
  chatOpen = open;
  el.chatPanel.classList.toggle('hidden', !chatOpen);
  el.unreadDot.classList.add('hidden');
  if (chatOpen) {
    el.chatInput.focus();
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }
}

function closeChat() {
  toggleChat(false);
}

function addChatPlaceholder() {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = 'You can also type here if the audio is unclear.';
  el.chatLog.appendChild(div);
}

function addChatMessage(who, text) {
  const empty = el.chatLog.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text; // textContent keeps stranger input inert
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
  if (who === 'stranger' && !chatOpen) {
    el.unreadDot.classList.remove('hidden');
  }
}

async function sendChat() {
  const text = el.chatInput.value.trim();
  if (!text || (phase !== 'connecting' && phase !== 'incall')) return;
  el.chatInput.value = '';
  addChatMessage('me', text);
  try {
    await api('chat', { clientId, text });
  } catch {
    addChatMessage('stranger', '⚠ (message not delivered — call may have ended)');
  }
}

/* ================= heartbeat (survives background-tab timer throttling) ================= */

function startHeartbeat() {
  try {
    if (!heartbeat) {
      // same-origin file: blob: workers would be blocked by the site CSP
      heartbeat = new Worker('heartbeat.js');
    }
    heartbeat.postMessage({ cmd: 'start', clientId });
  } catch {
    heartbeat = null; // workers unavailable — polling still doubles as a heartbeat
  }
}

function stopHeartbeat() {
  if (heartbeat) {
    heartbeat.postMessage({ cmd: 'stop' });
  }
}

/* ================= wiring ================= */

el.btnStart.addEventListener('click', start);
el.btnAgain.addEventListener('click', start);
el.btnHome.addEventListener('click', () => {
  phase = 'idle';
  show('start');
});
el.btnCancel.addEventListener('click', cancelWaiting);
el.btnEnd.addEventListener('click', () => {
  leaveBeacon();
  endCall('You ended the call');
});
el.btnMute.addEventListener('click', toggleMute);
el.btnChat.addEventListener('click', () => toggleChat());
el.chatClose.addEventListener('click', closeChat);
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatOpen) closeChat();
});

// pagehide covers tab close, refresh and mobile backgrounding
window.addEventListener('pagehide', () => {
  if (isActivePhase()) leaveBeacon();
});

// when a suspended/backgrounded tab wakes back up, poll immediately instead
// of waiting out the throttled timer — it may learn the call ended, or resume
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isActivePhase()) {
    stopPolling();
    startPolling();
  }
});

// small debug hook for diagnosing call state from the console
window.__vl = () => ({
  phase, role, partnerId, lastMsgId, muted, chatOpen,
  sigSent, sigGot, candidatesQueued: pendingCandidates.length,
  pc: pc ? { conn: pc.connectionState, ice: pc.iceConnectionState } : null,
});

// ICE diagnostics: candidate-pair and local-candidate summary (console use)
window.__vlStats = async () => {
  if (!pc) return null;
  const report = await pc.getStats();
  const pairs = [];
  const locals = {};
  const remotes = {};
  for (const r of report.values()) {
    if (r.type === 'candidate-pair') {
      pairs.push({ state: r.state, nominated: r.nominated, local: r.localCandidateId, remote: r.remoteCandidateId, prio: r.priority });
    } else if (r.type === 'local-candidate') {
      locals[r.id] = `${r.candidateType} ${r.address || r.ip} ${r.port} ${r.protocol}`;
    } else if (r.type === 'remote-candidate') {
      remotes[r.id] = `${r.candidateType} ${r.address || r.ip} ${r.port} ${r.protocol}`;
    }
  }
  return pairs
    .sort((a, b) => b.prio - a.prio)
    .slice(0, 6)
    .map((p) => ({ state: p.state, nominated: p.nominated, local: locals[p.local], remote: remotes[p.remote] }));
};
