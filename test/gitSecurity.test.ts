import assert from "node:assert/strict";

import { summarizeSyncError } from "../src/core/errorSummary";
import { GitCli, GitCommandError, redactRepoUrl } from "../src/core/git";

describe("Git credential redaction", () => {
  it("redacts URL userinfo and token query parameters", () => {
    const redacted = redactRepoUrl("https://token:secret@github.com/team/app.git?private_token=abc&x=1");
    assert.ok(!redacted.includes("token:secret"));
    assert.ok(!redacted.includes("abc"));
    assert.ok(redacted.includes("REDACTED"));
    assert.ok(redacted.includes("x=1"));
  });

  it("sanitizes every user-visible GitCommandError field", async () => {
    const repoUrl = "https://token:secret@localhost:1/team/app.git?private_token=abc";
    const git = new GitCli();
    let error: unknown;
    try {
      await git.run(["ls-remote", repoUrl]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof GitCommandError);
    const serialized = JSON.stringify({
      message: error.message,
      stderr: error.stderr,
      stdout: error.stdout,
      causeMessage: error.causeMessage
    });
    assert.ok(!serialized.includes("token:secret"));
    assert.ok(!serialized.includes("abc"));
  });

  it("redacts credentials in error summaries", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git ls-remote https://token@github.com/team/app.git failed",
        "https://token@github.com/team/app.git authentication failed",
        "",
        1
      ),
      "测试"
    );
    assert.ok(!summary.logMessage.includes("token@"));
    assert.ok(!summary.notificationMessage.includes("token@"));
  });

  it("redacts credentials even when URL parsing fails", () => {
    const redacted = redactRepoUrl("https://token:secret@:bad?private_token=abc");
    assert.ok(!redacted.includes("token:secret"));
    assert.ok(!redacted.includes("abc"));
    assert.ok(redacted.includes("REDACTED"));
  });

  it("redacts token query names case-insensitively", () => {
    const redacted = redactRepoUrl("https://example.invalid/repo.git?PRIVATE_TOKEN=DUMMY_SECRET&Token=OTHER_SECRET");
    assert.ok(!redacted.includes("DUMMY_SECRET"));
    assert.ok(!redacted.includes("OTHER_SECRET"));
  });
});
