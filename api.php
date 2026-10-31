<?php
/**
 * VoiceLoop API v2 — link-based multi-party voice rooms.
 *
 * Every client (the bundled web UI and any native app, e.g. Android) talks to
 * this single endpoint. See API.md for the full contract with examples.
 *
 *   create       POST  {nickname}                                  start a room (host)
 *   join         POST  {roomId, nickname}                          join a room via link
 *   poll         POST  {memberId, memberSecret, since, sinceChat, speaking}
 *                                                                  heartbeat + members + events + chat
 *   media_attach POST  {memberId, memberSecret, offerSdp}          -> {answerSdp} (tunneled to the SFU)
 *   chat         POST  {memberId, memberSecret, text}
 *   leave        POST  {memberId, memberSecret}                    (also used by sendBeacon)
 *   heartbeat    POST  {memberId, memberSecret}
 *   end_room     POST  {memberId, memberSecret}                    host only: finalize + close
 *   sessions     GET                                               list finished recordings
 *   session      GET   ?file=<name>                                stream a recording (Range supported)
 *
 * Media is forwarded by the Node SFU (sfu/server.js) on 127.0.0.1 — the SDP
 * exchange is tunneled through media_attach so clients only ever see this
 * endpoint. Recording is fully server-side: the SFU writes per-member .ogg
 * parts, and finalize mixes them with ffmpeg into sessions/<room>-<ts>.ogg.
 */

declare(strict_types=1);

const STALE_MS      = 12000;  // member without a heartbeat for this long counts as gone
const CLEANUP_MS    = 60000;  // purge member rows this old
const CHAT_MAXLEN   = 500;
const NICK_MAXLEN   = 24;
const RATE_WINDOW   = 60;     // seconds
const RATE_MAX      = 12;     // create/join attempts per IP per window

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, must-revalidate');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function out(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

// ------------------------------------------------------------------- config --

function loadConfig(): array {
    static $cfg = null;
    if (is_array($cfg)) {
        return $cfg;
    }
    $file = __DIR__ . '/config.json';
    for ($i = 0; $i < 3; $i++) {
        if (is_file($file)) {
            $parsed = json_decode((string) file_get_contents($file), true);
            if (is_array($parsed)) {
                $cfg = $parsed;
                return $cfg;
            }
        }
        $generated = [
            'sfuPort'   => 3000,
            'sfuSecret' => bin2hex(random_bytes(16)),
            'maxSlots'  => 15,
            'partsDir'  => __DIR__ . '/sessions/parts',
            'finalDir'  => __DIR__ . '/sessions',
            'ffmpegBin' => 'ffmpeg',
        ];
        $fh = @fopen($file, 'x');
        if ($fh) {
            fwrite($fh, (string) json_encode($generated, JSON_PRETTY_PRINT));
            fclose($fh);
        }
    }
    out(['error' => 'cannot read or create config.json'], 500);
}

// ---------------------------------------------------------------------- db --

function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dir = __DIR__ . '/data';
    if (!is_dir($dir) && !mkdir($dir, 0770, true)) {
        out(['error' => 'cannot create data directory'], 500);
    }
    $pdo = new PDO('sqlite:' . $dir . '/voice.db');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS rooms (
            room_id    TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            closed_at  INTEGER
        )
    SQL);
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS members (
            member_id  TEXT PRIMARY KEY,
            room_id    TEXT NOT NULL,
            nickname   TEXT NOT NULL,
            secret     TEXT NOT NULL,
            is_host    INTEGER NOT NULL DEFAULT 0,
            slot       INTEGER NOT NULL,
            joined_at  INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL,
            speaking   INTEGER NOT NULL DEFAULT 0,
            media      INTEGER NOT NULL DEFAULT 0
        )
    SQL);
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_members_room ON members (room_id)');
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS events (
            event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    TEXT NOT NULL,
            type       TEXT NOT NULL,
            payload    TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        )
    SQL);
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_events_room ON events (room_id, event_id)');
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS chat (
            chat_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    TEXT NOT NULL,
            member_id  TEXT NOT NULL,
            nickname   TEXT NOT NULL,
            text       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    SQL);
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS sessions (
            session_id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    TEXT NOT NULL,
            file       TEXT NOT NULL,
            format     TEXT NOT NULL DEFAULT 'ogg',
            started_at INTEGER,
            ended_at   INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0
        )
    SQL);
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS ratelimit (
            ip           TEXT NOT NULL,
            action       TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            count        INTEGER NOT NULL,
            PRIMARY KEY (ip, action)
        )
    SQL);
    return $pdo;
}

