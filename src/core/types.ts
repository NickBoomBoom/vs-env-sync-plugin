export const EXTENSION_NAMESPACE = "envSync";
export const DEFAULT_PATH_REGEX = "^\\.env[^/]*$";
export const DEFAULT_PATH_REGEXES = [DEFAULT_PATH_REGEX] as const;
export const DEFAULT_GIT_PROJECT_SEARCH_DEPTH = 2;
export const DEFAULT_GIT_PROJECT_IGNORE_DIRECTORIES = [
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store"
] as const;
export const DEFAULT_CONFIG_REPO_BRANCH = "main";
export const DEFAULT_NOTIFICATION_LEVEL = "summary" as const;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RepoIdentity {
  host: string;
  owner: string;
  repo: string;
  slug: string;
}

export interface ConfigRepoSettings {
  repoUrl: string;
  branch: string;
}

export type NotificationLevel = "errors" | "summary" | "all";

export interface WorkspaceSyncContext {
  workspacePath: string;
  workspaceName: string;
  project: RepoIdentity;
  pathRegexSources: string[];
  pathRegexes: RegExp[];
  ignoredProjectRoots: string[];
}

export interface RemoteFileState {
  relativePath: string;
  content: Buffer;
}

export type LocalOnlyDecision = "upload" | "skip";
export type ConflictDecision = "pull" | "upload" | "skip";

export interface SyncPrompts {
  chooseLocalOnly(context: WorkspaceSyncContext, relativePath: string): Promise<LocalOnlyDecision>;
  chooseConflict(context: WorkspaceSyncContext, relativePath: string): Promise<ConflictDecision>;
}

export interface OpenSyncResult {
  uploadedPaths: string[];
  pulledPaths: string[];
  skippedPaths: string[];
}

export interface PushSyncResult {
  pushedPaths: string[];
  deletedPaths: string[];
  committed: boolean;
}
