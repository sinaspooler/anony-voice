# VoiceLoop v0.2 🎙️

Voice **rooms** with invite links. Create a room, share the link with one or
many friends, and talk — with nicknames, live "who's talking" indicators, and
a full **server-side recording** of every session saved as `.ogg`.

- **Link-based rooms** — the host creates a room and shares `?room=<id>`;
  anyone with the link joins with just a nickname. Up to 15 participants.
- **Multi-party audio over an SFU** — a small Node service forwards each
  participant's stream to everyone else: one upload per person, no mesh
  multiplication. Runs on a 1-core / 4 GB VPS without breaking a sweat.
- **Automatic recording** — the server records every participant (independent
  of anyone staying connected) and mixes one `sessions/<room>-<timestamp>.ogg`
  per session with ffmpeg. Download link appears when the room ends.
- **Nicknames for everyone** — including the host; no accounts anywhere.
- **Who's talking** — glowing avatar rings driven by live audio levels plus
  server-side speaking flags, so you always see who is speaking.
- **Text chat** alongside the audio.
- **API-first**: the web UI and any native app (e.g. Android) use the same
  HTTP API — see **[API.md](API.md)** for the complete client contract.

## Quick start (XAMPP, Windows dev box)

1. Serve this folder (e.g. `htdocs\anony-voice0.2`) and start the media
   service: `cd sfu && npm install && node server.js` (listens on 127.0.0.1:3000).
2. Open `http://localhost/anony-voice0.2/`, enter a nickname, **Create a room**.
3. Share the invite link (or open it in other windows), join with other
   nicknames, talk.
4. When the host ends the room, the mixed recording appears in `sessions/`
   (needs `ffmpeg` on PATH; otherwise per-member parts are kept).

**Full Windows walkthrough**: [WINDOWS.md](WINDOWS.md) — prerequisites,
step-by-step setup, and troubleshooting for testing locally on Windows.

`config.json` is generated on first run with a random SFU secret shared by
`api.php` and the SFU. Delete it to rotate.

## One-line install on a server (Ubuntu 24.04)

```bash
curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash -s -- --domain voice.example.com
```

Installs Apache + PHP + SQLite + Node.js + ffmpeg, deploys the code, sets up
the `voice-sfu` systemd service, writes the hardened Apache vhost, configures
the firewall, and enables HTTPS. Step-by-step manual: **[UBUNTU-INSTALL.md](UBUNTU-INSTALL.md)**.

## How it works

```
Browser / Android app ── REST (api.php) ──► PHP + SQLite   rooms, members, events, chat, sessions
        │                    │                (one public endpoint for everything)
        │                    └── tunnels the SDP exchange ──► Node SFU (127.0.0.1:3000)
        └── WebRTC audio ────────────────────────────────────► SFU: forwards 1 upload per member
                                                                  to all others, records per-member
                                                                  .ogg, mixes via ffmpeg on close
```

- **Vanilla ICE** (gather-complete offers/answers) through the HTTP tunnel —
  no WebSocket server, no trickle, trivial for native clients.
- **Slots**: every member occupies one of 15 media slots; downlink lane
  `i` carries the member in slot `i`. Clients map lanes → people via the
  roster from `poll`.
- **Ephemeral state**: rooms/members/events live in SQLite and are garbage
  collected aggressively; the only artifacts kept are the session recordings.

## Files

| File | Purpose |
|---|---|
| `index.html` / `style.css` | UI: welcome (nickname + create/join), room (tiles, REC, share panel), ended |
| `app.js` | Room client: WebRTC to the SFU, polling, speaking meters, chat, recording link |
| `heartbeat.js` | Web Worker keep-alive so background tabs aren't dropped |
| `api.php` | API v2: rooms, members, media tunnel, events, chat, sessions (see API.md) |
| `sfu/server.js` | Node audio SFU: forwarding + per-member recording (werift, no native deps) |
| `sfu/oggmux.js` | Minimal Ogg/Opus muxer (RFC 3533 + RFC 7845) with tests |
| `sessions/` | Mixed recordings (`<room>-<ts>.ogg`) + per-member parts (web-denied) |
| `API.md` | **The client contract — hand this to an app developer/agent** |
| `UBUNTU-INSTALL.md` | Server manual |

## Notes & troubleshooting

- **HTTPS is mandatory for microphones** on any non-localhost origin — the
  installer handles it via certbot when `--domain` is given.
- **SFU down?** Clients get "Media service unavailable" while HTTP still works.
  Check `systemctl status voice-sfu` / `journalctl -u voice-sfu`.
- **No .ogg in `sessions/`?** ffmpeg missing → parts kept in `sessions/parts/`
  and the session row says `format: "parts"`. Install ffmpeg and re-mix manually.
- **Strict-NAT callers**: the SFU is a public server, so clients connect
  *outward* to it — mesh-NAT problems from P2P designs don't apply here.
