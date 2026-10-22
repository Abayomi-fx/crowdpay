const admin = require('firebase-admin');
const db = require('../config/database');
const logger = require('../config/logger');

function serviceAccount() {
  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    logger.error('FIREBASE_SERVICE_ACCOUNT must be valid JSON');
    return null;
  }
}

function messaging() {
  const account = serviceAccount();
  if (!account) return null;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.messaging();
}

function isInvalidToken(error) {
  return [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ].includes(error?.code);
}

async function sendToUser(userId, message) {
  const client = messaging();
  if (!client) return false;

  const { rows } = await db.query('SELECT token FROM push_subscriptions WHERE user_id = $1', [
    userId,
  ]);
  if (!rows.length) return false;

  const tokens = rows.map(row => row.token);
  let delivered = false;
  for (let start = 0; start < tokens.length; start += 500) {
    const batch = tokens.slice(start, start + 500);
    const response = await client.sendEachForMulticast({
      tokens: batch,
      notification: { title: message.title, body: message.body || '' },
      data: {
        type: String(message.type),
        link: message.link || '/',
      },
    });
    delivered ||= response.successCount > 0;

    const invalid = response.responses
      .map((result, index) =>
        result.success || !isInvalidToken(result.error) ? null : batch[index]
      )
      .filter(Boolean);
    if (invalid.length) {
      await db.query(
        'DELETE FROM push_subscriptions WHERE user_id = $1 AND token = ANY($2::text[])',
        [userId, invalid]
      );
    }
  }
  return delivered;
}

module.exports = { sendToUser };
