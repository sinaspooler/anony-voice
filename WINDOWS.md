# Running VoiceLoop on Windows locally (XAMPP)

Test the full stack — rooms, live audio, recording — on your own PC with
XAMPP. Two browser windows simulate two participants; `localhost` is a secure
context, so microphone access works without HTTPS.

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| [XAMPP](https://www.apachefriends.org/) (PHP 8.x) | Apache + PHP | `J:\xampp\php\php.exe -v` |
| [Node.js](https://nodejs.org/) 18+ | runs the audio service (`sfu/`) | `node -v` |
| [Git](https://git-scm.com/) | to clone/update | `git --version` |
| ffmpeg *(optional)* | mixes session recordings into `.ogg` | `ffmpeg -version` |

Install ffmpeg quickly if you want recordings:
`winget install Gyan.FFmpeg` (then reopen your terminal).

## 2. Place the project

Clone or copy the project into XAMPP's web root:

```bat
cd C:\xampp\htdocs
git clone https://github.com/sinaspooler/anony-voice.git anony-voice0.2
```

(Adjust the XAMPP path — e.g. `J:\xampp\htdocs` — to your install.)

## 3. Start Apache

Open the **XAMPP Control Panel** → **Apache** → *Start*. Verify:
<http://localhost/anony-voice0.2/> shows the VoiceLoop welcome screen.

## 4. Start the audio service (SFU) — required

The SFU forwards the audio between participants and records sessions. It runs
on `127.0.0.1:3000` and is **not** exposed to the network.

```bat
cd C:\xampp\htdocs\anony-voice0.2\sfu
npm install
node server.js
```

Leave this window open while testing. You should see:
`[sfu] listening on 127.0.0.1:3000 (slots: 15)`.

Confirm it's healthy: <http://127.0.0.1:3000/health> → `{"ok":true,...}`.

> `config.json` (shared secret) is generated automatically on first start —
> both `api.php` and the SFU read it. Delete it to rotate the secret.

## 5. Make a call

1. Open <http://localhost/anony-voice0.2/> in **one window**, enter a nickname,
   click **Create a room**.
2. Copy the invite link (🔗 Invite) and open it in a **second window** (or a
   different browser). Join with a different nickname.
3. Allow the microphone in both windows when asked.
4. Check the tiles, speaking glows, chat, and the red REC timer. Use
   headphones to avoid echo.
5. Click **⏹️ End room** (host) — the recording link appears on the ended
   screen, and the `.ogg` lands in `sessions\`.

## 6. Where things live

| Path | What |
|---|---|
| `data\voice.db` | SQLite room state (auto-created) |
| `sessions\*.ogg` | finished room recordings |
| `sessions\parts\` | per-member recordings kept until mixed |
| `config.json` | SFU port + shared secret (auto-generated) |

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| "Media service unavailable" on join | The SFU isn't running — repeat step 4 and watch its window for errors. |
| Port 3000 already in use | Another SFU is running; close it, or change `sfuPort` in `config.json` (restart both Apache PHP consumers and the SFU). |
| "Microphone unavailable" | `localhost` is secure, so this means the browser blocked the device — check Windows **Settings → Privacy → Microphone** and the browser's site permissions. |
| No `.ogg` after ending a room | ffmpeg missing → `winget install Gyan.FFmpeg`, reopen the terminal, end a new room. Old sessions stay as parts in `sessions\parts\`. |
| Page loads but joining fails | Apache serving a different folder than the one you cloned into — match the URL path to the folder name. |

## 8. Updating

```bat
cd C:\xampp\htdocs\anony-voice0.2
git pull
cd sfu && npm install
```

Restart the SFU window (Ctrl+C, `node server.js`) and reload the page.
