import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRepoManager } from "../src/core/configRepoManager";
import { GitCli } from "../src/core/git";

class RecoveryGit extends GitCli {
  readonly calls: string[][] = [];
  failRebase = false;
  async run(args: string[], options: { cwd?: string } = {}): Promise<string> {
    this.calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--git-path") return `.git/${args[2]}`;
    if (args[0] === "branch") return "main";
    if (args[0] === "show-ref") return "";
    if (args[0] === "rev-list") return "0";
    if (args[0] === "rebase" && args[1] === "origin/main" && this.failRebase) {
      await fs.mkdir(path.join(options.cwd!, ".git", "rebase-merge"), { recursive: true });
      throw new Error("rebase conflict");
    }
    if (args[0] === "rebase" && args[1] === "--abort") {
      await fs.rmdir(path.join(options.cwd!, ".git", "rebase-merge"));
    }
    return "";
  }
}
const logger = { info() {}, warn() {}, error() {} };

describe("config repo rebase recovery", () => {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    it(`preserves existing ${state} and reports the actual config repo`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-rebase-"));
      try {
        await fs.mkdir(path.join(root, ".git", state), { recursive: true });
        const git = new RecoveryGit();
        const manager = new ConfigRepoManager(root, git, logger);
        await assert.rejects(manager.refresh({ repoPath: root, branch: "main" }), (error: Error) => {
          assert.ok(error.message.includes(root));
          assert.ok(error.message.includes("git rebase --abort"));
          return true;
        });
        assert.ok(!git.calls.some(args => ["checkout", "fetch", "stash", "rebase"].includes(args[0])));
        assert.ok((await fs.stat(path.join(root, ".git", state))).isDirectory());
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
  it("aborts only its own failed rebase and allows the next refresh", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-rebase-"));
    try {
      const git = new RecoveryGit();
      git.failRebase = true;
      const manager = new ConfigRepoManager(root, git, logger);
      await assert.rejects(manager.refresh({ repoPath: root, branch: "main" }), /rebase conflict/);
      assert.ok(git.calls.some(args => args[0] === "rebase" && args[1] === "--abort"));
      git.failRebase = false;
      await manager.refresh({ repoPath: root, branch: "main" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
