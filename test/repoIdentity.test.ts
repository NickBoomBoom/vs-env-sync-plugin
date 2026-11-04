import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

import { parseOriginUrl } from "../src/core/repoIdentity";
import { assertPathInside, branchStorePath } from "../src/core/storagePaths";
import { WorkspaceSyncContext } from "../src/core/types";

function expectedHash(value: string): string {
  return createHash("sha256").update(`v1:${value}`).digest("hex");
}

function contextFor(originUrl: string, branch: string): WorkspaceSyncContext {
  const project = parseOriginUrl(originUrl);
  assert.ok(project);
  return { project, branch } as WorkspaceSyncContext;
}

describe("repoIdentity", () => {
  it("parses ssh origin urls", () => {
    const parsed = parseOriginUrl("git@github.com:team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      path: "team/app",
      slug: "github.com/team/app"
    });
  });

  it("parses https origin urls", () => {
    const parsed = parseOriginUrl("https://github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      path: "team/app",
      slug: "github.com/team/app"
    });
  });

  it("parses https urls with username", () => {
    const parsed = parseOriginUrl("https://token@github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      path: "team/app",
      slug: "github.com/team/app"
    });
  });

  it("parses ssh scheme urls", () => {
    const parsed = parseOriginUrl("ssh://git@github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      path: "team/app",
      slug: "github.com/team/app"
    });
  });

  it("preserves full nested group paths and separates their stores", () => {
    const left = parseOriginUrl("https://gitlab.com/group-a/sub/app.git");
    const right = parseOriginUrl("https://gitlab.com/group-b/sub/app.git");
    assert.equal(left?.path, "group-a/sub/app");
    assert.equal(left?.slug, "gitlab.com/group-a/sub/app");
    assert.notEqual(
      branchStorePath("/config", contextFor("https://gitlab.com/group-a/sub/app.git", "main")),
      branchStorePath("/config", contextFor("https://gitlab.com/group-b/sub/app.git", "main"))
    );
  });

  it("uses case-independent unique hashes for project branches", () => {
    const upper = branchStorePath("/config", contextFor("git@github.com:team/app.git", "Feature"));
    const lower = branchStorePath("/config", contextFor("git@github.com:team/app.git", "feature"));
    assert.notEqual(upper, lower);
    assert.equal(
      upper,
      path.join(
        "/config",
        "projects",
        "github.com",
        expectedHash("team/app"),
        "branches",
        expectedHash("Feature")
      )
    );
  });

  it("rejects unsafe origin path segments", () => {
    for (const originUrl of [
      "..:../..",
      "git@github.com:team/../app.git",
      "git@github.com:team//app.git",
      "git@github.com:team\\repo/app.git",
      "git@github.com:team/app\u0001.git"
    ]) {
      assert.equal(parseOriginUrl(originUrl), undefined, originUrl);
    }
  });

  it("accepts only paths contained by the storage root", () => {
    assert.doesNotThrow(() => assertPathInside("/tmp/config", "/tmp/config/projects/app"));
    assert.throws(() => assertPathInside("/tmp/config", "/tmp/outside"));
    assert.throws(() => assertPathInside("/tmp/config", "/tmp/config-backup/file"));
  });
});
