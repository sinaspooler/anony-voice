'use strict';

/**
 * Full backend integration test for VoiceLoop v0.2 — runs against the real
 * Apache-served api.php + running SFU. Verifies the whole lifecycle:
 * create → join → media attach (tunneled) → audio forwarding → speaking
 * flags → chat → end_room → mixed session recording.
 *
 *   node test-api.js [apiBase] [ffprobe]
 *   apiBase default: http://localhost/anony-voice0.2/api.php
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');

const API = process.argv[2] || 'http://localhost/anony-voice0.2/api.php';
const FFPROBE = process.argv[3] || 'ffprobe';
const MAX_SLOTS = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(action, payload) {
  const res = await fetch(`${API}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${action} -> HTTP ${res.status}: ${json.error || '?'}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

let pktSeq = 100;
let pktTs = 960;

function buildPeer(memberId, memberSecret, slot) {
  const state = {
    memberId,
    memberSecret,
    pc: null,
    mic: null,
    pt: 96,
    received: [],
    speaking: false,
  };

  async function attach() {
    const pc = new RTCPeerConnection({ iceServers: [] });
    state.pc = pc;
    const mic = new MediaStreamTrack({ kind: 'audio' });
    state.mic = mic;
    pc.addTransceiver(mic, { direction: 'sendrecv' });
    for (let s = 0; s < MAX_SLOTS; s++) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    pc.ontrack = ({ track, transceiver }) => {
      track.onReceiveRtp.subscribe((rtp) => {
        state.received.push({ mid: transceiver.mid, from: memberId });
      });
    };

    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, 2000);
      pc.iceGatheringStateChange.subscribe((st) => {
        if (st === 'complete') { clearTimeout(t); resolve(); }
      });
    });

    const resp = await api('media_attach', { memberId, memberSecret, offerSdp: pc.localDescription.sdp });
    const m = resp.answerSdp.match(/a=rtpmap:(\d+) opus/i);
    state.pt = m ? parseInt(m[1], 10) : 96;
    await pc.setRemoteDescription({ type: 'answer', sdp: resp.answerSdp });

    for (let i = 0; i < 100 && pc.connectionState !== 'connected'; i++) await sleep(100);
    if (pc.connectionState !== 'connected') {
      throw new Error(`${memberId} media not connected (state=${pc.connectionState})`);
    }
  }

  function pump(count) {
    return new Promise((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        const payload = Buffer.alloc(120);
        payload[0] = 0xfc;
        payload.fill(0x77, 1);
        const pkt = new RtpPacket(
          new RtpHeader({ payloadType: state.pt, sequenceNumber: pktSeq, timestamp: pktTs, ssrc: 0x4321 }),
          payload,
        );
        pktSeq = (pktSeq + 1) & 0xffff;
        pktTs = (pktTs + 960) >>> 0;
        state.mic.writeRtp(pkt);
        if (++i >= count) { clearInterval(timer); resolve(); }
      }, 10);
    });
  }

  return { state, attach, pump };
}

async function main() {
  console.log('API under test:', API);

  // ---- 1. host creates the room -------------------------------------------
  const host = await api('create', { nickname: 'alice' });
  console.log('room created:', host.roomId, '| host slot', host.slot);
  if (!host.isHost || host.slot !== 0 || !host.joinUrl.includes(host.roomId)) {
    throw new Error('create response malformed');
  }

  // ---- 2. guest joins ------------------------------------------------------
  const bob = await api('join', { roomId: host.roomId, nickname: 'bob' });
  console.log('bob joined: slot', bob.slot);
  if (bob.members.length !== 2 || !bob.members.some((m) => m.nickname === 'alice' && m.isHost)) {
    throw new Error('join members list wrong');
  }

  // ---- 3. closed/unknown room handling ------------------------------------
  let caught = false;
  try { await api('join', { roomId: 'deadbeefdeadbeef', nickname: 'x' }); } catch (e) {
    caught = e.status === 404;
    if (!caught) console.log('unexpected join error:', e.status, e.message);
  }
  if (!caught) throw new Error('join on unknown room should 404');

  // ---- 4. both attach media through the API -------------------------------
  const hostPeer = buildPeer(host.memberId, host.memberSecret, host.slot);
  const bobPeer = buildPeer(bob.memberId, bob.memberSecret, bob.slot);
  await hostPeer.attach();
  await bobPeer.attach();
  console.log('both members attached through the API tunnel');

  // ---- 5. audio flows: alice speaks, bob hears ----------------------------
  await hostPeer.pump(100);
  await sleep(800);
  if (bobPeer.state.received.length < 80) {
    throw new Error(`bob received too few packets: ${bobPeer.state.received.length}`);
  }
  console.log(`bob received ${bobPeer.state.received.length} forwarded packets from alice`);

  // ---- 6. speaking flags propagate ---------------------------------------
  hostPeer.state.speaking = true;
  await api('poll', { memberId: host.memberId, memberSecret: host.memberSecret, since: 0, sinceChat: 0, speaking: true });
  await sleep(300);
  const bobPoll = await api('poll', { memberId: bob.memberId, memberSecret: bob.memberSecret, since: 0, sinceChat: 0, speaking: false });
  const hostView = bobPoll.members.find((m) => m.memberId === host.memberId);
  if (!hostView || hostView.speaking !== true) throw new Error('alice speaking flag did not reach bob');
  if (!bobPoll.recording) throw new Error('recording flag should be true with media attached');
  console.log('speaking flags + recording flag verified');

  // ---- 7. chat -------------------------------------------------------------
  await api('chat', { memberId: bob.memberId, memberSecret: bob.memberSecret, text: 'hello from bob' });
  await sleep(200);
  const hostPoll = await api('poll', { memberId: host.memberId, memberSecret: host.memberSecret, since: bobPoll.lastEventId, sinceChat: 0, speaking: false });
  const chatMsg = hostPoll.chats.find((c) => c.text === 'hello from bob');
  if (!chatMsg || chatMsg.nickname !== 'bob') throw new Error('chat did not reach alice');
  console.log('chat delivery verified');

  // ---- 8. more audio, then host ends the room -----------------------------
  await hostPeer.pump(80);
  await bobPeer.pump(40);
  await sleep(700);

  const end = await api('end_room', { memberId: host.memberId, memberSecret: host.memberSecret });
  console.log('room ended, session:', JSON.stringify(end.session));
  if (!end.session || end.session.format !== 'ogg' || end.session.sizeBytes <= 0) {
    throw new Error('session not mixed to ogg: ' + JSON.stringify(end.session));
  }

  // ---- 9. host's poll shows closed + bob got the closure ------------------
  const closed = await api('poll', { memberId: host.memberId, memberSecret: host.memberSecret, since: 0, sinceChat: 0, speaking: false });
  if (closed.status !== 'closed' || !closed.sessionFile) throw new Error('closed status missing for host');

  // ---- 10. sessions list + download (with Range) --------------------------
  const list = await fetch(`${API}?action=sessions`).then((r) => r.json());
  const found = list.sessions.find((s) => s.file === end.session.file);
  if (!found) throw new Error('session not in list');

  const dl = await fetch(`${API}?action=session&file=${encodeURIComponent(end.session.file)}`);
  if (dl.status !== 200 || dl.headers.get('content-type') !== 'audio/ogg') {
    throw new Error('session download failed: ' + dl.status);
  }
  const range = await fetch(`${API}?action=session&file=${encodeURIComponent(end.session.file)}`, {
    headers: { Range: 'bytes=0-99' },
  });
  if (range.status !== 206) throw new Error('range request should 206, got ' + range.status);
  console.log('sessions list + download + range verified');

  // ---- 11. ffprobe the downloaded mix -------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-api-'));
  const file = path.join(dir, end.session.file);
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const dur = parseFloat(probe.format.duration);
  console.log(`mixed recording: codec=${probe.streams[0].codec_name} duration=${dur.toFixed(2)}s size=${end.session.sizeBytes}`);
  if (probe.streams[0].codec_name !== 'opus') throw new Error('mix is not opus');
  // duration = both pumps (3.6s of packets) + the wall-clock gap between them
  // (~1.4s) — RTP timestamps advance through silence, as a faithful recording should
  if (dur < 3.0 || dur > 7.0) throw new Error('mix duration unexpected: ' + dur);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nALL API INTEGRATION TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
