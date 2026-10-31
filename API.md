# VoiceLoop API v2 — client contract

This document is the complete contract for building a VoiceLoop client (for
example an Android app) against a VoiceLoop server. Everything — room
management, WebRTC media, text chat, speaker indicators and recordings — goes
through **one HTTP endpoint** plus one WebRTC connection per client.

- **Base URL**: `https://<your-server>/voice/api.php` (path may differ per install).
- **Format**: JSON everywhere. `POST` bodies are `application/json`.
- **CORS**: all responses carry `Access-Control-Allow-Origin: *` (native apps don't need it, web clients do).
- **Errors**: non-200 status with `{"error": "..."}`. `503` almost always means the media service (SFU) is not running on the server.

---

## 1. Concepts

| Concept | Meaning |
|---|---|
| **Room** | Created by a host; identified by a 16-hex-char `roomId`. Lives until the host ends it or the last member leaves. |
| **Member** | A participant with a `memberId` (24 hex) + `memberSecret` (32 hex). The secret authenticates every call — treat it like a session token. |
| **Slot** | Each member occupies a media slot `0..14` (`maxSlots` configurable). Slot = *which downlink audio lane carries that member*, see §4. |
| **Events** | Server-side timeline entries (`member_joined`, `member_left`, `room_closed`) fetched via `poll`. |
| **Recording** | Always on. The server records every participant and mixes one `.ogg` per room on close. |

There is **no user authentication** — identity is per-room and per-tab/app-session, established by a nickname.

---

## 2. Room lifecycle (HTTP)

### 2.1 Create a room (host)

```
POST api.php?action=create
{"nickname": "alice"}
```
Response:
```json
{
  "roomId": "1a2b3c4d5e6f7089",
  "memberId": "f01a2b3c4d5e6f7089aabbcc",
  "memberSecret": "64-hex-chars",
  "nickname": "alice",
  "isHost": true,
  "slot": 0,
  "maxSlots": 15,
  "joinUrl": "https://host/voice/?room=1a2b3c4d5e6f7089"
}
```
`joinUrl` is what the host shares (web clients open it; an app can just extract `?room=`).

### 2.2 Join a room

```
POST api.php?action=join
{"roomId": "1a2b3c4d5e6f7089", "nickname": "bob"}
```
Response: same shape as `create` plus `members: [{memberId, nickname, isHost, slot, speaking, isYou}]` — the current roster.
Errors: `404` room not found · `410` room closed · `409` room full · `429` rate limited.

### 2.3 Poll (heartbeat + roster + events + chat)

Call repeatedly (~every 800 ms while in the room):
```
POST api.php?action=poll
{"memberId": "...", "memberSecret": "...", "since": 0, "sinceChat": 0, "speaking": true}
```
- `speaking` = whether **this client's** microphone currently picks up voice (see §4.3). The server shows this flag to everyone else.
- `since` / `sinceChat`: last event / chat ids you've seen (start at 0).

Response:
```json
{
  "status": "ok",
  "members": [
    {"memberId": "f01a...", "nickname": "alice", "isHost": true, "slot": 0, "speaking": false, "isYou": true},
    {"memberId": "9c8b...", "nickname": "bob", "isHost": false, "slot": 1, "speaking": true, "isYou": false}
  ],
  "events": [{"id": 3, "type": "member_joined", "payload": {"nickname": "bob", "slot": 1}}],
  "lastEventId": 3,
  "chats": [{"id": 1, "memberId": "9c8b...", "nickname": "bob", "text": "hi!"}],
  "lastChatId": 1,
  "recording": true
}
```
Event types: `member_joined {nickname, slot}` · `member_left {nickname, reason}` (`left`|`timeout`) · `room_closed {reason}` (`host_ended`|`empty`).

When the room closes, `poll` returns:
```json
{"status": "closed", "sessionFile": "1a2b3c4d5e6f7089-1761891200.ogg", "reason": "room_closed"}
```
Stop polling; optionally download the recording (§5).

### 2.4 Chat, leave, heartbeat, end room

```
POST api.php?action=chat      {"memberId","memberSecret","text"}            // text ≤ 500 chars
POST api.php?action=heartbeat {"memberId","memberSecret"}                   // keep-alive every ~3 s
POST api.php?action=leave     {"memberId","memberSecret"}                   // leave (idempotent)
POST api.php?action=end_room  {"memberId","memberSecret"}                   // HOST only: close for everyone
```
`end_room` and the last `leave` return `{"ok":true,"session":{"file":"...","format":"ogg","sizeBytes":123}}`.

---

## 3. Media attach (WebRTC)

The server runs an audio-only forwarding unit (SFU). Each client:
1. Uploads **one** microphone stream.
2. Receives **one lane per room slot** — lane `s` carries whoever occupies slot `s`.

### 3.1 Build the offer (16 m-lines!)

Create a peer connection, then add transceivers **in this exact order** before offering:

- m-line 0: your microphone, direction `sendrecv`
- m-lines 1..15 (`maxSlots`): `recvonly` audio — downlink lane for slot `i-1`

Web (browser) example:
```js
const pc = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
pc.addTransceiver(micTrack, {direction: 'sendrecv'});
for (let s = 0; s < 15; s++) pc.addTransceiver('audio', {direction: 'recvonly'});
```
Android (`org.webrtc`) equivalent: add one `AudioTrack` sender + 15 `RtpTransceiver`s with direction `RECV_ONLY` before calling `createOffer`.

### 3.2 Exchange SDP through the API (vanilla ICE — no trickle)

1. `setLocalDescription(offer)`.
2. Wait for ICE gathering to complete (poll `iceGatheringState === 'complete'`, 2 s timeout is fine) so the offer carries all candidates.
3. `POST api.php?action=media_attach {"memberId","memberSecret","offerSdp": "<full offer SDP string>"}`
4. Response: `{"answerSdp": "..."}` → `setRemoteDescription({type:'answer', sdp})`.

Audio constraints: `echoCancellation: true, noiseSuppression: true`, mono, opus (negotiated automatically).

### 3.3 Map incoming audio to people

Each downlink m-line fires one `ontrack`. Identify the lane via the **mid** (m-line id):

```
slot = parseInt(trackEvent.transceiver.mid, 10) - 1
memberId = the member whose poll-reported slot === slot
```
Keep a `slot → memberId` map updated from `poll`'s `members[]` (each member carries its `slot`; the `member_joined` event also carries it). Attach the received stream to a player immediately — audio starts flowing once that member speaks.

### 4.3 Speaking indicators (who is talking)

Two independent signals combine into the UI:

1. **Your own speaking flag**: compute mic RMS locally (e.g. WebAudio `AnalyserNode`, RMS of time-domain data, threshold ~0.06 after a 4× gain) and send it as `speaking` in every `poll`. Server stamps it for all other clients.
2. **Others' speaking flags**: `poll.members[].speaking`. For a snappier UI you may *also* meter the remote audio locally (AnalyserNode per lane) and use the server flag as fallback — the web client does exactly this.

---

## 4. Housekeeping rules a client must follow

- **Heartbeat**: every member must call `poll` (or `heartbeat`) at least every ~10 s or the server drops it (12 s staleness). A backgrounded app should keep a lightweight timer/worker alive — this is the lifeline of the room.
- **Leaving**: call `leave` when the user exits (and on app kill via whatever best-effort hook exists). Members that vanish are auto-removed after ~12 s and marked `member_left reason:"timeout"`.
- **Reconnect**: on network loss, re-poll; if `403` (unknown member), the member is gone — re-`join` the room with the same nickname.

---

## 5. Recordings

- Every room is recorded server-side (starts when the first participant connects their mic, ends when the room closes). The host does **not** need to stay.
- `GET api.php?action=sessions` → `{"sessions": [{roomId, file, format, startedAt, endedAt, durationSec, sizeBytes, url}]}` (`format` is `ogg`, or `parts` if the server lacks ffmpeg).
- `GET api.php?action=session&file=<file>` streams the recording, `Content-Type: audio/ogg`, HTTP `Range` supported — use it for playback or download.
- The web UI exposes the recording link on the end screen; apps can list/play all sessions via the two endpoints above.

---

## 6. Example end-to-end walkthrough (curl)

```bash
API="https://host/voice/api.php"

# host
curl -s -X POST "$API?action=create" -H 'Content-Type: application/json' -d '{"nickname":"alice"}'
# -> roomId R, memberId M1, memberSecret S1, joinUrl

# guest (second device)
curl -s -X POST "$API?action=join" -H 'Content-Type: application/json' -d '{"roomId":"R","nickname":"bob"}'
# -> memberId M2, memberSecret S2

# both clients: poll loop (~800ms) + media_attach with their 16-m-line offer SDP
curl -s -X POST "$API?action=media_attach" -H 'Content-Type: application/json' \
  -d '{"memberId":"M1","memberSecret":"S1","offerSdp":"v=0\r\n..."}'
# -> {"answerSdp":"v=0\r\n..."}

curl -s -X POST "$API?action=poll" -H 'Content-Type: application/json' \
  -d '{"memberId":"M2","memberSecret":"S2","since":0,"sinceChat":0,"speaking":false}'

# host ends the room -> recording mixed server-side
curl -s -X POST "$API?action=end_room" -H 'Content-Type: application/json' -d '{"memberId":"M1","memberSecret":"S1"}'
# -> {"ok":true,"session":{"file":"R-1761891200.ogg","format":"ogg","sizeBytes":48211}}

curl -s -o room.ogg "$API?action=session&file=R-1761891200.ogg"
```

---

## 7. Server-side notes (for the host of a VoiceLoop instance)

- The media service runs on the server only: `node sfu/server.js` (listens on 127.0.0.1:3000, never exposed). `api.php` proxies the SDP exchange.
- Shared secret lives in `config.json` (auto-generated on first API call; both `api.php` and the SFU read it).
- Requires: PHP 8 + pdo_sqlite, Node 18+, ffmpeg for the final `.ogg` mix (without it, per-member parts are kept under `sessions/parts/`).
- `maxSlots` in `config.json` caps room size (15 default) — each member uploads exactly one stream regardless of room size.
