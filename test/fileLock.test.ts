import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileLock } from "../src/core/fileLock";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("FileLock", () => {
  it("serializes tasks and releases after failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-"));
    const first = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });
    const second = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });
    let active = 0;
    let maximumActive = 0;
    let firstResult = 0;

    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstTask = first.runExclusive("repo", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      markStarted();
      await delay(30);
      firstResult = 42;
      active -= 1;
    });
    await started;
    const secondTask = second.runExclusive("repo", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.equal(firstResult, 42);
      active -= 1;
    });
    await Promise.all([firstTask, secondTask]);

    assert.equal(maximumActive, 1);
    await assert.rejects(first.runExclusive("repo", async () => {
      throw new Error("task failed");
    }), /task failed/);
    assert.equal(await second.runExclusive("repo", async () => "released"), "released");
  });

  it("does not steal a stale lease while the owner process is alive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-live-"));
    const first = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });
    const second = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });
    let releaseFirst: () => void = () => {};
    let secondCompleted = false;
    const firstTask = first.runExclusive("repo", async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await delay(20);
    const lockPath = path.join(root, "locks", `${createHash("sha256").update("repo").digest("hex")}.lock`);
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const secondTask = second.runExclusive("repo", async () => {
      secondCompleted = true;
    });
    await delay(30);
    assert.equal(secondCompleted, false);
    releaseFirst();
    await Promise.all([firstTask, secondTask]);
    assert.equal(secondCompleted, true);
  });

  it("recovers a lock owned by a dead process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-dead-"));
    const lockPath = path.join(root, "locks", `${createHash("sha256").update("repo").digest("hex")}.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99_999_999, ownerId: "dead" }));
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const lock = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });

    assert.equal(await lock.runExclusive("repo", async () => "recovered"), "recovered");
  });

  it("recovers an empty lock left by an initialization crash", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-empty-"));
    const lockPath = path.join(root, "locks", `${createHash("sha256").update("repo").digest("hex")}.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "");
    await fs.utimes(lockPath, new Date(0), new Date(0));
    const lock = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10, initializationTimeoutMs: 10 });

    assert.equal(await lock.runExclusive("repo", async () => "recovered"), "recovered");
  });

  it("does not remove a newly acquired lock while racing to recover a dead owner", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-recovery-race-"));
      const lockPath = path.join(root, "locks", `${createHash("sha256").update("repo").digest("hex")}.lock`);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify({ pid: 99_999_999, ownerId: "dead" }));
      const first = new FileLock(root, { retryDelayMs: 1, heartbeatIntervalMs: 5 });
      const second = new FileLock(root, { retryDelayMs: 1, heartbeatIntervalMs: 5 });
      let active = 0;
      let maximumActive = 0;
      const run = (lock: FileLock) => lock.runExclusive("repo", async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(2);
        active -= 1;
      });
      await Promise.all([run(first), run(second)]);
      assert.equal(maximumActive, 1);
    }
  });

  it("publishes complete owner data before starting the locked task", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-lock-owner-"));
    const lockPath = path.join(root, "locks", `${createHash("sha256").update("repo").digest("hex")}.lock`);
    const lock = new FileLock(root, { retryDelayMs: 5, heartbeatIntervalMs: 10 });

    await lock.runExclusive("repo", async () => {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number; ownerId: string };
      assert.equal(owner.pid, process.pid);
      assert.ok(owner.ownerId.length > 0);
    });
  });
});
