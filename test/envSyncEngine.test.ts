import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { compilePathRegexes } from "../src/core/pathRegex";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

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
      slug: "github.com/team/app"
    },
    pathRegexSources: ["^\\.env[^/]*$"],
    pathRegexes: compilePathRegexes(["^\\.env[^/]*$"]),
    ignoredProjectRoots: []
  };
}

function createConfigRepoManager(remoteGitRoot: string, onCommit: () => void = () => {}): ConfigRepoManager {
  return {
    async verifyRemote(): Promise<void> {},
    async ensureReady() {
      return {
        repoPath: remoteGitRoot,
        branch: "main"
      };
    },
    async refresh(): Promise<void> {},
    async commitProjectChanges(): Promise<boolean> {
      onCommit();
      return true;
    }
  } as unknown as ConfigRepoManager;
}

describe("EnvSyncEngine", () => {
  it("pulls missing remote files on workspace open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-open-"));
    const workspacePath = path.join(root, "workspace");
    const storagePath = path.join(root, "storage");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app", "branches", "main");

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
      async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        return false;
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
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app", "branches", "main");

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
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app", "branches", "main");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=2\n");
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    await fs.writeFile(path.join(remoteStorePath, ".env.old"), "OLD=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
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
      createContext(workspacePath)
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      pushedPaths: [".env"],
      deletedPaths: [".env.old"],
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env"), "utf8"), "LOCAL=2\n");
    await assert.rejects(fs.access(path.join(remoteStorePath, ".env.old")));
  });

  it("matches files when any configured regex applies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-multi-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app", "branches", "main");

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
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, "config", ".env.dev"), "utf8"), "CONFIG=1\n");
  });

  it("stores branch names containing slashes in one encoded directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-encoded-branch-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const projectRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const encodedBranchRoot = path.join(projectRoot, "branches", "feature%2Flogin");

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
    const branchRoot = path.join(legacyRoot, "branches", "main");
    let commitCount = 0;

    await fs.mkdir(workspacePath, { recursive: true });
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
    const branchRoot = path.join(legacyRoot, "branches", "main");
    let commitCount = 0;

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(branchRoot, { recursive: true });
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

    assert.deepEqual(result, { uploadedPaths: [], pulledPaths: [], skippedPaths: [] });
    assert.equal(commitCount, 0);
    await assert.rejects(fs.access(path.join(branchRoot, ".env")));
  });

  it("updates only the current branch store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-branch-isolation-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const legacyRoot = path.join(remoteGitRoot, "projects", "github.com", "team", "app");
    const mainRoot = path.join(legacyRoot, "branches", "main");
    const otherRoot = path.join(legacyRoot, "branches", "feature%2Fother");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(mainRoot, { recursive: true });
    await fs.mkdir(otherRoot, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "CURRENT=1\n");
    await fs.writeFile(path.join(legacyRoot, ".env"), "SHARED=1\n");
    await fs.writeFile(path.join(mainRoot, ".env"), "MAIN=1\n");
    await fs.writeFile(path.join(otherRoot, ".env"), "OTHER=1\n");

    const engine = new EnvSyncEngine(createConfigRepoManager(remoteGitRoot), new StaticPrompts(), new InMemoryLogger());
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
    assert.equal(commitCount, 0);
    await assert.rejects(fs.access(path.join(legacyRoot, "branches", "main")));
  });
});
