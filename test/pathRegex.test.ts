import assert from "node:assert/strict";

import {
  compilePathRegex,
  compilePathRegexes,
  matchesWorkspaceRelativePath,
  normalizePathRegexSources,
  normalizeRelativePath,
  toWorkspaceRelativePath
} from "../src/core/pathRegex";

describe("pathRegex", () => {
  it("matches default root env files", () => {
    const regexes = compilePathRegexes(["^\\.env[^/]*$"]);

    assert.equal(matchesWorkspaceRelativePath(regexes, ".env"), true);
    assert.equal(matchesWorkspaceRelativePath(regexes, ".env.local"), true);
    assert.equal(matchesWorkspaceRelativePath(regexes, "config/.env.local"), false);
  });

  it("supports custom subdirectory matching across multiple regexes", () => {
    const regexes = compilePathRegexes(["^\\.env[^/]*$", "^config/\\.env[^/]*$"]);

    assert.equal(matchesWorkspaceRelativePath(regexes, ".env"), true);
    assert.equal(matchesWorkspaceRelativePath(regexes, "config/.env.dev"), true);
    assert.equal(matchesWorkspaceRelativePath(regexes, "nested/config/.env.dev"), false);
  });

  it("normalizes windows paths to posix before matching", () => {
    const regexes = compilePathRegexes(["^config/\\.env[^/]*$"]);

    assert.equal(matchesWorkspaceRelativePath(regexes, "config\\.env.dev"), true);
    assert.equal(matchesWorkspaceRelativePath(regexes, normalizeRelativePath("config\\.env.dev")), true);
  });

  it("builds workspace-relative paths", () => {
    const relativePath = toWorkspaceRelativePath("/workspace/project", "/workspace/project/config/.env.local");
    assert.equal(relativePath, "config/.env.local");
  });

  it("falls back to the legacy regex when array config is empty", () => {
    assert.deepEqual(normalizePathRegexSources([], "^legacy$"), ["^legacy$"]);
  });

  it("falls back to the default regex when no config is provided", () => {
    assert.deepEqual(normalizePathRegexSources([], ""), ["^\\.env[^/]*$"]);
  });

  it("throws on invalid regex", () => {
    assert.throws(() => compilePathRegex("["), SyntaxError);
    assert.throws(() => compilePathRegexes(["["]), SyntaxError);
  });
});
