'use strict';

// Validation for sfu/oggmux.js: mux synthetic Opus packets (valid TOC bytes,
// noise payloads) and check the result with ffprobe/ffmpeg.
//   node test-oggmux.js <path-to-ffprobe> <path-to-ffmpeg>

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { OpusOggMuxer, SAMPLE_RATE } = require('./oggmux');

const ffprobe = process.argv[2] || 'ffprobe';
const ffmpeg = process.argv[3] || 'ffmpeg';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oggmux-'));
const file = path.join(dir, 'test.ogg');

const DURATION_S = 3;
const FRAME_MS = 20;
const FRAMES = (DURATION_S * 1000) / FRAME_MS;

const pages = [];
const mux = new OpusOggMuxer({
  serial: 0x12345678,
  onPage: (buf) => pages.push(buf),
});

let ts = 1000; // random RTP timestamp base
for (let i = 0; i < FRAMES; i++) {
  // TOC 0xFC: config 31 (CELT FB, 20 ms), mono, code 0 -> 960 samples @48k
  const payload = Buffer.alloc(120);
  payload[0] = 0xfc;
  require('crypto').randomFillSync(payload, 1);
  mux.addPacket(ts, payload);
  ts += 960;
}
mux.end();

fs.writeFileSync(file, Buffer.concat(pages));
const size = fs.statSync(file).size;
console.log(`muxed ${FRAMES} packets -> ${pages.length} pages, ${size} bytes, muxer duration=${mux.durationSeconds().toFixed(3)}s`);

// 1) ffprobe must identify an opus stream with the right duration
const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
const st = probe.streams[0];
console.log(`ffprobe: codec=${st.codec_name} channels=${st.channels} sample_rate=${st.sample_rate} duration=${probe.format.duration}s`);
if (st.codec_name !== 'opus') throw new Error('codec is not opus');
if (Math.abs(parseFloat(probe.format.duration) - DURATION_S) > 0.2) throw new Error('duration mismatch');

// 2) ffmpeg must fully decode the file (CRC/framing integrity)
const decoded = path.join(dir, 'decoded.wav');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', file, '-c:a', 'pcm_s16le', decoded]);
const dec = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', decoded]).toString());
console.log(`decode: ok, wav duration=${dec.format.duration}s`);

// 3) simulate packet loss: drop every 3rd packet, duration must stay ~3s
const file2 = path.join(dir, 'lossy.ogg');
const pages2 = [];
const mux2 = new OpusOggMuxer({ serial: 0x87654321, onPage: (b) => pages2.push(b) });
let ts2 = 50000;
for (let i = 0; i < FRAMES; i++) {
  if (i % 3 !== 2) {
    const payload = Buffer.alloc(80);
    payload[0] = 0xfc;
    require('crypto').randomFillSync(payload, 1);
    mux2.addPacket(ts2, payload);
  }
  ts2 += 960; // timestamps keep advancing across the losses
}
mux2.end();
fs.writeFileSync(file2, Buffer.concat(pages2));
const probe2 = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', file2]).toString());
console.log(`lossy stream: duration=${probe2.format.duration}s (expected ~${DURATION_S}, gaps preserved)`);
if (Math.abs(parseFloat(probe2.format.duration) - DURATION_S) > 0.2) throw new Error('lossy duration mismatch');

// 4) an empty muxer must emit nothing (callers skip empty sessions)
const file3 = path.join(dir, 'empty.ogg');
const pages3 = [];
const mux3 = new OpusOggMuxer({ serial: 1, onPage: (b) => pages3.push(b) });
mux3.end();
fs.writeFileSync(file3, Buffer.concat(pages3));
if (fs.statSync(file3).size !== 0) throw new Error('empty muxer should emit no bytes');
console.log('empty stream: 0 bytes (skipped)');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nALL OGG MUXER TESTS PASSED');
