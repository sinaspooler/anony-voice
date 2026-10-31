'use strict';

/**
 * Minimal single-stream Ogg/Opus muxer (RFC 3533 Ogg framing + RFC 7845
 * Opus-in-Ogg mapping). Purpose-built for the VoiceLoop SFU: it wraps the
 * Opus packets carried by RTP into a standards-compliant .ogg file that
 * ffmpeg/players/browsers can decode, without any native dependency.
 *
 * Usage:
 *   const mux = new OpusOggMuxer({ serial, onPage: (buf) => stream.write(buf) });
 *   mux.addPacket(rtpTimestamp, payload); // payload = one complete Opus packet
 *   mux.end();
 *
 * RTP timestamps are 48 kHz for Opus. Granule positions are derived from RTP
 * timestamp deltas, so upstream packet loss or DTX gaps keep their true
 * duration and multi-party mixes stay aligned in wall-clock time.
 */

// Frame duration per config index, in ms (RFC 6716 section 3.1, table 2).
const FRAME_MS = [
  10, 20, 40, 60, // SILK NB
  10, 20, 40, 60, // SILK MB
  10, 20, 40, 60, // SILK WB
  10, 20,         // Hybrid SWB
  10, 20,         // Hybrid FB
  2.5, 5, 10, 20, // CELT NB
  2.5, 5, 10, 20, // CELT WB
  2.5, 5, 10, 20, // CELT SWB
  2.5, 5, 10, 20, // CELT FB
];

const SAMPLE_RATE = 48000;

/** Samples contributed by one Opus packet (RFC 6716 TOC byte parsing). */
function packetSamples(payload) {
  if (payload.length < 1) return 0;
  const toc = payload[0];
  const code = toc & 3;
  const perFrame = Math.round(FRAME_MS[toc >> 3] * SAMPLE_RATE / 1000);
  if (code === 0) return perFrame;
  if (code === 1 || code === 2) return perFrame * 2;
  // code 3: frame count byte follows the TOC (1..48 frames)
  const count = (payload[1] & 0x3f) + 1;
  return perFrame * count;
}

const PAGE_HEADER = Buffer.from('OggS', 'ascii');

// Ogg CRC-32: polynomial 0x04c11db7, init 0, no final xor, non-reflected.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff];
  }
  return crc >>> 0;
}

/** Lacing values for one packet (RFC 3533: last segment must be < 255). */
function lacingFor(len) {
  const n = Math.floor(len / 255);
  const rem = len % 255;
  const out = new Array(n + (rem > 0 ? 1 : 1)); // 255-multiple packets end with a 0 segment
  for (let i = 0; i < n; i++) out[i] = 255;
  out[n] = rem;
  return out;
}

function u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0);
  return b;
}

function buildPage(serial, seq, headerType, granule, packets) {
  const segments = [];
  for (const p of packets) {
    for (const v of lacingFor(p.length)) segments.push(v);
  }
  if (segments.length > 255) throw new Error('page overflow: ' + segments.length + ' segments');

  const head = Buffer.alloc(27 + segments.length);
  PAGE_HEADER.copy(head, 0);
  head[4] = 0;              // stream structure version
  head[5] = headerType;     // 0x01 continued, 0x02 BOS, 0x04 EOS
  u64le(granule).copy(head, 6);
  u32le(serial).copy(head, 14);
  u32le(seq).copy(head, 18);
  // CRC placeholder (zero) spans bytes 22..25
  head[26] = segments.length;
  for (let i = 0; i < segments.length; i++) head[27 + i] = segments[i];

  const body = Buffer.concat(packets);
  const page = Buffer.concat([head, body]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function opusHeadPacket(preskip) {
  const b = Buffer.alloc(19);
  Buffer.from('OpusHead', 'ascii').copy(b, 0);
  b[8] = 1;                          // version
  b[9] = 1;                          // channel count (mono)
  b.writeUInt16LE(preskip, 10);
  b.writeUInt32LE(SAMPLE_RATE, 12);  // input sample rate
  b.writeUInt16LE(0, 16);            // output gain
  b[18] = 0;                         // channel mapping family
  return b;
}

function opusTagsPacket() {
  const vendor = Buffer.from('voiceloop-sfu', 'ascii');
  const b = Buffer.alloc(8 + 4 + vendor.length + 4);
  Buffer.from('OpusTags', 'ascii').copy(b, 0);
  b.writeUInt32LE(vendor.length, 8);
  vendor.copy(b, 12);
  b.writeUInt32LE(0, 12 + vendor.length); // no user comments
  return b;
}

class OpusOggMuxer {
  /**
   * @param {object} opts
   * @param {number} opts.serial       Ogg bitstream serial number (unique per file)
   * @param {(page: Buffer) => void} opts.onPage  called with each finished page
   * @param {number} [opts.preskip]    Opus encoder pre-skip samples (default 312)
   * @param {number} [opts.flushBytes] emit a page once this much audio is queued
   * @param {number} [opts.flushMs]    ... or once this much wall-time is queued
   */
  constructor(opts) {
    this.serial = opts.serial >>> 0;
    this.onPage = opts.onPage;
    this.preskip = opts.preskip ?? 312;
    this.flushBytes = opts.flushBytes ?? 4096;
    this.flushMs = opts.flushMs ?? 320;

    this.seq = 0;
    this.granule = 0;
    this.prevTs = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingSamples = 0;
    this.bosDone = false;
    this.eosDone = false;
    this.packetCount = 0;
  }

  /** Feed one complete Opus packet (TOC byte included) with its RTP timestamp. */
  addPacket(rtpTimestamp, payload) {
    if (this.eosDone || !payload || payload.length === 0) return;

    if (!this.bosDone) {
      this.bosDone = true;
      this.onPage(buildPage(this.serial, this.seq++, 0x02, 0, [opusHeadPacket(this.preskip)]));
      this.onPage(buildPage(this.serial, this.seq++, 0x00, 0, [opusTagsPacket()]));
    }

    const samples = packetSamples(payload);
    if (this.prevTs === null) {
      // First audio packet: granule = its own sample count (decoders drop pre-skip).
      this.granule += samples;
    } else {
      let delta = (rtpTimestamp - this.prevTs) >>> 0;
      // Guard against clock restarts: anything beyond 10s of gap is treated as
      // a new source and mapped without a gap.
      if (delta > SAMPLE_RATE * 10) delta = samples;
      this.granule += delta;
    }
    this.prevTs = rtpTimestamp >>> 0;

    this.pending.push(payload);
    this.pendingBytes += payload.length;
    this.pendingSamples += samples;
    this.packetCount++;

    if (this.pendingBytes >= this.flushBytes || this.pendingSamples >= SAMPLE_RATE * this.flushMs / 1000) {
      this.flush(0x00);
    }
  }

  flush(headerType) {
    if (this.pending.length === 0) return;
    this.onPage(buildPage(this.serial, this.seq++, headerType, this.granule, this.pending));
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingSamples = 0;
  }

  /** Finish the stream: flush queued audio and write the EOS page.
   *  A muxer that never received audio emits nothing (empty file) — callers
   *  skip such recordings rather than finalizing empty sessions. */
  end() {
    if (this.eosDone) return;
    this.eosDone = true;
    if (!this.bosDone) return;
    this.flush(0x04);
  }

  /** Total audio duration in seconds represented so far. */
  durationSeconds() {
    return Math.max(0, this.granule - this.preskip) / SAMPLE_RATE;
  }
}

module.exports = { OpusOggMuxer, packetSamples, oggCrc, SAMPLE_RATE };
