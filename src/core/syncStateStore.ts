import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ConfigRepoSettings, WorkspaceSyncContext } from "./types";

interface SyncState {
  version: 1;
  files: Record<string, string>;
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

  async write(
    settings: ConfigRepoSettings,
    context: WorkspaceSyncContext,
    files: ReadonlyMap<string, string>
  ): Promise<void> {
    const statePath = await this.statePath(settings, context);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    const state: SyncState = {
      version: 1,
      files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(temporaryPath, statePath);
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
}
