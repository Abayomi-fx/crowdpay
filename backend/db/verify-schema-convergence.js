'use strict';

/**
 * Verify that the database contains every table declared by the application
 * schema and migrations, and optionally compare its structure with a second
 * database bootstrap path.
 *
 * Drift detection: every migration file (and schema.sql) is hashed with
 * SHA-256. The resulting checksum manifest can be written with
 * --write-checksums and compared in CI with --check-checksums so that any
 * edit to an already-shipped migration is reported as drift, not silently
 * accepted.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const CHECKSUMS_FILE = path.join(__dirname, 'migration-checksums.json');

function migrationFiles() {
  return [
    SCHEMA_FILE,
    ...fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(file => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort()
      .map(file => path.join(MIGRATIONS_DIR, file)),
  ];
}

function expectedTables() {
  const tables = new Set(['schema_migrations']);
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w]+\.)?"?([\w]+)"?/gi;

  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(file, 'utf8');
    for (const match of sql.matchAll(createTable)) tables.add(match[1].toLowerCase());
  }
  return [...tables].sort();
}

/**
 * Compute SHA-256 checksums for every schema/migration file, keyed by path
 * relative to the db directory so the manifest is portable across machines.
 */
function computeChecksums() {
  const checksums = {};
  for (const file of migrationFiles()) {
    const key = path.relative(__dirname, file).split(path.sep).join('/');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    checksums[key] = hash;
  }
  return checksums;
}

/**
 * Compare current checksums against a stored manifest. Returns a list of
 * failures: modified files, files missing from the manifest (new migrations
 * that were not recorded), and files recorded but no longer present.
 */
function compareChecksums(current, recorded) {
  const failures = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (!(file in current)) {
      failures.push(`migration '${file}' was recorded but no longer exists`);
    } else if (current[file] !== hash) {
      failures.push(`migration '${file}' has drifted: checksum changed after being recorded`);
    }
  }
  for (const file of Object.keys(current)) {
    if (!(file in recorded)) {
      failures.push(`migration '${file}' has no recorded checksum (run --write-checksums)`);
    }
  }
  return failures;
}

function readChecksumManifest(file = CHECKSUMS_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(`checksum manifest not found at ${file}; run --write-checksums first`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`checksum manifest at ${file} is malformed`);
  }
  return parsed;
}

async function readSnapshot(pool) {
  const { rows } = await pool.query(`
    SELECT table_name, column_name, data_type,
           udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, column_name
  `);
  return rows.map(normalizeColumnRow);
}

/**
 * Physical column order is intentionally not part of the convergence
 * contract. PostgreSQL assigns ordinal_position at CREATE TABLE time and has
 * no supported ALTER that reorders columns, so a migrations-only database
 * appends later columns while a schema.sql bootstrap may declare them inline.
 * Both paths must expose the same columns with the same type, nullability and
 * default; their ordinal positions are an implementation detail (#1045).
 */
function normalizeColumnRow(row) {
  return {
    table_name: row.table_name,
    column_name: row.column_name,
    data_type: row.data_type,
    udt_name: row.udt_name,
    is_nullable: row.is_nullable,
    column_default: row.column_default,
  };
}

function tableNames(snapshot) {
  return [...new Set(snapshot.map(row => row.table_name))].sort();
}

function validateExpectedTables(snapshot) {
  const actual = new Set(tableNames(snapshot));
  return expectedTables()
    .filter(table => !actual.has(table))
    .map(table => `table '${table}' is missing`);
}

