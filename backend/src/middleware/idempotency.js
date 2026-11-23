const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { sendErrorResponse } = require('./errorHandler');

const MAX_KEY_LENGTH = 255;

// An in-progress key older than this is treated as abandoned (crashed or
// aborted handler) and may be reclaimed by a retry (#388).
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
// Completed keys are replayable for this long, then purged (#388).
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

function msFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function lockTtlMs() {
  return msFromEnv('IDEMPOTENCY_LOCK_TTL_MS', DEFAULT_LOCK_TTL_MS);
}

function retentionMs() {
  return msFromEnv('IDEMPOTENCY_RETENTION_MS', DEFAULT_RETENTION_MS);
}

/** JSON with object keys sorted at every level, so key order never matters (#390). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Path plus query parameters sorted by name then value (#390). */
function canonicalUrl(originalUrl) {
  const url = new URL(originalUrl, 'http://localhost');
  const params = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1;
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  const query = new URLSearchParams(params).toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function hashRequest(req) {
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${canonicalUrl(req.originalUrl)}\n${canonicalJson(req.body ?? {})}`)
    .digest('hex');
}

// Non-JSON bodies are stored in this wrapper so they replay unchanged (#389).
const RAW_MARKER = '__idempotency_raw';

function toStoredBody(contentType, text) {
  if (/\bjson\b/i.test(contentType || '') && text) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through: store as text
    }
  }
  return { [RAW_MARKER]: true, content_type: contentType || null, body: text };
}

function replay(res, status, stored) {
  res.set('Idempotent-Replayed', 'true');
  if (stored && typeof stored === 'object' && stored[RAW_MARKER]) {
    res.status(status);
    if (stored.content_type) res.set('Content-Type', stored.content_type);
    return res.end(stored.body || undefined);
  }
  return res.status(status).json(stored);
}

const isOlderThan = (timestamp, ms) =>
  Boolean(timestamp) && Date.now() - new Date(timestamp).getTime() > ms;

/**
 * Honors an optional `Idempotency-Key` header on authenticated POSTs. The first
 * request with a key runs normally and its 2xx response (JSON, text or empty)
 * is stored per user; a replay with the same key and an equivalent request
 * (JSON key order and query-parameter order do not matter) returns that stored
 * response instead of executing the handler again. Non-2xx outcomes and
 * requests the client abandoned are discarded so the client can retry. Stale
 * in-progress keys are reclaimable after IDEMPOTENCY_LOCK_TTL_MS and completed
 * keys expire after IDEMPOTENCY_RETENTION_MS.
 * Must run after requireAuth.
 */
async function idempotency(req, res, next) {
  const key = req.get('idempotency-key');
  const userId = req.user?.userId;
  if (!key || !userId) return next();
  if (key.length > MAX_KEY_LENGTH) {
    return sendErrorResponse(res, 400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
  }

  const requestHash = hashRequest(req);
  const claim = () =>
    db.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING user_id`,
      [userId, key, req.method, req.originalUrl, requestHash]
    );

  try {
    let { rows: inserted } = await claim();

    if (!inserted.length) {
      const { rows } = await db.query(
        `SELECT request_hash, response_status, response_body, completed_at, created_at
         FROM idempotency_keys
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key]
      );
      const existing = rows[0];
      const expired = Boolean(existing) && (existing.completed_at
        ? isOlderThan(existing.completed_at, retentionMs())
        : isOlderThan(existing.created_at, lockTtlMs()));

      if (existing && !expired) {
        if (existing.request_hash !== requestHash) {
          return sendErrorResponse(res, 422, 'Idempotency-Key was already used with a different request');
        }
        if (!existing.completed_at) {
          return sendErrorResponse(res, 409, 'A request with this Idempotency-Key is still in progress');
        }
        return replay(res, existing.response_status, existing.response_body);
      }

      // #388: the previous holder expired (or vanished); reclaim the key.
      if (existing) {
        await db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
      }
      ({ rows: inserted } = await claim());
      if (!inserted.length) {
        return sendErrorResponse(res, 409, 'A request with this Idempotency-Key is still in progress');
      }
    }
  } catch (err) {
    return next(err);
  }

  let settled = false;
  const settle = (status, stored) => {
    if (settled) return;
    settled = true;
    const query = status >= 200 && status < 300
      ? db.query(
        `UPDATE idempotency_keys
         SET response_status = $3, response_body = $4::jsonb, completed_at = NOW()
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key, status, JSON.stringify(stored ?? null)]
      )
      : db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
    query.catch((err) => logger.error('Failed to persist idempotency key', { error: err.message }));
  };

  // #389: every response path (res.json, res.send, res.sendStatus, res.end)
  // finishes through res.end, so capture the final body there.
  let captured = '';
  const originalEnd = res.end;
  res.end = function end(chunk, encoding, cb) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      captured = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    return originalEnd.call(this, chunk, encoding, cb);
  };

  res.on('finish', () => {
    settle(res.statusCode, toStoredBody(res.get('Content-Type'), captured));
  });
  // #388: a client that disconnects before the response finishes must not
  // leave the key locked.
  res.on('close', () => {
    if (!res.writableFinished) settle(0);
  });

  next();
}

/**
 * Delete completed keys past their retention and in-progress keys past the
 * lock TTL (#388). Returns the number of rows removed.
 */
async function purgeExpiredIdempotencyKeys() {
  const { rowCount } = await db.query(
    `DELETE FROM idempotency_keys
     WHERE (completed_at IS NOT NULL AND completed_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
        OR (completed_at IS NULL AND created_at < NOW() - ($2::bigint * INTERVAL '1 millisecond'))`,
    [retentionMs(), lockTtlMs()]
  );
  return rowCount ?? 0;
}

module.exports = {
  idempotency,
  purgeExpiredIdempotencyKeys,
  hashRequest,
  canonicalJson,
  canonicalUrl,
};
