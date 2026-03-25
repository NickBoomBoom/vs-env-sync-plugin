import assert from "node:assert/strict";

import { summarizeSyncError } from "../src/core/errorSummary";
import { GitCommandError } from "../src/core/git";

describe("errorSummary", () => {
  it("classifies repository access failures", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git push failed",
        "git@github.com: Permission denied (publickey).",
        ""
      ),
      "push sync"
    );

    assert.equal(summary.statusMessage, "Repository access denied");
    assert.match(summary.notificationMessage, /repository access was denied/i);
  });

  it("classifies network failures", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git fetch failed",
        "fatal: unable to access 'https://github.com/team/repo.git/': Could not resolve host: github.com",
        ""
      ),
      "workspace-open sync"
    );

    assert.equal(summary.statusMessage, "Network access failed");
    assert.match(summary.notificationMessage, /network access/i);
  });

  it("classifies push rejections", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git push failed",
        " ! [rejected] main -> main (fetch first)\nerror: failed to push some refs",
        ""
      ),
      "push sync"
    );

    assert.equal(summary.statusMessage, "Push was rejected");
    assert.match(summary.notificationMessage, /rejected the push/i);
  });

  it("classifies git executable lookup failures", () => {
    const summary = summarizeSyncError(
      new GitCommandError("git push failed", "", "", undefined, "ENOENT", "spawn git ENOENT"),
      "push sync"
    );

    assert.equal(summary.statusMessage, "Git is unavailable");
    assert.match(summary.notificationMessage, /git is not available/i);
  });
});
