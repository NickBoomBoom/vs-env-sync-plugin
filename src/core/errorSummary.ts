import { GitCommandError } from "./git";

export interface SyncErrorSummary {
  logMessage: string;
  notificationMessage: string;
  statusMessage: string;
}

function joinDetails(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter((part) => part.length > 0).join("\n");
}

function includesAny(source: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

function classifyGitError(error: GitCommandError, phase: string): SyncErrorSummary {
  const details = joinDetails([error.message, error.stderr, error.stdout, error.causeMessage ?? ""]);
  const normalizedDetails = details.toLowerCase();

  if (error.systemCode === "ENOENT" || normalizedDetails.includes("spawn git enoent")) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: git is not available in the extension host environment.`,
      statusMessage: "Git is unavailable"
    };
  }

  if (
    includesAny(normalizedDetails, [
      "permission denied",
      "publickey",
      "authentication failed",
      "access denied",
      "could not read username",
      "terminal prompts disabled",
      "repository not found"
    ])
  ) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: repository access was denied. Check credentials and the configured remote URL.`,
      statusMessage: "Repository access denied"
    };
  }

  if (
    includesAny(normalizedDetails, [
      "could not resolve host",
      "temporary failure in name resolution",
      "failed to connect",
      "connection timed out",
      "network is unreachable",
      "no route to host",
      "connection refused",
      "operation timed out"
    ])
  ) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: network access to the Git remote is unavailable.`,
      statusMessage: "Network access failed"
    };
  }

  if (
    includesAny(normalizedDetails, [
      "failed to push some refs",
      "non-fast-forward",
      "[rejected]",
      "fetch first",
      "remote rejected"
    ])
  ) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: the config repository rejected the push. Pull the latest changes or resolve remote updates first.`,
      statusMessage: "Push was rejected"
    };
  }

  if (
    includesAny(normalizedDetails, [
      "conflict",
      "could not apply",
      "please commit or stash",
      "needs merge"
    ])
  ) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: the config repository has a rebase or merge conflict that needs manual resolution.`,
      statusMessage: "Rebase conflict"
    };
  }

  if (normalizedDetails.includes("not a git repository")) {
    return {
      logMessage: `${phase} failed: ${details}`,
      notificationMessage: `Env Sync ${phase} failed: the target folder is not a Git repository anymore.`,
      statusMessage: "Git repository not found"
    };
  }

  return {
    logMessage: `${phase} failed: ${details}`,
    notificationMessage: `Env Sync ${phase} failed. Check the "Env Sync" output for details.`,
    statusMessage: `${phase} failed`
  };
}

export function summarizeSyncError(error: unknown, phase: string): SyncErrorSummary {
  if (error instanceof GitCommandError) {
    return classifyGitError(error, phase);
  }

  if (error instanceof Error) {
    return {
      logMessage: `${phase} failed: ${error.message}`,
      notificationMessage: `Env Sync ${phase} failed: ${error.message}`,
      statusMessage: `${phase} failed`
    };
  }

  return {
    logMessage: `${phase} failed with an unknown error.`,
    notificationMessage: `Env Sync ${phase} failed. Check the "Env Sync" output for details.`,
    statusMessage: `${phase} failed`
  };
}
