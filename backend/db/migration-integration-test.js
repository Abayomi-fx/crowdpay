'use strict';

/**
 * Upgrade a committed, production-like snapshot in an isolated database.
 * The database is created and dropped for this process, so CI runs never
 * share state with the normal migration or application test database.
 *
 * Drift detection: before upgrading, the fixture snapshot's recorded
 * migration checksums (schema_migrations) are compared against the checksums
 * of the migration files currently on disk. Any mismatch means an applied
 * migration was edited after the fixture was captured, which would silently
 * diverge production-like environments from the repository, so the run fails.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Pool } = require('pg');
const { listUpMigrationFilenames } = require('./migrateLib');

const execFileAsync = promisify(execFile);
const fixturePath = path.join(__dirname, 'fixtures', 'production-like-20260404.sql');
const migrationsDir = path.join(__dirname, 'migrations');

function databaseUrlWithName(source, name) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

function checksumFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Compute the expected checksum for every up-migration currently in the repo.
 * @returns {Map<string, string>} filename -> sha256 hex digest
 */
function currentMigrationChecksums() {
  const checksums = new Map();
  for (const filename of listUpMigrationFilenames()) {
    checksums.set(filename, checksumFile(path.join(migrationsDir, filename)));
  }
  return checksums;
}

/**
 * Compare fixture-recorded checksums with the repository's current checksums.
 * Throws on any drift: a checksum mismatch, a migration recorded in the
 * fixture that no longer exists on disk, or a repo migration missing from the
 * fixture (unless it is pending, which is allowed to be applied by the upgrade).
 * @param {Map<string,string>} recorded filename -> checksum from the fixture
 * @param {Map<string,string>} current filename -> checksum from disk
 */
function assertNoMigrationDrift(recorded, current) {
  const problems = [];

  for (const [filename, recordedChecksum] of recorded) {
    if (!current.has(filename)) {
      problems.push(`${filename}: applied in fixture but missing from repository`);
      continue;
    }
    const currentChecksum = current.get(filename);
    if (recordedChecksum !== currentChecksum) {
      problems.push(
        `${filename}: checksum changed (fixture ${recordedChecksum}, repository ${currentChecksum})`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Migration drift detected:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Read recorded checksums from the fixture's schema_migrations rows.
 * Supports both a `checksum` column and fixtures without one (in which case
 * the checksum is recomputed from the file recorded at apply time is not
 * possible, so the comparison is limited to filename presence).
 */
async function recordedMigrationChecksums(pool) {
  const { rows: columns } = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  `);
  const hasChecksum = columns.some(c => c.column_name === 'checksum');
  const { rows } = await pool.query(
    hasChecksum
      ? 'SELECT filename, checksum FROM schema_migrations ORDER BY filename'
      : 'SELECT filename, NULL::text AS checksum FROM schema_migrations ORDER BY filename'
  );
  return new Map(rows.map(r => [r.filename, r.checksum]));
}

async function main() {
  const sourceUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres';
  const databaseName = `crowdpay_migration_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = databaseUrlWithName(sourceUrl, 'postgres');
  const targetUrl = databaseUrlWithName(sourceUrl, databaseName);
  const adminPool = new Pool({ connectionString: adminUrl });
  let targetPool;

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    targetPool = new Pool({ connectionString: targetUrl });
    await targetPool.query(fs.readFileSync(fixturePath, 'utf8'));

    // Drift check runs against the fixture before the migration runner touches it.
    const recorded = await recordedMigrationChecksums(targetPool);
    const current = currentMigrationChecksums();
    const recordedWithChecksum = new Map(
      [...recorded].filter(([, checksum]) => checksum !== null)
    );
    const checksumsRecorded = recordedWithChecksum.size > 0;
    if (checksumsRecorded) {
      assertNoMigrationDrift(recordedWithChecksum, current);
    } else {
      // Fixture predates checksums: still fail if an applied migration vanished.
      for (const filename of recorded.keys()) {
        if (!current.has(filename)) {
          throw new Error(
            `Migration drift detected: ${filename} applied in fixture but missing from repository`
          );
        }
      }
    }
    console.log(
      `[migration-integration] drift check OK (${recorded.size} applied, ${checksumsRecorded ? 'checksums verified' : 'checksums not recorded in fixture'}).`
    );

    await execFileAsync(process.execPath, ['db/migrate.js', 'up'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: targetUrl },
      maxBuffer: 10 * 1024 * 1024,
    });

    const { rows: counts } = await targetPool.query(`
      SELECT
        (SELECT COUNT(*) FROM campaigns WHERE id = '00000000-0000-0000-0000-000000000010') AS campaigns,
        (SELECT COUNT(*) FROM contributions WHERE id = '00000000-0000-0000-0000-000000000020' AND tx_hash = 'fixture-contribution-tx') AS contributions,
        (SELECT COUNT(*) FROM withdrawal_requests WHERE id = '00000000-0000-0000-0000-000000000030') AS payouts
    `);
    const countsRow = counts[0];
    if (
      countsRow.campaigns !== '1' ||
      countsRow.contributions !== '1' ||
      countsRow.payouts !== '1'
    ) {
      throw new Error(`Fixture records were not preserved: ${JSON.stringify(countsRow)}`);
    }

    const { rows: migrationRows } = await targetPool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    if (migrationRows.length !== listUpMigrationFilenames().length) {
      throw new Error(
        `Migration runner did not apply the complete set: ${migrationRows.length}/${listUpMigrationFilenames().length}`
      );
    }

    const { rows: indexes } = await targetPool.query(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_contributions_campaign_id', 'stellar_transactions_campaign_created_idx', 'ledger_stream_alerts_campaign_idx')
    `);
    if (indexes.length !== 3) throw new Error('Required upgrade indexes are missing');

    const { rows: constraints } = await targetPool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND ((table_name = 'campaigns' AND constraint_type = 'CHECK')
           OR (table_name = 'contributions' AND constraint_type = 'UNIQUE')
           OR (table_name = 'withdrawal_requests' AND constraint_type = 'CHECK'))
    `);
    if (constraints.length < 3) throw new Error('Required upgrade constraints are missing');

    console.log(
      '[migration-integration] OK: fixture upgraded with records, indexes, and constraints intact.'
    );
  } finally {
    if (targetPool) await targetPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  }
}

main().catch(err => {
  console.error('[migration-integration] FAILED:', err.message);
  process.exitCode = 1;
});

module.exports = {
  checksumFile,
  currentMigrationChecksums,
  assertNoMigrationDrift,
};
