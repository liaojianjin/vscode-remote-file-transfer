import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FILE_SIZE_MB = 50;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
export const TTL_HOURS = 24;

const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_INTERVAL_MS = 120;
const STAGING_POOL_NAME = 'vscode-remote-file-transfer';
const STAGING_DB_FILENAME = 'staging.json';
const SESSIONS_DIR_NAME = 'sessions';
const SESSION_STALE_MS = 90_000;

export interface StagingEntry {
  id: string;
  filename: string;
  size: number;
  remoteAuthority: string;
  remoteHost?: string;
  workspaceName: string;
  path: string;
  dockerContainer?: string;
  dockerContainerId?: string;
  timestamp: number;
}

interface StageFileInput {
  filename: string;
  size: number;
  remoteAuthority: string;
  remoteHost?: string;
  workspaceName: string;
  path: string;
  dockerContainer?: string;
  dockerContainerId?: string;
}

export class StagingManager {
  private readonly stagingRootDir: string;
  private readonly stagingFilesDir: string;
  private readonly dbPath: string;
  private readonly lockPath: string;
  private readonly sessionsDir: string;

  constructor(poolName = STAGING_POOL_NAME) {
    this.stagingRootDir = path.join(os.tmpdir(), poolName);
    this.stagingFilesDir = path.join(this.stagingRootDir, 'files');
    this.dbPath = path.join(this.stagingRootDir, STAGING_DB_FILENAME);
    this.lockPath = path.join(this.stagingRootDir, '.lock');
    this.sessionsDir = path.join(this.stagingRootDir, SESSIONS_DIR_NAME);
  }

  public async stageBinaryFile(data: Uint8Array, metadata: StageFileInput): Promise<StagingEntry> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupExpiredAndOrphansSync();

      const entries = this.readDbSync();
      const replacementIndex = entries.findIndex(
        (entry) =>
          entry.remoteAuthority === metadata.remoteAuthority &&
          entry.path === metadata.path
      );

      const newEntry: StagingEntry = {
        id: randomUUID(),
        filename: metadata.filename,
        size: metadata.size,
        remoteAuthority: metadata.remoteAuthority,
        remoteHost: metadata.remoteHost,
        workspaceName: metadata.workspaceName,
        path: metadata.path,
        dockerContainer: metadata.dockerContainer,
        dockerContainerId: metadata.dockerContainerId,
        timestamp: Date.now()
      };

      const newFilePath = this.getPhysicalFilePath(newEntry.id);
      const binary = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      fs.writeFileSync(newFilePath, binary);

      const previousEntry = replacementIndex >= 0 ? entries[replacementIndex] : undefined;
      if (replacementIndex >= 0) {
        entries[replacementIndex] = newEntry;
      } else {
        entries.push(newEntry);
      }

      try {
        this.writeDbSync(entries);
      } catch (error) {
        this.safeRemoveFile(newFilePath);
        throw error;
      }

      if (previousEntry && previousEntry.id !== newEntry.id) {
        this.safeRemoveFile(this.getPhysicalFilePath(previousEntry.id));
      }

