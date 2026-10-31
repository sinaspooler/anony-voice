#!/usr/bin/env bash
#
# VoiceLoop — one-line installer for Ubuntu 24.04 (Debian-based systems work,
# Ubuntu 24.04 is what it's tested against).
#
# Quick use:
#   curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash
#
# With your domain (recommended — enables HTTPS, which browsers require for
# microphone access):
#   curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash -s -- --domain voice.example.com
#
# Options:
#   --domain <name>    domain pointed at this server; enables the certbot HTTPS step
#   --repo <url>       git repo to install from (default: the upstream repo)
#   --dir <path>       install location (default: /var/www/html/voice)
#   --no-https         skip the certbot step even when --domain is given
#   -h, --help         show this help
#
set -euo pipefail

REPO="https://github.com/sinaspooler/anony-voice.git"
INSTALL_DIR="/var/www/html/voice"
DOMAIN=""
SKIP_HTTPS=0

usage() {
    cat <<'EOF'
VoiceLoop installer for Ubuntu 24.04

Quick use:
  curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash

With your domain (recommended — enables HTTPS, which browsers require for
microphone access):
  curl -fsSL https://raw.githubusercontent.com/sinaspooler/anony-voice/main/install.sh | sudo bash -s -- --domain voice.example.com

Options:
  --domain <name>    domain pointed at this server; enables the certbot HTTPS step
  --repo <url>       git repo to install from (default: the upstream repo)
  --dir <path>       install location (default: /var/www/html/voice)
  --no-https         skip the certbot step even when --domain is given
  -h, --help         show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)   DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
        --repo)     REPO="${2:?--repo needs a value}"; shift 2 ;;
        --dir)      INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
        --no-https) SKIP_HTTPS=1; shift ;;
        -h|--help)  usage; exit 0 ;;
        *)          echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

# ---------------------------------------------------------------- preflight --

if [ "${EUID}" -ne 0 ]; then
    echo "Please run as root — re-run with:  curl -fsSL <installer-url> | sudo bash"
    exit 1
fi

if [ ! -f /etc/os-release ] || ! grep -qi 'ubuntu\|debian' /etc/os-release; then
    echo "This installer targets Ubuntu/Debian systems. For anything else, follow UBUNTU-INSTALL.md manually."
    exit 1
fi

fail() {
    echo ""
    echo "✗ Install failed at: $*"
    echo "  Check /var/log/apache2/error.log and the output above, then re-run this installer (it is safe to re-run)."
    exit 1
}
trap 'fail "line $LINENO"' ERR

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# ------------------------------------------------------------ 1. packages ----

step "Installing Apache, PHP, Node.js, SQLite and certbot (this can take a minute)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apache2 libapache2-mod-php php php-sqlite3 git certbot python3-certbot-apache nodejs npm ffmpeg >/dev/null

if ! php -m | grep -qi 'pdo_sqlite'; then
    echo "WARNING: pdo_sqlite missing from PHP — voice chat will not work. Run: phpenmod sqlite3 pdo_sqlite"
fi

# ------------------------------------------------------------ 2. the code ----

step "Deploying the code to ${INSTALL_DIR}"
# never let git prompt for credentials: when piped, stdin is this script
export GIT_TERMINAL_PROMPT=0
if [ -d "${INSTALL_DIR}/.git" ]; then
    git -C "${INSTALL_DIR}" remote set-url origin "${REPO}"
    git -C "${INSTALL_DIR}" pull --ff-only
elif [ -e "${INSTALL_DIR}" ]; then
    echo "ERROR: ${INSTALL_DIR} exists but is not a git checkout — move it away or choose another --dir."
    exit 1
else
    git clone --depth 1 "${REPO}" "${INSTALL_DIR}"
fi

# ----------------------------------------------- 3. writable data directory --

step "Preparing the writable data and sessions directories"
# Apache on Ubuntu runs as www-data and the web root is root-owned, so the
# SQLite database and the session recordings cannot create themselves without
# this.
mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/sessions"
chown -R www-data:www-data "${INSTALL_DIR}/data" "${INSTALL_DIR}/sessions"

# ----------------------------------------------------- 4. the Node.js SFU ----

