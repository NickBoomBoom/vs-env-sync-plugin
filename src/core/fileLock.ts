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
      try {
        await fs.mkdir(lockPath);
        try {
          const owner: LockOwner = { pid: process.pid, ownerId };
          await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner));
          return;
        } catch (error) {
          await fs.rm(lockPath, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const owner = await this.readOwner(lockPath);
      if (owner && !processIsAlive(owner.pid)) {
        await this.removeDeadLock(lockPath, owner.ownerId);
        continue;
      }
      if (!owner && (await this.initializationExpired(lockPath))) {
        await this.removeDeadLock(lockPath, undefined);
        continue;
      }
      await delay(this.retryDelayMs);
    }
  }

  private async readOwner(lockPath: string): Promise<LockOwner | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner;
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
        await fs.rename(stalePath, lockPath);
      } catch {
        // Another waiter may already have restored or replaced the lock.
      }
      return;
    }
    await fs.rm(stalePath, { recursive: true, force: true });
  }

  private async release(lockPath: string, ownerId: string): Promise<void> {
    try {
      const owner = await this.readOwner(lockPath);
      if (owner?.ownerId === ownerId) {
        await fs.unlink(path.join(lockPath, "owner.json"));
        await fs.rmdir(lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
