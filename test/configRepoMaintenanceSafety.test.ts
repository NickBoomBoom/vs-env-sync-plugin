import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRepoManager } from "../src/core/configRepoManager";
import { ConfigRepoMaintenance } from "../src/core/configRepoMaintenance";
import { GitCli, GitRunOptions } from "../src/core/git";

class MaintenanceGit extends GitCli {
  readonly calls: string[][] = [];
  abortFails = false;
  async run(args: string[], options: GitRunOptions = {}): Promise<string> {
    this.calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return options.cwd!;
    if (args[0] === "rev-parse" && args[1] === "--git-path") return `.git/${args[2]}`;
    if (args[0] === "branch") return "main";
    if (args[0] === "stash") return "stash@{0}: saved before sync";
    if (args[0] === "rebase") {
      if (this.abortFails) throw new Error("abort failed");
      await fs.rm(path.join(options.cwd!, ".git", "rebase-merge"), { recursive: true });
    }
    return "";
  }
}
const logger = { info() {}, warn() {}, error() {} };
const settings = { repoUrl: "https://example.com/private/config.git", branch: "main" };

describe("config repo maintenance safety", function () {
  this.timeout(15000);
  let root: string;
  let git: MaintenanceGit;
  let manager: ConfigRepoManager;
  let maintenance: ConfigRepoMaintenance;
  let repo: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "env-maintenance-safety-"));
    git = new MaintenanceGit();
    manager = new ConfigRepoManager(root, git, logger);
    maintenance = new ConfigRepoMaintenance(root, manager, git, logger);
    repo = manager.getRepoPath(settings);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function seed(): Promise<void> {
    await fs.mkdir(path.join(repo, ".git", "rebase-merge"), { recursive: true });
    await fs.writeFile(path.join(repo, ".git", "rebase-merge", "head-name"), "refs/heads/main");
    await fs.writeFile(path.join(repo, ".env.local"), "SECRET=preserve\n");
  }
  it("does not create or mutate an absent cache", async () => {
    assert.equal((await maintenance.diagnose(settings)).exists, false);
    const result = await maintenance.repair(settings, async () => { throw new Error("must not prompt"); });
    assert.equal(result.outcome, "not-needed");
    assert.equal(git.calls.length, 0);
    await assert.rejects(fs.access(repo));
  });
  it("diagnoses an existing cache without network or working-tree writes", async () => {
    await seed();
    const diagnosis = await maintenance.diagnose(settings);
    assert.equal(diagnosis.repoPath, repo);
    assert.equal(diagnosis.currentBranch, "main");
    assert.equal(diagnosis.rebase, "rebase-merge");
    assert.match(diagnosis.stashes!, /saved before sync/);
    assert.ok(git.calls.some(args => args[0] === "--no-optional-locks" && args[1] === "status"));
    assert.ok(!git.calls.some(args => ["clone", "fetch", "checkout", "rebase", "push", "reset"].includes(args[0])));
    assert.equal(await fs.readFile(path.join(repo, ".env.local"), "utf8"), "SECRET=preserve\n");
  });
  it("rechecks the operation after confirmation before making a backup", async () => {
    await seed();
    const result = await maintenance.repair(settings, async () => {
      await fs.rm(path.join(repo, ".git", "rebase-merge"), { recursive: true });
      return true;
    });
    assert.equal(result.outcome, "not-needed");
    assert.ok(!git.calls.some(args => args[0] === "rebase"));
    await assert.rejects(fs.access(path.join(root, "repair-backups")));
  });
  it("cancellation preserves the rebase and creates no backup", async () => {
    await seed();
    assert.equal((await maintenance.repair(settings, async () => false)).outcome, "cancelled");
    assert.ok((await fs.stat(path.join(repo, ".git", "rebase-merge"))).isDirectory());
    assert.ok(!git.calls.some(args => args[0] === "rebase"));
    await assert.rejects(fs.access(path.join(root, "repair-backups")));
  });
  it("backs up Git state and sensitive untracked files before aborting", async () => {
    await seed();
    const result = await maintenance.repair(settings, async () => true);
    assert.equal(result.outcome, "repaired");
    if (result.outcome !== "repaired") throw new Error("repair expected");
    assert.equal(await fs.readFile(path.join(result.backupPath, ".env.local"), "utf8"), "SECRET=preserve\n");
    assert.equal(await fs.readFile(path.join(result.backupPath, ".git", "rebase-merge", "head-name"), "utf8"), "refs/heads/main");
    await assert.rejects(fs.access(path.join(repo, ".git", "rebase-merge")));
    assert.ok(!git.calls.some(args => ["push", "fetch", "reset", "clean"].includes(args[0])));
    assert.ok(!git.calls.some(args => args[0] === "stash" && args[1] !== "list"));
  });
  it("does not abort when the backup destination cannot be created", async () => {
    await seed();
    await fs.writeFile(path.join(root, "repair-backups"), "blocked");
    await assert.rejects(maintenance.repair(settings, async () => true));
    assert.ok(!git.calls.some(args => args[0] === "rebase"));
    assert.ok((await fs.stat(path.join(repo, ".git", "rebase-merge"))).isDirectory());
  });
  it("rejects a linked Git directory before prompting or mutation", async () => {
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, ".git"), "gitdir: ../outside");
    await assert.rejects(maintenance.repair(settings, async () => { throw new Error("must not prompt"); }), /已停止维护/);
    assert.ok(!git.calls.some(args => args[0] === "rebase"));
  });
  it("does not prompt or back up a healthy cache", async () => {
    await seed();
    await fs.rm(path.join(repo, ".git", "rebase-merge"), { recursive: true });
    const result = await maintenance.repair(settings, async () => { throw new Error("must not prompt"); });
    assert.equal(result.outcome, "not-needed");
    await assert.rejects(fs.access(path.join(root, "repair-backups")));
  });
  it("recovers a real conflicting rebase while retaining commits and stashes", async function () {
    this.timeout(60000);
    await fs.mkdir(repo, { recursive: true });
    const realGit = new GitCli();
    const run = (...args: string[]) => realGit.run(args, { cwd: repo });
    await run("init", "--initial-branch=main");
    await run("config", "user.email", "test@example.com");
    await run("config", "user.name", "Recovery Test");
    await run("config", "core.autocrlf", "false");
    await fs.writeFile(path.join(repo, "config.txt"), "base\n");
    await run("add", ".");
    await run("commit", "-m", "base");
    await run("checkout", "-b", "topic");
    await fs.writeFile(path.join(repo, "config.txt"), "topic\n");
    await run("commit", "-am", "topic");
    await run("checkout", "main");
    await fs.writeFile(path.join(repo, "config.txt"), "main\n");
    await run("commit", "-am", "main");
    const originalHead = await run("rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, ".env.saved"), "SECRET=stashed\n");
    await run("stash", "push", "--include-untracked", "-m", "preserve me");
    const originalStash = await run("rev-parse", "refs/stash");
    await assert.rejects(run("rebase", "topic"));
    const realManager = new ConfigRepoManager(root, realGit, logger);
    const realMaintenance = new ConfigRepoMaintenance(root, realManager, realGit, logger);
    const result = await realMaintenance.repair(settings, async diagnosis => {
      assert.equal(diagnosis.rebase, "rebase-merge");
      return true;
    });
    assert.equal(result.outcome, "repaired");
    if (result.outcome !== "repaired") throw new Error("repair expected");
    assert.equal(await run("rev-parse", "HEAD"), originalHead);
    assert.equal(await run("rev-parse", "refs/stash"), originalStash);
    assert.equal(await run("branch", "--show-current"), "main");
    assert.ok((await fs.stat(path.join(result.backupPath, ".git", "rebase-merge"))).isDirectory());
    assert.equal((await realMaintenance.diagnose(settings)).rebase, undefined);
  });
  it("preserves the full backup and reports its path when Git abort fails", async () => {
    await seed();
    git.abortFails = true;
    await assert.rejects(maintenance.repair(settings, async () => true), /备份已保留/);
    const backups = await fs.readdir(path.join(root, "repair-backups"));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(root, "repair-backups", backups[0], "repository", ".env.local"), "utf8"), "SECRET=preserve\n");
    assert.ok((await fs.stat(path.join(repo, ".git", "rebase-merge"))).isDirectory());
  });
});
