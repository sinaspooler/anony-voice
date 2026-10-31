'use strict';

/* ================= config ================= */

const API = 'api.php';
const MAX_SLOTS = 15;
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const POLL_ROOM = 800;
const HEARTBEAT_MS = 3000;

/* ================= state ================= */

let nickname = sessionStorage.getItem('vl_nick') || '';
let roomId = null;
let memberId = null;
let memberSecret = null;
let isHost = false;
let joinUrl = null;
let mySlot = -1;

let phase = 'welcome'; // welcome | room | ended
let pc = null;
let localStream = null;
let audioCtx = null;
let micAnalyser = null;
let micMeterData = null;
let slotAudio = new Array(MAX_SLOTS).fill(null); // { audio, analyser, data }
let micRaf = 0;

const members = new Map(); // memberId -> {nickname, isHost, slot, speaking, isYou}
let lastEventId = 0;
let lastChatId = 0;
let pollHandle = null;
let pollBusy = false;

let muted = false;
let recording = false;
let recStartedAt = 0;
let recTimer = null;

let chatOpen = false;
let heartbeatWorker = null;

/* ================= elements ================= */

const $ = (sel) => document.querySelector(sel);

const el = {
  screens: {
    welcome: $('#screen-welcome'),
    room: $('#screen-room'),
    ended: $('#screen-ended'),
  },
  nickname: $('#nickname'),
  roomCode: $('#room-code'),
  btnCreate: $('#btn-create'),
  btnJoin: $('#btn-join'),
  welcomeError: $('#welcome-error'),
  recLabel: $('#rec-label'),
  roomChip: $('#room-chip'),
  btnShare: $('#btn-share'),
  sharePanel: $('#share-panel'),
  shareUrl: $('#share-url'),
  btnCopy: $('#btn-copy'),
  tiles: $('#tiles'),
  btnChat: $('#btn-chat'),
  unreadDot: $('#btn-chat .unread-dot'),
  btnMute: $('#btn-mute'),
  btnEnd: $('#btn-end'),
  btnLeave: $('#btn-leave'),
  hostHint: $('#host-hint'),
  endedTitle: $('#ended-title'),
  endedSub: $('#ended-sub'),
  endedSession: $('#ended-session'),
  btnAgain: $('#btn-again'),
  chatPanel: $('#chat-panel'),
  chatClose: $('#btn-chat-close'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  audioSink: $('#audio-sink'),
};

/* ================= helpers ================= */

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  phase = name;
  if (name !== 'room') closeChat();
}

function showError(message) {
  el.welcomeError.textContent = message;
  el.welcomeError.classList.remove('hidden');
}