      return newEntry;
    });
  }

  public async listEntries(): Promise<StagingEntry[]> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupExpiredAndOrphansSync();
      return this.readDbSync().sort((a, b) => b.timestamp - a.timestamp);
    });
  }

  public async readStagedBinary(id: string): Promise<Buffer> {
    return this.withLock(() => {
      this.ensureStorageReady();
      const filePath = this.getPhysicalFilePath(id);
      if (!fs.existsSync(filePath)) {
        throw new Error(`暂存文件不存在: ${id}`);
      }
      return fs.readFileSync(filePath);
    });
  }

  public async cleanupExpiredAndOrphans(): Promise<void> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupExpiredAndOrphansSync();
    });
  }

  public async registerSession(sessionId: string): Promise<void> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupStaleSessionsSync();
      const isFirstSession = this.listSessionFilesSync().length === 0;
      if (isFirstSession) {
        this.clearAllEntriesSync();
      }
      const sessionFilePath = this.getSessionFilePath(sessionId);
      fs.writeFileSync(sessionFilePath, String(Date.now()), 'utf-8');
    });
  }

  public async touchSession(sessionId: string): Promise<void> {
    return this.withLock(() => {
      this.ensureStorageReady();
      const sessionFilePath = this.getSessionFilePath(sessionId);
      const now = new Date();
      if (!fs.existsSync(sessionFilePath)) {
        fs.writeFileSync(sessionFilePath, String(Date.now()), 'utf-8');
      } else {
        fs.utimesSync(sessionFilePath, now, now);
      }
      this.cleanupStaleSessionsSync();
    });
  }

  public async unregisterSessionAndCleanupIfLast(sessionId: string): Promise<boolean> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.safeRemoveFile(this.getSessionFilePath(sessionId));
      this.cleanupStaleSessionsSync();

      if (this.listSessionFilesSync().length > 0) {
        return false;
      }

      this.clearAllEntriesSync();
      return true;
    });
  }

  public async deleteEntriesByIds(ids: string[]): Promise<{ deleted: number; notFound: number }> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupExpiredAndOrphansSync();

      const targetIds = new Set(ids);
      if (targetIds.size === 0) {
        return { deleted: 0, notFound: 0 };
      }

      const entries = this.readDbSync();
      const keptEntries: StagingEntry[] = [];
      let deleted = 0;

      for (const entry of entries) {
        if (!targetIds.has(entry.id)) {
          keptEntries.push(entry);
          continue;
        }

        deleted += 1;
        this.safeRemoveFile(this.getPhysicalFilePath(entry.id));
      }

      if (deleted > 0) {
        this.writeDbSync(keptEntries);
      }

      return { deleted, notFound: targetIds.size - deleted };
    });
  }

  public async clearAllEntries(): Promise<number> {
    return this.withLock(() => {
      this.ensureStorageReady();
      this.cleanupExpiredAndOrphansSync();
      return this.clearAllEntriesSync();
    });
  }

  private ensureStorageReady(): void {
    fs.mkdirSync(this.stagingRootDir, { recursive: true });
    fs.mkdirSync(this.stagingFilesDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    if (!fs.existsSync(this.dbPath)) {
      this.writeDbSync([]);
    }
  }

  private readDbSync(): StagingEntry[] {
    if (!fs.existsSync(this.dbPath)) {
      return [];
    }

    const raw = fs.readFileSync(this.dbPath, 'utf-8');
    if (!raw.trim()) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`staging.json 解析失败: ${(error as Error).message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('staging.json 数据结构非法，根节点必须是数组');
    }

    return parsed.filter((item): item is StagingEntry => this.isValidEntry(item));
  }

  private writeDbSync(entries: StagingEntry[]): void {
    const tmpPath = `${this.dbPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');

    try {
      const stringData = JSON.stringify(entries, null, 2);
      fs.writeSync(fd, stringData, null, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tmpPath, this.dbPath);
    } catch (error) {
      this.safeRemoveFile(tmpPath);
      throw error;
    }
  }

  private cleanupExpiredAndOrphansSync(): void {
    const entries = this.readDbSync();
    const now = Date.now();
    let dbChanged = false;

    const aliveEntries: StagingEntry[] = [];
    for (const entry of entries) {
      const expired = now - entry.timestamp > TTL_MS;
      const filePath = this.getPhysicalFilePath(entry.id);

      if (expired) {
        dbChanged = true;
        this.safeRemoveFile(filePath);
        continue;
      }

      if (!fs.existsSync(filePath)) {
        dbChanged = true;
        continue;
      }

      aliveEntries.push(entry);
    }

    const referencedIds = new Set(aliveEntries.map((entry) => entry.id));
    const physicalFiles = fs.readdirSync(this.stagingFilesDir);

    for (const filename of physicalFiles) {
      const filePath = path.join(this.stagingFilesDir, filename);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      if (!referencedIds.has(filename)) {
        this.safeRemoveFile(filePath);
      }
    }

    if (dbChanged) {
      this.writeDbSync(aliveEntries);
    }
  }

  private getPhysicalFilePath(id: string): string {
    return path.join(this.stagingFilesDir, id);
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.session`);
  }

  private async withLock<T>(task: () => T | Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await task();
    } finally {
      this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    fs.mkdirSync(this.stagingRootDir, { recursive: true });
    const startAt = Date.now();

    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        return;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'EEXIST') {
          throw new Error(`创建锁失败: ${nodeError.message}`);
        }

        let stale = false;
        try {
          const lockStat = fs.statSync(this.lockPath);
          stale = Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
        } catch (statError) {
          const statNodeError = statError as NodeJS.ErrnoException;
          if (statNodeError.code === 'ENOENT') {
            continue;
          }
          throw new Error(`检查锁状态失败: ${statNodeError.message}`);
        }

        if (stale) {
          try {
            fs.rmSync(this.lockPath, { recursive: true, force: true });
          } catch (rmError) {
            if (fs.existsSync(this.lockPath)) {
              throw new Error(`接管死锁失败: ${(rmError as Error).message}`);
            }
          }

          if (fs.existsSync(this.lockPath)) {
            throw new Error('接管死锁失败: rmSync 后锁仍存在');
          }
          continue;
        }

        if (Date.now() - startAt > LOCK_ACQUIRE_TIMEOUT_MS) {
          throw new Error('获取锁超时');
        }

        await delay(LOCK_RETRY_INTERVAL_MS);
      }
    }
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  private isValidEntry(item: unknown): item is StagingEntry {
    if (!item || typeof item !== 'object') {
      return false;
    }

    const entry = item as Record<string, unknown>;
    return (
      typeof entry.id === 'string' &&
      typeof entry.filename === 'string' &&
      typeof entry.size === 'number' &&
      typeof entry.remoteAuthority === 'string' &&
      (typeof entry.remoteHost === 'undefined' || typeof entry.remoteHost === 'string') &&
      typeof entry.workspaceName === 'string' &&
      typeof entry.path === 'string' &&
      (typeof entry.dockerContainer === 'undefined' || typeof entry.dockerContainer === 'string') &&
      (typeof entry.dockerContainerId === 'undefined' || typeof entry.dockerContainerId === 'string') &&
      typeof entry.timestamp === 'number'
    );
  }

  private safeRemoveFile(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
  }

  private clearAllEntriesSync(): number {
    const entries = this.readDbSync();
    if (entries.length === 0) {
      return 0;
    }

    for (const entry of entries) {
      this.safeRemoveFile(this.getPhysicalFilePath(entry.id));
    }

    this.writeDbSync([]);
    return entries.length;
  }

  private cleanupStaleSessionsSync(): void {
    for (const filename of this.listSessionFilesSync()) {
      const sessionPath = path.join(this.sessionsDir, filename);
      try {
        const stat = fs.statSync(sessionPath);
        const isStale = Date.now() - stat.mtimeMs > SESSION_STALE_MS;
        if (isStale) {
          this.safeRemoveFile(sessionPath);
        }
      } catch {
        // ignore
      }
    }
  }

  private listSessionFilesSync(): string[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }

    return files.filter((filename) => {
      const filePath = path.join(this.sessionsDir, filename);
      try {
        return fs.statSync(filePath).isFile() && filename.endsWith('.session');
      } catch {
        return false;
      }
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
