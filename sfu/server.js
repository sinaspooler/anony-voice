'use strict';

/**
 * VoiceLoop audio SFU (selective forwarding unit).
 *
 * A small Node service that sits on 127.0.0.1 next to Apache and does three
 * things for every voice room:
 *   1. Receives one Opus audio stream per participant (WebRTC, via werift) and
 *      forwards it to every other participant.
 *   2. Records each participant's stream to its own .ogg file (sfu/oggmux.js),
 *      so api.php can mix a complete session recording with ffmpeg.
 *   3. Never touches the public internet: api.php tunnels the WebRTC SDP
 *      exchange here and authenticates members before calling /attach.
 *
 * Media mapping: the client's offer contains m-line 0 (their microphone,
 * sendrecv) and m-lines 1..maxSlots (recvonly downlink slots). Downlink
 * m-line i carries the audio of whoever occupies room slot (i-1) — occupancy
 * and slot assignment are decided by api.php, which reports the slot of every
 * member to clients. Outbound RTP per slot is renumbered (stable SSRC from
 * the sender, continuous sequence numbers and timestamps), so slots can be
 * reused by later joiners without confusing receivers.
 *
 * Control API (JSON, same secret as config.json):
 *   POST /attach   {secret, roomId, memberId, slot, offerSdp} -> {answerSdp}
 *   POST /detach   {secret, roomId, memberId}                 -> {ok}
 *   POST /finalize {secret, roomId} -> {members:[{memberId, file, offsetMs, durationMs}]}
 *   GET  /health                               -> {ok}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  RTCPeerConnection,
  MediaStreamTrack,
  MediaStream,
} = require('werift');
const { OpusOggMuxer, packetSamples } = require('./oggmux');

// ------------------------------------------------------------------ config --

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

function loadConfig() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const cfg = {
        sfuPort: 3000,
        sfuSecret: crypto.randomBytes(16).toString('hex'),
        maxSlots: 15,
        partsDir: path.join(ROOT, 'sessions', 'parts'),
        finalDir: path.join(ROOT, 'sessions'),
        ffmpegBin: 'ffmpeg',
      };
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
  }
  throw new Error('cannot read or create config.json');
}

const cfg = loadConfig();
const MAX_SLOTS = cfg.maxSlots || 15;
const PARTS_DIR = cfg.partsDir;

// ------------------------------------------------------------- room state --

/** rooms: Map<roomId, { recordingStart, members: Map<memberId, Member> }> */
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { recordingStart: null, members: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

function makeMember(roomId, memberId, slot) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  const member = {
    roomId,
    memberId,
    slot,
    pc,
    uplink: null,          // remote track (their microphone)
    downlinks: new Array(MAX_SLOTS).fill(null), // local sender tracks, index = source slot
    out: [],               // per-slot RTP renumbering state
    muxer: null,
    fsStream: null,
    file: null,
    firstPacketAt: null,
    closed: false,
  };

  for (let s = 0; s < MAX_SLOTS; s++) {
    member.out[s] = { seq: (Math.random() * 0x8000) | 0, ts: (Math.random() * 0x40000000) | 0 };
  }

  // their microphone arrives on the first m-line
  pc.ontrack = ({ track }) => {
    if (member.uplink) return; // m-line 0 only
    member.uplink = track;
    track.onReceiveRtp.subscribe((rtp) => onUplinkRtp(member, rtp));
  };

  pc.connectionStateChange.subscribe((state) => {
    // a participant who vanished without /detach stops consuming resources;
    // their recording is flushed when api.php detaches or finalizes the room
    if (state === 'failed' || state === 'closed') {
      member.uplink = null;
    }
  });

  return member;
}

function onUplinkRtp(member, rtp) {
  const room = rooms.get(member.roomId);
  if (!room) return;
  const now = Date.now();
  if (member.firstPacketAt === null) member.firstPacketAt = now;
  // the room's recording timeline starts at the first audio packet anywhere in
  // the room — mixes then begin when people actually talk, not when they join
  if (room.recordingStart === null) room.recordingStart = now;

  const samples = packetSamples(rtp.payload);
  const mySlot = member.slot;

  // 1) record the original stream
  if (member.muxer) {
    member.muxer.addPacket(rtp.header.timestamp, rtp.payload);
  }

  // 2) forward to everyone else through their slot track for mySlot
  for (const other of room.members.values()) {
    if (other.memberId === member.memberId) continue;
    const track = other.downlinks[mySlot];
    if (!track) continue;
    const st = other.out[mySlot];
    const pkt = rtp.clone();
    pkt.header.sequenceNumber = st.seq & 0xffff;
    pkt.header.timestamp = st.ts >>> 0;
    st.seq = (st.seq + 1) & 0xffff;
    st.ts = (st.ts + samples) >>> 0;
    try {
      track.writeRtp(pkt);
    } catch {
      // receiver is mid-teardown; skip
    }
  }
}

