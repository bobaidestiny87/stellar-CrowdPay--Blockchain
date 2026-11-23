const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const {
  sendErrorResponse,
  normalizeErrorResponse,
  errorHandler,
} = require('./errorHandler');

function buildApp(register) {
  const app = express();
  app.use(normalizeErrorResponse);
  register(app);
  app.use(errorHandler);
  return app;
}

test('sendErrorResponse sends { error: { code, message, fields } } with a status-derived code', async () => {
  const app = buildApp((a) => {
    a.get('/x', (req, res) => sendErrorResponse(res, 404, 'Campaign not found'));
    a.get('/y', (req, res) =>
      sendErrorResponse(res, 422, 'Bad amount', { amount: 'Bad amount' })
    );
  });

  const notFound = await request(app).get('/x');
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, {
    error: { code: 'NOT_FOUND', message: 'Campaign not found' },
  });

  const invalid = await request(app).get('/y');
  assert.deepEqual(invalid.body, {
    error: { code: 'VALIDATION_ERROR', message: 'Bad amount', fields: { amount: 'Bad amount' } },
  });
});

test('sendErrorResponse supports a custom code and extra top-level keys', async () => {
  const app = buildApp((a) => {
    a.get('/x', (req, res) =>
      sendErrorResponse(res, 503, 'Try later', undefined, 'CIRCUIT_OPEN', { retryable: true })
    );
  });
  const res = await request(app).get('/x');
  assert.deepEqual(res.body, {
    retryable: true,
    error: { code: 'CIRCUIT_OPEN', message: 'Try later' },
  });
});

test('normalizeErrorResponse coerces legacy shapes into the envelope with a status-derived code', async () => {
  const app = buildApp((a) => {
    a.get('/string', (req, res) => res.status(409).json({ error: 'Already exists', detail: 'x' }));
    a.get('/nocode', (req, res) => res.status(403).json({ error: { message: 'Nope' } }));
    a.get('/bare', (req, res) => res.status(400).json({ message: 'odd' }));
  });

  const s = await request(app).get('/string');
  assert.deepEqual(s.body, { detail: 'x', error: { code: 'CONFLICT', message: 'Already exists' } });

  const n = await request(app).get('/nocode');
  assert.deepEqual(n.body, { error: { code: 'FORBIDDEN', message: 'Nope' } });

  const b = await request(app).get('/bare');
  assert.equal(b.body.error.code, 'BAD_REQUEST');
  assert.equal(typeof b.body.error.message, 'string');
});

test('normalizeErrorResponse coerces res.send with a string or Buffer body', async () => {
  const app = buildApp((a) => {
    a.get('/text', (req, res) => res.status(400).send('bad'));
    a.get('/buffer', (req, res) => res.status(502).send(Buffer.from('upstream down')));
    a.get('/json-text', (req, res) =>
      res.status(409).type('json').send(JSON.stringify({ error: 'Duplicate', id: 7 }))
    );
    a.get('/object', (req, res) => res.status(403).send({ error: 'Nope' }));
  });

  const text = await request(app).get('/text');
  assert.equal(text.status, 400);
  assert.match(text.headers['content-type'], /application\/json/);
  assert.deepEqual(text.body, { error: { code: 'BAD_REQUEST', message: 'bad' } });

  const buf = await request(app).get('/buffer');
  assert.equal(buf.status, 502);
  assert.deepEqual(buf.body, { error: { code: 'BAD_GATEWAY', message: 'upstream down' } });

  const jsonText = await request(app).get('/json-text');
  assert.deepEqual(jsonText.body, { id: 7, error: { code: 'CONFLICT', message: 'Duplicate' } });

  const obj = await request(app).get('/object');
  assert.deepEqual(obj.body, { error: { code: 'FORBIDDEN', message: 'Nope' } });
});

