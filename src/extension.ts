import fs from "node:fs/promises";
import * as vscode from "vscode";

import { ConfigRepoManager } from "./core/configRepoManager";
import { EnvSyncEngine } from "./core/envSyncEngine";
import { GitCli, GitCommandError } from "./core/git";
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
  DEFAULT_PATH_REGEX,
  DEFAULT_PATH_REGEXES,
  EXTENSION_NAMESPACE,
  Logger,
  WorkspaceSyncContext
} from "./core/types";
import { resolveWorkspaceProject } from "./core/workspaceResolver";

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

class VscodePrompts {
  async chooseLocalOnly(relativePath: string): Promise<"upload" | "skip"> {
    const decision = await vscode.window.showWarningMessage(
      `Env Sync: remote is missing ${relativePath}.`,
      { modal: false },
      "Upload local",
      "Skip"
    );
    return decision === "Upload local" ? "upload" : "skip";
  }

  async chooseConflict(relativePath: string): Promise<"pull" | "upload" | "skip"> {
    const decision = await vscode.window.showWarningMessage(
      `Env Sync: conflict detected for ${relativePath}.`,
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
  private debounceHandle: NodeJS.Timeout | undefined;
  private suppressedPaths = new Map<string, number>();
  private syncing = false;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly queue: SerialQueue,
    private readonly engine: EnvSyncEngine,
    private readonly git: GitCli,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/*"));
    this.watcher.onDidCreate((uri) => void this.onWorkspaceFileEvent(uri));
    this.watcher.onDidChange((uri) => void this.onWorkspaceFileEvent(uri));
    this.watcher.onDidDelete((uri) => void this.onWorkspaceFileEvent(uri));
    await this.syncOnOpen();
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
  }

  private async syncOnOpen(): Promise<void> {
    await this.queue.enqueue(async () => {
      const context = await this.resolveContext();
      if (!context) {
        return;
      }

      this.syncing = true;
      try {
        const settings = this.getConfigRepoSettings();
        if (!settings) {
          return;
        }

        this.logger.info(`Running workspace-open sync for ${context.project.slug}.`);
        const result = await this.engine.syncOnWorkspaceOpen(settings, context);
        this.suppressWatcherEvents(result.pulledPaths);
        if (result.pulledPaths.length > 0) {
          void vscode.window.showInformationMessage(
            `Env Sync pulled ${result.pulledPaths.length} file(s) for ${this.folder.name}.`
          );
        }
      } catch (error) {
        this.handleError(error, "workspace-open sync");
      } finally {
        this.syncing = false;
      }
    });
  }

  private async onWorkspaceFileEvent(uri: vscode.Uri): Promise<void> {
    const context = await this.resolveContext();
    if (!context) {
      return;
    }

    if (uri.scheme !== "file") {
      return;
    }

    const relativePath = toWorkspaceRelativePath(this.folder.uri.fsPath, uri.fsPath);
    if (relativePath.startsWith("..")) {
      return;
    }

    if (!matchesWorkspaceRelativePath(context.pathRegexes, relativePath)) {
      return;
    }

    if (this.isSuppressed(relativePath)) {
      return;
    }

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

        const context = await this.resolveContext();
        if (!context) {
          return;
        }

        const settings = this.getConfigRepoSettings();
        if (!settings) {
          return;
        }

        this.logger.info(`Running push sync for ${context.project.slug}.`);
        try {
          const result = await this.engine.syncLocalChanges(settings, context);
          if (result.committed) {
            this.logger.info(
              `Push sync committed ${result.pushedPaths.length} updated and ${result.deletedPaths.length} deleted file(s).`
            );
          }
        } catch (error) {
          this.handleError(error, "push sync");
        }
      });
    }, 3000);
  }

  private suppressWatcherEvents(relativePaths: string[]): void {
    const expiresAt = Date.now() + 10_000;
    for (const relativePath of relativePaths) {
      this.suppressedPaths.set(normalizeRelativePath(relativePath), expiresAt);
    }
  }

  private isSuppressed(relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
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

  private async resolveContext(): Promise<WorkspaceSyncContext | undefined> {
    if (!vscode.workspace.isTrusted) {
      this.logger.info(`Skipping ${this.folder.name}: workspace is not trusted.`);
      return undefined;
    }

    if (this.folder.uri.scheme !== "file") {
      this.logger.info(`Skipping ${this.folder.name}: only file workspaces are supported.`);
      return undefined;
    }

    const project = await resolveWorkspaceProject(this.folder.uri.fsPath, this.git);
    if (!project) {
      this.logger.info(`Skipping ${this.folder.name}: git origin is missing or unsupported.`);
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE, this.folder.uri);
    const configuredPathRegexes = configuration.get<string[]>("pathRegexes", [...DEFAULT_PATH_REGEXES]);
    const legacyPathRegex = configuration.get<string>("pathRegex", "");
    const pathRegexSources = normalizePathRegexSources(configuredPathRegexes, legacyPathRegex);

    let pathRegexes: RegExp[];
    try {
      pathRegexes = compilePathRegexes(pathRegexSources);
    } catch (error) {
      const message = `Invalid envSync.pathRegexes for ${this.folder.name}: ${(error as Error).message}`;
      this.logger.error(message);
      void vscode.window.showErrorMessage(message);
      return undefined;
    }

    if (
      configuredPathRegexes.length === 0 &&
      legacyPathRegex.trim().length > 0
    ) {
      this.logger.warn(`Using deprecated envSync.pathRegex fallback for ${this.folder.name}.`);
    }

    return {
      workspacePath: this.folder.uri.fsPath,
      workspaceName: this.folder.name,
      project,
      pathRegexSources,
      pathRegexes
    };
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
    if (error instanceof GitCommandError) {
      this.logger.error(`${phase} failed: ${error.message}\n${error.stderr || error.stdout}`);
    } else if (error instanceof Error) {
      this.logger.error(`${phase} failed: ${error.message}`);
    } else {
      this.logger.error(`${phase} failed with an unknown error.`);
    }

    void vscode.window.showErrorMessage(`Env Sync ${phase} failed. Check the "Env Sync" output for details.`);
  }
}

class WorkspaceCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, WorkspaceSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly queue: SerialQueue,
    private readonly engine: EnvSyncEngine,
    private readonly git: GitCli,
    private readonly logger: Logger
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

    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();

    for (const folder of folders) {
      const key = folder.uri.toString();
      const session = new WorkspaceSession(folder, this.queue, this.engine, this.git, this.logger);
      this.sessions.set(key, session);
      await session.start();
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
  const git = new GitCli();
  const queue = new SerialQueue();
  const configRepoManager = new ConfigRepoManager(context.globalStorageUri.fsPath, git, logger);
  const engine = new EnvSyncEngine(configRepoManager, new VscodePrompts(), logger);
  const coordinator = new WorkspaceCoordinator(queue, engine, git, logger);

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
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to initialize config repo: ${message}`);
      void vscode.window.showErrorMessage(`Failed to initialize config repo: ${message}`);
    }
  });

  context.subscriptions.push(outputChannel, initializeCommand, coordinator);
  await coordinator.start();
}

export function deactivate(): void {}
