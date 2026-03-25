import path from "node:path";

import { DEFAULT_PATH_REGEX, DEFAULT_PATH_REGEXES } from "./types";

export function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.replace(/^\/+/, "");
}

export function normalizePathRegexSources(
  sources: readonly string[] | undefined,
  legacySource?: string | undefined
): string[] {
  const normalized = (sources ?? []).map((source) => source.trim()).filter((source) => source.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }

  if (legacySource && legacySource.trim().length > 0) {
    return [legacySource.trim()];
  }

  return [...DEFAULT_PATH_REGEXES];
}

export function compilePathRegexes(sources: readonly string[] | undefined, legacySource?: string | undefined): RegExp[] {
  return normalizePathRegexSources(sources, legacySource).map((source) => new RegExp(source));
}

export function compilePathRegex(source: string | undefined): RegExp {
  const raw = source && source.trim().length > 0 ? source.trim() : DEFAULT_PATH_REGEX;
  return new RegExp(raw);
}

export function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(workspacePath, absolutePath));
}

export function matchesWorkspaceRelativePath(pathRegexes: readonly RegExp[], relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return pathRegexes.some((pathRegex) => {
    pathRegex.lastIndex = 0;
    return pathRegex.test(normalized);
  });
}
