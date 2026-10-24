'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const lib = require('./migrateLib');

test('sha256 is deterministic and hex-encoded', () => {
  const a = lib.sha256('CREATE TABLE t (id int);');
  const b = lib.sha256('CREATE TABLE t (id int);');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, lib.sha256('CREATE TABLE t (id int); '));
});

test('isUpMigration excludes down migrations and non-sql files', () => {
  assert.strictEqual(lib.isUpMigration('001_init.sql'), true);
  assert.strictEqual(lib.isUpMigration('001_init.down.sql'), false);
  assert.strictEqual(lib.isUpMigration('README.md'), false);
});

test('downFilenameFor maps up file to down file', () => {
  assert.strictEqual(lib.downFilenameFor('002_add.sql'), '002_add.down.sql');
});

test('validateMigrationFiles rejects unsupported formats in the real directory', () => {
  // The committed migrations directory must only contain .sql files (or dotfiles).
  assert.doesNotThrow(() => lib.validateMigrationFiles());
});

test('fileHashFor matches sha256 of file content and changes on edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const name = '999_checksum_test.sql';
  const original = lib.MIGRATIONS_DIR;
  // Exercise hashing through the public helpers on a real file in the directory.
  const fullPath = path.join(lib.MIGRATIONS_DIR, name);
  try {
    fs.writeFileSync(fullPath, 'SELECT 1;');
    const h1 = lib.fileHashFor(name);
    assert.strictEqual(h1, lib.sha256('SELECT 1;'));
    fs.writeFileSync(fullPath, 'SELECT 2;');
    const h2 = lib.fileHashFor(name);
    assert.notStrictEqual(h1, h2, 'edited migration must produce a different checksum (drift)');
  } finally {
    fs.rmSync(fullPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(lib.MIGRATIONS_DIR, original);
  }
});

test('readDownSql returns null when no down migration exists', () => {
  assert.strictEqual(lib.readDownSql('__nonexistent_migration__.sql'), null);
});

test('advisory lock helpers issue the expected queries', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    },
  };
  await lib.acquireMigrationLock(client);
  const ok = await lib.releaseMigrationLock(client);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls[0].params, [lib.MIGRATION_ADVISORY_LOCK_KEY]);
  assert.match(calls[1].sql, /pg_advisory_unlock/);
});

test('loadApplied returns rows including file_hash for drift comparison', async () => {
  const client = {
    query: async () => ({
      rows: [{ filename: '001_init.sql', file_hash: 'abc', applied_at: new Date(0) }],
    }),
  };
  const rows = await lib.loadApplied(client);
  assert.strictEqual(rows[0].file_hash, 'abc');
});

test('drift detection: applied hash mismatch against current file is detectable', async () => {
  const name = '998_drift_test.sql';
  const fullPath = path.join(lib.MIGRATIONS_DIR, name);
  try {
    fs.writeFileSync(fullPath, 'CREATE TABLE drift_a (id int);');
    const recorded = lib.fileHashFor(name);
    fs.writeFileSync(fullPath, 'CREATE TABLE drift_b (id int);');
    const client = {
      query: async () => ({ rows: [{ filename: name, file_hash: recorded }] }),
    };
    const applied = await lib.loadApplied(client);
    const drifted = applied.filter(r => r.file_hash !== lib.fileHashFor(r.filename));
    assert.strictEqual(drifted.length, 1);
    assert.strictEqual(drifted[0].filename, name);
  } finally {
    fs.rmSync(fullPath, { force: true });
  }
});
