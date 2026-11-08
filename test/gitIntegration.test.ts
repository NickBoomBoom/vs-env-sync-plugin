import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { GitCli, GitCommandError } from "../src/core/git";
import { compilePathRegexes } from "../src/core/pathRegex";
import { SyncStateStore } from "../src/core/syncStateStore";
import { branchDirectoryName, hashedBranchStorePath } from "../src/core/storagePaths";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

function readableBranchFile(branch: string, ...relativePaths: string[]): string {
  return path.join("projects", "github.com", "team", "app", "branches", branchDirectoryName(branch), ...relativePaths);
}

class TestLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class TestPrompts implements SyncPrompts {
  async chooseLocalOnly(): Promise<"upload" | "skip"> {
    return "upload";
  }

  async chooseConflict(): Promise<"pull" | "upload" | "skip"> {
    return "upload";
  }
}

async function git(gitCli: GitCli, cwd: string, ...args: string[]): Promise<string> {
  return gitCli.run(args, { cwd });
}

async function createBareRepo(basePath: string, name: string, gitCli: GitCli): Promise<string> {
  const repoPath = path.join(basePath, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(gitCli, repoPath, "init", "--bare");
  return repoPath;
}

async function cloneRepo(basePath: string, remotePath: string, name: string, gitCli: GitCli): Promise<string> {
  const repoPath = path.join(basePath, name);
  await gitCli.run(["clone", remotePath, repoPath]);
  await git(gitCli, repoPath, "config", "user.email", "test@example.com");
  await git(gitCli, repoPath, "config", "user.name", "Test User");
  return repoPath;
}

async function createInitialCommit(repoPath: string, gitCli: GitCli, filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, filePath)), { recursive: true });
  await fs.writeFile(path.join(repoPath, filePath), content);
  await git(gitCli, repoPath, "add", "-A");
  await git(gitCli, repoPath, "commit", "-m", "initial");
  await git(gitCli, repoPath, "branch", "-M", "main");
  await git(gitCli, repoPath, "push", "-u", "origin", "main");
}

function createContext(workspacePath: string): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "workspace",
    branch: "main",
    project: {
      host: "github.com",
      owner: "team",
      repo: "app",
      path: "team/app",
      slug: "github.com/team/app"
    },
    pathRegexSources: ["^\\.env[^/]*$"],
    pathRegexes: compilePathRegexes(["^\\.env[^/]*$"]),
    ignoredProjectRoots: [],
    ignoredDirectoryNames: []
  };
}

