# Installing VoiceLoop on Ubuntu Server 24.04

A complete guide for taking a fresh **Ubuntu 24.04** server to a working
anonymous voice-chat site. The stack is Apache + PHP (8.3) + SQLite — all from
the standard Ubuntu repositories, no Composer, npm or databases to install.

> **Why HTTPS is not optional:** browsers only allow microphone access
> (`getUserMedia`) on *secure contexts*. `http://localhost` counts as secure,
> but any visitor connecting to your server over plain `http://your-domain`
> will be silently blocked from sharing their mic. Step 7 (Let's Encrypt) is
> therefore part of the install, not an extra.

---

## Fast path: the one-line installer

Everything in steps 2–6 (and optionally 7) is automated by the bundled
installer — safe to re-run, works on a fresh Ubuntu 24.04 box:

```bash
# HTTP-only (add HTTPS afterwards with step 7)
curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash

# with HTTPS in one go (domain must already point at this server)
curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash -s -- --domain voice.example.com
```

The rest of this guide documents what the installer does, step by step, plus
testing and troubleshooting — read on if you want manual control or need to
debug.

---

## 1. Prerequisites

- A Ubuntu 24.04 server with a user that has `sudo`.
- A **domain name** with an `A` record pointing at the server's public IP
  (needed for the TLS certificate in step 7). Example used below: `voice.example.com`.
- Ports 22, 80 and 443 reachable (check your cloud provider's firewall too).

## 2. System and package install

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install apache2 libapache2-mod-php php php-sqlite3 git nodejs npm ffmpeg
```

Verify:

```bash
php -v          # expect PHP 8.3.x
php -m | grep -i 'pdo_sqlite\|sqlite3'   # both lines must appear
apache2 -v      # expect Apache/2.4.x (Ubuntu)
node -v         # expect v18+ (v0.2's audio service)
ffmpeg -version # needed to mix session recordings into .ogg
```

Both `pdo_sqlite` and `sqlite3` ship enabled by default; if a line is missing,
`sudo phpenmod -s cli sqlite3 pdo_sqlite` and restart Apache.

## 3. Deploy the code

```bash
sudo git clone https://github.com/sinaspooler/anony-voice.git /var/www/html/voice
```

(Or upload the files with `scp`/`rsync` if you prefer — the layout must end up
as `/var/www/html/voice/index.html` etc.)

## 4. Writable directories + the audio service (SFU)

v0.2 has two runtime areas and one companion service:

```bash
# database + recordings must be writable by PHP (www-data)
sudo mkdir -p /var/www/html/voice/data /var/www/html/voice/sessions
sudo chown -R www-data:www-data /var/www/html/voice/data /var/www/html/voice/sessions

# install the SFU's dependencies and register it as a service
cd /var/www/html/voice/sfu
sudo npm ci --omit=dev || sudo npm install --omit=dev

sudo tee /etc/systemd/system/voice-sfu.service > /dev/null <<'EOF'
[Unit]
Description=VoiceLoop audio SFU (WebRTC forwarding + recording)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/html/voice/sfu
ExecStart=/usr/bin/node /var/www/html/voice/sfu/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now voice-sfu
sleep 2
curl -s http://127.0.0.1:3000/health     # expect {"ok":true,...}
```

The SFU listens **only on 127.0.0.1** — clients never talk to it directly;
`api.php` tunnels the WebRTC handshake to it. `config.json` (shared secret) is
auto-generated on first run; delete it to rotate.

## 5. Apache site configuration

Ubuntu's default Apache config has `AllowOverride None`, so the `.htaccess`
file shipped in `data/` is **not** honored. Access to the database directory is
therefore blocked explicitly in the vhost instead.

Create `/etc/apache2/sites-available/voice.conf`:

```apache
<VirtualHost *:80>
    ServerName voice.example.com
    DocumentRoot /var/www/html/voice

    <Directory /var/www/html/voice>
        Options -Indexes
        AllowOverride None
        Require all granted
    </Directory>

    # never serve the SQLite database, the Node service, or raw recordings
    <Directory /var/www/html/voice/data>
        Require all denied
    </Directory>
    <Directory /var/www/html/voice/sfu>
        Require all denied
    </Directory>
    <Directory /var/www/html/voice/sessions>
        Require all denied
    </Directory>

    ErrorLog ${APACHE_LOG_DIR}/voice-error.log
    CustomLog ${APACHE_LOG_DIR}/voice-access.log combined
</VirtualHost>
```

Enable the site and reload:

```bash
sudo a2ensite voice
sudo a2dissite 000-default        # optional: remove the default placeholder page
sudo apache2ctl configtest        # must end with: Syntax OK
sudo systemctl reload apache2
```

## 6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Apache Full'
sudo ufw enable
sudo ufw status
```

Smoke test over HTTP (mic won't work until step 7, but the page must load):

```bash
curl -I http://voice.example.com/
```

The site was installed **as the web root** in this guide (DocumentRoot points
at the project folder), so the public URL is `https://voice.example.com/` —
not `/voice/`.

## 7. HTTPS with Let's Encrypt (required for microphone access)

```bash
sudo apt -y install certbot python3-certbot-apache
sudo certbot --apache -d voice.example.com
```

Answer the prompts (needs a reachable domain and open port 80). Certbot edits
the vhost to HTTPS and installs a renewal timer. Verify:

```bash
sudo certbot renew --dry-run
curl -I https://voice.example.com/
```

## 8. Test it end to end

1. Open `https://voice.example.com/`, enter a nickname, click **Create a room**.
2. Share the invite link (🔗 Invite button) and open it on **another device** —
   join with a different nickname. Any number of people up to 15 can join.
3. Check: participant tiles with nicknames, glowing rings around whoever is
   speaking, mute toggle, text chat, and the red **REC** timer.
4. The host's ⏹️ **End room** closes it for everyone; the recording link
   appears on the ended screen and the `.ogg` lands in
   `/var/www/html/voice/sessions/`.

Rooms also work between the API directly — see **API.md** (that contract is
what an Android app would implement).

## 9. Updating the site

```bash
cd /var/www/html/voice
sudo git pull
cd sfu && sudo npm ci --omit=dev      # if sfu/package.json changed
sudo systemctl restart voice-sfu     # pick up SFU changes
sudo systemctl reload apache2        # only needed if api.php changed
```

`data/` and `sessions/` are gitignored — updates never touch the database or
existing recordings. To wipe room state anyway:

```bash
sudo rm -f /var/www/html/voice/data/voice.db*
```

## 10. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Browser never asks for mic permission / "Microphone unavailable" | Site is being served over plain HTTP. Complete step 7, or browse via `https://`. |
| "Media service unavailable" on join | The SFU is down: `systemctl status voice-sfu`, `journalctl -u voice-sfu`. On a dev box: `cd sfu && node server.js`. |
| Room works but no session `.ogg` in `sessions/` | ffmpeg missing → the session row says `format: "parts"` and parts sit in `sessions/parts/`. Install ffmpeg (step 2) — new rooms will mix automatically. |
| `500` from `api.php` | PHP error log: `sudo tail -f /var/log/apache2/error.log`. Most common: `data/` or `sessions/` not writable — redo step 4. |
| Page loads but joining fails with "room not found" | Different origins in play (e.g. invite copied from `http://server-ip` while the room lives on `https://voice.example.com`) — always share the exact HTTPS URL. |
| `403 Forbidden` when opening `https://voice.example.com/data/` or `/sessions/` | **Expected** — those directories must never be web-readable; recordings download via `api.php?action=session`. |
| Participants freeze for someone after a few minutes | A member stopped heartbeating (app in background without the heartbeat worker, or network loss). The server auto-removes silent members after ~12 s. |
| Caller behind very strict corporate NAT can't connect | Unlike P2P designs, clients connect *outward* to your server, so most NATs work. For the rare blocking case, add a TURN server to `ICE_SERVERS` at the top of `app.js`. |
| Calls drop when a caller switches tabs for minutes | Should not happen — a Web Worker keeps the session heartbeating. If it does, check that `heartbeat.js` is served (DevTools → Network) and that no proxy strips it. |

## 11. Optional hardening

- **Recording retention**: `sessions/*.ogg` grow over time. Add a cron, e.g.
  keep 14 days: `0 3 * * * find /var/www/html/voice/sessions -name '*.ogg' -mtime +14 -delete`.
- **Multiple instances**: each vhost/clone is an independent room pool (give
  each its own SFU port + `config.json`).
- **Backups**: the only persistent artifacts are the recordings in
  `sessions/` — include them in backups if you need history.
- **PHP exposure**: the only PHP file is `api.php`; the frontend assets are
  static. If you want to go further, restrict `open_basedir` for this vhost to
  the project directory.
