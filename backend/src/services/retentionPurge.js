const db = require('../config/database');
const logger = require('../config/logger');

const DEFAULT_RETENTION_DAYS = {
  KYC: 365,
  WEBHOOK_DELIVERIES: 90,
  CAMPAIGN_WEBHOOK_DELIVERIES: 90,
  WEBHOOKS: 365,
};

async function purgeKycData({ retentionDays = DEFAULT_RETENTION_DAYS.KYC } = {}) {
  const { rows } = await db.query(
    `DELETE FROM users
     WHERE kyc_retention_expires_at < NOW()::timestamp
       AND kyc_legal_hold != 'active'
       AND kyc_retention_expires_at IS NOT NULL
     RETURNING id, kyc_status, kyc_completed_at`
  );
  if (rows.length) {
    logger.info('retention: purged expired KYC data', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

async function purgeWebhookDeliveries({ retentionDays = DEFAULT_RETENTION_DAYS.WEBHOOK_DELIVERIES } = {}) {
  const { rows } = await db.query(
    `DELETE FROM webhook_deliveries
     WHERE expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND expires_at IS NOT NULL
     RETURNING id, event_type, webhook_id`
  );
  if (rows.length) {
    logger.info('retention: purged expired webhook deliveries', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

async function purgeCampaignWebhookDeliveries({ retentionDays = DEFAULT_RETENTION_DAYS.CAMPAIGN_WEBHOOK_DELIVERIES } = {}) {
  const { rows } = await db.query(
    `DELETE FROM campaign_webhook_deliveries
     WHERE expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND expires_at IS NOT NULL
     RETURNING id, event, campaign_id`
  );
  if (rows.length) {
    logger.info('retention: purged expired campaign webhook deliveries', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

async function purgeWebhooks({ retentionDays = DEFAULT_RETENTION_DAYS.WEBHOOKS } = {}) {
  const { rows } = await db.query(
    `DELETE FROM webhooks
     WHERE retention_expires_at < NOW()::timestamp
       AND legal_hold != 'active'
       AND retention_expires_at IS NOT NULL
     RETURNING id, user_id, events`
  );
  if (rows.length) {
    logger.info('retention: purged expired webhooks', { deleted: rows.length, retentionDays });
  }
  return rows.length;
}

/**
 * Run all purge jobs.
 * @returns {Promise<{kyc: number, webhookDeliveries: number, campaignWebhookDeliveries: number, webhooks: number}>}
 */
async function runAllPurges() {
  const results = {
    kyc: await purgeKycData(),
    webhookDeliveries: await purgeWebhookDeliveries(),
    campaignWebhookDeliveries: await purgeCampaignWebhookDeliveries(),
    webhooks: await purgeWebhooks(),
  };
  logger.info('retention: completed all purge runs', results);
  return results;
}

module.exports = {
  purgeKycData,
  purgeWebhookDeliveries,
  purgeCampaignWebhookDeliveries,
  purgeWebhooks,
  runAllPurges,
  DEFAULT_RETENTION_DAYS,
};