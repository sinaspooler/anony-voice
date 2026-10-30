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

## 1. Prerequisites

- A Ubuntu 24.04 server with a user that has `sudo`.
- A **domain name** with an `A` record pointing at the server's public IP
  (needed for the TLS certificate in step 7). Example used below: `voice.example.com`.
- Ports 22, 80 and 443 reachable (check your cloud provider's firewall too).

## 2. System and package install

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install apache2 libapache2-mod-php php php-sqlite3 git
```

Verify:

```bash
php -v          # expect PHP 8.3.x
php -m | grep -i 'pdo_sqlite\|sqlite3'   # both lines must appear
apache2 -v      # expect Apache/2.4.x (Ubuntu)
```

Both `pdo_sqlite` and `sqlite3` ship enabled by default; if a line is missing,
`sudo phpenmod -s cli sqlite3 pdo_sqlite` and restart Apache.

## 3. Deploy the code

```bash
sudo git clone https://github.com/sinaspooler/anony-voice.git /var/www/html/voice
```

(Or upload the files with `scp`/`rsync` if you prefer — the layout must end up
as `/var/www/html/voice/index.html` etc.)

## 4. Create the writable data directory

The SQLite database lives in `data/` inside the project. On Ubuntu, Apache/PHP
run as the `www-data` user and `/var/www/html` is root-owned, so create and
hand over the directory **before** the first request:

```bash
sudo mkdir -p /var/www/html/voice/data
sudo chown -R www-data:www-data /var/www/html/voice/data
```

`api.php` creates `data/voice.db` automatically on first use — nothing else to
configure.

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

    # never serve the SQLite database or its WAL files
    <Directory /var/www/html/voice/data>
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

1. Open `https://voice.example.com/` in **two different browsers or devices**.
2. Click **Start talking** on both, allow the microphone when asked.
3. One side shows *Looking for a stranger…* until the other joins — then both
   flip to the call screen with a running timer.
4. Check: audio both ways, mute toggle, text chat, glowing mic rings, and
   *Stranger left* when one side closes the tab.

If you test with two windows **on the server's own desktop** (not possible on
a headless server, but true for a home lab), plain `http://localhost` also
works without HTTPS.

## 9. Updating the site

```bash
cd /var/www/html/voice
sudo git pull
sudo systemctl reload apache2    # only needed if api.php changed
```

`data/` is gitignored — updates never touch the live database. To wipe all
matchmaking state anyway:

```bash
sudo rm -f /var/www/html/voice/data/voice.db*
```

## 10. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Browser never asks for mic permission / "Microphone access is required" | Site is being served over plain HTTP. Complete step 7, or browse via `https://`. |
| `500` from `api.php`, nothing in `voice-error.log` | PHP error log: `sudo tail -f /var/log/apache2/error.log`. Most common: `data/` not writable — redo step 4. |
| "Could not reach the server" on the start screen | Apache down or PHP module missing: `systemctl status apache2`, `php -m`. |
| Page loads but pairing never happens | Two different sites configured (e.g. visitors on `https://voice.example.com` while a friend opened `http://server-ip`). Matchmaking pairs clients that use the **same origin** — always share the exact HTTPS URL. |
| `403 Forbidden` when opening `https://voice.example.com/data/` | **Expected** — that directory must never be web-readable. |
| "Connection failed" after ~30 s, works on LAN but not across the internet | Both callers are behind strict (symmetric) NATs and STUN alone can't punch through. Add a TURN server to `RTC_CONFIG` at the top of `app.js`: `{ urls: 'turn:your-turn:3478', username: '...', credential: '...' }` (e.g. a self-hosted [coturn](https://github.com/coturn/coturn) or a metered provider). |
| Calls drop when a caller switches tabs for minutes | Should not happen — a Web Worker keeps the session heartbeating. If it does, check that `heartbeat.js` is served (DevTools → Network) and that no proxy strips it. |

## 11. Optional hardening

- **Dedicated subdomain per use-case**: each vhost/clone is an independent
  matchmaking pool — a second clone under another subdomain splits "random
  stranger" traffic if you ever need to.
- **SQLite WAL size**: the database self-cleans (60 s for stale clients, 1 h
  for old messages); no cron jobs needed.
- **Backups**: there is nothing persistent to back up by design — no accounts,
  no history, no recordings.
- **PHP exposure**: the only PHP file is `api.php`; the frontend assets are
  static. If you want to go further, restrict `open_basedir` for this vhost to
  the project directory.