test('normalizeErrorResponse coerces res.sendStatus', async () => {
  const app = buildApp((a) => {
    a.get('/404', (req, res) => res.sendStatus(404));
    a.get('/503', (req, res) => res.sendStatus(503));
  });

  const notFound = await request(app).get('/404');
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers['content-type'], /application\/json/);
  assert.deepEqual(notFound.body, { error: { code: 'NOT_FOUND', message: 'Not Found' } });

  const unavailable = await request(app).get('/503');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, {
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable' },
  });
});

test('normalizeErrorResponse coerces res.end with and without a chunk', async () => {
  let callbackCalled = false;
  const app = buildApp((a) => {
    a.get('/empty', (req, res) => res.status(401).end());
    a.get('/chunk', (req, res) => res.status(500).end('boom', 'utf8'));
    a.get('/callback', (req, res) => {
      res.status(429).end(() => {
        callbackCalled = true;
      });
    });
  });

  const empty = await request(app).get('/empty');
  assert.equal(empty.status, 401);
  assert.match(empty.headers['content-type'], /application\/json/);
  assert.deepEqual(empty.body, { error: { code: 'UNAUTHORIZED', message: 'Request failed' } });

  const chunk = await request(app).get('/chunk');
  assert.equal(chunk.status, 500);
  assert.deepEqual(chunk.body, { error: { code: 'INTERNAL_ERROR', message: 'boom' } });

  const cb = await request(app).get('/callback');
  assert.equal(cb.status, 429);
  assert.deepEqual(cb.body, { error: { code: 'TOO_MANY_REQUESTS', message: 'Request failed' } });
  assert.equal(callbackCalled, true);
});

test('normalizeErrorResponse leaves successful and already-enveloped responses untouched', async () => {
  const app = buildApp((a) => {
    a.get('/ok-text', (req, res) => res.send('hello'));
    a.get('/ok-status', (req, res) => res.sendStatus(204));
    a.get('/ok-end', (req, res) => res.status(200).end('raw'));
    a.get('/coded', (req, res) =>
      res.status(422).send({ error: { code: 'CUSTOM', message: 'kept', fields: { a: 'b' } } })
    );
  });

  const okText = await request(app).get('/ok-text');
  assert.equal(okText.status, 200);
  assert.match(okText.headers['content-type'], /text\/html/);
  assert.equal(okText.text, 'hello');

  const okStatus = await request(app).get('/ok-status');
  assert.equal(okStatus.status, 204);

  const okEnd = await request(app).get('/ok-end');
  assert.equal(okEnd.text, 'raw');

  const coded = await request(app).get('/coded');
  assert.deepEqual(coded.body, { error: { code: 'CUSTOM', message: 'kept', fields: { a: 'b' } } });
});

test('errorHandler sends the envelope for thrown errors', async () => {
  const app = buildApp((a) => {
    a.get('/boom', () => {
      const err = new Error('Invalid amount');
      err.status = 422;
      throw err;
    });
  });
  const res = await request(app).get('/boom');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { error: { code: 'VALIDATION_ERROR', message: 'Invalid amount' } });
});

