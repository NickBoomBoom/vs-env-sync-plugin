import assert from "node:assert/strict";

import { decideThreeWay } from "../src/core/threeWaySync";

describe("threeWaySync", () => {
  it("does nothing when neither side changed", () => {
    assert.equal(decideThreeWay("a", "a", "a", true, "open"), "none");
    assert.equal(decideThreeWay(undefined, undefined, undefined, true, "change"), "none");
  });

  it("applies local additions, edits and deletions when remote is unchanged", () => {
    assert.equal(decideThreeWay(undefined, "local", undefined, true, "change"), "push");
    assert.equal(decideThreeWay("base", "local", "base", true, "change"), "push");
    assert.equal(decideThreeWay("base", undefined, "base", true, "change"), "delete-remote");
  });

  it("applies remote additions, edits and deletions when local is unchanged", () => {
    assert.equal(decideThreeWay(undefined, undefined, "remote", true, "open"), "pull");
    assert.equal(decideThreeWay("base", "base", "remote", true, "open"), "pull");
    assert.equal(decideThreeWay("base", "base", undefined, true, "open"), "delete-local");
  });

  it("accepts converged content and conflicts on divergent changes", () => {
    assert.equal(decideThreeWay("base", "same", "same", true, "change"), "none");
    assert.equal(decideThreeWay("base", "local", "remote", true, "change"), "conflict");
    assert.equal(decideThreeWay("base", undefined, "remote", true, "change"), "conflict");
    assert.equal(decideThreeWay("base", "local", undefined, true, "change"), "conflict");
  });

  it("is conservative without a baseline", () => {
    assert.equal(decideThreeWay(undefined, undefined, "remote", false, "change"), "pull");
    assert.equal(decideThreeWay(undefined, "local", undefined, false, "open"), "conflict");
    assert.equal(decideThreeWay(undefined, "local", undefined, false, "change"), "push");
    assert.equal(decideThreeWay(undefined, "same", "same", false, "open"), "none");
    assert.equal(decideThreeWay(undefined, "local", "remote", false, "open"), "conflict");
  });
});
