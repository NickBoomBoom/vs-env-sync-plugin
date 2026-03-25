import assert from "node:assert/strict";

import { parseOriginUrl } from "../src/core/repoIdentity";

describe("repoIdentity", () => {
  it("parses ssh origin urls", () => {
    const parsed = parseOriginUrl("git@github.com:team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      slug: "github.com/team/app"
    });
  });

  it("parses https origin urls", () => {
    const parsed = parseOriginUrl("https://github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      slug: "github.com/team/app"
    });
  });

  it("parses https urls with username", () => {
    const parsed = parseOriginUrl("https://token@github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      slug: "github.com/team/app"
    });
  });

  it("parses ssh scheme urls", () => {
    const parsed = parseOriginUrl("ssh://git@github.com/team/app.git");
    assert.deepEqual(parsed, {
      host: "github.com",
      owner: "team",
      repo: "app",
      slug: "github.com/team/app"
    });
  });
});
