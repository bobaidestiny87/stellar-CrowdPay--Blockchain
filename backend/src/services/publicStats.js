/**
 * Public landing-page counters (#394).
 *
 * All three counters use one predicate so they always describe the same set
 * of campaigns: a campaign counts when it is not soft-deleted and is not a
 * draft, a failed campaign or a refunded one (money that was returned is not
 * "raised"). Contributions count only when their campaign counts.
 */
const PUBLIC_CAMPAIGN_EXCLUDED_STATUSES = ['draft', 'failed', 'refunded'];

const PUBLIC_CAMPAIGN_PREDICATE = `c.deleted_at IS NULL AND c.status <> ALL($1::text[])`;

async function fetchPublicStats(db) {
  const params = [PUBLIC_CAMPAIGN_EXCLUDED_STATUSES];
  const [campaigns, raised, contributions] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total FROM campaigns c WHERE ${PUBLIC_CAMPAIGN_PREDICATE}`,
      params
    ),
    db.query(
      `SELECT COALESCE(SUM(c.raised_amount), 0)::numeric AS total
       FROM campaigns c WHERE ${PUBLIC_CAMPAIGN_PREDICATE}`,
      params
    ),
    db.query(
      `SELECT COUNT(*)::int AS total
       FROM contributions ct
       JOIN campaigns c ON c.id = ct.campaign_id
       WHERE ${PUBLIC_CAMPAIGN_PREDICATE}`,
      params
    ),
  ]);
  return {
    total_campaigns: campaigns.rows[0].total,
    total_raised: parseFloat(raised.rows[0].total),
    total_contributions: contributions.rows[0].total,
  };
}

module.exports = {
  fetchPublicStats,
  PUBLIC_CAMPAIGN_EXCLUDED_STATUSES,
  PUBLIC_CAMPAIGN_PREDICATE,
};
