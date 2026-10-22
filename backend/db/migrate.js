require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const { Pool } = require('pg');
const {
  listUpMigrationFilenames,
  readUpSql,
  fileHashFor,
  ensureSchemaMigrationsTable,
  validateMigrationFiles,
  listAllMigrationFilenames,
  loadApplied,
} = require('./migrateLib');
let checksumReport;
let writeChecksumFile;
try {
  ({ checksumReport, writeChecksumFile } = require('./migrationChecksums'));
} catch (err) {
  checksumReport = () => ({ entries: [], missing: [], mismatched: [], unexpected: [] });
  writeChecksumFile = () => {
    throw new Error('migrationChecksums module unavailable: ' + err.message);
  };
}

// Match backend/.env.example and docker-compose db service defaults.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMMAND = process.argv[2] || 'up';

// When running after `psql -f db/schema.sql` (the `migrate:fresh` flow), a few
// early migrations duplicate tables/columns that schema.sql already provides
// (e.g. 20260401 creates users/campaigns/contributions). Those objects are
// part of the canonical base schema snapshot and their final shape lives in
// schema.sql, so re-creating them is unnecessary and would abort the run.
//
// `--bootstrap-schema` (or MIGRATE_BOOTSTRAP_SCHEMA=1) makes `up` skip a
// migration whose objects already exist (Postgres "duplicate_*" error codes)
// AFTER a full schema.sql bootstrap — never on a migrations-only install
// (`npm run migrate` stays strict). Already-applied migrations are never
// edited, so deployed environments keep their recorded hashes intact.
const BOOTSTRAP_SCHEMA =
  process.argv.includes('--bootstrap-schema') || process.env.MIGRATE_BOOTSTRAP_SCHEMA === '1';

// `--check-drift` (or MIGRATE_CHECK_DRIFT=1) makes `up` fail fast when the
// checked-in checksum manifest (db/migration-checksums.json) does not match
// the migration files on disk. This catches accidental edits to applied
// migrations before they reach a database in deployment CI.
const CHECK_DRIFT =
  process.argv.includes('--check-drift') || process.env.MIGRATE_CHECK_DRIFT === '1';

// PostgreSQL ERRCODEs for "this already exists" failures.
const ALREADY_CREATED_CODES = new Set([
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42P04', // duplicate_object
  '42710', // duplicate_object (constraints/indexes on existing objects)
]);

