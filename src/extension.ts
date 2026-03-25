import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

import { ConfigRepoManager } from "./core/configRepoManager";
import { EnvSyncEngine } from "./core/envSyncEngine";
import { summarizeSyncError } from "./core/errorSummary";
import { GitCli } from "./core/git";
import {
  compilePathRegexes,
  matchesWorkspaceRelativePath,
  normalizePathRegexSources,
  normalizeRelativePath,
  toWorkspaceRelativePath
} from "./core/pathRegex";
import { SerialQueue } from "./core/serialQueue";
import {
  ConfigRepoSettings,
  DEFAULT_CONFIG_REPO_BRANCH,
  DEFAULT_GIT_PROJECT_IGNORE_DIRECTORIES,
  DEFAULT_GIT_PROJECT_SEARCH_DEPTH,
  DEFAULT_NOTIFICATION_LEVEL,
  DEFAULT_PATH_REGEXES,
  EXTENSION_NAMESPACE,
  Logger,
  NotificationLevel,
  WorkspaceSyncContext
} from "./core/types";
import { discoverWorkspaceProjects } from "./core/workspaceResolver";

interface SessionSyncSettings {
  pathRegexSources: string[];
  pathRegexes: RegExp[];
  gitProjectSearchDepth: number;
  gitProjectIgnoreDirectories: string[];
  notificationLevel: NotificationLevel;
}

class OutputLogger implements Logger {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  info(message: string): void {
    this.outputChannel.appendLine(`[INFO] ${message}`);
  }

  warn(message: string): void {
    this.outputChannel.appendLine(`[WARN] ${message}`);
  }

  error(message: string): void {
    this.outputChannel.appendLine(`[ERROR] ${message}`);
  }
}

