import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compilePathRegexes } from "../src/core/pathRegex";
import { SyncStateStore } from "../src/core/syncStateStore";
import { WorkspaceSyncContext } from "../src/core/types";

function createContext(workspacePath: string, branch = "main"): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "app",
    branch,
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

describe("SyncStateStore", () => {
  it("persists independent baselines for config and project contexts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-state-"));
    const workspace = path.join(root, "workspace");
    const otherWorkspace = path.join(root, "other-workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(otherWorkspace, { recursive: true });
    const store = new SyncStateStore(root);
    const settings = { repoUrl: "https://github.com/team/config.git", branch: "main" };
    const context = createContext(workspace);

    await store.write(settings, context, new Map([[".env", "hash-1"]]));

    assert.deepEqual(await store.read(settings, context), new Map([[".env", "hash-1"]]));
    assert.deepEqual(await store.read({ ...settings, branch: "backup" }, context), new Map());
    assert.deepEqual(await store.read(settings, createContext(workspace, "feature")), new Map());
    assert.deepEqual(await store.read(settings, createContext(otherWorkspace)), new Map());
    assert.deepEqual(await store.read(settings, {
      ...context,
      project: { ...context.project, host: "gitlab.com", slug: "gitlab.com/team/app" }
    }), new Map());

    const stateDirectory = path.join(root, "sync-state");
    assert.equal((await fs.readdir(stateDirectory)).length, 1);
    await store.write(settings, context, new Map([[".env", "hash-2"]]));
    assert.deepEqual(await store.read(settings, context), new Map([[".env", "hash-2"]]));
    assert.equal((await fs.readdir(stateDirectory)).length, 1);
  });

  it("reports corrupt state with its file path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-state-corrupt-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const store = new SyncStateStore(root);
    const settings = { repoUrl: "https://github.com/team/config.git", branch: "main" };
    const context = createContext(workspace);
    await store.write(settings, context, new Map([[".env", "hash"]]));
    const stateDirectory = path.join(root, "sync-state");
    const stateFile = (await fs.readdir(stateDirectory))[0];
    await fs.writeFile(path.join(stateDirectory, stateFile), "not-json");

    await assert.rejects(store.read(settings, context), /sync-state[\\/].*\.json/);
  });
});
