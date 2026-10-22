'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DOWN_SUFFIX = '.down.sql';

function isUpMigration(filename) {
  return filename.endsWith('.sql') && !filename.endsWith(DOWN_SUFFIX);
}

function validateMigrationFiles() {
  const all = listAllMigrationFilenames();
  for (const f of all) {
    if (!f.endsWith('.sql')) {
      throw new Error(
        `Unsupported migration file format: '${f}'. Supported formats are: .sql (e.g. .sql, .down.sql).`
      );
    }
  }
}

function listAllMigrationFilenames() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => !f.startsWith('.'))
    .sort();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function listUpMigrationFilenames() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(isUpMigration).sort();
}

function downFilenameFor(upFile) {
  return upFile.replace(/\.sql$/, DOWN_SUFFIX);
}

function filePathFor(upFile) {
  return path.join(MIGRATIONS_DIR, upFile);
}

function readUpSql(upFile) {
  return fs.readFileSync(filePathFor(upFile), 'utf8');
}

function fileHashFor(upFile) {
  return sha256(readUpSql(upFile));
}

function readDownSql(upFile) {
  const downFile = downFilenameFor(upFile);
  const p = filePathFor(downFile);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      file_hash TEXT
    )
  `);
  // Backfill the hash column on databases created before hash tracking was added.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS file_hash TEXT');
}

async function loadApplied(client) {
  const { rows } = await client.query(
    'SELECT filename, file_hash, applied_at FROM schema_migrations'
  );
  return rows;
}

// Compute the expected checksum for every migration file on disk.
function computeMigrationChecksums() {
  const checksums = {};
  for (const f of listUpMigrationFilenames()) {
    checksums[f] = fileHashFor(f);
  }
  return checksums;
}

// Detect drift between applied migrations and the current files on disk.
// Returns a report describing any discrepancies. A migration is in drift when:
//   - it was applied but its file is now missing (or has been renamed),
//   - its file content has changed since it was applied (hash mismatch),
//   - it was applied before hash tracking existed (no recorded hash).
// The report is pure data so CI can format it and choose an exit code.
function detectDrift(appliedRows, options = {}) {
  const diskChecksums = computeMigrationChecksums();
  const applied = Array.isArray(appliedRows) ? appliedRows : [];
  const appliedNames = new Set(applied.map(r => r.filename));

  const missing = [];
  const modified = [];
  const unverified = [];

  for (const row of applied) {
    const filename = row.filename;
    const diskHash = diskChecksums[filename];
    if (!diskHash) {
      missing.push({ filename, appliedAt: row.applied_at || null });
      continue;
    }
    if (!row.file_hash) {
      unverified.push({ filename, diskHash, appliedAt: row.applied_at || null });
      continue;
    }
    if (row.file_hash !== diskHash) {
      modified.push({
        filename,
        recordedHash: row.file_hash,
        diskHash,
        appliedAt: row.applied_at || null,
      });
    }
  }

  const pending = Object.keys(diskChecksums)
    .filter(f => !appliedNames.has(f))
    .sort();

  const hasDrift = missing.length > 0 || modified.length > 0;
  // Unverified migrations are only treated as drift when strict verification is requested.
  const strict = options.strict === true;
  const hasDriftStrict = hasDrift || (strict && unverified.length > 0);

  return {
    ok: !hasDriftStrict,
    hasDrift,
    hasDriftStrict,
    strict,
    counts: {
      applied: applied.length,
      disk: Object.keys(diskChecksums).length,
      missing: missing.length,
      modified: modified.length,
      unverified: unverified.length,
      pending: pending.length,
    },
    missing,
    modified,
    unverified,
    pending,
  };
}

// Format a drift report as human-readable text for CI logs.
function formatDriftReport(report) {
  const lines = [];
  lines.push(
    `Migration drift check: ${report.ok ? 'OK' : 'FAILED'} ` +
      `(applied=${report.counts.applied}, disk=${report.counts.disk}, pending=${report.counts.pending})`
  );
  if (report.missing.length) {
    lines.push('Missing migration files (applied but not on disk):');
    for (const m of report.missing) lines.push(`\n  -- ${m.filename}`);
  }
  if (report.modified.length) {
    lines.push('Modified migration files (hash mismatch):');
    for (const m of report.modified) {
      lines.push(
        `\n  -- ${m.filename} (recorded=${m.recordedHash}, disk=${m.diskHash})`
      );
    }
  }
  if (report.unverified.length) {
    lines.push('Unverified migrations (no recorded hash):');
    for (const m of report.unverified) lines.push(`\n  -- ${m.filename}`);
  }
  if (report.pending.length) {
    lines.push('Pending migrations (on disk but not applied):');
    for (const f of report.pending) lines.push(`\n  -- ${f}`);
  }
  return lines.join('\n');
}

// Run the full drift check against a connected client. Used by deployment CI.
async function checkDrift(client, options = {}) {
  await ensureSchemaMigrationsTable(client);
  const applied = await loadApplied(client);
  return detectDrift(applied, options);
}

module.exports = {
  MIGRATIONS_DIR,
  DOWN_SUFFIX,
  isUpMigration,
  sha256,
  listUpMigrationFilenames,
  downFilenameFor,
  readUpSql,
  readDownSql,
  fileHashFor,
  ensureSchemaMigrationsTable,
  listAllMigrationFilenames,
  validateMigrationFiles,
  loadApplied,
  computeMigrationChecksums,
  detectDrift,
  formatDriftReport,
  checkDrift,
};
