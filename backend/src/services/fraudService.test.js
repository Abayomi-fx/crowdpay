const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('fraudService extracts features and scores contributions', async () => {
  let inserted = false;
  const dbStub = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO contribution_fraud_scores')) {
        inserted = true;
        return { rows: [] };
      }
      if (sql.includes('SELECT COUNT(*)')) {
        return { rows: [{ cnt: '0' }] };
      }
      if (sql.includes('SELECT created_at FROM users')) {
        return { rows: [{ created_at: new Date() }] };
      }
      return { rows: [] };
    },
  };

  const fraudService = proxyquire('./fraudService', {
    '../config/database': dbStub,
  });

  const result = await fraudService.scoreContribution({
    contributionId: 'contrib-1',
    campaignId: 'camp-1',
    userId: 'user-1',
    amount: '15000',
    ipAddress: '192.0.2.1',
    deviceFingerprint: 'suspicious-device',
  });

  assert.equal(typeof result.score, 'number');
  assert.ok(result.score > 0);
  assert.equal(inserted, true);
});
