import assert from "node:assert/strict";
import path from "node:path";

import { parseOriginUrl } from "../src/core/repoIdentity";
import { assertPathInside, branchDirectoryName, branchStorePath } from "../src/core/storagePaths";
import { WorkspaceSyncContext } from "../src/core/types";

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
    assert.equal(
      branchStorePath("/config", contextFor("https://gitlab.com/group-a/sub/app.git", "main")),
      path.join("/config", "projects", "gitlab.com", "group-a", "sub", "app", "branches", "main")
    );
    const upperGroups = branchStorePath("/config", contextFor("https://gitlab.com/Group/Sub/App.git", "main"));
    const segments = path.relative(path.join("/config", "projects", "gitlab.com"), upperGroups).split(path.sep);
    assert.match(segments[0], /^Group~[0-9a-f]{16}$/);
    assert.match(segments[1], /^Sub~[0-9a-f]{16}$/);
    assert.match(segments[2], /^App~[0-9a-f]{16}$/);
    assert.notEqual(upperGroups.toLowerCase(), branchStorePath("/config", contextFor("https://gitlab.com/group/sub/app.git", "main")).toLowerCase());
    assert.notEqual(
      branchStorePath("/config", contextFor("https://gitlab.com/group-a/sub/app.git", "main")),
      branchStorePath("/config", contextFor("https://gitlab.com/group-b/sub/app.git", "main"))
    );
  });

  it("keeps ordinary GitHub projects and branches readable with origin casing", () => {
    const context = contextFor("git@github.com:NickBoomBoom/electron-ai-switch.git", "v3");
    assert.equal(context.project.path, "NickBoomBoom/electron-ai-switch");
    assert.equal(
      branchStorePath("/config", context),
      path.join("/config", "projects", "github.com", "NickBoomBoom", "electron-ai-switch", "branches", "v3")
    );
    assert.equal(branchDirectoryName("main"), "main");
    assert.equal(branchDirectoryName("v3"), "v3");
  });

  it("keeps differently cased branches distinct under Windows casefolding", () => {
    const upper = branchStorePath("/config", contextFor("git@github.com:team/app.git", "Feature"));
    const lower = branchStorePath("/config", contextFor("git@github.com:team/app.git", "feature"));
    assert.notEqual(upper.toLowerCase(), lower.toLowerCase());
    assert.match(branchDirectoryName("Feature"), /~[0-9a-f]+$/);
    assert.equal(lower, path.join("/config", "projects", "github.com", "team", "app", "branches", "feature"));
  });

  it("encodes slash and literal percent without colliding", () => {
    assert.equal(branchDirectoryName("feature/login"), "feature%2Flogin");
    assert.equal(branchDirectoryName("feature%login"), "feature%25login");
    assert.notEqual(branchDirectoryName("feature/login").toLowerCase(), branchDirectoryName("feature%2flogin").toLowerCase());
  });

  it("uses readable hash-suffixed names for reserved and overly long branches", () => {
    for (const branch of ["con", "aux.txt", "CON.env", "lpt1.log", ".git", "a".repeat(300)]) {
      const directory = branchDirectoryName(branch);
      assert.match(directory, /~[0-9a-f]+$/);
      assert.ok(directory.length <= 255);
      assert.ok(!directory.includes("/") && !directory.includes("\\"));
      assert.ok(!/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(directory), "suffixing a device extension must not leave a reserved basename");
      assert.notEqual(directory.toLowerCase(), ".git");
    }
    assert.notEqual(branchDirectoryName("con").toLowerCase(), branchDirectoryName("CON").toLowerCase());
    assert.notEqual(branchDirectoryName("a".repeat(300)).toLowerCase(), branchDirectoryName(`${"a".repeat(299)}b`).toLowerCase());
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
