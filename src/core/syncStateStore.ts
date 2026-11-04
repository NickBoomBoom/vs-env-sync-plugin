import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ConfigRepoSettings, WorkspaceSyncContext } from "./types";

interface SyncState {
  version: 1;
  files: Record<string, string>;
}

interface LastContext {
  repoBranch: string;
  projectBranch: string;
}

export class SyncStateStore {
  constructor(private readonly baseStoragePath: string) {}

  async read(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<Map<string, string>> {
    const statePath = await this.statePath(settings, context);
    let source: string;
    try {
      source = await fs.readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw error;
    }

    try {
      const state = JSON.parse(source) as SyncState;
      if (state.version !== 1 || !state.files || Array.isArray(state.files) || typeof state.files !== "object") {
        throw new Error("invalid state");
      }
      if (Object.values(state.files).some((value) => typeof value !== "string")) {
        throw new Error("invalid file hash");
      }
      return new Map(Object.entries(state.files));
    } catch (error) {
      throw new Error(`无法读取同步状态 ${statePath}：${(error as Error).message}`);
    }
  }

  async hasContextChanged(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<boolean> {
    const contextPath = await this.lastContextPath(settings, context);
    try {
      const last = JSON.parse(await fs.readFile(contextPath, "utf8")) as LastContext;
      return last.repoBranch !== settings.branch || last.projectBranch !== context.branch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new Error(`无法读取分支同步上下文 ${contextPath}：${(error as Error).message}`);
    }
  }

  async write(
    settings: ConfigRepoSettings,
    context: WorkspaceSyncContext,
    files: ReadonlyMap<string, string>
  ): Promise<void> {
    const statePath = await this.statePath(settings, context);
    const state: SyncState = {
      version: 1,
      files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
    await this.writeJson(statePath, state);
    const lastContext: LastContext = {
      repoBranch: settings.branch,
      projectBranch: context.branch
    };
    await this.writeJson(await this.lastContextPath(settings, context), lastContext);
  }

  private async writeJson(targetPath: string, value: SyncState | LastContext): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporaryPath, targetPath);
  }

  private async statePath(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<string> {
    const workspacePath = await fs.realpath(context.workspacePath);
    const key = JSON.stringify({
      version: 1,
      repoUrl: settings.repoUrl,
      repoBranch: settings.branch,
      workspacePath,
      projectPath: context.project.path,
      projectBranch: context.branch
    });
    const hash = createHash("sha256").update(key).digest("hex");
    return path.join(this.baseStoragePath, "sync-state", `${hash}.json`);
  }

  private async lastContextPath(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<string> {
    const workspacePath = await fs.realpath(context.workspacePath);
    const key = JSON.stringify({
      version: 1,
      repoUrl: settings.repoUrl,
      workspacePath,
      projectPath: context.project.path
    });
    const hash = createHash("sha256").update(key).digest("hex");
    return path.join(this.baseStoragePath, "sync-context", `${hash}.json`);
  }
}