test('no route or middleware sends a bare-string or code-less error body', () => {
  // Every failure must go through sendErrorResponse (or next(err)) so clients
  // can rely on error.code. This guards against regressions in new code.
  const srcDir = path.join(__dirname, '..');
  const files = [
    ...fs.readdirSync(path.join(srcDir, 'routes')).map((f) => path.join(srcDir, 'routes', f)),
    ...fs.readdirSync(path.join(srcDir, 'middleware')).map((f) => path.join(srcDir, 'middleware', f)),
    path.join(srcDir, 'index.js'),
  ].filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith('errorHandler.js'));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\.json\(\s*\{\s*errors?\s*:(?!\s*\{)/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(srcDir, file)}:${line}`);
    }
    // Structured errors written by hand must still carry a code.
    const structured = /\.json\(\s*\{\s*error\s*:\s*\{([^}]*)\}/g;
    while ((m = structured.exec(src))) {
      if (!/\bcode\s*:/.test(m[1])) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(srcDir, file)}:${line} (missing code)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `use sendErrorResponse instead:\n${offenders.join('\n')}`);
});

function throwing(props, message) {
  return () => {
    const err = new Error(message);
    Object.assign(err, props);
    throw err;
  };
}

test('errorHandler never exposes Postgres SQLSTATEs or driver messages (#393)', async () => {
  const leak = 'duplicate key value violates unique constraint "contributions_tx_hash_key"';
  const app = buildApp((a) => {
    a.get('/unique', throwing({ code: '23505', constraint: 'contributions_tx_hash_key' }, leak));
    a.get('/fk', throwing({ code: '23503' }, 'insert on table "milestones" violates foreign key'));
    a.get('/data', throwing({ code: '22P02' }, 'invalid input syntax for type uuid: "x"'));
    a.get('/table', throwing({ code: '42P01' }, 'relation "campaign_secrets" does not exist'));
    a.get('/socket', throwing({ code: 'ECONNREFUSED' }, 'connect ECONNREFUSED 10.0.0.5:5432'));
    a.get('/node', throwing({ code: 'ERR_HTTP_HEADERS_SENT' }, 'Cannot set headers'));
  });

  const unique = await request(app).get('/unique');
  assert.equal(unique.status, 409);
  assert.deepEqual(unique.body, {
    error: { code: 'CONFLICT', message: 'Request conflicts with existing data' },
  });

  const fk = await request(app).get('/fk');
  assert.equal(fk.status, 409);
  assert.equal(fk.body.error.code, 'CONFLICT');

  const data = await request(app).get('/data');
  assert.equal(data.status, 400);
  assert.deepEqual(data.body, { error: { code: 'BAD_REQUEST', message: 'Invalid request' } });

  for (const route of ['/table', '/socket', '/node']) {
    const res = await request(app).get(route);
    assert.equal(res.status, 500, route);
    assert.deepEqual(res.body, {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    }, route);
  }

  // Nothing internal in any body, in any environment (NODE_ENV is "test" here).
  for (const route of ['/unique', '/fk', '/data', '/table', '/socket', '/node']) {
    const res = await request(app).get(route);
    for (const fragment of ['23505', '23503', '22P02', '42P01', 'ECONNREFUSED', 'ERR_', 'constraint', 'relation', 'table', '10.0.0.5']) {
      assert.ok(!res.text.includes(fragment), `${route} leaked "${fragment}": ${res.text}`);
    }
  }
});

test('errorHandler keeps an explicit status and our own public codes', async () => {
  const app = buildApp((a) => {
    a.get('/explicit', throwing({ code: '23505', status: 422 }, 'raw'));
    a.get('/own', throwing({ code: 'CIRCUIT_OPEN', status: 503 }, 'Upstream is unavailable'));
    a.get('/cursor', throwing({ code: 'INVALID_CURSOR', status: 400 }, 'Bad cursor'));
  });

  const explicit = await request(app).get('/explicit');
  assert.equal(explicit.status, 422);
  assert.equal(explicit.body.error.code, 'VALIDATION_ERROR');
  assert.ok(!explicit.text.includes('23505'));

  const own = await request(app).get('/own');
  assert.equal(own.status, 503);
  assert.equal(own.body.error.code, 'CIRCUIT_OPEN');

  const cursor = await request(app).get('/cursor');
  assert.deepEqual(cursor.body, { error: { code: 'INVALID_CURSOR', message: 'Bad cursor' } });
});

test('isPublicErrorCode accepts our codes and rejects internal ones', () => {
  const { isPublicErrorCode } = require('./errorHandler');
  for (const code of ['NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'CIRCUIT_OPEN', 'INVALID_CURSOR']) {
    assert.equal(isPublicErrorCode(code), true, code);
  }
  for (const code of ['23505', '42P01', 'XX000', 'ECONNREFUSED', 'ERR_HTTP_HEADERS_SENT', 'P0001', 42, null, undefined]) {
    assert.equal(isPublicErrorCode(code), false, String(code));
  }
});
