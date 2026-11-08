import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { compilePathRegexes } from "../src/core/pathRegex";
import { SyncStateStore } from "../src/core/syncStateStore";
import { branchDirectoryName, hashedBranchStorePath } from "../src/core/storagePaths";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";
import { WriteEventSuppressor } from "../src/core/writeEventSuppressor";

class InMemoryLogger implements Logger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(`info:${message}`);
  }

  warn(message: string): void {
    this.messages.push(`warn:${message}`);
  }

  error(message: string): void {
    this.messages.push(`error:${message}`);
  }
}

class StaticPrompts implements SyncPrompts {
  constructor(
    private readonly localOnlyDecision: "upload" | "skip" = "upload",
    private readonly conflictDecision: "pull" | "upload" | "skip" = "pull"
  ) {}

  async chooseLocalOnly(): Promise<"upload" | "skip"> {
    return this.localOnlyDecision;
  }

  async chooseConflict(): Promise<"pull" | "upload" | "skip"> {
    return this.conflictDecision;
  }
}

function createContext(workspacePath: string): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "app",
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

function readableBranchStorePath(remoteGitRoot: string, branch = "main"): string {
  return path.join(remoteGitRoot, "projects", "github.com", "team", "app", "branches", branchDirectoryName(branch));
}

function branchMetadata(branch = "main") {
  return { version: 2, layout: "readable-v2", project: { host: "github.com", path: "team/app" }, branch };
}

async function initializeBranchStore(branchRoot: string, branch = "main"): Promise<void> {
  await fs.mkdir(branchRoot, { recursive: true });
  await fs.writeFile(path.join(branchRoot, "env-sync-branch.json"), `${JSON.stringify(branchMetadata(branch))}\n`);
}

async function assertCurrentBranchMetadata(branchRoot: string, branch = "main"): Promise<void> {
  const metadata = JSON.parse(await fs.readFile(path.join(branchRoot, "env-sync-branch.json"), "utf8"));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.layout, "readable-v2");
  assert.deepEqual(metadata.project, { host: "github.com", path: "team/app" });
  assert.equal(metadata.branch, branch);
}

function createConfigRepoManager(remoteGitRoot: string, onCommit: () => void | boolean = () => {}): ConfigRepoManager {
  return {
    async verifyRemote(): Promise<void> {},
    async ensureReady() {
      return {
        repoPath: remoteGitRoot,
        branch: "main"
      };
    },
    async runExclusive(_settings: unknown, task: () => Promise<unknown>) {
      return task();
    },
    async refresh(): Promise<void> {},
    async commitProjectChanges(): Promise<boolean> {
      const committed = onCommit();
      return committed !== false;
    }
  } as unknown as ConfigRepoManager;
}

