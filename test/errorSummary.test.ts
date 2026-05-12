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
      "推送同步"
    );

    assert.equal(summary.statusMessage, "仓库访问被拒绝");
    assert.match(summary.notificationMessage, /仓库访问被拒绝/);
  });

  it("classifies network failures", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git fetch failed",
        "fatal: unable to access 'https://github.com/team/repo.git/': Could not resolve host: github.com",
        ""
      ),
      "打开工作区同步"
    );

    assert.equal(summary.statusMessage, "网络访问失败");
    assert.match(summary.notificationMessage, /无法通过网络访问 Git 远端/);
  });

  it("classifies push rejections", () => {
    const summary = summarizeSyncError(
      new GitCommandError(
        "git push failed",
        " ! [rejected] main -> main (fetch first)\nerror: failed to push some refs",
        ""
      ),
      "推送同步"
    );

    assert.equal(summary.statusMessage, "推送被拒绝");
    assert.match(summary.notificationMessage, /配置仓库拒绝了推送/);
  });

  it("classifies git executable lookup failures", () => {
    const summary = summarizeSyncError(
      new GitCommandError("git push failed", "", "", undefined, "ENOENT", "spawn git ENOENT"),
      "推送同步"
    );

    assert.equal(summary.statusMessage, "Git 不可用");
    assert.match(summary.notificationMessage, /无法使用 git/);
  });
});
