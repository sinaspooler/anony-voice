<?php
/**
 * VoiceLoop API — matchmaking, WebRTC signaling relay and text chat for
 * two anonymous voice-chat clients.
 *
 * Storage: SQLite at data/voice.db (auto-created; web access blocked via
 * data/.htaccess). All state is ephemeral by design — nothing about the
 * callers is stored beyond the live session.
 *
 * Actions:
 *   join       POST  {clientId}                        -> matchmaking (see below)
 *   poll       GET   ?clientId&since                   -> heartbeat + status + new messages
 *   signal     POST  {clientId, data:"<json>"}         -> queue a WebRTC offer/answer/ICE candidate
 *   chat       POST  {clientId, text}                  -> queue a chat message
 *   heartbeat  POST  {clientId}                        -> keep-alive (sent from a Web Worker)
 *   leave      POST  {clientId}                        -> tear down own session (also used by sendBeacon)
 *
 * Roles: when two clients are paired, the joiner becomes the pair's "b" side
 * and always sends the WebRTC offer; the client who was waiting first ("a")
 * answers. Deterministic roles mean the two sides can never both send offers.
 */

declare(strict_types=1);

const STALE_MS    = 10000; // no heartbeat for this long => client counts as gone
const CLEANUP_MS  = 60000; // purge client rows unseen for this long
const MSG_TTL_SEC = 3600;  // purge messages older than this
const CHAT_MAXLEN = 2000;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, must-revalidate');

function out(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

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
        CREATE TABLE IF NOT EXISTS clients (
            id        TEXT PRIMARY KEY,
            status    TEXT NOT NULL DEFAULT 'waiting',
            pair_id   TEXT,
            last_seen INTEGER NOT NULL
        )
    SQL);
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS pairs (
            id         TEXT PRIMARY KEY,
            a_id       TEXT NOT NULL,
            b_id       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    SQL);
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_id    TEXT NOT NULL,
            sender_id  TEXT NOT NULL,
            kind       TEXT NOT NULL,
            payload    TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    SQL);
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (pair_id, id)');
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

function validId(string $id): bool {
    return preg_match('/^[A-Za-z0-9_-]{8,64}$/', $id) === 1;
}

/** Delete everything that is clearly dead: forgotten tabs, broken pairs, old messages. */
function housekeep(PDO $pdo, int $now): void {
    $pdo->prepare('DELETE FROM clients WHERE last_seen < ?')->execute([$now - CLEANUP_MS]);

    // a pair is dead as soon as either member is gone or stale
    $pdo->prepare(
        'DELETE FROM pairs
         WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = pairs.a_id AND c.last_seen >= ?)
            OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = pairs.b_id AND c.last_seen >= ?)'
    )->execute([$now - STALE_MS, $now - STALE_MS]);

    // anyone still marked paired whose pair vanished is parked out of the queue;
    // they re-enter it explicitly by calling join again from the UI
    $pdo->exec(
        "UPDATE clients SET status = 'idle', pair_id = NULL
         WHERE status = 'paired' AND pair_id IS NOT NULL
           AND pair_id NOT IN (SELECT id FROM pairs)"
    );

    $pdo->prepare('DELETE FROM messages WHERE created_at < ?')->execute([$now - MSG_TTL_SEC * 1000]);
}

$action = $_REQUEST['action'] ?? '';
$now = (int) round(microtime(true) * 1000);

