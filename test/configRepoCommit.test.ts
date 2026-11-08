import assert from "node:assert/strict";
import path from "node:path";
import { ConfigRepoManager } from "../src/core/configRepoManager";
import { GitCli, GitCommandError } from "../src/core/git";

class CommitGit extends GitCli {
  readonly calls: string[][] = [];
  diffError?: Error;
  commitError?: Error;
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === "diff" && this.diffError) throw this.diffError;
    if (args[0] === "commit" && this.commitError) throw this.commitError;
    return "";
  }
}
const logger = { info() {}, warn() {}, error() {} };

describe("config repository commit outcomes", () => {
  const repo = { repoPath: path.resolve("test-cache"), branch: "main" };
  const projectPath = path.join(repo.repoPath, "projects", "example");
  it("returns false as success when staging has no differences", async () => {
    const git = new CommitGit();
    const manager = new ConfigRepoManager(repo.repoPath, git, logger);
    assert.equal(await manager.commitProjectChanges(repo, projectPath, "sync"), false);
    assert.deepEqual(git.calls.map(args => args[0]), ["add", "diff"]);
  });
  it("commits and pushes only when diff exits with 1", async () => {
    const git = new CommitGit();
    git.diffError = new GitCommandError("diff", "", "", 1);
    const manager = new ConfigRepoManager(repo.repoPath, git, logger);
    assert.equal(await manager.commitProjectChanges(repo, projectPath, "sync"), true);
    assert.ok(git.calls.some(args => args[0] === "commit"));
    assert.ok(git.calls.some(args => args[0] === "push"));
  });
  it("propagates fatal diff errors instead of treating them as changes", async () => {
    const git = new CommitGit();
    git.diffError = new GitCommandError("diff", "fatal: index cannot be read", "", 128);
    const manager = new ConfigRepoManager(repo.repoPath, git, logger);
    await assert.rejects(manager.commitProjectChanges(repo, projectPath, "sync"), error => error === git.diffError);
    assert.ok(!git.calls.some(args => ["commit", "push"].includes(args[0])));
  });
  it("propagates spawn errors instead of returning a successful no-op", async () => {
    const git = new CommitGit();
    git.diffError = new Error("spawn failed");
    const manager = new ConfigRepoManager(repo.repoPath, git, logger);
    await assert.rejects(manager.commitProjectChanges(repo, projectPath, "sync"), /spawn failed/);
    assert.ok(!git.calls.some(args => ["commit", "push"].includes(args[0])));
  });
  it("propagates commit failures and never pushes afterward", async () => {
    const git = new CommitGit();
    git.diffError = new GitCommandError("diff", "", "", 1);
    git.commitError = new GitCommandError("commit", "commit rejected", "", 1);
    const manager = new ConfigRepoManager(repo.repoPath, git, logger);
    await assert.rejects(manager.commitProjectChanges(repo, projectPath, "sync"), error => error === git.commitError);
    assert.ok(!git.calls.some(args => args[0] === "push"));
  });
});
