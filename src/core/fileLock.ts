import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface FileLockOptions {
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
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

  constructor(private readonly baseStoragePath: string, options: FileLockOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
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
      const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
      try {
        await fs.mkdir(candidatePath);
        const owner: LockOwner = { pid: process.pid, ownerId };
        await fs.writeFile(path.join(candidatePath, "owner.json"), JSON.stringify(owner));
        await fs.rename(candidatePath, lockPath);
        return;
      } catch (error) {
        await fs.rm(candidatePath, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") {
          throw error;
        }
      }

      if (!(await this.ownerIsAlive(lockPath))) {
        await this.removeDeadLock(lockPath);
        continue;
      }
      await delay(this.retryDelayMs);
    }
  }

  private async ownerIsAlive(lockPath: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner;
      return processIsAlive(owner.pid);
    } catch {
      return true;
    }
  }

  private async removeDeadLock(lockPath: string): Promise<void> {
    const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
    }
  }

  private async release(lockPath: string, ownerId: string): Promise<void> {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as LockOwner;
      if (owner.ownerId === ownerId) {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