async function validateCanonicalData(pool) {
  const failures = [];
  const { rows: featureFlagColumns } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'feature_flags'
     ORDER BY column_name
  `);
  const expectedFeatureFlagColumns = [
    'default_enabled',
    'description',
    'enabled',
    'key',
    'updated_at',
  ];
  const actualFeatureFlagColumns = featureFlagColumns.map(row => row.column_name);
  if (JSON.stringify(actualFeatureFlagColumns) !== JSON.stringify(expectedFeatureFlagColumns)) {
    failures.push(
      `feature_flags columns drift: expected [${expectedFeatureFlagColumns.join(', ')}], got [${actualFeatureFlagColumns.join(', ')}]`
    );
  }

  const { rows: flagRows } = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flags');
  if (flagRows[0].n < 4)
    failures.push(`feature_flags seed rows missing: expected >= 4, found ${flagRows[0].n}`);

  const { rows: templateColumns } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'campaign_templates'
     ORDER BY column_name
  `);
  const expectedTemplateColumns = [
    'category',
    'created_at',
    'description',
    'id',
    'is_active',
    'name',
    'slug',
    'template_data',
    'updated_at',
    'use_count',
  ];
  const actualTemplateColumns = templateColumns.map(row => row.column_name);
  if (JSON.stringify(actualTemplateColumns) !== JSON.stringify(expectedTemplateColumns)) {
    failures.push(
      `campaign_templates columns drift: expected [${expectedTemplateColumns.join(', ')}], got [${actualTemplateColumns.join(', ')}]`
    );
  }
  const { rows: templateRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM campaign_templates'
  );
  if (templateRows[0].n < 1) failures.push('campaign_templates has no seed rows after migration');
  return failures;
}

function compareSnapshots(actualInput, expectedInput) {
  // Accept snapshots written by older versions of this script too, but never
  // let a legacy `ordinal_position` field turn an equivalent schema into a
  // failure.
  const actual = actualInput.map(normalizeColumnRow);
  const expected = expectedInput.map(normalizeColumnRow);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];

  const actualTables = new Set(tableNames(actual));
  const expectedTableNames = new Set(tableNames(expected));
  const failures = [];
  for (const table of [...expectedTableNames].filter(name => !actualTables.has(name))) {
    failures.push(`comparison database is missing table '${table}'`);
  }
  for (const table of [...actualTables].filter(name => !expectedTableNames.has(name))) {
    failures.push(`comparison database has unexpected table '${table}'`);
  }

  const groupByTable = rows => {
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.table_name)) grouped.set(row.table_name, []);
      grouped.get(row.table_name).push(row);
    }
    return grouped;
  };
  const actualByTable = groupByTable(actual);
  const expectedByTable = groupByTable(expected);
  for (const table of new Set([...actualByTable.keys(), ...expectedByTable.keys()])) {
    if (
      JSON.stringify(actualByTable.get(table) || []) !==
      JSON.stringify(expectedByTable.get(table) || [])
    ) {
      failures.push(`columns differ for table '${table}'`);
    }
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const flagValue = name => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Option ${name} requires a file path`);
    }
    return value;
  };
  const writePath = flagValue('--write-snapshot');
  const comparePath = flagValue('--compare-snapshot');
  const writeChecksums = args.includes('--write-checksums');
  const checkChecksums = args.includes('--check-checksums');
  const checksumsPath = flagValue('--checksums-file') || CHECKSUMS_FILE;

  if (writeChecksums) {
    const checksums = computeChecksums();
    fs.writeFileSync(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`);
    console.log(
      `[verify-schema] Wrote ${Object.keys(checksums).length} migration checksums to ${checksumsPath}.`
    );
    return;
  }

  if (checkChecksums) {
    const failures = compareChecksums(computeChecksums(), readChecksumManifest(checksumsPath));
    if (failures.length) {
      console.error('[verify-schema] Migration drift detected:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log('[verify-schema] Migration checksums match the recorded manifest.');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const snapshot = await readSnapshot(pool);
    const failures = [...validateExpectedTables(snapshot), ...(await validateCanonicalData(pool))];
    if (comparePath) {
      failures.push(
        ...compareSnapshots(snapshot, JSON.parse(fs.readFileSync(comparePath, 'utf8')))
      );
    }
    if (writePath) fs.writeFileSync(writePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    if (failures.length) {
      console.error('[verify-schema] FAILED:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[verify-schema] OK: ${tableNames(snapshot).length} public tables verified.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[verify-schema] Failed to run check:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  compareChecksums,
  compareSnapshots,
  computeChecksums,
  expectedTables,
  readChecksumManifest,
  readSnapshot,
  validateCanonicalData,
  validateExpectedTables,
};
