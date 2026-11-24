const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN = '3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e';
const BODY = { reason: 'non_delivery', description: 'Never shipped' };

function buildApp({ openDispute = false, insertError = null, disputeStatus = 'open' } = {}) {
  const statements = [];
  const currentStatus = disputeStatus;
  const db = {
    async query(text, params) {
      statements.push(text);
      // PATCH /disputes/:id initial lookup
      if (text.includes('FROM disputes d') && text.includes('JOIN campaigns c')) {
        return { rows: [{ id: '11111111-1111-1111-1111-111111111111', campaign_id: CAMPAIGN, status: currentStatus, raised_by: 'backer-1' }] };
      }
      if (text.includes('FROM campaigns')) return { rows: [{ id: CAMPAIGN, creator_id: 'creator', title: 'C' }] };
      if (text.includes('FROM contributions')) return { rows: [{ id: 'ctr-1' }] };
      if (text.includes('FROM disputes') && text.includes("status IN ('open', 'under_review')")) {
        return { rows: openDispute ? [{ id: 'd-open' }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text) {
          statements.push(text);
          if (text.includes('INSERT INTO disputes')) {
            if (insertError) throw insertError;
            return { rows: [{ id: 'd-new', campaign_id: CAMPAIGN }] };
          }
          if (text.includes('UPDATE disputes') && text.includes('SET status')) {
            return { rows: [{ id: '11111111-1111-1111-1111-111111111111', campaign_id: CAMPAIGN, status: currentStatus }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const router = proxyquire('./disputes', {
    '../config/database': db,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'backer-1' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
    },
    '../services/emailService': { sendEmailSafe: async () => {} },
    '../config/logger': { info() {}, warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return { app, statements };
}

test('a second open dispute from the same contributor is a 409, not a new row', async () => {
  const { app, statements } = buildApp({ openDispute: true });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN}/disputes`).send(BODY);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already have an open dispute/);
  assert.equal(res.body.dispute_id, 'd-open');
  assert.ok(!statements.some((s) => s.includes('INSERT INTO disputes')));
});

test('a unique violation from a concurrent request is mapped to 409 and rolled back', async () => {
  const err = Object.assign(new Error('duplicate key'), { code: '23505' });
  const { app, statements } = buildApp({ insertError: err });
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN}/disputes`).send(BODY);
  assert.equal(res.status, 409);
  assert.ok(statements.includes('ROLLBACK'));
});

test('a first dispute is created', async () => {
  const { app } = buildApp();
  const res = await request(app).post(`/api/campaigns/${CAMPAIGN}/disputes`).send(BODY);
  assert.equal(res.status, 201);
});

test('disputeCreateLimiter caps disputes per user, independently of IP', async () => {
  const { createDisputeCreateLimiter } = require('./disputes');
  const limiter = createDisputeCreateLimiter({ max: 2, windowMs: 60_000, skip: () => false });
  const app = express();
  app.post(
    '/raise',
    (req, _res, next) => {
      req.user = { userId: req.get('x-user') };
      next();
    },
    limiter,
    (_req, res) => res.status(201).json({ ok: true })
  );

  const raise = (user, ip) => request(app).post('/raise').set('x-user', user).set('X-Forwarded-For', ip);
  assert.equal((await raise('u1', '1.1.1.1')).status, 201);
  assert.equal((await raise('u1', '2.2.2.2')).status, 201);
  const third = await raise('u1', '3.3.3.3');
  assert.equal(third.status, 429, 'changing IP does not reset the per-user budget');
  assert.equal(third.body.code, 'TOO_MANY_REQUESTS');
  assert.equal((await raise('u2', '1.1.1.1')).status, 201, 'other users are unaffected');
});

test('PATCH allows open -> under_review', async () => {
  const { app } = buildApp({ disputeStatus: 'open' });
  const res = await request(app).patch(`/api/disputes/11111111-1111-1111-1111-111111111111`).send({ status: 'under_review' });
  assert.equal(res.status, 200);
});

test('PATCH allows under_review -> resolved_creator', async () => {
  const { app } = buildApp({ disputeStatus: 'under_review' });
  const res = await request(app).patch(`/api/disputes/11111111-1111-1111-1111-111111111111`).send({ status: 'resolved_creator' });
  assert.equal(res.status, 200);
});

test('PATCH rejects closed -> open', async () => {
  const { app, statements } = buildApp({ disputeStatus: 'closed' });
  const res = await request(app).patch(`/api/disputes/11111111-1111-1111-1111-111111111111`).send({ status: 'open' });
  assert.equal(res.status, 409);
  assert.ok(!statements.some((s) => s.includes('UPDATE disputes')));
});

test('PATCH rejects open -> closed directly', async () => {
  const { app, statements } = buildApp({ disputeStatus: 'open' });
  const res = await request(app).patch(`/api/disputes/11111111-1111-1111-1111-111111111111`).send({ status: 'closed' });
  assert.equal(res.status, 409);
  assert.ok(!statements.some((s) => s.includes('UPDATE disputes')));
});

test('PATCH rejects terminal resolved_creator -> open', async () => {
  const { app, statements } = buildApp({ disputeStatus: 'resolved_creator' });
  const res = await request(app).patch(`/api/disputes/11111111-1111-1111-1111-111111111111`).send({ status: 'open' });
  assert.equal(res.status, 409);
  assert.ok(!statements.some((s) => s.includes('UPDATE disputes')));
});
