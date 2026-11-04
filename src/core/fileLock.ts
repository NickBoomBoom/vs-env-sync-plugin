import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface FileLockOptions {
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
  initializationTimeoutMs?: number;
}

interface LockOwner {
  pid: number;
  ownerId: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileLock {
  private readonly retryDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly initializationTimeoutMs: number;

  constructor(private readonly baseStoragePath: string, options: FileLockOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 1_000;
  }

  async runExclusive<T>(repoKey: string, task: () => Promise<T>): Promise<T> {
    const keyHash = createHash("sha256").update(repoKey).digest("hex");
    const lockPath = path.join(this.baseStoragePath, "locks", `${keyHash}.lock`);
    const ownerId = randomUUID();
    await this.acquire(lockPath, ownerId);
    const heartbeat = setInterval(() => {
      void fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await task();
    } finally {
      clearInterval(heartbeat);
      await this.release(lockPath, ownerId);
    }
  }

  private async acquire(lockPath: string, ownerId: string): Promise<void> {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    while (true) {
      const owner: LockOwner = { pid: process.pid, ownerId };
      const temporaryPath = `${lockPath}.${process.pid}.${ownerId}.tmp`;
      let linked = false;
      try {
        await fs.writeFile(temporaryPath, JSON.stringify(owner));
        await fs.link(temporaryPath, lockPath);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await fs.rm(temporaryPath, { force: true });
          throw error;
        }
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }

      if (linked) {
        const confirmedOwner = await this.readOwner(lockPath);
        if (confirmedOwner?.ownerId === ownerId) {
          return;
        }
        continue;
      }

      const currentOwner = await this.readOwner(lockPath);
      if (currentOwner && !processIsAlive(currentOwner.pid)) {
        await this.removeDeadLock(lockPath, currentOwner.ownerId);
        continue;
      }
      if (!currentOwner && (await this.initializationExpired(lockPath))) {
        throw new Error(`配置仓库锁文件损坏，请手动清理：${lockPath}`);
      }
      await delay(this.retryDelayMs);
    }
  }

  private async readOwner(lockPath: string): Promise<LockOwner | undefined> {
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockOwner>;
      if (Number.isInteger(owner.pid) && owner.pid! > 0 && typeof owner.ownerId === "string" && owner.ownerId.length > 0) {
        return { pid: owner.pid!, ownerId: owner.ownerId };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async initializationExpired(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs >= this.initializationTimeoutMs;
    } catch {
      return false;
    }
  }

  private async removeDeadLock(lockPath: string, expectedOwnerId: string | undefined): Promise<void> {
    const currentOwner = await this.readOwner(lockPath);
    if (expectedOwnerId ? currentOwner?.ownerId !== expectedOwnerId : currentOwner !== undefined) {
      return;
    }

    const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch {
      return;
    }

    const movedOwner = await this.readOwner(stalePath);
    const removedExpectedOwner = expectedOwnerId
      ? movedOwner?.ownerId === expectedOwnerId
      : movedOwner === undefined;
    if (!removedExpectedOwner) {
      try {
        await fs.link(stalePath, lockPath);
      } catch {
        // Another waiter may already have restored or replaced the lock.
      }
      await fs.rm(stalePath, { force: true });
      return;
    }
    await fs.rm(stalePath, { force: true });
  }

  private async release(lockPath: string, ownerId: string): Promise<void> {
    const owner = await this.readOwner(lockPath);
    if (owner?.ownerId === ownerId) {
      await fs.unlink(lockPath);
    }
  }
}
