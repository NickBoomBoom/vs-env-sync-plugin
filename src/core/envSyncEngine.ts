import path from "node:path";

import { ConfigRepoManager, ReadyConfigRepo } from "./configRepoManager";
import { readMatchingFiles, removeFileIfExists, writeFileEnsuringDir, pruneEmptyDirectories } from "./fileStore";
import {
  ConfigRepoSettings,
  Logger,
  OpenSyncResult,
  PushSyncResult,
  SyncPrompts,
  WorkspaceSyncContext
} from "./types";

function bufferEquals(left: Buffer, right: Buffer): boolean {
  return left.equals(right);
}

function projectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(repoPath, "projects", context.project.host, context.project.owner, context.project.repo);
}

function commitMessage(context: WorkspaceSyncContext): string {
  return `chore: sync env for ${context.project.slug}`;
}

export class EnvSyncEngine {
  constructor(
    private readonly configRepoManager: ConfigRepoManager,
    private readonly prompts: SyncPrompts,
    private readonly logger: Logger
  ) {}

  async verifyConfigRepo(settings: ConfigRepoSettings): Promise<void> {
    await this.configRepoManager.verifyRemote(settings);
  }

  async syncOnWorkspaceOpen(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<OpenSyncResult> {
    const repo = await this.configRepoManager.ensureReady(settings);
    await this.configRepoManager.refresh(repo);
    return this.runOpenSync(repo, context);
  }

  async syncLocalChanges(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<PushSyncResult> {
    const repo = await this.configRepoManager.ensureReady(settings);
    await this.configRepoManager.refresh(repo);
    return this.runPushSync(repo, context);
  }

  private async runOpenSync(repo: ReadyConfigRepo, context: WorkspaceSyncContext): Promise<OpenSyncResult> {
    const remoteRoot = projectStorePath(repo.repoPath, context);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes);
    const allPaths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);

    const result: OpenSyncResult = {
      uploadedPaths: [],
      pulledPaths: [],
      skippedPaths: []
    };

    for (const relativePath of [...allPaths].sort()) {
      const localContent = localFiles.get(relativePath);
      const remoteContent = remoteFiles.get(relativePath);
      const localTargetPath = path.join(context.workspacePath, relativePath);
      const remoteTargetPath = path.join(remoteRoot, relativePath);

      if (!localContent && remoteContent) {
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        continue;
      }

      if (localContent && !remoteContent) {
        const decision = await this.prompts.chooseLocalOnly(relativePath);
        if (decision === "upload") {
          await writeFileEnsuringDir(remoteTargetPath, localContent);
          result.uploadedPaths.push(relativePath);
        } else {
          result.skippedPaths.push(relativePath);
        }
        continue;
      }

      if (!localContent || !remoteContent) {
        continue;
      }

      if (bufferEquals(localContent, remoteContent)) {
        continue;
      }

      const decision = await this.prompts.chooseConflict(relativePath);
      if (decision === "pull") {
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        continue;
      }

      if (decision === "upload") {
        await writeFileEnsuringDir(remoteTargetPath, localContent);
        result.uploadedPaths.push(relativePath);
        continue;
      }

      result.skippedPaths.push(relativePath);
    }

    if (result.uploadedPaths.length > 0) {
      const committed = await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context));
      this.logger.info(`Workspace open sync uploaded ${result.uploadedPaths.length} file(s); committed=${committed}.`);
    }

    return result;
  }

  private async runPushSync(repo: ReadyConfigRepo, context: WorkspaceSyncContext): Promise<PushSyncResult> {
    const remoteRoot = projectStorePath(repo.repoPath, context);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes);
    const pushedPaths: string[] = [];
    const deletedPaths: string[] = [];

    for (const [relativePath, content] of localFiles) {
      const remoteTargetPath = path.join(remoteRoot, relativePath);
      const previousContent = remoteFiles.get(relativePath);
      if (!previousContent || !bufferEquals(previousContent, content)) {
        await writeFileEnsuringDir(remoteTargetPath, content);
        pushedPaths.push(relativePath);
      }
    }

    for (const relativePath of remoteFiles.keys()) {
      if (localFiles.has(relativePath)) {
        continue;
      }

      const remoteTargetPath = path.join(remoteRoot, relativePath);
      await removeFileIfExists(remoteTargetPath);
      await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
      deletedPaths.push(relativePath);
    }

    const committed = pushedPaths.length > 0 || deletedPaths.length > 0
      ? await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context))
      : false;

    return {
      pushedPaths,
      deletedPaths,
      committed
    };
  }
}