class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.item.name = "Env Sync";
    this.item.command = "envSync.showOutput";
    this.showReady();
    this.item.show();
  }

  showReady(detail = "Env Sync is idle."): void {
    this.item.text = "$(check)";
    this.item.tooltip = `${detail}\nClick to open Env Sync output.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  showSyncing(detail: string): void {
    this.item.text = "$(sync~spin)";
    this.item.tooltip = `${detail}\nClick to open Env Sync output.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  showError(detail: string): void {
    this.item.text = "$(error)";
    this.item.tooltip = `${detail}\nClick to open Env Sync output.`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatProjectLabel(context: WorkspaceSyncContext): string {
  return `${context.workspaceName} [${context.project.slug}]`;
}

function summarizePaths(paths: readonly string[], limit = 3): string {
  if (paths.length === 0) {
    return "";
  }

  const visiblePaths = paths.slice(0, limit);
  const remaining = paths.length - visiblePaths.length;
  const summary = visiblePaths.join(", ");
  return remaining > 0 ? `${summary}, +${remaining} more` : summary;
}

function buildSyncSummary(result: { pushedPaths: string[]; deletedPaths: string[] }): string {
  const parts: string[] = [];
  if (result.pushedPaths.length > 0) {
    parts.push(`updated ${summarizePaths(result.pushedPaths)}`);
  }
  if (result.deletedPaths.length > 0) {
    parts.push(`deleted ${summarizePaths(result.deletedPaths)}`);
  }
  return parts.join("; ");
}

class VscodePrompts {
  async chooseLocalOnly(context: WorkspaceSyncContext, relativePath: string): Promise<"upload" | "skip"> {
    const projectLabel = formatProjectLabel(context);
    const decision = await vscode.window.showWarningMessage(
      `Env Sync: remote is missing ${relativePath} for ${projectLabel}.`,
      { modal: false },
      "Upload local",
      "Skip"
    );
    return decision === "Upload local" ? "upload" : "skip";
  }

  async chooseConflict(context: WorkspaceSyncContext, relativePath: string): Promise<"pull" | "upload" | "skip"> {
    const projectLabel = formatProjectLabel(context);
    const decision = await vscode.window.showWarningMessage(
      `Env Sync: conflict detected for ${relativePath} in ${projectLabel}.`,
      { modal: false },
      "Pull remote",
      "Upload local",
      "Skip"
    );
    if (decision === "Pull remote") {
      return "pull";
    }

    if (decision === "Upload local") {
      return "upload";
    }

    return "skip";
  }
}

class WorkspaceSession implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private gitWatcher: vscode.FileSystemWatcher | undefined;
  private gitDirectoryWatcher: vscode.FileSystemWatcher | undefined;
  private debounceHandle: NodeJS.Timeout | undefined;
  private suppressedPaths = new Map<string, number>();
  private pendingProjectPaths = new Set<string>();
  private syncing = false;
  private cachedContexts: WorkspaceSyncContext[] | undefined;
  private cachedContextsPromise: Promise<WorkspaceSyncContext[]> | undefined;
  private cachedContextKey: string | undefined;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly queue: SerialQueue,
    private readonly engine: EnvSyncEngine,
    private readonly git: GitCli,
    private readonly logger: Logger,
    private readonly statusBar: StatusBarController
  ) {}

  async start(): Promise<void> {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/*"));
    this.watcher.onDidCreate((uri) => void this.onWorkspaceFileEvent(uri));
    this.watcher.onDidChange((uri) => void this.onWorkspaceFileEvent(uri));
    this.watcher.onDidDelete((uri) => void this.onWorkspaceFileEvent(uri));
    this.gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/.git/**"));
    this.gitDirectoryWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/.git"));
    const invalidateFromGit = () => this.invalidateContextCache();
    this.gitWatcher.onDidCreate(invalidateFromGit);
    this.gitWatcher.onDidChange(invalidateFromGit);
    this.gitWatcher.onDidDelete(invalidateFromGit);
    this.gitDirectoryWatcher.onDidCreate(invalidateFromGit);
    this.gitDirectoryWatcher.onDidChange(invalidateFromGit);
    this.gitDirectoryWatcher.onDidDelete(invalidateFromGit);
    await this.syncOnOpen();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.gitWatcher?.dispose();
    this.gitDirectoryWatcher?.dispose();
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
  }

  private async syncOnOpen(): Promise<void> {
    await this.queue.enqueue(async () => {
      const contexts = await this.resolveContexts();
      if (contexts.length === 0) {
        return;
      }

      this.syncing = true;
      let completedSuccessfully = false;
      try {
        const settings = this.getConfigRepoSettings();
        const syncSettings = this.getSessionSyncSettings();
        if (!settings) {
          return;
        }
        if (!syncSettings) {
          return;
        }

        for (const context of contexts) {
          this.statusBar.showSyncing(`Opening sync for ${formatProjectLabel(context)}.`);
          this.logger.info(`Running workspace-open sync for ${context.project.slug} (${context.workspaceName}).`);
          const result = await this.engine.syncOnWorkspaceOpen(settings, context);
          this.suppressWatcherEvents(context.workspacePath, result.pulledPaths);
          const syncSummaryParts: string[] = [];
          if (result.pulledPaths.length > 0) {
            syncSummaryParts.push(`pulled ${summarizePaths(result.pulledPaths)}`);
          }
          if (result.uploadedPaths.length > 0) {
            syncSummaryParts.push(`uploaded ${summarizePaths(result.uploadedPaths)}`);
          }

          if (syncSummaryParts.length > 0) {
            this.showInfoNotification(
              syncSettings.notificationLevel,
              `Env Sync synchronized ${formatProjectLabel(context)}: ${syncSummaryParts.join("; ")}.`,
              true
            );
          } else {
            this.showInfoNotification(
              syncSettings.notificationLevel,
              `Env Sync checked ${formatProjectLabel(context)}: no changes were needed.`,
              false
            );
          }
        }
        completedSuccessfully = true;
      } catch (error) {
        this.handleError(error, "workspace-open sync");
      } finally {
        this.syncing = false;
        if (completedSuccessfully) {
          this.statusBar.showReady("Workspace-open sync completed.");
        }
      }
    });
  }

  private async onWorkspaceFileEvent(uri: vscode.Uri): Promise<void> {
    const context = await this.resolveContextForUri(uri);
    if (!context) {
      return;
    }

    if (uri.scheme !== "file") {
      return;
    }

    const relativePath = toWorkspaceRelativePath(context.workspacePath, uri.fsPath);
    if (relativePath.startsWith("..")) {
      return;
    }

    if (this.isSuppressedAbsolutePath(uri.fsPath)) {
      return;
    }

    this.pendingProjectPaths.add(context.workspacePath);
    this.schedulePushSync();
  }

  private schedulePushSync(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }

    this.debounceHandle = setTimeout(() => {
      void this.queue.enqueue(async () => {
        if (this.syncing) {
          return;
        }

        const contexts = await this.resolveContexts();
        if (contexts.length === 0) {
          return;
        }

        const settings = this.getConfigRepoSettings();
        const syncSettings = this.getSessionSyncSettings();
        if (!settings) {
          return;
        }
        if (!syncSettings) {
          return;
        }

        this.syncing = true;
        let completedSuccessfully = false;
        try {
          const contextsByPath = new Map(contexts.map((context) => [context.workspacePath, context]));
          const pendingPaths = [...this.pendingProjectPaths];
          this.pendingProjectPaths.clear();

          for (const projectPath of pendingPaths) {
            const context = contextsByPath.get(projectPath);
            if (!context) {
              continue;
            }

            this.statusBar.showSyncing(`Pushing env changes for ${formatProjectLabel(context)}.`);
            this.logger.info(`Running push sync for ${context.project.slug} (${context.workspaceName}).`);
            const result = await this.engine.syncLocalChanges(settings, context);
            if (result.committed) {
              this.logger.info(
                `Push sync committed ${result.pushedPaths.length} updated and ${result.deletedPaths.length} deleted file(s) for ${context.workspaceName}.`
              );
              const summary = buildSyncSummary(result);
              this.showInfoNotification(
                syncSettings.notificationLevel,
                `Env Sync synchronized ${formatProjectLabel(context)}: ${summary}.`,
                true
              );
            } else {
              this.showInfoNotification(
                syncSettings.notificationLevel,
                `Env Sync checked ${formatProjectLabel(context)}: no changes were needed.`,
                false
              );
            }
          }
          completedSuccessfully = true;
        } catch (error) {
          this.handleError(error, "push sync");
        } finally {
          this.syncing = false;
          if (completedSuccessfully) {
            this.statusBar.showReady("Push sync completed.");
          }
        }
      });
    }, 3000);
  }

  private suppressWatcherEvents(projectPath: string, relativePaths: string[]): void {
    const expiresAt = Date.now() + 10_000;
    for (const relativePath of relativePaths) {
      const absolutePath = path.join(projectPath, normalizeRelativePath(relativePath));
      this.suppressedPaths.set(absolutePath, expiresAt);
    }
  }

  private isSuppressedAbsolutePath(absolutePath: string): boolean {
    const normalized = path.resolve(absolutePath);
    const expiresAt = this.suppressedPaths.get(normalized);
    if (!expiresAt) {
      return false;
    }

    if (Date.now() > expiresAt) {
      this.suppressedPaths.delete(normalized);
      return false;
    }

    return true;
  }

  private async resolveContexts(): Promise<WorkspaceSyncContext[]> {
    if (!vscode.workspace.isTrusted) {
      this.logger.info(`Skipping ${this.folder.name}: workspace is not trusted.`);
      return [];
    }

    if (this.folder.uri.scheme !== "file") {
      this.logger.info(`Skipping ${this.folder.name}: only file workspaces are supported.`);
      return [];
    }

    const syncSettings = this.getSessionSyncSettings();
    if (!syncSettings) {
      return [];
    }

    const cacheKey = JSON.stringify({
      pathRegexSources: syncSettings.pathRegexSources,
      gitProjectSearchDepth: syncSettings.gitProjectSearchDepth,
      gitProjectIgnoreDirectories: syncSettings.gitProjectIgnoreDirectories
    });
    if (this.cachedContexts && this.cachedContextKey === cacheKey) {
      return this.cachedContexts;
    }
    if (this.cachedContextsPromise && this.cachedContextKey === cacheKey) {
      return this.cachedContextsPromise;
    }

    this.cachedContextKey = cacheKey;
    this.cachedContextsPromise = (async () => {
      const discoveredProjects = await discoverWorkspaceProjects(
        this.folder.uri.fsPath,
        this.git,
        syncSettings.gitProjectSearchDepth,
        syncSettings.gitProjectIgnoreDirectories
      );
      if (discoveredProjects.length === 0) {
        this.logger.info(
          `Skipping ${this.folder.name}: no Git projects were found within depth ${syncSettings.gitProjectSearchDepth}.`
        );
        return [];
      }

      return discoveredProjects.map(({ projectPath, project }) => {
        const relativeProjectPath = normalizeRelativePath(toWorkspaceRelativePath(this.folder.uri.fsPath, projectPath));
        const ignoredProjectRoots = discoveredProjects
          .filter(
            ({ projectPath: candidatePath }) =>
              candidatePath !== projectPath && candidatePath.startsWith(`${projectPath}${path.sep}`)
          )
          .map(({ projectPath: candidatePath }) => normalizeRelativePath(toWorkspaceRelativePath(projectPath, candidatePath)));

        return {
          workspacePath: projectPath,
          workspaceName: relativeProjectPath.length > 0 ? relativeProjectPath : this.folder.name,
          project,
          pathRegexSources: syncSettings.pathRegexSources,
          pathRegexes: syncSettings.pathRegexes,
          ignoredProjectRoots
        };
      });
    })();

    try {
      const contexts = await this.cachedContextsPromise;
      if (this.cachedContextKey === cacheKey) {
        this.cachedContexts = contexts;
      }
      return contexts;
    } finally {
      this.cachedContextsPromise = undefined;
    }
  }

  private async resolveContextForUri(uri: vscode.Uri): Promise<WorkspaceSyncContext | undefined> {
    if (uri.scheme !== "file") {
      return undefined;
    }

    const contexts = await this.resolveContexts();
    if (contexts.length === 0) {
      return undefined;
    }

    const matchingContexts = contexts
      .filter((context) => {
        const relativePath = toWorkspaceRelativePath(context.workspacePath, uri.fsPath);
        return !relativePath.startsWith("..");
      })
      .sort((left, right) => right.workspacePath.length - left.workspacePath.length);

    for (const context of matchingContexts) {
      const relativePath = toWorkspaceRelativePath(context.workspacePath, uri.fsPath);
      if (!matchesWorkspaceRelativePath(context.pathRegexes, relativePath)) {
        continue;
      }

      if (this.isSuppressedAbsolutePath(uri.fsPath)) {
        return undefined;
      }

      return context;
    }

    return undefined;
  }

  private getSessionSyncSettings(): SessionSyncSettings | undefined {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE, this.folder.uri);
    const configuredPathRegexes = configuration.get<string[]>("pathRegexes", [...DEFAULT_PATH_REGEXES]);
    const legacyPathRegex = configuration.get<string>("pathRegex", "");
    const pathRegexSources = normalizePathRegexSources(configuredPathRegexes, legacyPathRegex);
    const configuredDepth = configuration.get<number>("gitProjectSearchDepth", DEFAULT_GIT_PROJECT_SEARCH_DEPTH);
    const configuredIgnoredDirectories = configuration.get<string[]>(
      "gitProjectIgnoreDirectories",
      [...DEFAULT_GIT_PROJECT_IGNORE_DIRECTORIES]
    );
    const configuredNotificationLevel = configuration.get<NotificationLevel>(
      "notificationLevel",
      DEFAULT_NOTIFICATION_LEVEL
    );

    let pathRegexes: RegExp[];
    try {
      pathRegexes = compilePathRegexes(pathRegexSources);
    } catch (error) {
      const message = `Invalid envSync.pathRegexes for ${this.folder.name}: ${(error as Error).message}`;
      this.logger.error(message);
      this.statusBar.showError(`Invalid path regex configuration for ${this.folder.name}.`);
      void vscode.window.showErrorMessage(message);
      return undefined;
    }

    if (
      configuredPathRegexes.length === 0 &&
      legacyPathRegex.trim().length > 0
    ) {
      this.logger.warn(`Using deprecated envSync.pathRegex fallback for ${this.folder.name}.`);
    }

    const gitProjectIgnoreDirectories = configuredIgnoredDirectories
      .map((directoryName) => directoryName.trim())
      .filter((directoryName, index, directories) => directoryName.length > 0 && directories.indexOf(directoryName) === index);

    return {
      pathRegexSources,
      pathRegexes,
      gitProjectSearchDepth: Number.isFinite(configuredDepth) ? Math.max(0, Math.floor(configuredDepth)) : DEFAULT_GIT_PROJECT_SEARCH_DEPTH,
      gitProjectIgnoreDirectories,
      notificationLevel: configuredNotificationLevel
    };
  }

  private invalidateContextCache(): void {
    this.cachedContexts = undefined;
    this.cachedContextsPromise = undefined;
    this.cachedContextKey = undefined;
  }

  private showInfoNotification(notificationLevel: NotificationLevel, message: string, hasChanges: boolean): void {
    if (notificationLevel === "errors") {
      return;
    }

    if (notificationLevel === "summary" && !hasChanges) {
      return;
    }

    void vscode.window.showInformationMessage(message);
  }

  private getConfigRepoSettings(): ConfigRepoSettings | undefined {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const repoUrl = configuration.get<string>("configRepoUrl", "").trim();
    const branch = configuration.get<string>("configRepoBranch", DEFAULT_CONFIG_REPO_BRANCH).trim();

    if (!repoUrl) {
      this.logger.info("Skipping sync: envSync.configRepoUrl is not configured.");
      return undefined;
    }

    return {
      repoUrl,
      branch: branch || DEFAULT_CONFIG_REPO_BRANCH
    };
  }

  private handleError(error: unknown, phase: string): void {
    const summary = summarizeSyncError(error, phase);
    this.logger.error(summary.logMessage);
    this.statusBar.showError(summary.statusMessage);
    void vscode.window.showErrorMessage(summary.notificationMessage);
  }
}

class WorkspaceCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, WorkspaceSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly queue: SerialQueue,
    private readonly engine: EnvSyncEngine,
    private readonly git: GitCli,
    private readonly logger: Logger,
    private readonly statusBar: StatusBarController
  ) {}

  async start(): Promise<void> {
    await this.refreshSessions();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refreshSessions();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(EXTENSION_NAMESPACE)) {
          void this.refreshSessions();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refreshSessions();
      })
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  async refreshSessions(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.statusBar.showReady("Env Sync is ready.");

    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();

    for (const folder of folders) {
      const key = folder.uri.toString();
      const session = new WorkspaceSession(folder, this.queue, this.engine, this.git, this.logger, this.statusBar);
      this.sessions.set(key, session);
      await session.start();
    }

    if (folders.length === 0) {
      this.statusBar.showReady("No workspace folders are open.");
    }
  }
}

async function ensureDirectoryExists(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await ensureDirectoryExists(context.globalStorageUri.fsPath);

  const outputChannel = vscode.window.createOutputChannel("Env Sync");
  const logger = new OutputLogger(outputChannel);
  const statusBar = new StatusBarController();
  const git = new GitCli();
  const queue = new SerialQueue();
  const configRepoManager = new ConfigRepoManager(context.globalStorageUri.fsPath, git, logger);
  const engine = new EnvSyncEngine(configRepoManager, new VscodePrompts(), logger);
  const coordinator = new WorkspaceCoordinator(queue, engine, git, logger, statusBar);
  const showOutputCommand = vscode.commands.registerCommand("envSync.showOutput", () => {
    outputChannel.show(true);
  });

  const initializeCommand = vscode.commands.registerCommand("envSync.initializeConfigRepo", async () => {
    const currentConfiguration = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const defaultRepoUrl = currentConfiguration.get<string>("configRepoUrl", "");
    const defaultBranch = currentConfiguration.get<string>("configRepoBranch", DEFAULT_CONFIG_REPO_BRANCH);

    const repoUrl = await vscode.window.showInputBox({
      title: "Env Sync: Config Repo URL",
      prompt: "Enter the private Git repository URL used to store synchronized env files.",
      value: defaultRepoUrl,
      ignoreFocusOut: true,
      validateInput(value) {
        return value.trim().length === 0 ? "Repository URL is required." : undefined;
      }
    });
    if (!repoUrl) {
      return;
    }

    const branch = await vscode.window.showInputBox({
      title: "Env Sync: Config Repo Branch",
      prompt: "Enter the branch to use in the config repository.",
      value: defaultBranch,
      ignoreFocusOut: true,
      validateInput(value) {
        return value.trim().length === 0 ? "Branch name is required." : undefined;
      }
    });
    if (!branch) {
      return;
    }

    const settings: ConfigRepoSettings = {
      repoUrl: repoUrl.trim(),
      branch: branch.trim()
    };

    try {
      await engine.verifyConfigRepo(settings);
      await currentConfiguration.update("configRepoUrl", settings.repoUrl, vscode.ConfigurationTarget.Global);
      await currentConfiguration.update("configRepoBranch", settings.branch, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage("Env Sync config repository saved.");
      logger.info(`Configured repo ${settings.repoUrl} on branch ${settings.branch}.`);
      await coordinator.refreshSessions();
    } catch (error) {
      const summary = summarizeSyncError(error, "config repo verification");
      logger.error(summary.logMessage);
      statusBar.showError(summary.statusMessage);
      void vscode.window.showErrorMessage(summary.notificationMessage);
    }
  });

  context.subscriptions.push(outputChannel, statusBar, initializeCommand, showOutputCommand, coordinator);
  await coordinator.start();
}

export function deactivate(): void {}