describe("EnvSyncEngine", () => {
  for (const scenario of ["unchanged", "unmatched", "skipped", "failed"] as const) {
    it(`reports storage paths and a truthful completion for ${scenario} syncs`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-log-"));
      try {
        const workspacePath = path.join(root, "workspace");
        const remoteGitRoot = path.join(root, "remote");
        const remoteStorePath = readableBranchStorePath(remoteGitRoot, "v3");
        await fs.mkdir(workspacePath, { recursive: true });
        await initializeBranchStore(remoteStorePath, "v3");
        if (scenario !== "unmatched") {
          await fs.writeFile(path.join(workspacePath, ".env"), "SECRET=never-log-this\n");
          await fs.writeFile(path.join(remoteStorePath, ".env"), scenario === "skipped" ? "SECRET=other\n" : "SECRET=never-log-this\n");
        }
        const logger = new InMemoryLogger();
        const manager = createConfigRepoManager(remoteGitRoot, () => {
          if (scenario === "failed") throw new Error("commit failed");
          return false;
        });
        const engine = new EnvSyncEngine(manager, new StaticPrompts("skip", "skip"), logger);
        const context = { ...createContext(workspacePath), branch: "v3" };
        const sync = engine.syncOnWorkspaceOpen({ repoUrl: "https://example.com/config.git", branch: "main" }, context);
        if (scenario === "failed") await assert.rejects(sync, /commit failed/);
        else await sync;
        const log = logger.messages.join("\n");
        assert.ok(log.includes("github.com/team/app [v3] → 配置仓库分支 main"));
        assert.ok(log.includes(path.relative(remoteGitRoot, remoteStorePath).split(path.sep).join("/")));
        assert.ok(!log.includes("never-log-this"));
        assert.equal(log.includes("同步检查完成"), scenario !== "failed");
        if (scenario === "unchanged") {
          assert.ok(log.includes("本地 1 个，配置仓库 1 个"));
          assert.ok(log.includes("无需变更"));
        }
        if (scenario === "unmatched") assert.ok(log.includes("本地没有匹配的 env 文件"));
        if (scenario === "skipped") {
          assert.ok(log.includes("本轮跳过 1 个文件，尚未同步这些文件：.env"));
          assert.ok(!log.includes("无需变更"));
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("pulls missing remote files on workspace open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-open-"));
    const workspacePath = path.join(root, "workspace");
    const storagePath = path.join(root, "storage");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env.local"), "REMOTE=1\n");

    const logger = new InMemoryLogger();
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async runExclusive(_settings: unknown, task: () => Promise<unknown>) {
      return task();
    },
    async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), logger);
    const result = await engine.syncOnWorkspaceOpen(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      createContext(workspacePath)
    );

    assert.deepEqual(result, {
      uploadedPaths: [],
      pulledPaths: [".env.local"],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(workspacePath, ".env.local"), "utf8"), "REMOTE=1\n");
  });

  it("uploads local files on workspace open when remote is missing and prompt allows upload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-upload-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env.local"), "LOCAL=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async runExclusive(_settings: unknown, task: () => Promise<unknown>) {
      return task();
    },
    async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts("upload"), new InMemoryLogger());
    const result = await engine.syncOnWorkspaceOpen(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      createContext(workspacePath)
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      uploadedPaths: [".env.local"],
      pulledPaths: [],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env.local"), "utf8"), "LOCAL=1\n");
  });

  it("pushes updates and deletions on local change sync", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-push-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=2\n");
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    await fs.writeFile(path.join(remoteStorePath, ".env.old"), "OLD=1\n");
    await initializeBranchStore(remoteStorePath);

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async runExclusive(_settings: unknown, task: () => Promise<unknown>) {
      return task();
    },
    async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));
    await stateStore.write(settings, context, new Map([
      [".env", createHash("sha256").update("REMOTE=1\n").digest("hex")],
      [".env.old", createHash("sha256").update("OLD=1\n").digest("hex")]
    ]));
    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), new InMemoryLogger(), stateStore);
    const result = await engine.syncLocalChanges(settings, context);

    assert.equal(committed, true);
    assert.deepEqual(result, {
      pushedPaths: [".env"],
      deletedPaths: [".env.old"],
      pulledPaths: [],
      deletedLocalPaths: [],
      skippedPaths: [],
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env"), "utf8"), "LOCAL=2\n");
    await assert.rejects(fs.access(path.join(remoteStorePath, ".env.old")));
  });

  it("matches files when any configured regex applies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-multi-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);

    await fs.mkdir(path.join(workspacePath, "config"), { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "config", ".env.dev"), "CONFIG=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async runExclusive(_settings: unknown, task: () => Promise<unknown>) {
      return task();
    },
    async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), new InMemoryLogger());
    const result = await engine.syncLocalChanges(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      {
        ...createContext(workspacePath),
        pathRegexSources: ["^\\.env[^/]*$", "^config/\\.env[^/]*$"],
        pathRegexes: compilePathRegexes(["^\\.env[^/]*$", "^config/\\.env[^/]*$"])
      }
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      pushedPaths: ["config/.env.dev"],
      deletedPaths: [],
      pulledPaths: [],
      deletedLocalPaths: [],
      skippedPaths: [],
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, "config", ".env.dev"), "utf8"), "CONFIG=1\n");
  });

  it("stores branch names containing slashes in one encoded directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-encoded-branch-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const projectRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const encodedBranchRoot = readableBranchStorePath(remoteGitRoot, "feature/login");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "FEATURE=1\n");

    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());
    const result = await engine.syncLocalChanges(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      { ...createContext(workspacePath), branch: "feature/login" }
    );

    assert.deepEqual(result.pushedPaths, [".env"]);
    assert.equal(await fs.readFile(path.join(encodedBranchRoot, ".env"), "utf8"), "FEATURE=1\n");
    await assert.rejects(fs.access(path.join(projectRoot, "branches", "feature", "login", ".env")));
  });

  it("inherits matching legacy files into a missing branch store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-inherit-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const branchRoot = readableBranchStorePath(remoteGitRoot);
    let commitCount = 0;

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, ".env"), "SHARED=1\n");

    const engine = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot, () => { commitCount += 1; }),
      new StaticPrompts(),
      new InMemoryLogger()
    );
    const result = await engine.syncOnWorkspaceOpen(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      createContext(workspacePath)
    );

    assert.deepEqual(result.pulledPaths, [".env"]);
    assert.equal(commitCount, 1);
    assert.equal(await fs.readFile(path.join(branchRoot, ".env"), "utf8"), "SHARED=1\n");
    assert.equal(await fs.readFile(path.join(legacyRoot, ".env"), "utf8"), "SHARED=1\n");
  });

  it("does not inherit legacy files when the branch store already exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-initialized-branch-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const branchRoot = readableBranchStorePath(remoteGitRoot);
    let commitCount = 0;

    await fs.mkdir(workspacePath, { recursive: true });
    await initializeBranchStore(branchRoot);
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, ".env"), "SHARED=1\n");

    const engine = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot, () => false),
      new StaticPrompts(),
      new InMemoryLogger()
    );
    const result = await engine.syncOnWorkspaceOpen(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      createContext(workspacePath)
    );

    assert.deepEqual(result, { uploadedPaths: [], pulledPaths: [], skippedPaths: [] });
    assert.equal(commitCount, 0);
    await assert.rejects(fs.access(path.join(branchRoot, ".env")));
  });

  it("upgrades a legacy version1 readable marker without replacing existing target data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-v1-marker-"));
    try {
      const workspacePath = path.join(root, "workspace");
      const remoteGitRoot = path.join(root, "remote");
      const branchRoot = readableBranchStorePath(remoteGitRoot);
      await fs.mkdir(workspacePath, { recursive: true });
      await fs.mkdir(branchRoot, { recursive: true });
      await fs.writeFile(path.join(branchRoot, "env-sync-branch.json"), "{\"version\":1}\n");
      await fs.writeFile(path.join(branchRoot, ".env.keep"), "KEEP=1\n");
      let commits = 0;
      const engine = new EnvSyncEngine(
        createConfigRepoManager(remoteGitRoot, () => { commits += 1; }),
        new StaticPrompts(),
        new InMemoryLogger()
      );
      const result = await engine.syncOnWorkspaceOpen(
        { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
        createContext(workspacePath)
      );
      assert.deepEqual(result.pulledPaths, [".env.keep"]);
      assert.equal(await fs.readFile(path.join(branchRoot, ".env.keep"), "utf8"), "KEEP=1\n");
      assert.equal(await fs.readFile(path.join(workspacePath, ".env.keep"), "utf8"), "KEEP=1\n");
      await assertCurrentBranchMetadata(branchRoot);
      assert.equal(commits, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("updates only the current branch store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-branch-isolation-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const mainRoot = readableBranchStorePath(remoteGitRoot);
    const otherRoot = readableBranchStorePath(remoteGitRoot, "feature/other");

    await fs.mkdir(workspacePath, { recursive: true });
    await initializeBranchStore(mainRoot);
    await initializeBranchStore(otherRoot, "feature/other");
    await fs.writeFile(path.join(workspacePath, ".env"), "CURRENT=1\n");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, ".env"), "SHARED=1\n");
    await fs.writeFile(path.join(mainRoot, ".env"), "MAIN=1\n");
    await fs.writeFile(path.join(otherRoot, ".env"), "OTHER=1\n");

    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts("upload", "upload"), new InMemoryLogger());
    await engine.syncLocalChanges(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      createContext(workspacePath)
    );

    assert.equal(await fs.readFile(path.join(mainRoot, ".env"), "utf8"), "CURRENT=1\n");
    assert.equal(await fs.readFile(path.join(legacyRoot, ".env"), "utf8"), "SHARED=1\n");
    assert.equal(await fs.readFile(path.join(otherRoot, ".env"), "utf8"), "OTHER=1\n");
  });

  it("excludes branch stores when reading legacy data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-legacy-exclusion-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const otherBranchFile = path.join(legacyRoot, "branches", "other", "config", ".env.dev");
    let commitCount = 0;

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(path.dirname(otherBranchFile), { recursive: true });
    await fs.writeFile(otherBranchFile, "OTHER=1\n");

    const engine = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot, () => { commitCount += 1; }),
      new StaticPrompts(),
      new InMemoryLogger()
    );
    const result = await engine.syncOnWorkspaceOpen(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      {
        ...createContext(workspacePath),
        pathRegexSources: ["^.*\\.env[^/]*$"],
        pathRegexes: compilePathRegexes(["^.*\\.env[^/]*$"])
      }
    );

    assert.deepEqual(result, { uploadedPaths: [], pulledPaths: [], skippedPaths: [] });
    assert.equal(commitCount, 1);
    await assert.rejects(fs.access(path.join(readableBranchStorePath(remoteGitRoot), "config", ".env.dev")));
    await assert.rejects(fs.access(path.join(readableBranchStorePath(remoteGitRoot), "branches", "other", "config", ".env.dev")));
    assert.equal(await fs.readFile(otherBranchFile, "utf8"), "OTHER=1\n");
    await assertCurrentBranchMetadata(readableBranchStorePath(remoteGitRoot));
  });

  it("resumes partial migration without reviving deleted legacy files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-migration-resume-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyBranchRoot = hashedBranchStorePath(remoteGitRoot, createContext(workspacePath));
    const branchRoot = readableBranchStorePath(remoteGitRoot);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(legacyBranchRoot, { recursive: true });
    await fs.mkdir(branchRoot, { recursive: true });
    await fs.writeFile(path.join(legacyBranchRoot, "env-sync-branch.json"), "{\"version\":1}\n");
    await fs.writeFile(path.join(legacyBranchRoot, ".env.one"), "ONE=1\n");
    await fs.writeFile(path.join(legacyBranchRoot, ".env.two"), "TWO=1\n");
    await fs.writeFile(path.join(branchRoot, ".env.one"), "ONE=1\n");

    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const openResult = await engine.syncOnWorkspaceOpen(settings, context);

    assert.deepEqual(openResult.pulledPaths, [".env.one", ".env.two"]);
    assert.equal(await fs.readFile(path.join(branchRoot, ".env.two"), "utf8"), "TWO=1\n");
    await assertCurrentBranchMetadata(branchRoot);

    await fs.unlink(path.join(workspacePath, ".env.two"));
    await fs.unlink(path.join(branchRoot, ".env.two"));
    await engine.syncLocalChanges(settings, context);

    await assert.rejects(fs.access(path.join(branchRoot, ".env.two")));
    assert.equal(await fs.readFile(path.join(legacyBranchRoot, ".env.two"), "utf8"), "TWO=1\n");
  });

  it("pulls another device's additions while pushing a different local change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-multi-device-"));
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const contextA = createContext(workspaceA);
    const contextB = createContext(workspaceB);
    const stateB = new SyncStateStore(path.join(root, "state-b"));

    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env.shared"), "SHARED=1\n");
    await fs.writeFile(path.join(workspaceA, ".env.shared"), "SHARED=1\n");
    await fs.writeFile(path.join(workspaceA, ".env.new"), "NEW=1\n");
    await fs.writeFile(path.join(workspaceB, ".env.shared"), "SHARED=1\n");
    await stateB.write(settings, contextB, new Map([
      [".env.shared", createHash("sha256").update("SHARED=1\n").digest("hex")]
    ]));

    const engineA = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot),
      new StaticPrompts(),
      new InMemoryLogger(),
      new SyncStateStore(path.join(root, "state-a"))
    );
    await engineA.syncLocalChanges(settings, contextA);
    await fs.writeFile(path.join(workspaceB, ".env.shared"), "SHARED=2\n");
    const engineB = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot),
      new StaticPrompts("upload", "upload"),
      new InMemoryLogger(),
      stateB
    );
    const result = await engineB.syncLocalChanges(settings, contextB);

    assert.deepEqual(result.pulledPaths, [".env.new"]);
    assert.deepEqual(result.pushedPaths, [".env.shared"]);
    assert.equal(await fs.readFile(path.join(workspaceB, ".env.new"), "utf8"), "NEW=1\n");
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env.new"), "utf8"), "NEW=1\n");
  });

  it("deletes remotely only when a baseline proves the file was locally deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-tracked-delete-"));
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const workspacePath = path.join(root, "workspace");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));

    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env.delete"), "DELETE=1\n");
    await stateStore.write(settings, context, new Map([
      [".env.delete", createHash("sha256").update("DELETE=1\n").digest("hex")]
    ]));
    const engine = new EnvSyncEngine(
      createConfigRepoManager(remoteGitRoot),
      new StaticPrompts(),
      new InMemoryLogger(),
      stateStore
    );

    const result = await engine.syncLocalChanges(settings, context);

    assert.deepEqual(result.deletedPaths, [".env.delete"]);
    await assert.rejects(fs.access(path.join(remoteStorePath, ".env.delete")));
  });

  it("keeps a skipped conflict during later background syncs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-skip-conflict-"));
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const workspacePath = path.join(root, "workspace");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));

    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=1\n");
    await stateStore.write(settings, context, new Map([
      [".env", createHash("sha256").update("BASE=1\n").digest("hex")]
    ]));
    const prompts = new StaticPrompts("skip", "skip");
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), prompts, new InMemoryLogger(), stateStore);

    await engine.syncOnWorkspaceOpen(settings, context);
    await fs.writeFile(path.join(workspacePath, ".env.other"), "OTHER=1\n");
    const result = await engine.syncLocalChanges(settings, context);

    assert.deepEqual(result.skippedPaths, [".env"]);
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env"), "utf8"), "REMOTE=1\n");
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env.other"), "utf8"), "OTHER=1\n");
  });

  it("advances the baseline only after the config commit succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-state-retry-"));
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const workspacePath = path.join(root, "workspace");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));
    const oldHash = createHash("sha256").update("OLD=1\n").digest("hex");
    const newHash = createHash("sha256").update("NEW=1\n").digest("hex");

    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env"), "OLD=1\n");
    await fs.writeFile(path.join(workspacePath, ".env"), "NEW=1\n");
    await stateStore.write(settings, context, new Map([[".env", oldHash]]));
    let attempts = 0;
    const manager = createConfigRepoManager(remoteGitRoot, () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("push failed");
      }
    });
    const engine = new EnvSyncEngine(manager, new StaticPrompts("upload", "upload"), new InMemoryLogger(), stateStore);

    await assert.rejects(engine.syncLocalChanges(settings, context), /push failed/);
    assert.deepEqual(await stateStore.read(settings, context), new Map([[".env", oldHash]]));
    await engine.syncLocalChanges(settings, context);
    assert.deepEqual(await stateStore.read(settings, context), new Map([[".env", newHash]]));
  });

  it("applies an uploaded local deletion to the remote", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-upload-delete-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));
    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    await stateStore.write(settings, context, new Map([[".env", createHash("sha256").update("BASE=1\n").digest("hex")]]));
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts("upload", "upload"), new InMemoryLogger(), stateStore);

    const result = await engine.syncLocalChanges(settings, context);

    assert.deepEqual(result.deletedPaths, [".env"]);
    await assert.rejects(fs.access(path.join(remoteStorePath, ".env")));
  });

  it("applies a pulled remote deletion to the local workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-pull-delete-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));
    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=1\n");
    await stateStore.write(settings, context, new Map([[".env", createHash("sha256").update("BASE=1\n").digest("hex")]]));
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts("upload", "pull"), new InMemoryLogger(), stateStore);

    const result = await engine.syncLocalChanges(settings, context);

    assert.deepEqual(result.deletedLocalPaths, [".env"]);
    await assert.rejects(fs.access(path.join(workspacePath, ".env")));
  });

  it("keeps the old baseline when committing remote writes fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-uncommitted-state-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    const stateStore = new SyncStateStore(path.join(root, "state"));
    const oldHash = createHash("sha256").update("OLD=1\n").digest("hex");
    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env"), "OLD=1\n");
    await fs.writeFile(path.join(workspacePath, ".env"), "NEW=1\n");
    await stateStore.write(settings, context, new Map([[".env", oldHash]]));
    const manager = createConfigRepoManager(remoteGitRoot, () => { throw new Error("commit failed"); });
    const engine = new EnvSyncEngine(manager, new StaticPrompts("upload", "upload"), new InMemoryLogger(), stateStore);

    await assert.rejects(engine.syncLocalChanges(settings, context), /commit failed/);
    assert.deepEqual(await stateStore.read(settings, context), new Map([[".env", oldHash]]));
  });

  it("registers pulled content before writing so later user saves are not suppressed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-observer-order-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const context = createContext(workspacePath);
    await initializeBranchStore(remoteStorePath);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    const suppressor = new WriteEventSuppressor();
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());

    await engine.syncOnWorkspaceOpen(settings, context, suppressor);
    await fs.writeFile(path.join(workspacePath, ".env"), "USER=1\n");

    assert.equal(await suppressor.shouldSuppress(path.join(workspacePath, ".env")), false);
  });

  it("treats branch switching as a new local context instead of a local edit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-branch-roundtrip-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteA = readableBranchStorePath(remoteGitRoot);
    const remoteB = readableBranchStorePath(remoteGitRoot, "feature");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const contextA = createContext(workspacePath);
    const contextB = { ...contextA, branch: "feature" };
    const stateStore = new SyncStateStore(path.join(root, "state"));
    await initializeBranchStore(remoteA);
    await initializeBranchStore(remoteB, "feature");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteA, ".env"), "A=1\n");
    await fs.writeFile(path.join(remoteB, ".env"), "B=1\n");
    await fs.writeFile(path.join(workspacePath, ".env"), "A=1\n");
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts("upload", "pull"), new InMemoryLogger(), stateStore);

    await engine.syncOnWorkspaceOpen(settings, contextA);
    await engine.syncOnWorkspaceOpen(settings, contextB);
    const result = await engine.syncLocalChanges(settings, contextA);

    assert.deepEqual(result.pulledPaths, [".env"]);
    assert.equal(await fs.readFile(path.join(remoteA, ".env"), "utf8"), "A=1\n");
    assert.equal(await fs.readFile(path.join(workspacePath, ".env"), "utf8"), "A=1\n");
  });

  it("keeps a skipped branch-switch conflict in context-switch mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-branch-skip-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteA = readableBranchStorePath(remoteGitRoot);
    const remoteB = readableBranchStorePath(remoteGitRoot, "feature");
    const settings = { repoUrl: "git@github.com:team/env-config.git", branch: "main" };
    const contextA = createContext(workspacePath);
    const contextB = { ...contextA, branch: "feature" };
    const stateStore = new SyncStateStore(path.join(root, "state"));
    await initializeBranchStore(remoteA);
    await initializeBranchStore(remoteB, "feature");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(remoteA, ".env"), "A=1\n");
    await fs.writeFile(path.join(remoteB, ".env"), "B=1\n");
    await fs.writeFile(path.join(workspacePath, ".env"), "A=1\n");
    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts("skip", "skip"), new InMemoryLogger(), stateStore);

    await engine.syncOnWorkspaceOpen(settings, contextA);
    await engine.syncOnWorkspaceOpen(settings, contextB);
    await fs.writeFile(path.join(workspacePath, ".env"), "B=1\n");
    const first = await engine.syncLocalChanges(settings, contextA);
    const second = await engine.syncLocalChanges(settings, contextA);

    assert.deepEqual(first.skippedPaths, [".env"]);
    assert.deepEqual(second.skippedPaths, [".env"]);
    assert.deepEqual(second.pushedPaths, []);
    assert.equal(await fs.readFile(path.join(remoteA, ".env"), "utf8"), "A=1\n");
  });

  it("prunes ignored directories and internal files from synchronization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-scan-ignore-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    await fs.mkdir(path.join(workspacePath, "ignored"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "ignored", ".env.secret"), "IGNORED=1\n");
    await fs.writeFile(path.join(workspacePath, "nested", ".env.nested"), "NESTED=1\n");
    await fs.writeFile(path.join(workspacePath, ".env.local"), "LOCAL=1\n");
    await fs.writeFile(path.join(workspacePath, "env-sync-branch.json"), "INTERNAL=1\n");

    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());
    const result = await engine.syncLocalChanges(
      { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
      {
        ...createContext(workspacePath),
        pathRegexSources: ["^.*$"],
        pathRegexes: compilePathRegexes(["^.*$"]),
        ignoredProjectRoots: ["nested"],
        ignoredDirectoryNames: ["ignored"]
      }
    );

    assert.deepEqual(result.pushedPaths, [".env.local"]);
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env.local"), "utf8"), "LOCAL=1\n");
    await assert.rejects(fs.access(path.join(remoteStorePath, "ignored", ".env.secret")));
    await assert.rejects(fs.access(path.join(remoteStorePath, "nested", ".env.nested")));
    await assertCurrentBranchMetadata(remoteStorePath);
  });

  it("pushes env changes when a project contains many non-matching files", async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-many-files-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = readableBranchStorePath(remoteGitRoot);
    const dependenciesPath = path.join(workspacePath, "dependencies");

    try {
      await fs.mkdir(dependenciesPath, { recursive: true });
      await fs.mkdir(remoteStorePath, { recursive: true });
      await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=1\n");
      for (let offset = 0; offset < 130_000; offset += 1_000) {
        await Promise.all(
          Array.from({ length: 1_000 }, (_, index) =>
            fs.writeFile(path.join(dependenciesPath, `${offset + index}.js`), "")
          )
        );
      }

      const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());
      const result = await engine.syncLocalChanges(
        { repoUrl: "git@github.com:team/env-config.git", branch: "main" },
        createContext(workspacePath)
      );

      assert.deepEqual(result.pushedPaths, [".env"]);
      assert.equal(await fs.readFile(path.join(remoteStorePath, ".env"), "utf8"), "LOCAL=1\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
