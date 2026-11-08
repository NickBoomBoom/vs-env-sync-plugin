import { createHash } from "node:crypto";
import path from "node:path";

import { WorkspaceSyncContext } from "./types";

export const BRANCH_METADATA_FILE = "env-sync-branch.json";
export const STORAGE_ARCHIVE_DIRECTORY = ".env-sync-archive";
export const MIGRATION_JOURNAL_FILE = "env-sync-migration.json";
const MAX_COMPONENT_LENGTH = 96;

function storageHash(value: string): string {
  return createHash("sha256").update(`v1:${value}`).digest("hex");
}

function encodedName(value: string): string {
  // Reserve '%' and '~' so literal names cannot impersonate escapes or suffixes.
  return [...value].map((character) => /^[a-zA-Z0-9._-]$/.test(character)
    ? character
    : [...Buffer.from(character)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")
  ).join("");
}

function readableSegment(value: string, caseSensitive: boolean): string {
  if (!value) throw new Error("存储目录名称不能为空。");
  const encoded = encodedName(value);
  const deviceName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(encoded);
  const reserved = deviceName || encoded.toLowerCase() === ".git";
  const needsSuffix = reserved || /\.$/.test(encoded) || encoded.length > MAX_COMPONENT_LENGTH ||
    (caseSensitive && value !== value.toLowerCase());
  if (!needsSuffix) return encoded;
  let prefix = encoded.slice(0, 64).replace(/%(?:[0-9a-f])?$/i, "");
  // AUX.txt~hash is still a Windows device name: the suffix after '.' is ignored.
  if ((deviceName && encoded.includes(".")) || encoded.toLowerCase() === ".git") prefix = `_${prefix}`;
  return `${prefix}~${storageHash(value).slice(0, 16)}`;
}

/** Common branches stay readable; only unsafe/case-sensitive names need a suffix. */
export function branchDirectoryName(branch: string): string {
  return readableSegment(branch, true);
}

export function assertPathInside(rootPath: string, targetPath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径超出允许范围：${targetPath}`);
  }
}

export function projectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  // GitHub project paths are case-insensitive: preserve their familiar display case.
  // Other hosts may contain case-distinct namespaces, so protect those components.
  const caseSensitive = context.project.host.toLowerCase() !== "github.com";
  const segments = context.project.path.split("/").map((segment) => readableSegment(segment, caseSensitive));
  const fullPath = segments.join("/");
  const projectSegments = fullPath.length <= 200 ? segments : [
    `~project-${encodedName(context.project.path.replace(/\//g, "--")).slice(0, 64).replace(/%(?:[0-9a-f])?$/i, "")}~${storageHash(context.project.path).slice(0, 16)}`
  ];
  const target = path.join(repoPath, "projects", readableSegment(context.project.host.toLowerCase(), false), ...projectSegments);
  assertPathInside(repoPath, target);
  return target;
}

export function branchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(projectStorePath(repoPath, context), "branches", branchDirectoryName(context.branch));
  assertPathInside(projectStorePath(repoPath, context), target);
  return target;
}

export function branchMetadataPath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(branchStorePath(repoPath, context), BRANCH_METADATA_FILE);
}

/** Read-only compatibility locations used by the v2 migration. */
export function hashedProjectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(repoPath, "projects", context.project.host, storageHash(context.project.path));
  assertPathInside(repoPath, target);
  return target;
}

export function hashedBranchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(hashedProjectStorePath(repoPath, context), "branches", storageHash(context.branch));
}

export function legacyProjectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(repoPath, "projects", context.project.host, context.project.owner, context.project.repo);
  assertPathInside(repoPath, target);
  return target;
}

export function legacyBranchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(legacyProjectStorePath(repoPath, context), "branches", encodeURIComponent(context.branch));
}

export interface BranchStorageMetadata {
  version: 2;
  layout: "readable-v2";
  project: { host: string; path: string };
  branch: string;
  baselineGeneration?: string;
  migration?: { source: string; sourceKind?: "hashed" | "legacy-branch" | "legacy-shared"; fingerprint?: string; archive?: string; selection?: "source" | "target" };
}

export function createBranchMetadata(
  context: WorkspaceSyncContext,
  migration?: BranchStorageMetadata["migration"]
): BranchStorageMetadata {
  return {
    version: 2,
    layout: "readable-v2",
    project: { host: context.project.host, path: context.project.path },
    branch: context.branch,
    ...(migration ? { migration } : {})
  };
}