describe("git integration", () => {
  it("clones, pulls and pushes env changes through the config repo manager", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(
      seedClone,
      gitCli,
      readableBranchFile("main", ".env.local"),
      "REMOTE=1\n"
    );

    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });

    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const engine = new EnvSyncEngine(manager, new TestPrompts(), new TestLogger(), new SyncStateStore(path.join(root, "state")));
    const settings = {
      repoUrl: bareConfigRepo,
      branch: "main"
    };

    const openResult = await engine.syncOnWorkspaceOpen(settings, createContext(workspacePath));
    assert.deepEqual(openResult, {
      uploadedPaths: [],
      pulledPaths: [".env.local"],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(workspacePath, ".env.local"), "utf8"), "REMOTE=1\n");

    const readyConfigRepo = await manager.ensureReady(settings);
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.name", "Test User");

    await fs.writeFile(path.join(workspacePath, ".env.local"), "REMOTE=2\n");
    const pushResult = await engine.syncLocalChanges(settings, createContext(workspacePath));
    assert.deepEqual(pushResult, {
      pushedPaths: [".env.local"],
      deletedPaths: [],
      pulledPaths: [],
      deletedLocalPaths: [],
      skippedPaths: [],
      committed: true
    });

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    await git(gitCli, verifyClone, "checkout", "main");
    assert.equal(
      await fs.readFile(path.join(verifyClone, readableBranchFile("main", ".env.local")), "utf8"),
      "REMOTE=2\n"
    );
  });

  it("pushes inherited legacy data without removing the legacy files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-inherit-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(
      seedClone,
      gitCli,
      path.join("projects", "github.com", "team", "app", ".env.local"),
      "SHARED=1\n"
    );

    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const engine = new EnvSyncEngine(manager, new TestPrompts(), new TestLogger());
    const settings = { repoUrl: bareConfigRepo, branch: "main" };
    const readyConfigRepo = await manager.ensureReady(settings);
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.name", "Test User");

    const openResult = await engine.syncOnWorkspaceOpen(settings, createContext(workspacePath));
    assert.deepEqual(openResult.pulledPaths, [".env.local"]);

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    const legacyFile = path.join(verifyClone, "projects", "github.com", "team", "app", ".env.local");
    const branchFile = path.join(verifyClone, readableBranchFile("main", ".env.local"));
    assert.equal(await fs.readFile(legacyFile, "utf8"), "SHARED=1\n");
    assert.equal(await fs.readFile(branchFile, "utf8"), "SHARED=1\n");
  });

  it("pushes changes while preserving uncommitted files in the config repo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-dirty-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    const legacyProjectFile = path.join("projects", "github.com", "team", "app", ".env");
    await createInitialCommit(
      seedClone,
      gitCli,
      legacyProjectFile,
      "SHARED=1\nKEEP1=1\nKEEP2=1\nKEEP3=1\nREMOTE=1\n"
    );

    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=2\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const engine = new EnvSyncEngine(manager, new TestPrompts(), new TestLogger());
    const settings = { repoUrl: bareConfigRepo, branch: "main" };
    const readyConfigRepo = await manager.ensureReady(settings);
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, readyConfigRepo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(seedClone, legacyProjectFile), "SHARED=1\nKEEP1=1\nKEEP2=1\nKEEP3=1\nREMOTE=2\n");
    await git(gitCli, seedClone, "add", "-A");
    await git(gitCli, seedClone, "commit", "-m", "remote update");
    await git(gitCli, seedClone, "push");
    await git(gitCli, readyConfigRepo.repoPath, "fetch", "--prune", "origin");
    await fs.writeFile(
      path.join(readyConfigRepo.repoPath, legacyProjectFile),
      "UNCOMMITTED=1\nKEEP1=1\nKEEP2=1\nKEEP3=1\nREMOTE=1\n"
    );

    const pushResult = await engine.syncLocalChanges(settings, createContext(workspacePath));

    assert.deepEqual(pushResult, {
      pushedPaths: [".env"],
      deletedPaths: [],
      pulledPaths: [],
      deletedLocalPaths: [],
      skippedPaths: [],
      committed: true
    });
    assert.equal(
      await fs.readFile(path.join(readyConfigRepo.repoPath, legacyProjectFile), "utf8"),
      "UNCOMMITTED=1\nKEEP1=1\nKEEP2=1\nKEEP3=1\nREMOTE=2\n"
    );
    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    assert.equal(
      await fs.readFile(path.join(verifyClone, readableBranchFile("main", ".env")), "utf8"),
      "LOCAL=2\n"
    );
  });

  it("commits only the current project and preserves other index changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-scope-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    const branchFile = readableBranchFile("main", ".env");
    await fs.mkdir(path.dirname(path.join(repo.repoPath, branchFile)), { recursive: true });
    await fs.writeFile(path.join(repo.repoPath, branchFile), "CURRENT=1\n");
    await fs.writeFile(path.join(repo.repoPath, "other.txt"), "OTHER=1\n");
    await fs.writeFile(path.join(repo.repoPath, "README.md"), "LOCAL=1\n");
    await git(gitCli, repo.repoPath, "add", "other.txt");

    await manager.commitProjectChanges(repo, path.dirname(path.join(repo.repoPath, branchFile)), "current project");

    const committedFiles = await git(gitCli, repo.repoPath, "show", "--name-only", "--format=", "HEAD");
    assert.equal(committedFiles, branchFile.replace(/\\/g, "/"));
    assert.equal(await git(gitCli, repo.repoPath, "diff", "--cached", "--name-only"), "other.txt");
    assert.equal(await fs.readFile(path.join(repo.repoPath, "README.md"), "utf8"), "LOCAL=1\n");
  });

  it("preserves local commits when switching back to an existing config branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-local-branch-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const settings = { repoUrl: bareConfigRepo, branch: "main" };
    const repo = await manager.ensureReady(settings);
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(repo.repoPath, "local.txt"), "LOCAL=1\n");
    await git(gitCli, repo.repoPath, "add", "local.txt");
    await git(gitCli, repo.repoPath, "commit", "-m", "local commit");
    const localCommit = await git(gitCli, repo.repoPath, "rev-parse", "main");
    await git(gitCli, repo.repoPath, "checkout", "-b", "other");

    await manager.ensureReady(settings);

    assert.equal(await git(gitCli, repo.repoPath, "rev-parse", "main"), localCommit);
    assert.equal(await fs.readFile(path.join(repo.repoPath, "local.txt"), "utf8"), "LOCAL=1\n");
  });

  it("retries an ahead commit during a later refresh without file changes", async () => {
    class FailNextPushGitCli extends GitCli {
      private failures = 0;
      failNextPush(): void {
        this.failures = 3;
      }
      async run(args: string[], options: { cwd?: string } = {}): Promise<string> {
        if (args[0] === "push" && this.failures > 0) {
          this.failures -= 1;
          throw new GitCommandError("push failed", "non-fast-forward", "", 1);
        }
        return super.run(args, options);
      }
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-retry-"));
    const gitCli = new FailNextPushGitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(repo.repoPath, "ahead.txt"), "AHEAD=1\n");
    await git(gitCli, repo.repoPath, "add", "ahead.txt");
    await git(gitCli, repo.repoPath, "commit", "-m", "ahead commit");

    gitCli.failNextPush();
    await assert.rejects(manager.refresh(repo), /push failed/);
    await manager.refresh(repo);

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    assert.equal(await fs.readFile(path.join(verifyClone, "ahead.txt"), "utf8"), "AHEAD=1\n");
  });

  it("publishes a recovered first commit when the remote branch was missing", async () => {
    class FailNextPushGitCli extends GitCli {
      private failures = 0;
      failNextPush(): void {
        this.failures = 3;
      }
      async run(args: string[], options: { cwd?: string } = {}): Promise<string> {
        if (args[0] === "push" && this.failures > 0) {
          this.failures -= 1;
          throw new GitCommandError("push failed", "non-fast-forward", "", 1);
        }
        return super.run(args, options);
      }
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-first-retry-"));
    const gitCli = new FailNextPushGitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(repo.repoPath, "first.txt"), "FIRST=1\n");
    await git(gitCli, repo.repoPath, "add", "first.txt");
    await git(gitCli, repo.repoPath, "commit", "-m", "first commit");

    gitCli.failNextPush();
    await assert.rejects(manager.refresh(repo), /push failed/);
    await manager.refresh(repo);

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    assert.equal(await fs.readFile(path.join(verifyClone, "first.txt"), "utf8"), "FIRST=1\n");
  });

  it("fetches before choosing a new config branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-new-config-branch-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(repo.repoPath, "wrong.txt"), "WRONG=1\n");
    await git(gitCli, repo.repoPath, "add", "wrong.txt");
    await git(gitCli, repo.repoPath, "commit", "-m", "wrong branch commit");
    await git(gitCli, seedClone, "checkout", "-b", "backup");
    await git(gitCli, seedClone, "push", "-u", "origin", "backup");

    const backupRepo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "backup" });
    await manager.refresh(backupRepo);

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    await git(gitCli, verifyClone, "checkout", "backup");
    await assert.rejects(fs.access(path.join(verifyClone, "wrong.txt")));
  });

  it("syncs env files even when the config repository ignores them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-ignored-env-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, ".gitignore", ".env\n");
    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const engine = new EnvSyncEngine(manager, new TestPrompts(), new TestLogger(), new SyncStateStore(path.join(root, "state")));

    await engine.syncLocalChanges({ repoUrl: bareConfigRepo, branch: "main" }, createContext(workspacePath));

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    assert.equal(await fs.readFile(path.join(verifyClone, readableBranchFile("main", ".env")), "utf8"), "LOCAL=1\n");
  });

  it("serializes concurrent managers sharing one config clone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-managers-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });
    await fs.writeFile(path.join(workspaceA, ".env.a"), "A=1\n");
    await fs.writeFile(path.join(workspaceB, ".env.b"), "B=1\n");
    const storage = path.join(root, "storage");
    const settings = { repoUrl: bareConfigRepo, branch: "main" };
    const engineA = new EnvSyncEngine(
      new ConfigRepoManager(storage, new GitCli(), new TestLogger()),
      new TestPrompts(),
      new TestLogger(),
      new SyncStateStore(path.join(root, "state-a"))
    );
    const engineB = new EnvSyncEngine(
      new ConfigRepoManager(storage, new GitCli(), new TestLogger()),
      new TestPrompts(),
      new TestLogger(),
      new SyncStateStore(path.join(root, "state-b"))
    );

    await Promise.all([
      engineA.syncLocalChanges(settings, createContext(workspaceA)),
      engineB.syncLocalChanges(settings, createContext(workspaceB))
    ]);

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    assert.equal(await fs.readFile(path.join(verifyClone, readableBranchFile("main", ".env.a")), "utf8"), "A=1\n");
    assert.equal(await fs.readFile(path.join(verifyClone, readableBranchFile("main", ".env.b")), "utf8"), "B=1\n");
  });

  it("preserves untracked and ignored files when the remote starts tracking their paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-untracked-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    await fs.writeFile(path.join(seedClone, ".gitignore"), ".env\n");
    await git(gitCli, seedClone, "add", ".gitignore");
    await git(gitCli, seedClone, "commit", "-m", "ignore env");
    await git(gitCli, seedClone, "push");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    await git(gitCli, repo.repoPath, "config", "user.email", "test@example.com");
    await git(gitCli, repo.repoPath, "config", "user.name", "Test User");
    await fs.writeFile(path.join(repo.repoPath, "README.md"), "LOCAL=1\n");
    await fs.writeFile(path.join(repo.repoPath, ".env"), "LOCAL=2\n");
    await fs.mkdir(path.join(repo.repoPath, "nested"), { recursive: true });
    await fs.writeFile(path.join(repo.repoPath, "nested", ".env.example"), "SHARED=1\n");
    await fs.writeFile(path.join(seedClone, ".env"), "REMOTE=1\n");
    await fs.mkdir(path.join(seedClone, "nested"), { recursive: true });
    await fs.writeFile(path.join(seedClone, "nested", ".env.example"), "SHARED=1\n");
    await git(gitCli, seedClone, "add", "-f", "-A");
    await git(gitCli, seedClone, "commit", "-m", "track env files");
    await git(gitCli, seedClone, "push");

    await manager.refresh(repo);

    assert.equal((await fs.readFile(path.join(repo.repoPath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "LOCAL=1\n");
    assert.equal((await fs.readFile(path.join(repo.repoPath, ".env"), "utf8")).replace(/\r\n/g, "\n"), "LOCAL=2\n");
    assert.equal((await fs.readFile(path.join(repo.repoPath, "nested", ".env.example"), "utf8")).replace(/\r\n/g, "\n"), "SHARED=1\n");
    assert.equal(await git(gitCli, repo.repoPath, "stash", "list"), "");
  });

  it("rebases remote additions at long legacy hashed paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-long-path-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "README.md", "BASE=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const repo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });
    const remoteFile = path.join(path.relative(seedClone, hashedBranchStorePath(seedClone, createContext(seedClone))), ".env");
    await fs.mkdir(path.dirname(path.join(seedClone, remoteFile)), { recursive: true });
    await fs.writeFile(path.join(seedClone, remoteFile), "REMOTE=1\n");
    await git(gitCli, seedClone, "add", "-A");
    await git(gitCli, seedClone, "commit", "-m", "add hashed env");
    await git(gitCli, seedClone, "push");

    await manager.refresh(repo);

    assert.equal((await fs.readFile(path.join(repo.repoPath, remoteFile), "utf8")).replace(/\r\n/g, "\n"), "REMOTE=1\n");
    if (process.platform === "win32") {
      assert.equal(await git(gitCli, repo.repoPath, "config", "--get", "core.longpaths"), "true");
    }
  });

  it("rebases onto the configured branch when a concurrent fetch writes multiple branches", async () => {
    class ConcurrentFetchGitCli extends GitCli {
      async run(args: string[], options: { cwd?: string } = {}): Promise<string> {
        if (args[0] === "pull") {
          return super.run([...args, "other"], options);
        }
        return super.run(args, options);
      }
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-fetch-race-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(seedClone, gitCli, "main.txt", "MAIN=1\n");
    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const readyConfigRepo = await manager.ensureReady({ repoUrl: bareConfigRepo, branch: "main" });

    await git(gitCli, seedClone, "checkout", "-b", "other");
    await fs.writeFile(path.join(seedClone, "other.txt"), "OTHER=1\n");
    await git(gitCli, seedClone, "add", "-A");
    await git(gitCli, seedClone, "commit", "-m", "other branch");
    await git(gitCli, seedClone, "push", "-u", "origin", "other");
    await git(gitCli, seedClone, "checkout", "main");
    await fs.writeFile(path.join(seedClone, "main.txt"), "MAIN=2\n");
    await git(gitCli, seedClone, "add", "-A");
    await git(gitCli, seedClone, "commit", "-m", "main update");
    await git(gitCli, seedClone, "push");

    const racingManager = new ConfigRepoManager(path.join(root, "storage"), new ConcurrentFetchGitCli(), new TestLogger());
    await racingManager.refresh(readyConfigRepo);

    assert.equal(await fs.readFile(path.join(readyConfigRepo.repoPath, "main.txt"), "utf8"), "MAIN=2\n");
    await assert.rejects(fs.access(path.join(readyConfigRepo.repoPath, "other.txt")));
  });
});
