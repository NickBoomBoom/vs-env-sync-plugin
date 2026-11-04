import { createHash } from "node:crypto";
import path from "node:path";

import { WorkspaceSyncContext } from "./types";

export const BRANCH_METADATA_FILE = "env-sync-branch.json";

function storageHash(value: string): string {
  return createHash("sha256").update(`v1:${value}`).digest("hex");
}

export function assertPathInside(rootPath: string, targetPath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径超出允许范围：${targetPath}`);
  }
}

export function projectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(repoPath, "projects", context.project.host, storageHash(context.project.path));
  assertPathInside(repoPath, target);
  return target;
}

export function branchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(projectStorePath(repoPath, context), "branches", storageHash(context.branch));
  assertPathInside(projectStorePath(repoPath, context), target);
  return target;
}

export function branchMetadataPath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(branchStorePath(repoPath, context), BRANCH_METADATA_FILE);
  assertPathInside(branchStorePath(repoPath, context), target);
  return target;
}
