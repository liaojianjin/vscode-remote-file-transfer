import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StagingManager, TTL_HOURS } from '../StagingManager';

function createPoolName(): string {
  return `vscode-rft-test-${process.pid}-${Date.now()}-${randomUUID()}`;
}

function getPoolRoot(poolName: string): string {
  return path.join(os.tmpdir(), poolName);
}

function getFilesDir(poolName: string): string {
  return path.join(getPoolRoot(poolName), 'files');
}

function getDbPath(poolName: string): string {
  return path.join(getPoolRoot(poolName), 'staging.json');
}

function cleanupPool(poolName: string): void {
  fs.rmSync(getPoolRoot(poolName), { recursive: true, force: true });
}

test('stage and read binary file without data corruption', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);
  const payload = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x41]);

  const entry = await manager.stageBinaryFile(payload, {
    filename: 'binary.bin',
    size: payload.byteLength,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/var/tmp/binary.bin'
  });

  const binary = await manager.readStagedBinary(entry.id);
  assert.deepEqual([...binary], [0x00, 0x7f, 0x80, 0xff, 0x41]);

  const list = await manager.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].remoteAuthority, 'ssh-remote+alpha');
  assert.equal(list[0].path, '/var/tmp/binary.bin');
});

test('overwrite only when remoteAuthority and path are both equal', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);

  const first = await manager.stageBinaryFile(new Uint8Array([1]), {
    filename: 'same-name.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/opt/same-name.txt'
  });

  const second = await manager.stageBinaryFile(new Uint8Array([2]), {
    filename: 'same-name.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/opt/same-name.txt'
  });

  const third = await manager.stageBinaryFile(new Uint8Array([3]), {
    filename: 'same-name.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+beta',
    workspaceName: 'ws-b',
    path: '/opt/same-name.txt'
  });

  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);

  const list = await manager.listEntries();
  assert.equal(list.length, 2);

  const alphaEntry = list.find(
    (entry) => entry.remoteAuthority === 'ssh-remote+alpha' && entry.path === '/opt/same-name.txt'
  );
  const betaEntry = list.find(
    (entry) => entry.remoteAuthority === 'ssh-remote+beta' && entry.path === '/opt/same-name.txt'
  );

  assert.ok(alphaEntry);
  assert.ok(betaEntry);
  assert.equal(alphaEntry?.id, second.id);

  const firstFilePath = path.join(getFilesDir(poolName), first.id);
  assert.equal(fs.existsSync(firstFilePath), false);
});

test('cleanup removes expired records and orphan physical files', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);

  const entry = await manager.stageBinaryFile(new Uint8Array([9, 9, 9]), {
    filename: 'expired.bin',
    size: 3,
    remoteAuthority: 'ssh-remote+gamma',
    workspaceName: 'ws-c',
    path: '/data/expired.bin'
  });

  const dbPath = getDbPath(poolName);
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')) as Array<Record<string, unknown>>;
  db[0].timestamp = Date.now() - (TTL_HOURS * 60 * 60 * 1000 + 10_000);
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');

  const orphanPath = path.join(getFilesDir(poolName), 'orphan-file');
  fs.writeFileSync(orphanPath, Buffer.from([1, 2, 3]));

  await manager.cleanupExpiredAndOrphans();

  const list = await manager.listEntries();
  assert.equal(list.length, 0);

  const expiredFilePath = path.join(getFilesDir(poolName), entry.id);
  assert.equal(fs.existsSync(expiredFilePath), false);
  assert.equal(fs.existsSync(orphanPath), false);
});

test('stale lock directory is forcefully taken over and removed', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);

  await manager.stageBinaryFile(new Uint8Array([1, 2, 3]), {
    filename: 'lock.bin',
    size: 3,
    remoteAuthority: 'ssh-remote+delta',
    workspaceName: 'ws-d',
    path: '/tmp/lock.bin'
  });

  const lockPath = path.join(getPoolRoot(poolName), '.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  const staleAt = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const list = await manager.listEntries();
  assert.equal(list.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test('deleteEntriesByIds deletes selected files only', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);
  const first = await manager.stageBinaryFile(new Uint8Array([1]), {
    filename: 'a.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/tmp/a.txt'
  });
  const second = await manager.stageBinaryFile(new Uint8Array([2]), {
    filename: 'b.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/tmp/b.txt'
  });

  const result = await manager.deleteEntriesByIds([first.id, 'missing-id']);
  assert.equal(result.deleted, 1);
  assert.equal(result.notFound, 1);

  const list = await manager.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, second.id);
  assert.equal(fs.existsSync(path.join(getFilesDir(poolName), first.id)), false);
  assert.equal(fs.existsSync(path.join(getFilesDir(poolName), second.id)), true);
});

test('clearAllEntries removes every record and physical file', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);
  const first = await manager.stageBinaryFile(new Uint8Array([1]), {
    filename: 'a.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+alpha',
    workspaceName: 'ws-a',
    path: '/tmp/a.txt'
  });
  const second = await manager.stageBinaryFile(new Uint8Array([2]), {
    filename: 'b.txt',
    size: 1,
    remoteAuthority: 'ssh-remote+beta',
    workspaceName: 'ws-b',
    path: '/tmp/b.txt'
  });

  const deletedCount = await manager.clearAllEntries();
  assert.equal(deletedCount, 2);

  const list = await manager.listEntries();
  assert.equal(list.length, 0);
  assert.equal(fs.existsSync(path.join(getFilesDir(poolName), first.id)), false);
  assert.equal(fs.existsSync(path.join(getFilesDir(poolName), second.id)), false);
});

test('persists remote host and docker source metadata', async (t) => {
  const poolName = createPoolName();
  t.after(() => cleanupPool(poolName));

  const manager = new StagingManager(poolName);
  await manager.stageBinaryFile(new Uint8Array([7]), {
    filename: 'docker.txt',
    size: 1,
    remoteAuthority: 'attached-container+9f8a7b6c5d4e',
    remoteHost: 'prod-jump-01',
    workspaceName: 'ws-docker',
    path: '/workspace/docker.txt',
    dockerContainer: 'payments-api',
    dockerContainerId: '9f8a7b6c5d4e1234567890abcdef1234567890abcdef1234567890abcdef1234'
  });

  const list = await manager.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].remoteHost, 'prod-jump-01');
  assert.equal(list[0].dockerContainer, 'payments-api');
  assert.ok(list[0].dockerContainerId?.startsWith('9f8a7b6c5d4e'));
});
