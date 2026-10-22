const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function noop() {}
async function asyncNoop() {}

function buildWorker() {
  return proxyquire('./worker', {
    './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
    './config/database': { query: async () => ({ rows: [] }) },
    './services/featureFlags': { isEnabled: () => true },
    './services/ledgerMonitor': { startLedgerMonitor: asyncNoop },
    './services/webhookDispatcher': { startWebhookRetryPoller: noop },
    './services/recurringContributionsService': {
      startRecurringContributionsCron: noop,
      stopRecurringContributionsCron: noop,
    },
    './services/recurring': {
      startSubscriptionClaimWorker: noop,
      stopSubscriptionClaimWorker: noop,
    },
    './services/ops/healthCollector': {
      startHealthCollector: noop,
      stopHealthCollector: noop,
    },
    './services/campaignStatusService': { refreshActiveCampaignStatuses: asyncNoop },
    './services/reconciliation': { reconcileCampaignBalances: asyncNoop },
    './services/campaignPublishing': { publishDraftCampaign: asyncNoop },
    './services/contractDeploymentRetryService': { retryFailedContractDeployments: asyncNoop },
    './services/weeklyDigestService': { sendWeeklyContributorDigests: asyncNoop },
    './services/deadlineReminderService': { sendDeadlineReminders: asyncNoop },
    './services/campaignUpdatesPublishing': { publishDueCampaignUpdates: asyncNoop },
    './services/payoutScheduleService': { processDuePayoutSchedules: asyncNoop },
    './services/milestoneAutoRelease': { processAutoReleases: asyncNoop },
  });
}

test('Background Worker Bootstrap', async t => {
  let originalEnv;

  t.beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  t.afterEach(() => {
    process.env = originalEnv;
  });

  await t.test('does not start in test environment', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.NODE_ENV = 'test';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('does not start when WORKER_ENABLED is false', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('starts workers when enabled', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';

    await startBackgroundWorkers();

    assert.equal(isWorkerRunning(), true);

    await stopBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });
});