function stopMemberRecording(member) {
  if (member.muxer) {
    member.muxer.end();
    member.muxer = null;
  }
  if (member.fsStream) {
    member.fsStream.end();
    member.fsStream = null;
  }
}

function closeMember(member) {
  if (member.closed) return;
  member.closed = true;
  stopMemberRecording(member);
  try { member.pc.close(); } catch { /* already closed */ }
}

// --------------------------------------------------------------- handlers --

function startRecording(roomId, memberId) {
  const room = rooms.get(roomId);
  const member = room?.members.get(memberId);
  if (!room || !member) return;
  const dir = path.join(PARTS_DIR, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, memberId + '.ogg');
  member.file = file;
  member.fsStream = fs.createWriteStream(file, { flags: 'w' });
  member.muxer = new OpusOggMuxer({
    serial: crypto.randomBytes(4).readUInt32LE(0),
    onPage: (buf) => member.fsStream.write(buf),
  });
}

async function handleAttach(body) {
  const { roomId, memberId, slot, offerSdp } = body;
  if (typeof roomId !== 'string' || typeof memberId !== 'string' ||
      !Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS ||
      typeof offerSdp !== 'string') {
    return { status: 400, json: { error: 'bad attach parameters' } };
  }

  const room = getRoom(roomId);
  if (room.members.has(memberId)) closeMember(room.members.get(memberId));

  const member = makeMember(roomId, memberId, slot);
  room.members.set(memberId, member);

  // pre-create the downlink sender tracks: m-line (slot+1) carries slot audio.
  // each slot gets its own MediaStream id so receivers can map lanes to people
  const pc = member.pc;
  pc.addTransceiver('audio', { direction: 'recvonly' }); // m-line 0: their mic
  for (let s = 0; s < MAX_SLOTS; s++) {
    const t = new MediaStreamTrack({ kind: 'audio' });
    t.streamId = 'slot' + s;
    const ms = new MediaStream({ id: 'slot' + s, tracks: [t] });
    member.downlinks[s] = t;
    pc.addTransceiver(t, { direction: 'sendonly', streams: [ms] }); // m-line s+1
  }

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

  // bind each pre-created track to its transceiver's sender (m-line order =
  // insertion order: 0 uplink, 1..maxSlots downlink slots)
  const transceivers = pc.getTransceivers();
  for (let s = 0; s < MAX_SLOTS; s++) {
    const trx = transceivers[s + 1];
    if (trx && trx.sender) {
      await trx.sender.replaceTrack(member.downlinks[s]).catch(() => {});
    }
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // vanilla ICE: wait for all candidates (bounded), then return the full SDP
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, 2000);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  startRecording(roomId, memberId);
  return { status: 200, json: { answerSdp: pc.localDescription.sdp } };
}

function handleDetach(body) {
  const { roomId, memberId } = body;
  const room = rooms.get(roomId);
  if (room) {
    const member = room.members.get(memberId);
    if (member) {
      // flush + close media, but keep the record so /finalize can still
      // collect this member's recording
      closeMember(member);
    }
  }
  return { status: 200, json: { ok: true } };
}

async function handleFinalize(body) {
  const { roomId } = body;
  const room = rooms.get(roomId);
  if (!room) return { status: 200, json: { members: [] } };

  const out = [];
  for (const member of room.members.values()) {
    closeMember(member);
    if (member.file && member.firstPacketAt !== null && fs.existsSync(member.file)) {
      out.push({
        memberId: member.memberId,
        file: member.file,
        offsetMs: Math.max(0, member.firstPacketAt - (room.recordingStart ?? member.firstPacketAt)),
      });
    }
  }
  rooms.delete(roomId);
  return { status: 200, json: { members: out } };
}

// ----------------------------------------------------------------- server --

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }

    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.secret !== cfg.sfuSecret) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'bad secret' }));
      return;
    }

    let result;
    if (req.method === 'POST' && url === '/attach') result = await handleAttach(body);
    else if (req.method === 'POST' && url === '/detach') result = handleDetach(body);
    else if (req.method === 'POST' && url === '/finalize') result = await handleFinalize(body);
    else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    res.writeHead(result.status);
    res.end(JSON.stringify(result.json));
  } catch (err) {
    console.error('[sfu] error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'internal', detail: err.message }));
  }
});

// memory hygiene: rooms nobody touched for 2h are dropped (api.php owns the
// authoritative lifecycle; this only guards against leaks)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    let last = room.recordingStart ?? 0;
    for (const m of room.members.values()) last = Math.max(last, m.firstPacketAt ?? 0);
    if (now - last > 2 * 3600 * 1000) {
      for (const m of room.members.values()) closeMember(m);
      rooms.delete(roomId);
      console.log('[sfu] swept stale room', roomId);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(cfg.sfuPort, '127.0.0.1', () => {
  console.log(`[sfu] listening on 127.0.0.1:${cfg.sfuPort} (slots: ${MAX_SLOTS})`);
});

process.on('SIGINT', () => {
  for (const room of rooms.values()) {
    for (const m of room.members.values()) closeMember(m);
  }
  process.exit(0);
});