/** Request body: JSON (fetch calls) with a form-encoded fallback (sendBeacon). */
function body(): array {
    $raw = file_get_contents('php://input');
    if (is_string($raw) && $raw !== '') {
        $json = json_decode($raw, true);
        if (is_array($json)) {
            return $json;
        }
    }
    return $_POST;
}

function validToken(string $id): bool {
    return preg_match('/^[A-Za-z0-9_-]{8,64}$/', $id) === 1;
}

function cleanNickname(array $in): string {
    $nick = trim((string) ($in['nickname'] ?? ''));
    $nick = preg_replace('/[\x00-\x1f\x7f]/u', '', $nick) ?? '';
    return mb_substr($nick, 0, NICK_MAXLEN);
}

function rateLimited(string $ip, string $action, int $now): bool {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT window_start, count FROM ratelimit WHERE ip = ? AND action = ?');
    $stmt->execute([$ip, $action]);
    $row = $stmt->fetch();
    if (!$row || $now - (int) $row['window_start'] >= RATE_WINDOW) {
        $pdo->prepare('INSERT OR REPLACE INTO ratelimit (ip, action, window_start, count) VALUES (?, ?, ?, 1)')
            ->execute([$ip, $action, $now]);
        return false;
    }
    if ((int) $row['count'] >= RATE_MAX) {
        return true;
    }
    $pdo->prepare('UPDATE ratelimit SET count = count + 1 WHERE ip = ? AND action = ?')
        ->execute([$ip, $action]);
    return false;
}

function addEvent(string $roomId, string $type, array $payload = []): void {
    db()->prepare('INSERT INTO events (room_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$roomId, $type, json_encode($payload), (int) round(microtime(true) * 1000)]);
}

/** Call the SFU's control API over loopback. Returns decoded JSON or null. */
function sfuCall(string $path, array $payload): ?array {
    $cfg = loadConfig();
    $url = 'http://127.0.0.1:' . (int) $cfg['sfuPort'] . $path;
    $payload['secret'] = (string) $cfg['sfuSecret'];
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/json\r\n",
        'content'       => json_encode($payload),
        'timeout'       => 10,
        'ignore_errors' => true,
    ]]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) {
        return null;
    }
    $json = json_decode($raw, true);
    return is_array($json) ? $json : null;
}

/** Member lookup + secret check. Exits with an error on failure. */
function authMember(array $in): array {
    $memberId = (string) ($in['memberId'] ?? '');
    $secret = (string) ($in['memberSecret'] ?? '');
    if (!validToken($memberId) || !validToken($secret)) {
        out(['error' => 'invalid credentials'], 400);
    }
    $stmt = db()->prepare(
        'SELECT m.*, r.closed_at FROM members m JOIN rooms r ON r.room_id = m.room_id WHERE m.member_id = ?'
    );
    $stmt->execute([$memberId]);
    $member = $stmt->fetch();
    if (!$member || !hash_equals((string) $member['secret'], $secret)) {
        out(['error' => 'unknown member'], 403);
    }
    return $member;
}

function liveMembers(string $roomId, int $now): array {
    $stmt = db()->prepare(
        'SELECT member_id, nickname, is_host, slot, speaking, media, joined_at FROM members
         WHERE room_id = ? AND last_seen >= ? ORDER BY slot ASC'
    );
    $stmt->execute([$roomId, $now - STALE_MS]);
    return $stmt->fetchAll();
}

