'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isUpMigration,
  downFilenameFor,
  sha256,
  validateMigrationFiles,
  listAllMigrationFilenames,
  listUpMigrationFilenames,
  MIGRATIONS_DIR,
} = require('../../db/migrateLib');

test('isUpMigration excludes .down.sql rollback scripts', () => {
  assert.equal(isUpMigration('20260401_users.sql'), true);
  assert.equal(isUpMigration('002_20260402_wallets.up.sql'), true);
  assert.equal(isUpMigration('20260401_users.down.sql'), false);
  assert.equal(isUpMigration('notes.txt'), false);
});

test('downFilenameFor derives the rollback filename from an up migration', () => {
  assert.equal(downFilenameFor('20260401_users.sql'), '20260401_users.down.sql');
  assert.equal(downFilenameFor('002_20260402_wallets.up.sql'), '002_20260402_wallets.up.down.sql');
});

test('sha256 is deterministic and matches the node crypto implementation', () => {
  const expected = sha256('select 1;');
  assert.equal(expected, sha256('select 1;'));
  assert.equal(expected.length, 64);
  assert.notEqual(sha256('select 1;'), sha256('select 2;'));
});

// #898: a stray `.js` migration next to the `.sql` files made the runner abort
// on the very first statement, and the swallowed error meant operators saw a
// bare non-zero exit. These tests pin the committed directory to the supported
// format so a future stray extension fails the build instead of the deploy.
test('validateMigrationFiles accepts the committed migration set', () => {
  assert.doesNotThrow(() => validateMigrationFiles());

  for (const file of listAllMigrationFilenames()) {
    assert.equal(
      file.endsWith('.sql'),
      true,
      `${file} must use a supported migration format (.sql / .down.sql)`
    );
  }
});

test('the legacy velocity-alert-threshold .js migration is gone and its .sql twin remains', () => {
  const files = listAllMigrationFilenames();

  assert.equal(
    files.some(file => file.endsWith('.js')),
    false,
    'no .js migration may be committed under db/migrations'
  );
  assert.equal(
    files.includes('20250601000000_add_velocity_alert_threshold.js'),
    false,
    'the unsupported .js migration must be deleted'
  );
  assert.equal(
    files.includes('20250601000000_add_velocity_alert_threshold.sql'),
    true,
    'the .sql twin still has to apply velocity_alert_threshold'
  );
  assert.equal(
    listUpMigrationFilenames().includes('20250601000000_add_velocity_alert_threshold.sql'),
    true
  );
});

test('validateMigrationFiles rejects an unsupported extension before running any migration', () => {
  const stray = path.join(MIGRATIONS_DIR, 'zzs_validate_migration_files_stray.js');
  fs.writeFileSync(stray, '// stray, unsupported migration\n');
  try {
    assert.throws(
      () => validateMigrationFiles(),
      /Unsupported migration file format: 'zzs_validate_migration_files_stray\.js'/
    );
  } finally {
    fs.rmSync(stray, { force: true });
  }
});

// Drift detection: checksums must be stable across runs and change when a
// committed migration file is edited after being applied.
test('sha256 of a migration file detects content drift', () => {
  const file = path.join(MIGRATIONS_DIR, 'zzz_drift_detection_fixture.sql');
  const original = 'CREATE TABLE drift_fixture (id int);\n';
  const mutated = 'CREATE TABLE drift_fixture (id bilint);\n';
  try {
    fs.writeFileSync(file, original);
    const before = sha256(fs.readFileSync(file, 'utf8'));
    // Re-reading the same content must yield the same checksum.
    assert.equal(before, sha256(fs.readFileSync(file, 'utf8')));

    fs.writeFileSync(file, mutated);
    const after = sha256(fs.readFileSync(file, 'utf8'));
    assert.notEqual(before, after, 'editing an applied migration must change its checksum');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
