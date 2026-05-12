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
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：扩展宿主环境中无法使用 git。`,
      statusMessage: "Git 不可用"
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
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：仓库访问被拒绝。请检查凭据和已配置的远端 URL。`,
      statusMessage: "仓库访问被拒绝"
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
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：无法通过网络访问 Git 远端。`,
      statusMessage: "网络访问失败"
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
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：配置仓库拒绝了推送。请先拉取最新变更或处理远端更新。`,
      statusMessage: "推送被拒绝"
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
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：配置仓库存在需要手动处理的 rebase 或 merge 冲突。`,
      statusMessage: "存在 rebase 冲突"
    };
  }

  if (normalizedDetails.includes("not a git repository")) {
    return {
      logMessage: `${phase}失败：${details}`,
      notificationMessage: `Env Sync ${phase}失败：目标文件夹已不是 Git 仓库。`,
      statusMessage: "未找到 Git 仓库"
    };
  }

  return {
    logMessage: `${phase}失败：${details}`,
    notificationMessage: `Env Sync ${phase}失败。请查看“Env Sync”输出了解详情。`,
    statusMessage: `${phase}失败`
  };
}

export function summarizeSyncError(error: unknown, phase: string): SyncErrorSummary {
  if (error instanceof GitCommandError) {
    return classifyGitError(error, phase);
  }

  if (error instanceof Error) {
    return {
      logMessage: `${phase}失败：${error.message}`,
      notificationMessage: `Env Sync ${phase}失败：${error.message}`,
      statusMessage: `${phase}失败`
    };
  }

  return {
    logMessage: `${phase}失败，原因未知。`,
    notificationMessage: `Env Sync ${phase}失败。请查看“Env Sync”输出了解详情。`,
    statusMessage: `${phase}失败`
  };
}