step "Installing and starting the audio forwarding service (SFU)"
cd "${INSTALL_DIR}/sfu"
npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null

cat > /etc/systemd/system/voice-sfu.service <<EOF
[Unit]
Description=VoiceLoop audio SFU (WebRTC forwarding + recording)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${INSTALL_DIR}/sfu
ExecStart=/usr/bin/node ${INSTALL_DIR}/sfu/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now voice-sfu
for i in $(seq 1 20); do
    if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then break; fi
    sleep 0.5
done
if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "SFU is running on 127.0.0.1:3000 (systemd unit: voice-sfu)."
else
    echo "WARNING: SFU did not answer on 127.0.0.1:3000 — check: journalctl -u voice-sfu"
fi
cd - >/dev/null

# ------------------------------------------------------------ 4. the vhost ---

step "Writing the Apache site configuration"
if [ -n "${DOMAIN}" ]; then
    SERVER_NAME_LINE="    ServerName ${DOMAIN}"
else
    SERVER_NAME_LINE="    # ServerName voice.example.com   # add when you have a domain"
fi

cat > /etc/apache2/sites-available/voice.conf <<EOF
<VirtualHost *:80>
${SERVER_NAME_LINE}
    DocumentRoot ${INSTALL_DIR}

    <Directory ${INSTALL_DIR}>
        Options -Indexes
        AllowOverride None
        Require all granted
    </Directory>

    # never serve the SQLite database, the Node service, or raw recordings
    <Directory ${INSTALL_DIR}/data>
        Require all denied
    </Directory>
    <Directory ${INSTALL_DIR}/sfu>
        Require all denied
    </Directory>
    <Directory ${INSTALL_DIR}/sessions>
        Require all denied
    </Directory>

    ErrorLog \${APACHE_LOG_DIR}/voice-error.log
    CustomLog \${APACHE_LOG_DIR}/voice-access.log combined
</VirtualHost>
EOF

a2ensite -q voice
a2dissite -q 000-default 2>/dev/null || true
apache2ctl configtest
systemctl reload apache2

# -------------------------------------------------------------- 5. firewall --

step "Configuring the firewall"
if command -v ufw >/dev/null 2>&1; then
    if ufw status | grep -q "Status: active"; then
        ufw allow OpenSSH  >/dev/null
        ufw allow "Apache Full" >/dev/null
        echo "Firewall rules added (ufw was already active)."
    else
        echo "ufw is installed but inactive — left untouched. To use it:"
        echo "  ufw allow OpenSSH && ufw allow 'Apache Full' && ufw enable"
    fi
else
    echo "ufw not installed — skipping. If you use another firewall, open ports 80 and 443."
fi

# ---------------------------------------------------------------- 6. HTTPS ---

if [ -n "${DOMAIN}" ] && [ "${SKIP_HTTPS}" -eq 0 ]; then
    step "Requesting a Let's Encrypt certificate for ${DOMAIN}"
    if [ -t 0 ] && [ -e /dev/tty ]; then
        certbot --apache -d "${DOMAIN}" < /dev/tty
    else
        echo "Non-interactive session — finish HTTPS setup with:"
        echo "  sudo certbot --apache -d ${DOMAIN}"
    fi
else
    step "HTTPS"
    if [ -n "${DOMAIN}" ]; then
        echo "Skipping as requested (--no-https). Run later:  sudo certbot --apache -d ${DOMAIN}"
    else
        cat <<'EOF'

IMPORTANT: the site is currently HTTP-only. Browsers only grant microphone
access on secure origins, so until HTTPS is set up, visitors will see
"Microphone access is required". Once your domain points at this server:

    sudo certbot --apache -d your-domain.example.com

(On the server itself, http://localhost/ is treated as secure and works for a
quick test.)
EOF
    fi
fi

# -------------------------------------------------------------- 7. summary ---

URL="http://${DOMAIN:-<your-server-ip>}/"
step "Done — VoiceLoop is installed"
cat <<EOF

  Location : ${INSTALL_DIR}
  URL      : ${URL}

Try it: open ${URL} in two different browsers or devices, click
"Start talking" on both, and the two will connect to each other.

Update any time with:  cd ${INSTALL_DIR} && sudo git pull
Full guide: ${INSTALL_DIR}/UBUNTU-INSTALL.md
EOF
