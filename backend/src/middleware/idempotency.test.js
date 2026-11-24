const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp() {
  const store = new Map();
  const deletes = [];
  const db = {
    query: async (text, params) => {
      const id = `${params[0]}:${params[1]}`;
      if (text.includes('INSERT INTO idempotency_keys')) {
        if (store.has(id)) return { rows: [] };
        store.set(id, { request_hash: params[4], completed_at: null, created_at: new Date() });
        return { rows: [{ user_id: params[0] }] };
      }
      if (text.includes('SELECT request_hash')) {
        return { rows: store.has(id) ? [store.get(id)] : [] };
      }
      if (text.includes('UPDATE idempotency_keys')) {
        Object.assign(store.get(id), {
          response_status: params[2],
          response_body: JSON.parse(params[3]),
          completed_at: new Date(),
        });
        return { rows: [] };
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        deletes.push(id);
        store.delete(id);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const { idempotency } = proxyquire('./idempotency', {
    '../config/database': db,
    '../config/logger': { error: () => {} },
  });

  let calls = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 'user-1' };
    next();
  });
  app.post('/things', idempotency, (req, res) => {
    calls += 1;
    if (req.body.fail) return res.status(400).json({ error: 'bad' });
    res.status(201).json({ id: `thing-${calls}` });
  });
  app.post('/text', idempotency, (req, res) => {
    calls += 1;
    res.status(200).type('text/plain').send(`text-${calls}`);
  });
  app.post('/empty', idempotency, (req, res) => {
    calls += 1;
    res.sendStatus(204);
  });
  app.post('/hang', idempotency, () => {
    calls += 1; // never answers: the client gives up
  });
  return { app, store, deletes, getCalls: () => calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('replays the stored response for a repeated Idempotency-Key', async () => {
  const { app, getCalls } = buildApp();
  const first = await request(app).post('/things').set('Idempotency-Key', 'k1').send({ a: 1 });
  await flush();
  const second = await request(app).post('/things').set('Idempotency-Key', 'k1').send({ a: 1 });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(getCalls(), 1);
});

test('rejects reuse of a key with a different body', async () => {
  const { app } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'k2').send({ a: 1 });
  await flush();
  const res = await request(app).post('/things').set('Idempotency-Key', 'k2').send({ a: 2 });
  assert.equal(res.status, 422);
});

test('does not store non-2xx responses so the client can retry', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'k3').send({ fail: true });
  await flush();
  const res = await request(app).post('/things').set('Idempotency-Key', 'k3').send({ fail: true });
  assert.equal(res.status, 400);
  assert.equal(getCalls(), 2);
});

test('runs normally without an Idempotency-Key header', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things').send({});
  await request(app).post('/things').send({});
  assert.equal(getCalls(), 2);
});

// ── #389: text and empty 2xx responses are stored and replayed ──────────────

test('a text 2xx response is replayed instead of re-running the handler (#389)', async () => {
  const { app, getCalls } = buildApp();
  const first = await request(app).post('/text').set('Idempotency-Key', 't1').send({ a: 1 });
  await flush();
  const second = await request(app).post('/text').set('Idempotency-Key', 't1').send({ a: 1 });
  assert.equal(first.text, 'text-1');
  assert.equal(second.status, 200);
  assert.equal(second.text, 'text-1');
  assert.match(second.headers['content-type'], /text\/plain/);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(getCalls(), 1);
});

test('an empty 2xx response is replayed instead of re-running the handler (#389)', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/empty').set('Idempotency-Key', 'e1').send({});
  await flush();
  const second = await request(app).post('/empty').set('Idempotency-Key', 'e1').send({});
  assert.equal(second.status, 204);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(getCalls(), 1);
});

// ── #390: equivalent requests hash the same ──────────────────────────────────

