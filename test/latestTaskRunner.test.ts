import assert from "node:assert/strict";

import { LatestTaskRunner } from "../src/core/latestTaskRunner";

describe("LatestTaskRunner", () => {
  it("coalesces reentrant tasks without running them in parallel", async () => {
    const runner = new LatestTaskRunner();
    const executed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: () => void = () => {};
    const first = runner.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      executed.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      executed.push("first:end");
      active -= 1;
    });
    const second = runner.run(async () => {
      executed.push("second");
    });
    const third = runner.run(async () => {
      executed.push("third");
    });
    releaseFirst();
    await Promise.all([first, second, third]);

    assert.equal(maximumActive, 1);
    assert.deepEqual(executed, ["first:start", "first:end", "third"]);
  });

  it("releases the runner after a task fails", async () => {
    const runner = new LatestTaskRunner();
    await assert.rejects(runner.run(async () => {
      throw new Error("failed");
    }), /failed/);
    await runner.run(async () => {});
  });
});