function findFreeSlot(string $roomId, int $maxSlots): int {
    $stmt = db()->prepare('SELECT slot FROM members WHERE room_id = ?');
    $stmt->execute([$roomId]);
    $used = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    for ($s = 0; $s < $maxSlots; $s++) {
        if (!in_array($s, $used, true)) {
            return $s;
        }
    }
    return -1;
}

function sfuDetach(string $roomId, string $memberId): void {
    sfuCall('/detach', ['roomId' => $roomId, 'memberId' => $memberId]);
}

function ffmpegAvailable(string $bin): bool {
    if ($bin === '') {
        return false;
    }
    if (is_executable($bin)) {
        return true;
    }
    exec(escapeshellcmd($bin) . ' -version 2>&1', $output, $code);
    return $code === 0;
}

/**
 * Mix the SFU's per-member .ogg parts into one sessions/<room>-<ts>.ogg with
 * ffmpeg (adelay per member for join alignment, amix without normalization),
 * write the sessions row, and clean up the parts. Returns the session array
 * or null when nobody ever produced audio. Falls back to a 'parts' session
 * row when ffmpeg is unavailable.
 */
function finalizeSession(string $roomId): ?array {
    $cfg = loadConfig();
    $now = (int) round(microtime(true) * 1000);
    $pdo = db();

    $fin = sfuCall('/finalize', ['roomId' => $roomId]);
    $parts = is_array($fin['members'] ?? null) ? $fin['members'] : [];
    if (count($parts) === 0) {
        return null;
    }

    $startedAt = null;
    foreach ($parts as $p) {
        $start = $now - (int) ($p['offsetMs'] ?? 0);
        $startedAt = $startedAt === null ? $start : min($startedAt, $start);
    }

    $finalDir = (string) $cfg['finalDir'];
    if (!is_dir($finalDir)) {
        @mkdir($finalDir, 0770, true);
    }
    $outFile = $finalDir . '/' . $roomId . '-' . intdiv($now, 1000) . '.ogg';

    $format = 'parts';
    $size = 0;
    if (ffmpegAvailable((string) $cfg['ffmpegBin'])) {
        $ffmpeg = (string) $cfg['ffmpegBin'];
        if (count($parts) === 1) {
            $cmd = sprintf(
                '%s -v error -y -i %s -c:a copy %s',
                escapeshellcmd($ffmpeg),
                escapeshellarg((string) $parts[0]['file']),
                escapeshellarg($outFile)
            );
        } else {
            $inputs = '';
            $filters = '';
            $mixLabels = '';
            foreach ($parts as $i => $p) {
                $inputs .= ' -i ' . escapeshellarg((string) $p['file']);
                $filters .= sprintf('[%d:a]aresample=48000,adelay=%d:all=1[d%d];', $i, (int) ($p['offsetMs'] ?? 0), $i);
                $mixLabels .= sprintf('[d%d]', $i);
            }
            $filters .= $mixLabels . sprintf('amix=inputs=%d:normalize=0:duration=longest[aout]', count($parts));
            $cmd = sprintf(
                '%s -v error -y %s -filter_complex %s -map [aout] -c:a libopus -b:a 96k %s',
                escapeshellcmd($ffmpeg),
                $inputs,
                escapeshellarg($filters),
                escapeshellarg($outFile)
            );
        }
        exec($cmd . ' 2>&1', $logLines, $code);
        if ($code === 0 && is_file($outFile)) {
            $format = 'ogg';
            $size = (int) filesize($outFile);
            foreach ($parts as $p) {
                @unlink((string) $p['file']);
            }
            @rmdir(dirname((string) $parts[0]['file']));
        }
    }

    if ($format === 'parts') {
        $outFile = (string) $cfg['partsDir'] . '/' . $roomId;
        foreach ($parts as $p) {
            $f = (string) $p['file'];
            $size += is_file($f) ? (int) filesize($f) : 0;
        }
    }

    $file = basename((string) $outFile);
    $pdo->prepare('INSERT INTO sessions (room_id, file, format, started_at, ended_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$roomId, $file, $format, $startedAt, $now, $size]);

    return ['file' => $file, 'format' => $format, 'sizeBytes' => $size];
}

/** Housekeeping: drop stale members, auto-close and finalize emptied rooms. */
function housekeep(int $now): void {
    static $lastRun = 0;
    if ($now - $lastRun < 2000) {
        return; // at most every 2s across all pollers
    }
    $lastRun = $now;
    $pdo = db();

    $stale = $pdo->prepare('SELECT member_id, room_id, nickname FROM members WHERE last_seen < ?');
    $stale->execute([$now - STALE_MS]);
    foreach ($stale->fetchAll() as $m) {
        sfuDetach((string) $m['room_id'], (string) $m['member_id']);
        $pdo->prepare('DELETE FROM members WHERE member_id = ?')->execute([$m['member_id']]);
        addEvent((string) $m['room_id'], 'member_left', ['nickname' => $m['nickname'], 'reason' => 'timeout']);
    }

    // rooms with no live members get closed + finalized (nobody is left to notify)
    $open = $pdo->query(
        'SELECT room_id FROM rooms WHERE closed_at IS NULL AND room_id NOT IN
         (SELECT DISTINCT room_id FROM members WHERE last_seen >= ' . ($now - STALE_MS) . ')'
    );
    foreach ($open->fetchAll(PDO::FETCH_COLUMN) as $roomId) {
        $pdo->prepare('UPDATE rooms SET closed_at = ? WHERE room_id = ?')->execute([$now, $roomId]);
        addEvent((string) $roomId, 'room_closed', ['reason' => 'empty']);
        finalizeSession((string) $roomId);
    }

    $pdo->prepare('DELETE FROM members WHERE last_seen < ?')->execute([$now - CLEANUP_MS]);
    $pdo->prepare('DELETE FROM ratelimit WHERE window_start < ?')->execute([$now - RATE_WINDOW * 10]);
}

// ------------------------------------------------------------------ router --

$action = $_REQUEST['action'] ?? '';
$now = (int) round(microtime(true) * 1000);

try {
    switch ($action) {
        case 'create': {
            $in = body();
            $nickname = cleanNickname($in);
            if ($nickname === '') {
                out(['error' => 'nickname required'], 400);
            }
            if (rateLimited($_SERVER['REMOTE_ADDR'] ?? 'x', 'create', $now)) {
                out(['error' => 'too many requests'], 429);
            }
            $cfg = loadConfig();
            $pdo = db();

            $roomId = bin2hex(random_bytes(8));
            $memberId = bin2hex(random_bytes(12));
            $secret = bin2hex(random_bytes(16));

            $pdo->prepare('INSERT INTO rooms (room_id, created_at) VALUES (?, ?)')->execute([$roomId, $now]);
            $pdo->prepare('INSERT INTO members (member_id, room_id, nickname, secret, is_host, slot, joined_at, last_seen) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
                ->execute([$memberId, $roomId, $nickname, $secret, $now, $now]);

            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            // the web app lives next to api.php (dirname of the script), so the
            // invite points at e.g. /voice/?room=... whether installed in a
            // subfolder or at the web root (dirname('/api.php') === '/')
            $dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
            $base = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $dir . '/';

            out([
                'roomId'       => $roomId,
                'memberId'     => $memberId,
                'memberSecret' => $secret,
                'nickname'     => $nickname,
                'isHost'       => true,
                'slot'         => 0,
                'maxSlots'     => (int) $cfg['maxSlots'],
                'joinUrl'      => $base . '?room=' . $roomId,
            ]);
        }

        case 'join': {
            $in = body();
            $roomId = preg_replace('/[^a-zA-Z0-9]/', '', (string) ($in['roomId'] ?? ''));
            $nickname = cleanNickname($in);
            if ($roomId === '' || $nickname === '') {
                out(['error' => 'roomId and nickname required'], 400);
            }
            if (rateLimited($_SERVER['REMOTE_ADDR'] ?? 'x', 'join', $now)) {
                out(['error' => 'too many requests'], 429);
            }
            $cfg = loadConfig();
            $pdo = db();
            housekeep($now);

            $stmt = $pdo->prepare('SELECT * FROM rooms WHERE room_id = ?');
            $stmt->execute([$roomId]);
            $room = $stmt->fetch();
            if (!$room) {
                out(['error' => 'room not found'], 404);
            }
            if ($room['closed_at'] !== null) {
                out(['error' => 'room closed'], 410);
            }
            if (count(liveMembers($roomId, $now)) >= (int) $cfg['maxSlots']) {
                out(['error' => 'room full'], 409);
            }
            $slot = findFreeSlot($roomId, (int) $cfg['maxSlots']);
            if ($slot < 0) {
                out(['error' => 'room full'], 409);
            }

            $memberId = bin2hex(random_bytes(12));
            $secret = bin2hex(random_bytes(16));
            $pdo->prepare('INSERT INTO members (member_id, room_id, nickname, secret, is_host, slot, joined_at, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
                ->execute([$memberId, $roomId, $nickname, $secret, $slot, $now, $now]);
            addEvent($roomId, 'member_joined', ['nickname' => $nickname, 'slot' => $slot]);

            $membersOut = [];
            foreach (liveMembers($roomId, $now) as $m) {
                $membersOut[] = [
                    'memberId' => $m['member_id'],
                    'nickname' => $m['nickname'],
                    'isHost'   => (bool) $m['is_host'],
                    'slot'     => (int) $m['slot'],
                    'speaking' => (bool) $m['speaking'],
                    'isYou'    => $m['member_id'] === $memberId,
                ];
            }

            out([
                'roomId'       => $roomId,
                'memberId'     => $memberId,
                'memberSecret' => $secret,
                'nickname'     => $nickname,
                'isHost'       => false,
                'slot'         => $slot,
                'members'      => $membersOut,
            ]);
        }

        case 'poll': {
            $in = body();
            $member = authMember($in);
            if ($member['closed_at'] !== null) {
                $stmt = db()->prepare('SELECT file FROM sessions WHERE room_id = ? ORDER BY session_id DESC LIMIT 1');
                $stmt->execute([$member['room_id']]);
                $file = $stmt->fetchColumn();
                out([
                    'status'      => 'closed',
                    'sessionFile' => $file !== false ? basename((string) $file) : null,
                    'reason'      => 'room_closed',
                ]);
            }
            $since = max(0, (int) ($in['since'] ?? 0));
            $sinceChat = max(0, (int) ($in['sinceChat'] ?? 0));
            $speaking = !empty($in['speaking']);

            $pdo = db();
            $pdo->prepare('UPDATE members SET last_seen = ?, speaking = ? WHERE member_id = ?')
                ->execute([$now, $speaking ? 1 : 0, $member['member_id']]);
            housekeep($now);

            $membersOut = [];
            foreach (liveMembers((string) $member['room_id'], $now) as $m) {
                $membersOut[] = [
                    'memberId' => $m['member_id'],
                    'nickname' => $m['nickname'],
                    'isHost'   => (bool) $m['is_host'],
                    'slot'     => (int) $m['slot'],
                    'speaking' => (bool) $m['speaking'],
                    'isYou'    => $m['member_id'] === $member['member_id'],
                ];
            }

            $stmt = db()->prepare('SELECT event_id, type, payload FROM events WHERE room_id = ? AND event_id > ? ORDER BY event_id ASC');
            $stmt->execute([$member['room_id'], $since]);
            $events = [];
            $lastEvent = $since;
            foreach ($stmt->fetchAll() as $e) {
                $events[] = ['id' => (int) $e['event_id'], 'type' => $e['type'], 'payload' => json_decode((string) $e['payload'], true)];
                $lastEvent = (int) $e['event_id'];
            }

            $stmt = db()->prepare('SELECT chat_id, member_id, nickname, text FROM chat WHERE room_id = ? AND chat_id > ? ORDER BY chat_id ASC');
            $stmt->execute([$member['room_id'], $sinceChat]);
            $chats = [];
            $lastChat = $sinceChat;
            foreach ($stmt->fetchAll() as $c) {
                $chats[] = ['id' => (int) $c['chat_id'], 'memberId' => $c['member_id'], 'nickname' => $c['nickname'], 'text' => $c['text']];
                $lastChat = (int) $c['chat_id'];
            }

            $recStmt = db()->prepare('SELECT COUNT(*) c FROM members WHERE room_id = ? AND media = 1 AND last_seen >= ?');
            $recStmt->execute([$member['room_id'], $now - STALE_MS]);
            $recording = ((int) $recStmt->fetchColumn()) > 0;

            out([
                'status'      => 'ok',
                'members'     => $membersOut,
                'events'      => $events,
                'lastEventId' => $lastEvent,
                'chats'       => $chats,
                'lastChatId'  => $lastChat,
                'recording'   => $recording,
            ]);
        }

        case 'media_attach': {
            $in = body();
            $member = authMember($in);
            if ($member['closed_at'] !== null) {
                out(['error' => 'room closed'], 410);
            }
            $offerSdp = (string) ($in['offerSdp'] ?? '');
            if (strlen($offerSdp) < 40 || strpos($offerSdp, 'v=0') !== 0) {
                out(['error' => 'offerSdp required'], 400);
            }
            $resp = sfuCall('/attach', [
                'roomId'   => $member['room_id'],
                'memberId' => $member['member_id'],
                'slot'     => (int) $member['slot'],
                'offerSdp' => $offerSdp,
            ]);
            if (!$resp || empty($resp['answerSdp'])) {
                out(['error' => 'media service unavailable'], 503);
            }
            db()->prepare('UPDATE members SET media = 1 WHERE member_id = ?')->execute([$member['member_id']]);
            out(['answerSdp' => $resp['answerSdp']]);
        }

        case 'chat': {
            $in = body();
            $member = authMember($in);
            if ($member['closed_at'] !== null) {
                out(['error' => 'room closed'], 410);
            }
            $text = mb_substr(trim((string) ($in['text'] ?? '')), 0, CHAT_MAXLEN);
            if ($text === '') {
                out(['error' => 'empty message'], 400);
            }
            db()->prepare('INSERT INTO chat (room_id, member_id, nickname, text, created_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([$member['room_id'], $member['member_id'], $member['nickname'], $text, $now]);
            out(['ok' => true]);
        }

        case 'heartbeat': {
            $in = body();
            $member = authMember($in);
            db()->prepare('UPDATE members SET last_seen = ? WHERE member_id = ?')->execute([$now, $member['member_id']]);
            out(['ok' => true]);
        }

        case 'leave': {
            $in = body();
            $memberId = (string) ($in['memberId'] ?? $_GET['memberId'] ?? '');
            $secret = (string) ($in['memberSecret'] ?? $_GET['memberSecret'] ?? '');
            if (validToken($memberId) && validToken($secret)) {
                $stmt = db()->prepare(
                    'SELECT m.*, r.closed_at FROM members m JOIN rooms r ON r.room_id = m.room_id WHERE m.member_id = ?'
                );
                $stmt->execute([$memberId]);
                $member = $stmt->fetch();
                if ($member && hash_equals((string) $member['secret'], $secret) && $member['closed_at'] === null) {
                    sfuDetach((string) $member['room_id'], $memberId);
                    db()->prepare('DELETE FROM members WHERE member_id = ?')->execute([$memberId]);
                    addEvent((string) $member['room_id'], 'member_left', ['nickname' => $member['nickname'], 'reason' => 'left']);

                    $left = db()->prepare('SELECT COUNT(*) FROM members WHERE room_id = ?');
                    $left->execute([$member['room_id']]);
                    if ((int) $left->fetchColumn() === 0) {
                        db()->prepare('UPDATE rooms SET closed_at = ? WHERE room_id = ?')->execute([$now, $member['room_id']]);
                        addEvent((string) $member['room_id'], 'room_closed', ['reason' => 'empty']);
                        out(['ok' => true, 'session' => finalizeSession((string) $member['room_id'])]);
                    }
                }
            }
            out(['ok' => true]);
        }

        case 'end_room': {
            $in = body();
            $member = authMember($in);
            if (!$member['is_host']) {
                out(['error' => 'host only'], 403);
            }
            if ($member['closed_at'] !== null) {
                out(['ok' => true, 'session' => null]);
            }
            db()->prepare('UPDATE rooms SET closed_at = ? WHERE room_id = ?')->execute([$now, $member['room_id']]);

            foreach (liveMembers((string) $member['room_id'], $now) as $m) {
                sfuDetach((string) $member['room_id'], (string) $m['member_id']);
            }
            addEvent((string) $member['room_id'], 'room_closed', ['reason' => 'host_ended']);
            out(['ok' => true, 'session' => finalizeSession((string) $member['room_id'])]);
        }

        case 'sessions': {
            $list = [];
            $stmt = db()->query('SELECT room_id, file, format, started_at, ended_at, size_bytes FROM sessions ORDER BY session_id DESC LIMIT 200');
            foreach ($stmt->fetchAll() as $s) {
                $list[] = [
                    'roomId'      => $s['room_id'],
                    'file'        => $s['file'],
                    'format'      => $s['format'],
                    'startedAt'   => (int) $s['started_at'],
                    'endedAt'     => (int) $s['ended_at'],
                    'durationSec' => $s['started_at'] ? intdiv(((int) $s['ended_at']) - ((int) $s['started_at']), 1000) : null,
                    'sizeBytes'   => (int) $s['size_bytes'],
                    'url'         => 'api.php?action=session&file=' . rawurlencode((string) $s['file']),
                ];
            }
            out(['sessions' => $list]);
        }

        case 'session': {
            $file = basename((string) ($_GET['file'] ?? ''));
            if ($file === '' || !preg_match('/^[a-zA-Z0-9._-]+\.ogg$/', $file)) {
                out(['error' => 'bad file name'], 400);
            }
            $cfg = loadConfig();
            $path = (string) $cfg['finalDir'] . '/' . $file;
            if (!is_file($path)) {
                out(['error' => 'not found'], 404);
            }
            $size = (int) filesize($path);
            $start = 0;
            $end = $size - 1;
            if (isset($_SERVER['HTTP_RANGE']) && preg_match('/bytes=(\d*)-(\d*)/', $_SERVER['HTTP_RANGE'], $m)) {
                if ($m[1] !== '') {
                    $start = (int) $m[1];
                }
                if ($m[2] !== '') {
                    $end = min((int) $m[2], $size - 1);
                }
                header('HTTP/1.1 206 Partial Content');
                header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
            } else {
                header('Accept-Ranges: bytes');
            }
            header('Content-Type: audio/ogg');
            header('Content-Length: ' . ($end - $start + 1));
            header('Content-Disposition: inline; filename="' . $file . '"');
            $fh = fopen($path, 'rb');
            fseek($fh, $start);
            $remaining = $end - $start + 1;
            while ($remaining > 0 && !feof($fh)) {
                $chunk = fread($fh, min(65536, $remaining));
                if ($chunk === false) {
                    break;
                }
                echo $chunk;
                $remaining -= strlen($chunk);
            }
            fclose($fh);
            exit;
        }

        default:
            out(['error' => 'unknown action'], 404);
    }
} catch (Throwable $e) {
    out(['error' => 'server error', 'detail' => $e->getMessage()], 500);
}
