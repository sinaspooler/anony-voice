# VoiceLoop 🎙️

Talk live with a random stranger — voice only, fully anonymous. No accounts, no
names, no logs. Two people open the site, click **Start talking**, and get
paired automatically.

- **Random pairing** — Omegle-style queue: whoever is waiting gets connected.
- **Peer-to-peer audio** (WebRTC) — voice flows directly between the two
  browsers. The server only performs matchmaking, connection setup (signaling)
  and relays text-chat lines. **Nothing is recorded.**
- **Text chat fallback** for when the audio is unclear.
- **Live mic-level rings** around both avatars, so you can see when the other
  person is speaking.
- **Mute** and **End call** controls, call timer, instant "Stranger left"
  detection.
- Pure PHP + SQLite + vanilla JS. No dependencies, no build step.

## One-line install on a server (Ubuntu 24.04)

```bash
curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash
```

That single command installs Apache + PHP + SQLite, deploys the code to
`/var/www/html/voice`, prepares the writable data directory, writes the Apache
site (with the database directory locked away from the web), configures the
firewall if `ufw` is active, and starts serving.

**Recommended — with your domain** (enables HTTPS, which browsers require for
microphone access; point an `A` record at the server first):

```bash
curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash -s -- --domain voice.example.com
```

Extras: `--repo <url>` to install a fork, `--dir <path>` for another location,
`--no-https` to skip certbot, `--help` for all options. The installer is safe
to re-run. Full step-by-step instructions and troubleshooting live in
[UBUNTU-INSTALL.md](UBUNTU-INSTALL.md).

## Quick start (XAMPP, Windows)

1. This folder lives in `htdocs\voice`, so with Apache running open:
   **http://localhost/voice/**
2. Click **Start talking** and allow microphone access.
3. To test alone, open the same URL in a **second browser window** and click
   start there too — the two windows will connect to each other.
   (Headphones recommended to avoid echo.)

No configuration needed: `data/voice.db` (SQLite) is created automatically on
first use, and `data/.htaccess` blocks web access to it.

## How it works

```
Browser A ──HTTP poll/join/signal/chat──► api.php ──► SQLite (ephemeral state)
Browser B ────────────── the same ──────► api.php
Browser A ◄════════ direct peer-to-peer audio (WebRTC) ════════► Browser B
```

1. `join` — the client registers and either gets paired with a waiting
   stranger immediately or enters the queue. The joiner is the WebRTC
   *initiator*; the person who waited first *answers* (no offer collisions).
2. Both browsers exchange SDP offers/answers and ICE candidates through
   `signal` (short polling: ~400 ms while connecting, ~1 s in a call).
3. Once ICE connects, audio is direct browser-to-browser. A Web Worker
   heartbeat keeps sessions alive even in background tabs; stale clients
   (>10 s silent) are considered gone and their partner is notified.
4. Leaving the page sends a `sendBeacon(leave)` so the other side sees
   "Stranger left" immediately.

State lives only in the SQLite database and is garbage-collected aggressively:
clients unseen for 60 s are purged, messages older than an hour are purged.
Client IDs are random per-tab tokens kept in `sessionStorage` — they identify
nothing about you.

## Notes & troubleshooting

**Microphone is blocked on another device / over the network**
Browsers only allow `getUserMedia` in secure contexts. `http://localhost` is
secure, but `http://192.168.x.x/voice/` or any plain-HTTP public URL is not.
To invite someone over LAN/internet, put Apache behind HTTPS (XAMPP ships
`makecert.bat`; or use a tunnel like cloudflared/ngrok which provide TLS) —
or self-sign and open the site once with the certificate accepted.

**"Connecting…" never becomes "Connected"** (works on localhost, fails across
networks): both sides are behind strict (symmetric) NATs. STUN alone cannot
punch through that — add a TURN server to `RTC_CONFIG` at the top of
`app.js` (e.g. open relay creds or a Metered/Coturn instance).

**Quick test without Apache**: from this folder run
`J:\xampp\php\php.exe -S localhost:8000`, then open
http://localhost:8000/ (localhost is a secure context, so the mic works).

**Reset**: delete `data/voice.db*` to wipe all state (there is normally
nothing worth wiping).

## Files

| File | Purpose |
|---|---|
| `install.sh` | One-line server installer for Ubuntu 24.04 (packages, deploy, Apache, firewall, HTTPS) |
| `index.html` | Single-page UI: start / waiting / call / ended screens + chat panel |
| `style.css` | Dark theme, radar waiting animation, mic-level rings, chat styling |
| `app.js` | WebRTC, polling client, matchmaking flow, chat, audio meters |
| `heartbeat.js` | Web Worker keep-alive so background tabs aren't dropped mid-call |
| `api.php` | Matchmaking + signaling + chat API over SQLite |
| `UBUNTU-INSTALL.md` | Full Ubuntu 24.04 server manual (manual steps, HTTPS, troubleshooting) |
| `data/` | Auto-created SQLite database (web access blocked) |