test('reordered JSON keys and query parameters are the same request (#390)', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things?b=2&a=1').set('Idempotency-Key', 'o1').send({ x: 1, y: { p: 1, q: 2 } });
  await flush();
  const second = await request(app)
    .post('/things?a=1&b=2')
    .set('Idempotency-Key', 'o1')
    .send({ y: { q: 2, p: 1 }, x: 1 });
  assert.equal(second.status, 201);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(getCalls(), 1);
});

test('a genuinely different body is still rejected (#390)', async () => {
  const { app } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'o2').send({ x: 1 });
  await flush();
  const res = await request(app).post('/things').set('Idempotency-Key', 'o2').send({ x: 2 });
  assert.equal(res.status, 422);
});

test('canonical hashing helpers', () => {
  const { canonicalJson, canonicalUrl } = proxyquire('./idempotency', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../config/logger': { error: () => {} },
  });
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
  assert.equal(canonicalUrl('/x?b=2&a=3&a=1'), '/x?a=1&a=3&b=2');
  assert.equal(canonicalUrl('/x'), '/x');
});

// ── #388: aborted requests and stale keys never lock a key forever ──────────

test('a client disconnect frees the key (#388)', async () => {
  const { app, store, deletes } = buildApp();
  const server = app.listen(0);
  const { port } = server.address();
  await new Promise((resolve) => {
    const req = require('http').request(
      {
        port,
        method: 'POST',
        path: '/hang',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'h1' },
      },
      () => {}
    );
    req.on('error', () => resolve());
    req.end('{}');
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 100);
  });
  for (let i = 0; i < 40 && !deletes.includes('user-1:h1'); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  server.close();
  assert.ok(deletes.includes('user-1:h1'), 'aborted request left the key locked');
  assert.equal(store.has('user-1:h1'), false);
});

test('a stale in-progress key is reclaimed after the lock TTL (#388)', async () => {
  const { app, store, getCalls } = buildApp();
  store.set('user-1:s1', {
    request_hash: 'whatever',
    completed_at: null,
    created_at: new Date(Date.now() - 60 * 60 * 1000),
  });
  const res = await request(app).post('/things').set('Idempotency-Key', 's1').send({ a: 1 });
  assert.equal(res.status, 201);
  assert.equal(getCalls(), 1);
});

test('a fresh in-progress key still returns 409 (#388)', async () => {
  const { app, store } = buildApp();
  const { hashRequest } = proxyquire('./idempotency', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../config/logger': { error: () => {} },
  });
  const sameRequest = { method: 'POST', originalUrl: '/things', body: { a: 1 } };
  store.set('user-1:s2', {
    request_hash: hashRequest(sameRequest),
    completed_at: null,
    created_at: new Date(),
  });
  const res = await request(app).post('/things').set('Idempotency-Key', 's2').send({ a: 1 });
  assert.equal(res.status, 409);
});

test('a completed key past retention runs the request again (#388)', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'r1').send({ a: 1 });
  await flush();
  process.env.IDEMPOTENCY_RETENTION_MS = '1';
  try {
    await new Promise((r) => setTimeout(r, 10));
    const res = await request(app).post('/things').set('Idempotency-Key', 'r1').send({ a: 1 });
    assert.equal(res.status, 201);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    assert.equal(getCalls(), 2);
  } finally {
    delete process.env.IDEMPOTENCY_RETENTION_MS;
  }
});

test('purgeExpiredIdempotencyKeys deletes expired and abandoned rows (#388)', async () => {
  const seen = [];
  const { purgeExpiredIdempotencyKeys } = proxyquire('./idempotency', {
    '../config/database': {
      query: async (text, params) => {
        seen.push({ text, params });
        return { rowCount: 3 };
      },
    },
    '../config/logger': { error: () => {} },
  });
  assert.equal(await purgeExpiredIdempotencyKeys(), 3);
  assert.match(seen[0].text, /completed_at IS NOT NULL AND completed_at </);
  assert.match(seen[0].text, /completed_at IS NULL AND created_at </);
  assert.deepEqual(seen[0].params, [86_400_000, 300_000]);
});
