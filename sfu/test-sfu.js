'use strict';

/**
 * End-to-end media test for sfu/server.js — no browser needed.
 * Spawns the SFU, connects two werift clients through the full /attach flow,
 * pumps RTP from client A, verifies client B receives the forwarded audio,
 * then finalizes the room and ffprobe-checks the per-member recordings.
 *
 *   node test-sfu.js [ffprobe]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');

const FFPROBE = process.argv[2] || 'ffprobe';
const BASE = 'http://127.0.0.1:3000';
const ROOM = 'test-' + crypto.randomUUID().slice(0, 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
}

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('SFU did not become healthy');
}

/** Attach one synthetic participant through the same flow api.php uses. */
async function attach(memberId, slot) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const mic = new MediaStreamTrack({ kind: 'audio' });
  pc.addTransceiver(mic, { direction: 'sendrecv' });
  for (let s = 0; s < 15; s++) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  const received = [];
  pc.ontrack = ({ track, transceiver }) => {
    track.onReceiveRtp.subscribe((rtp) => {
      received.push({ mid: transceiver.mid, ts: rtp.header.timestamp, len: rtp.payload.length });
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

  const res = await fetch(BASE + '/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: readConfig().sfuSecret, roomId: ROOM, memberId, slot, offerSdp: pc.localDescription.sdp }),
  });
  const { answerSdp } = await res.json();
  if (!answerSdp) throw new Error('no answerSdp for ' + memberId);

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  for (let i = 0; i < 100; i++) {
    if (pc.connectionState === 'connected') break;
    await sleep(100);
  }
  if (pc.connectionState !== 'connected') throw new Error(`${memberId} did not connect (state=${pc.connectionState})`);

  // the opus payload type the SFU negotiated in its answer
  const m = answerSdp.match(/a=rtpmap:(\d+) opus/i);
  const pt = m ? parseInt(m[1], 10) : 96;

  return { pc, mic, received, pt, answerSdp };
}

let pktSeq = 1;
let pktTs = 480;

function pump(track, pt, count) {
  return new Promise((resolve) => {
    let i = 0;
    const timer = setInterval(() => {
      const payload = Buffer.alloc(120);
      payload[0] = 0xfc; // opus TOC: config 31 (20 ms), mono, code 0
      payload.fill(0x55, 1);
      const pkt = new RtpPacket(
        new RtpHeader({ payloadType: pt, sequenceNumber: pktSeq, timestamp: pktTs, ssrc: 0x1234 }),
        payload,
      );
      pktSeq = (pktSeq + 1) & 0xffff;
      pktTs = (pktTs + 960) >>> 0;
      track.writeRtp(pkt);
      if (++i >= count) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
}

async function main() {
  const ffprobe = FFPROBE;
  console.log('starting SFU...');
  const sfu = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit' });
  try {
    await waitHealthy();
    console.log('SFU healthy, attaching two clients through the real /attach flow');

    const a = await attach('clientA', 0);
    const b = await attach('clientB', 1);
    console.log('both clients connected');

    console.log('pumping 100 opus packets (20ms each) from clientA...');
    await pump(a.mic, a.pt, 100);
    await sleep(500);
    console.log('pumping 50 opus packets from clientB (joins the timeline late)...');
    await pump(b.mic, b.pt, 50);
    await sleep(1500); // let forwarding + muxer flushes settle

    const total = b.received.length;
    const distinctMids = new Set(b.received.map((r) => r.mid));
    console.log(`clientB received ${total} forwarded packets on mids: ${[...distinctMids].join(',')}`);
    if (total < 80) throw new Error('clientB received too few packets: ' + total);
    if (distinctMids.size !== 1) throw new Error('packets arrived on unexpected mids');
    const slotMid = [...distinctMids][0];
    if (parseInt(slotMid, 10) !== 1) throw new Error(`expected slot 0 on mid 1, got mid ${slotMid}`);

    console.log('finalizing room...');
    const fin = await fetch(BASE + '/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: readConfig().sfuSecret, roomId: ROOM }),
    });
    const finBody = await fin.json();
    console.log('finalize ->', JSON.stringify(finBody));

    if (!finBody.members || finBody.members.length === 0) throw new Error('finalize returned no recordings');
    const byMember = Object.fromEntries(finBody.members.map((m) => [m.memberId, m]));
    if (!byMember.clientA) throw new Error('clientA recording missing');
    if (byMember.clientA.offsetMs !== 0) throw new Error('clientA offset should be 0, got ' + byMember.clientA.offsetMs);
    if (!byMember.clientB) throw new Error('clientB recording missing');
    if (byMember.clientB.offsetMs < 1000) throw new Error('clientB offset should reflect late join, got ' + byMember.clientB.offsetMs);

    for (const m of finBody.members) {
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', m.file]).toString());
      const dur = parseFloat(probe.format.duration);
      console.log(`  ${m.memberId}: offset=${m.offsetMs}ms duration=${dur.toFixed(2)}s codec=${probe.streams[0].codec_name}`);
      if (probe.streams[0].codec_name !== 'opus') throw new Error('part is not opus');
      if (m.memberId === 'clientA' && (dur < 1.5 || dur > 2.5)) throw new Error('clientA part duration wrong: ' + dur);
      if (m.memberId === 'clientB' && (dur < 0.7 || dur > 1.5)) throw new Error('clientB part duration wrong: ' + dur);
    }

    console.log('\nALL SFU TESTS PASSED');
  } finally {
    sfu.kill();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
