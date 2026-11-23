const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchPublicStats,
  PUBLIC_CAMPAIGN_EXCLUDED_STATUSES,
  PUBLIC_CAMPAIGN_PREDICATE,
} = require('./publicStats');

// Seeded campaigns: only `active` and `funded` are public (#394).
const campaigns = [
  { id: 'c-active', status: 'active', raised_amount: 100, deleted_at: null },
  { id: 'c-funded', status: 'funded', raised_amount: 250, deleted_at: null },
  { id: 'c-draft', status: 'draft', raised_amount: 0, deleted_at: null },
  { id: 'c-failed', status: 'failed', raised_amount: 40, deleted_at: null },
  { id: 'c-refunded', status: 'refunded', raised_amount: 75, deleted_at: null },
  { id: 'c-deleted', status: 'active', raised_amount: 500, deleted_at: new Date() },
];
const contributions = [
  { campaign_id: 'c-active' },
  { campaign_id: 'c-active' },
  { campaign_id: 'c-funded' },
  { campaign_id: 'c-failed' },
  { campaign_id: 'c-refunded' },
  { campaign_id: 'c-deleted' },
];

// Evaluates the shared predicate in JS, asserting every query uses it.
function fakeDb() {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push(text);
      assert.ok(text.includes(PUBLIC_CAMPAIGN_PREDICATE), `query does not use the shared predicate:\n${text}`);
      const excluded = params[0];
      const isPublic = (c) => c.deleted_at === null && !excluded.includes(c.status);
      const pub = campaigns.filter(isPublic);
      if (text.includes('FROM contributions')) {
        const ids = new Set(pub.map((c) => c.id));
        return { rows: [{ total: contributions.filter((x) => ids.has(x.campaign_id)).length }] };
      }
      if (text.includes('SUM(c.raised_amount)')) {
        return { rows: [{ total: String(pub.reduce((sum, c) => sum + c.raised_amount, 0)) }] };
      }
      return { rows: [{ total: pub.length }] };
    },
  };
}

test('all three public counters describe the same campaigns (#394)', async () => {
  const db = fakeDb();
  const stats = await fetchPublicStats(db);
  assert.deepEqual(stats, { total_campaigns: 2, total_raised: 350, total_contributions: 3 });
  assert.equal(db.queries.length, 3);
});

test('draft, failed and refunded campaigns are excluded', () => {
  assert.deepEqual(PUBLIC_CAMPAIGN_EXCLUDED_STATUSES, ['draft', 'failed', 'refunded']);
  assert.match(PUBLIC_CAMPAIGN_PREDICATE, /deleted_at IS NULL/);
});