try {
    switch ($action) {
        case 'join': {
            $in = body();
            $id = (string) ($in['clientId'] ?? '');
            if (!validId($id)) {
                out(['error' => 'invalid clientId'], 400);
            }
            $pdo = db();
            housekeep($pdo, $now);

            // BEGIN IMMEDIATE serializes matchmaking: two simultaneous joins
            // can never claim the same waiting partner or double-pair.
            $pdo->exec('BEGIN IMMEDIATE');
            try {
                // wipe leftovers from this client's previous session (page refresh etc.)
                $pdo->prepare('DELETE FROM pairs WHERE a_id = ? OR b_id = ?')->execute([$id, $id]);
                $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([$id]);

                $stmt = $pdo->prepare(
                    "SELECT id FROM clients
                     WHERE status = 'waiting' AND id <> ? AND last_seen >= ?
                     ORDER BY last_seen ASC LIMIT 1"
                );
                $stmt->execute([$id, $now - STALE_MS]);
                $partner = $stmt->fetchColumn();

                if ($partner !== false) {
                    $pairId = bin2hex(random_bytes(8));
                    $pdo->prepare('INSERT INTO pairs (id, a_id, b_id, created_at) VALUES (?, ?, ?, ?)')
                        ->execute([$pairId, $partner, $id, $now]);
                    $pdo->prepare("UPDATE clients SET status = 'paired', pair_id = ? WHERE id = ?")
                        ->execute([$pairId, $partner]);
                    $pdo->prepare("INSERT INTO clients (id, status, pair_id, last_seen) VALUES (?, 'paired', ?, ?)")
                        ->execute([$id, $pairId, $now]);
                    $pdo->exec('COMMIT');
                    out(['status' => 'paired', 'pairId' => $pairId, 'role' => 'initiator', 'partnerId' => $partner]);
                }

                $pdo->prepare("INSERT INTO clients (id, status, pair_id, last_seen) VALUES (?, 'waiting', NULL, ?)")
                    ->execute([$id, $now]);
                $pdo->exec('COMMIT');
                out(['status' => 'waiting']);
            } catch (Throwable $e) {
                $pdo->exec('ROLLBACK');
                throw $e;
            }
        }

        case 'poll': {
            $id = (string) ($_GET['clientId'] ?? '');
            if (!validId($id)) {
                out(['error' => 'invalid clientId'], 400);
            }
            $since = max(0, (int) ($_GET['since'] ?? 0));
            $pdo = db();

            // this poll doubles as the in-page heartbeat
            $pdo->prepare('UPDATE clients SET last_seen = ? WHERE id = ?')->execute([$now, $id]);

            $stmt = $pdo->prepare('SELECT status, pair_id FROM clients WHERE id = ?');
            $stmt->execute([$id]);
            $me = $stmt->fetch();
            if (!$me) {
                out(['status' => 'idle']);
            }
            if ($me['status'] === 'waiting') {
                out(['status' => 'waiting']);
            }
            if ($me['status'] !== 'paired' || !is_string($me['pair_id'])) {
                out(['status' => 'idle']);
            }

            $stmt = $pdo->prepare('SELECT id, a_id, b_id FROM pairs WHERE id = ?');
            $stmt->execute([$me['pair_id']]);
            $pair = $stmt->fetch();
            if (!$pair) {
                $pdo->prepare("UPDATE clients SET status = 'idle', pair_id = NULL WHERE id = ?")->execute([$id]);
                out(['status' => 'ended', 'reason' => 'partner_left']);
            }

            $partnerId = $pair['a_id'] === $id ? $pair['b_id'] : $pair['a_id'];
            $role = $pair['b_id'] === $id ? 'initiator' : 'responder';

            $stmt = $pdo->prepare('SELECT last_seen FROM clients WHERE id = ?');
            $stmt->execute([$partnerId]);
            $partnerSeen = $stmt->fetchColumn();
            if ($partnerSeen === false || (int) $partnerSeen < $now - STALE_MS) {
                $pdo->prepare('DELETE FROM pairs WHERE id = ?')->execute([$pair['id']]);
                $pdo->prepare("UPDATE clients SET status = 'idle', pair_id = NULL WHERE id = ?")->execute([$id]);
                out(['status' => 'ended', 'reason' => 'partner_left']);
            }

            $stmt = $pdo->prepare(
                'SELECT id, kind, payload FROM messages
                 WHERE pair_id = ? AND sender_id = ? AND id > ?
                 ORDER BY id ASC'
            );
            $stmt->execute([$pair['id'], $partnerId, $since]);
            $messages = [];
            $last = $since;
            foreach ($stmt->fetchAll() as $m) {
                $messages[] = ['id' => (int) $m['id'], 'kind' => $m['kind'], 'payload' => $m['payload']];
                $last = (int) $m['id'];
            }
            out([
                'status'    => 'paired',
                'role'      => $role,
                'partnerId' => $partnerId,
                'messages'  => $messages,
                'lastMsgId' => $last,
            ]);
        }

        case 'signal':
        case 'chat': {
            $in = body();
            $id = (string) ($in['clientId'] ?? '');
            if (!validId($id)) {
                out(['error' => 'invalid clientId'], 400);
            }
            $pdo = db();

            $stmt = $pdo->prepare('SELECT id FROM pairs WHERE a_id = ? OR b_id = ?');
            $stmt->execute([$id, $id]);
            $pairId = $stmt->fetchColumn();
            if ($pairId === false) {
                out(['error' => 'not in a call'], 409);
            }

            if ($action === 'signal') {
                $payload = (string) ($in['data'] ?? '');
                json_decode($payload);
                if (json_last_error() !== JSON_ERROR_NONE) {
                    out(['error' => 'signal payload must be a JSON string'], 400);
                }
            } else {
                $payload = mb_substr(trim((string) ($in['text'] ?? '')), 0, CHAT_MAXLEN);
                if ($payload === '') {
                    out(['error' => 'empty message'], 400);
                }
            }

            $pdo->prepare('INSERT INTO messages (pair_id, sender_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
                ->execute([$pairId, $id, $action, $payload, $now]);
            out(['ok' => true, 'id' => (int) $pdo->lastInsertId()]);
        }

        case 'heartbeat': {
            $in = body();
            $id = (string) ($in['clientId'] ?? '');
            if (!validId($id)) {
                out(['error' => 'invalid clientId'], 400);
            }
            $pdo = db();
            $pdo->prepare('UPDATE clients SET last_seen = ? WHERE id = ?')->execute([$now, $id]);
            out(['ok' => true]);
        }

        case 'leave': {
            $in = body();
            $id = (string) ($in['clientId'] ?? $_GET['clientId'] ?? '');
            if (validId($id)) {
                $pdo = db();
                $pdo->prepare('DELETE FROM pairs WHERE a_id = ? OR b_id = ?')->execute([$id, $id]);
                $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([$id]);
            }
            out(['ok' => true]);
        }

        default:
            out(['error' => 'unknown action'], 404);
    }
} catch (Throwable $e) {
    out(['error' => 'server error', 'detail' => $e->getMessage()], 500);
}