async function api(action, payload) {
  const res = await fetch(`${API}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error((data && data.error) ? data.error : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function leaveBeacon() {
  if (!memberId) return;
  navigator.sendBeacon(
    `${API}?action=leave`,
    new URLSearchParams({ memberId, memberSecret }),
  );
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ================= welcome flow ================= */

async function createRoom() {
  if (!requireNickname()) return;
  try {
    const resp = await api('create', { nickname });
    enterRoom(resp, true);
  } catch (err) {
    showError('Could not create the room: ' + err.message);
  }
}

async function joinRoom() {
  if (!requireNickname()) return;
  const code = el.roomCode.value.trim().replace(/[^a-zA-Z0-9]/g, '');
  if (!code) {
    showError('Enter a room code or open an invite link.');
    return;
  }
  try {
    const resp = await api('join', { roomId: code, nickname });
    enterRoom(resp, false);
  } catch (err) {
    const friendly = err.status === 404 ? 'That room does not exist.'
      : err.status === 410 ? 'That room has ended.'
      : err.status === 409 ? 'That room is full.'
      : 'Could not join: ' + err.message;
    showError(friendly);
  }
}

function requireNickname() {
  nickname = el.nickname.value.trim().slice(0, 24);
  if (!nickname) {
    showError('Pick a nickname first.');
    el.nickname.focus();
    return false;
  }
  sessionStorage.setItem('vl_nick', nickname);
  el.welcomeError.classList.add('hidden');
  return true;
}

/* ================= room flow ================= */

function enterRoom(resp, showShare) {
  roomId = resp.roomId;
  memberId = resp.memberId;
  memberSecret = resp.memberSecret;
  isHost = resp.isHost;
  mySlot = resp.slot;
  joinUrl = resp.joinUrl || (location.origin + location.pathname + '?room=' + roomId);
  phase = 'room';

  members.clear();
  for (const m of resp.members || []) {
    members.set(m.memberId, { nickname: m.nickname, isHost: m.isHost, slot: m.slot, speaking: m.speaking, isYou: m.isYou });
  }
  if (!resp.members) {
    members.set(memberId, { nickname: resp.nickname, isHost: true, slot: resp.slot, speaking: false, isYou: true });
  }

  el.roomChip.textContent = 'room ' + roomId;
  el.shareUrl.value = joinUrl;
  el.sharePanel.classList.toggle('hidden', !showShare);
  el.btnEnd.classList.toggle('hidden', !isHost);
  el.hostHint.hidden = !isHost;
  el.chatLog.innerHTML = '';
  el.recLabel.textContent = 'REC 00:00';

  show('room');
  renderTiles();

  startMedia();
  startPolling();
  startHeartbeat();
}

/* ---------------- media: one peer connection to the SFU ---------------- */

async function startMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    showEnded('Microphone unavailable', 'Voice chat needs microphone access. Allow the mic and try again.');
    return;
  }

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const src = audioCtx.createMediaStreamSource(localStream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 512;
  src.connect(micAnalyser);
  micMeterData = new Uint8Array(micAnalyser.fftSize);
  startMeters();

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // m-line 0: our microphone up
  pc.addTransceiver(localStream.getAudioTracks()[0], { direction: 'sendrecv' });
  // m-lines 1..MAX_SLOTS: one downlink slot each (slot s lives on mid s+1)
  for (let s = 0; s < MAX_SLOTS; s++) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.ontrack = (ev) => {
    const mid = parseInt(ev.transceiver.mid || '0', 10);
    const slot = mid - 1;
    if (slot < 0 || slot >= MAX_SLOTS) return;
    attachSlotAudio(slot, ev.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'failed') {
      showEnded('Connection failed', 'The audio connection to the room could not be established.');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  try {
    await waitGatherComplete(pc);
    const resp = await api('media_attach', { memberId, memberSecret, offerSdp: pc.localDescription.sdp });
    await pc.setRemoteDescription({ type: 'answer', sdp: resp.answerSdp });
    startRecTimer();
  } catch (err) {
    if (phase === 'room') {
      showEnded('Media service unavailable', err.status === 503
        ? 'The audio server is not running. Ask the host to start it (node sfu/server.js).'
        : err.message);
    }
  }
}

function waitGatherComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, 2000); // bounded: some candidates beat none
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}

function attachSlotAudio(slot, stream) {
  if (slotAudio[slot]) return; // one binding per slot
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.play().catch(() => { /* autoplay guard */ });
  el.audioSink.appendChild(audio);

  let analyser = null;
  let data = null;
  if (audioCtx) {
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    data = new Uint8Array(analyser.fftSize);
  }
  slotAudio[slot] = { audio, analyser, data };
}

/* ---------------- polling loop ---------------- */

function startPolling() {
  if (pollHandle !== null) return;
  const tick = async () => {
    if (pollHandle === null) return;
    if (!pollBusy && memberId) {
      pollBusy = true;
      try {
        const resp = await api('poll', {
          memberId,
          memberSecret,
          since: lastEventId,
          sinceChat: lastChatId,
          speaking: levelOf({ analyser: micAnalyser, data: micMeterData }) > 0.06 && !muted,
        });
        applyPoll(resp);
      } catch (err) {
        if (err.status === 403) {
          // credentials rejected: room was torn down server-side
          stopPolling();
          showEnded('Room closed', 'Your session is no longer registered with the server.');
          return;
        }
        // transient network hiccup — retry next tick
      }
      pollBusy = false;
    }
    if (pollHandle !== null) pollHandle = setTimeout(tick, POLL_ROOM);
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
  if (resp.status === 'closed') {
    stopPolling();
    stopHeartbeat();
    // the sessions row is written moments after the room is closed; if it is
    // not there yet, look for it briefly before giving up on the link
    if (resp.sessionFile) {
      showEnded('Room ended', 'The recording has been saved.', resp.sessionFile);
    } else {
      showEnded('Room ended', 'The recording is being saved.');
      offerSessionWhenReady(3);
    }
    return;
  }

  if (resp.recording && !recording) {
    recording = true;
    if (!recStartedAt) {
      recStartedAt = Date.now();
      startRecTimer();
    }
  }

  // membership: rebuild the map, then reconcile tiles
  const seen = new Set();
  for (const m of resp.members || []) {
    seen.add(m.memberId);
    const known = members.get(m.memberId);
    if (known) {
      known.speaking = m.speaking;
      known.nickname = m.nickname;
    } else {
      members.set(m.memberId, { nickname: m.nickname, isHost: m.isHost, slot: m.slot, speaking: m.speaking, isYou: m.isYou });
    }
  }
  for (const id of [...members.keys()]) {
    if (!seen.has(id)) members.delete(id);
  }
  renderTiles();

  for (const ev of resp.events || []) {
    lastEventId = Math.max(lastEventId, ev.id);
    if (ev.type === 'member_joined' && ev.payload) {
      addSystemLine(`${ev.payload.nickname} joined the room`);
    } else if (ev.type === 'member_left' && ev.payload) {
      addSystemLine(`${ev.payload.nickname} left the room`);
    } else if (ev.type === 'room_closed') {
      // poll flips to status closed on the next response
    }
  }

  for (const c of resp.chats || []) {
    lastChatId = Math.max(lastChatId, c.id);
    addChatMessage(c.memberId === memberId ? 'me' : 'stranger', `${c.nickname}: ${c.text}`);
  }
}

/* ---------------- tiles (participants + speaking glow) ---------------- */

function renderTiles() {
  const ids = [...members.keys()];
  // rebuild only when membership changed
  const signature = ids.map((id) => id + ':' + members.get(id).slot).join('|');
  if (el.tiles.dataset.sig === signature) return;
  el.tiles.dataset.sig = signature;
  el.tiles.innerHTML = '';

  for (const id of ids) {
    const m = members.get(id);
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.member = id;
    tile.dataset.slot = String(m.slot);

    const avatar = document.createElement('div');
    avatar.className = 'tile-avatar' + (m.isYou ? ' you' : '');
    avatar.textContent = (m.nickname || '?').charAt(0).toUpperCase();

    const name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = m.nickname + (m.isHost ? ' 👑' : '') + (m.isYou ? ' (you)' : '');

    tile.appendChild(avatar);
    tile.appendChild(name);
    el.tiles.appendChild(tile);
  }
  paintLevels(); // reset glows for the new tiles
}

function levelOf(meter) {
  if (!meter || !meter.analyser) return 0;
  meter.analyser.getByteTimeDomainData(meter.data);
  let sum = 0;
  for (let i = 0; i < meter.data.length; i++) {
    const v = (meter.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / meter.data.length) * 4);
}

function paintLevels() {
  if (phase !== 'room') return;

  // server-reported speaking flags are the authoritative cross-device signal
  // (polled ~1s); local analysers add a fast, real-time shimmer on top
  const remoteSpeaking = new Set();
  let selfSpeaking = false;
  for (const m of members.values()) {
    if (m.speaking) (m.isYou ? selfSpeaking = true : remoteSpeaking.add(m.slot));
  }

  const localTile = el.tiles.querySelector('.tile-avatar.you');
  if (localTile) {
    const lvl = muted ? 0 : Math.max(levelOf({ analyser: micAnalyser, data: micMeterData }), selfSpeaking ? 0.85 : 0);
    paintRing(localTile, lvl);
  }
  for (let s = 0; s < MAX_SLOTS; s++) {
    const tile = el.tiles.querySelector(`.tile[data-slot="${s}"] .tile-avatar`);
    if (!tile) continue;
    const meter = slotAudio[s];
    const lvl = Math.max(levelOf(meter), remoteSpeaking.has(s) ? 0.85 : 0);
    paintRing(tile, lvl);
  }
  micRaf = requestAnimationFrame(paintLevels);
}

function paintRing(node, level) {
  node.style.boxShadow =
    `0 0 ${(6 + level * 26).toFixed(1)}px ${(level * 6).toFixed(1)}px ` +
    `rgba(56, 224, 198, ${(0.12 + level * 0.8).toFixed(2)})`;
}

function startMeters() {
  if (!micRaf) micRaf = requestAnimationFrame(paintLevels);
}

function stopMeters() {
  if (micRaf) {
    cancelAnimationFrame(micRaf);
    micRaf = 0;
  }
}

/* ---------------- recording indicator ---------------- */

function startRecTimer() {
  if (recTimer) return;
  if (!recStartedAt) recStartedAt = Date.now();
  recTimer = setInterval(() => {
    el.recLabel.textContent = 'REC ' + fmtClock((Date.now() - recStartedAt) / 1000);
  }, 500);
  el.recLabel.parentElement.classList.add('active');
}

/* ---------------- mute ---------------- */

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  for (const t of localStream.getAudioTracks()) t.enabled = !muted;
  el.btnMute.textContent = muted ? '🔇' : '🎙️';
  el.btnMute.classList.toggle('active', muted);
  el.btnMute.title = muted ? 'Unmute microphone' : 'Mute microphone';
}

/* ---------------- teardown ---------------- */

function teardownMedia() {
  stopMeters();
  if (pc) {
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
    pc = null;
  }
  for (const sink of [...el.audioSink.children]) sink.remove();
  slotAudio = new Array(MAX_SLOTS).fill(null);
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  micAnalyser = null;
  if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
  recording = false;
  recStartedAt = 0;
  members.clear();
  el.tiles.innerHTML = '';
  el.tiles.dataset.sig = '';
  if (muted) {
    muted = false;
    el.btnMute.textContent = '🎙️';
    el.btnMute.classList.remove('active');
  }
}

function showEnded(title, subtitle, sessionFile) {
  if (phase === 'ended') return;
  phase = 'ended';
  stopPolling();
  stopHeartbeat();
  teardownMedia();
  el.endedTitle.textContent = title;
  el.endedSub.textContent = subtitle || 'The call is over.';
  el.endedSession.classList.add('hidden');
  el.endedSession.innerHTML = '';
  if (sessionFile) offerSessionLink(sessionFile);
  show('ended');
}

/** Render (or refresh) the recording download link on the ended screen. */
function offerSessionLink(sessionFile) {
  el.endedSession.innerHTML = '';
  const a = document.createElement('a');
  a.href = `${API}?action=session&file=${encodeURIComponent(sessionFile)}`;
  a.textContent = '⬇ Download the room recording';
  a.download = sessionFile;
  el.endedSession.appendChild(a);
  el.endedSession.classList.remove('hidden');
}

/** After a room closes, poll the sessions list for the finished mix. */
async function offerSessionWhenReady(attempts) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2500));
    try {
      const list = await fetch(`${API}?action=sessions`).then((r) => r.json());
      const mine = (list.sessions || []).find((s) => s.roomId === roomId);
      if (mine) {
        offerSessionLink(mine.file);
        return true;
      }
    } catch { /* retry */ }
  }
  return false;
}

/* ---------------- text chat ---------------- */

function toggleChat(force) {
  const open = force !== undefined ? force : !chatOpen;
  if (open === chatOpen) return;
  chatOpen = open;
  el.chatPanel.classList.toggle('hidden', !chatOpen);
  el.unreadDot.classList.add('hidden');
  if (chatOpen) el.chatInput.focus();
}

function addChatMessage(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
  if (who === 'stranger' && !chatOpen) el.unreadDot.classList.remove('hidden');
}

function addSystemLine(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

async function sendChat() {
  const text = el.chatInput.value.trim();
  if (!text || phase !== 'room') return;
  el.chatInput.value = '';
  addChatMessage('me', `${nickname}: ${text}`);
  try {
    await api('chat', { memberId, memberSecret, text });
  } catch {
    addChatMessage('stranger', '⚠ (message not delivered)');
  }
}

/* ---------------- heartbeat (background-tab keep-alive) ---------------- */

function startHeartbeat() {
  try {
    if (!heartbeatWorker) {
      heartbeatWorker = new Worker('heartbeat.js');
    }
    heartbeatWorker.postMessage({
      cmd: 'start',
      apiUrl: new URL(API, location.href).href,
      memberId,
      memberSecret,
      interval: HEARTBEAT_MS,
    });
  } catch {
    heartbeatWorker = null; // workers unavailable — polling doubles as the heartbeat
  }
}

function stopHeartbeat() {
  try {
    if (heartbeatWorker) heartbeatWorker.postMessage({ cmd: 'stop' });
  } catch { /* noop */ }
}

/* ---------------- wiring ---------------- */

el.btnCreate.addEventListener('click', createRoom);
el.btnJoin.addEventListener('click', joinRoom);
el.roomCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
el.nickname.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (el.roomCode.value) joinRoom();
    else createRoom();
  }
});
el.btnAgain.addEventListener('click', () => {
  memberId = null;
  roomId = null;
  show('welcome');
});
el.btnShare.addEventListener('click', () => {
  el.sharePanel.classList.toggle('hidden');
});
el.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(joinUrl);
    el.btnCopy.textContent = 'Copied!';
    setTimeout(() => { el.btnCopy.textContent = 'Copy'; }, 1500);
  } catch {
    el.shareUrl.select();
    document.execCommand('copy');
  }
});
el.btnMute.addEventListener('click', toggleMute);
el.btnChat.addEventListener('click', () => toggleChat());
el.chatClose.addEventListener('click', () => toggleChat(false));
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
el.btnLeave.addEventListener('click', () => {
  leaveBeacon();
  showEnded('You left the room', 'Thanks for talking!');
});
el.btnEnd.addEventListener('click', async () => {
  try {
    const resp = await api('end_room', { memberId, memberSecret });
    if (resp.session) {
      // the ended screen may already be visible via the poll's closed status —
      // refresh its download link either way
      offerSessionLink(resp.session.file);
      el.endedTitle.textContent = 'Room ended';
      el.endedSub.textContent = 'The recording has been saved.';
    }
  } catch {
    // the poll's closed path handles the screen; finalize continues server-side
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatOpen) toggleChat(false);
});
window.addEventListener('pagehide', () => {
  if (phase === 'room') leaveBeacon();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && phase === 'room' && pollHandle === null && memberId) {
    startPolling();
  }
  // a room that ended while this tab was in the background may have a
  // finished recording by now — check once on return
  if (!document.hidden && phase === 'ended' && roomId
      && document.querySelector('#ended-session').classList.contains('hidden')) {
    offerSessionWhenReady(1);
  }
});

/* ---------------- boot ---------------- */

(function boot() {
  if (nickname) el.nickname.value = nickname;
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    el.roomCode.value = room.replace(/[^a-zA-Z0-9]/g, '');
    el.roomCode.disabled = true;
  }
  el.nickname.focus();
})();
