import assert from "node:assert/strict";

import { processPendingProjects } from "../src/core/pendingProjects";

describe("pendingProjects", () => {
  it("continues other projects and retains only failed paths", async () => {
    const pending = new Set(["a", "b"]);
    const completed: string[] = [];
    const failures: string[] = [];

    const succeeded = await processPendingProjects(pending, async (projectPath) => {
      if (projectPath === "a") {
        throw new Error("failed");
      }
      completed.push(projectPath);
    }, (projectPath) => {
      failures.push(projectPath);
    });

    assert.equal(succeeded, false);
    assert.deepEqual(completed, ["b"]);
    assert.deepEqual(failures, ["a"]);
    assert.deepEqual(pending, new Set(["a"]));
  });

  it("removes successful paths from the pending set", async () => {
    const pending = new Set(["a", "b"]);
    const succeeded = await processPendingProjects(pending, async () => {}, () => {});
    assert.equal(succeeded, true);
    assert.equal(pending.size, 0);
  });
});