async function runUp() {
  const client = await pool.connect();
  try {
    if (CHECK_DRIFT) {
      const drift = checksumReport();
      if (drift.missing.length || drift.mismatched.length || drift.unexpected.length) {
        throw new Error(
          `Migration checksum drift detected. ` +
            `missing=[${drift.missing.join(',')}] ` +
            `mismatched=[${drift.mismatched.join(',')}] ` +
            `unexpected=[${drift.unexpected.join(',')}]. ` +
            `Run \`node db/migrate.js checksums --write\` and commit the manifest.`
        );
      }
    }
    validateMigrationFiles();
    await ensureSchemaMigrationsTable(client);
    const appliedRows = await loadApplied(client);
    const appliedMap = new Map(appliedRows.map(r => [r.filename, r]));

    // Verify that already-applied migrations haven't been edited in place.
    for (const file of listUpMigrationFilenames()) {
      const record = appliedMap.get(file);
      if (!record || !record.file_hash) continue;
      if (record.file_hash !== fileHashFor(file)) {
        throw new Error(
          `Migration '${file}' was applied but its content has changed since then ` +
            `(hash mismatch). Do not edit an applied migration - add a new one instead.`
        );
      }
    }

    let count = 0;
    for (const file of listUpMigrationFilenames()) {
      if (appliedMap.has(file)) {
        continue;
      }
      const sql = readUpSql(file);
      const hash = fileHashFor(file);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, file_hash) VALUES ($1, $2)', [
          file,
          hash,
        ]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (BOOTSTRAP_SCHEMA && err.code && ALREADY_CREATED_CODES.has(err.code)) {
          await client.query('BEGIN');
          await client.query(
            'INSERT INTO schema_migrations (filename, file_hash) VALUES ($1, $2)',
            [file, hash]
          );
          await client.query('COMMIT');
          count++;
          continue;
        }
        throw err;
      }
    }
    console.log(`[migrate] Done. Applied ${count} migration(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Never swallow the failure silently: an unexplained non-zero exit hides
    // validation errors (e.g. an unsupported migration file) from operators.
    console.error('[migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runStatus() {
  const client = await pool.connect();
  try {
    await ensureSchemaMigrationsTable(client);
    const appliedRows = await loadApplied(client);
    const appliedMap = new Map(appliedRows.map(r => [r.filename, r]));

    const files = listAllMigrationFilenames();
    const rows = files.map(file => {
      const record = appliedMap.get(file);
      let status = 'PENDING';
      let appliedAt = '';
      if (!file.endsWith('.sql')) {
        status = 'UNSUPPORTED FORMAT';
      } else if (file.endsWith('.down.sql')) {
        status = 'DOWN MIGRATION';
      } else if (record) {
        appliedAt =
          record.applied_at instanceof Date
            ? record.applied_at.toISOString()
            : String(record.applied_at);
        status =
          record.file_hash && record.file_hash !== fileHashFor(file)
            ? 'APPLIED (HASH MISMATCH)'
            : 'APPLIED';
      }
      return { file, status, appliedAt };
    });

    console.log('Migration status:');
    console.log('-----------------');
    for (const r of rows) {
      const at = r.appliedAt ? ` @ ${r.appliedAt}` : '';
      console.log(`  ${r.status.padEnd(28)} ${r.file}${at}`);
    }
    const pending = rows.filter(r => r.status === 'PENDING').length;
    const applied = rows.filter(r => r.status.startsWith('APPLIED')).length;
    const unsupported = rows.filter(r => r.status === 'UNSUPPORTED FORMAT').length;
    console.log('-----------------');
    console.log(
      `${applied} applied, ${pending} pending, ${unsupported} unsupported (${rows.length} total).`
    );
  } catch (err) {
    console.error('[migrate:status] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runChecksums() {
  try {
    const write = process.argv.includes('--write');
    const drift = checksumReport();
    if (write) {
      writeChecksumFile();
      console.log('[migrate:checksums] Wrote db/migration-checksums.json');
      return;
    }
    if (drift.missing.length || drift.mismatched.length || drift.unexpected.length) {
      console.error('[migrate:checksums] Drift detected:');
      for (const f of drift.missing) console.error(`  MISSING    ${f}`);
      for (const f of drift.mismatched) console.error(`  MISMATCHED ${f}`);
      for (const f of drift.unexpected) console.error(`  UNEXPECTED ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[migrate:checksums] OK (${drift.entries.length} migration(s) verified).`);
  } catch (err) {
    console.error('[migrate:checksums] Failed:', err.message);
    process.exitCode = 1;
  }
}

async function runVerify() {
  try {
    validateMigrationFiles();
    const drift = checksumReport();
    if (drift.missing.length || drift.mismatched.length || drift.unexpected.length) {
      throw new Error(
        `Migration checksum drift detected. ` +
          `missing=[${drift.missing.join(',')}] ` +
          `mismatched=[${drift.mismatched.join(',')}] ` +
          `unexpected=[${drift.unexpected.join(',')}].`
      );
    }
    console.log(`[migrate:verify] OK (${drift.entries.length} migration(s) verified).`);
  } catch (err) {
    console.error('[migrate:verify] Failed:', err.message);
    process.exitCode = 1;
  }
}

async function runDown() {
  console.error('[migrate:down] Rollback is not supported due to lack of down migration files.');
  process.exitCode = 1;
}

async function main() {
  switch (COMMAND) {
    case 'up':
    case 'migrate':
      await runUp();
      break;
    case 'status':
      await runStatus();
      break;
    case 'checksums':
      await runChecksums();
      break;
    case 'verify':
      await runVerify();
      break;
    case 'down':
      await runDown();
      break;
    default:
      console.error(`Unknown command: ${COMMAND}`);
      console.error('Usage: node db/migrate.js [up|status|down|checksums|verify] [--bootstrap-schema] [--check-drift]');
      console.error('  --bootstrap-schema  skip migrations whose objects already exist after');
      console.error(
        '                      `psql -f db/schema.sql` (used by npm run migrate:fresh)'
      );
      console.error('  --check-drift       fail `up` if migration files drift from the manifest');
      console.error('  checksums [--write] print/write db/migration-checksums.json');
      console.error('  verify              validate migration files and checksum manifest');
      process.exitCode = 1;
      await pool.end();
  }
}

main();
