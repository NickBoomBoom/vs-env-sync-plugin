# Multi-device Env Sync Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Env Sync 修复为可安全用于多设备、同项目、多分支的 env 同步插件，并解决全局审查发现的全部正确性、安全性、恢复和生命周期问题。

**Architecture:** 以每台设备持久化的文件哈希基线实现三方同步，以版本化哈希存储避免身份碰撞并迁移旧目录。Git 操作在进程内队列和跨进程仓库锁中完成，使用限定 pathspec 的提交、显式 rebase 和 ahead push 恢复保证最终一致性。

**Tech Stack:** TypeScript、Node.js 内置 fs/path/crypto、VS Code Extension API、Git CLI、Mocha。

**Spec:** `docs/superpowers/specs/2026-11-04-multi-device-sync-design.md`

## Global Constraints

- 不引入新的运行时依赖。
- 保持现有命令和设置兼容，新设置必须有默认值。
- 冲突只提供整文件拉取、上传或跳过，不做逐行合并。
- 旧目录和旧文件只读保留，不删除。
- 每个缺陷先写失败测试，再写最小实现。
- 用户可见仓库 URL 必须脱敏，实际 Git 命令仍使用原始 URL。
- 最终必须运行完整 `npm test` 和 VSIX 打包检查。

## Review Focus

- 配置仓库分支切换后的空远端：Task 2 测试必须使用独立基线，不能删除本地文件。
- 初始化复制中途退出：Task 1 测试必须续传缺失文件，且初始化完成后不能复活已删除文件。
- 系统休眠导致锁租约暂停但进程仍存活：Task 4 测试不得接管锁。
- 远端删除与本地修改同时发生：Task 2 测试必须提示冲突，不能静默覆盖。
- 扩展写入后立即发生不同内容的用户保存：Task 5 测试必须处理用户事件，不能继续抑制。

---

### Task 1: 安全项目身份、哈希存储与可恢复迁移

**Files:**
- Modify: `src/core/repoIdentity.ts`
- Modify: `src/core/types.ts`
- Create: `src/core/storagePaths.ts`
- Modify: `src/core/envSyncEngine.ts`
- Modify: `test/repoIdentity.test.ts`
- Modify: `test/envSyncEngine.test.ts`

**Interfaces:**
- Produces: `RepoIdentity.path` 保存完整项目路径，`RepoIdentity.slug` 为 `<host>/<path>`。
- Produces: `branchStorePath(repoPath: string, context: WorkspaceSyncContext): string`，返回 `projects/<safe-host>/<sha256(project.path)>/branches/<sha256(context.branch)>/`。
- Produces: `assertPathInside(rootPath: string, targetPath: string): void`，目标越界时抛错。
- Produces: 分支内初始化元数据文件名常量，后续扫描和提交统一使用。

- [ ] **Step 1: 写 origin 与路径失败测试**
  - 验证 GitLab `group-a/sub/app` 与 `group-b/sub/app` 的 `path`、slug 和存储目录不同。
  - 验证 `Feature` 与 `feature` 分支目录不同。
  - 验证空段、`.`、`..`、反斜杠和控制字符被拒绝。
  - 验证 `assertPathInside` 拒绝 `../outside` 和相似前缀目录。
- [ ] **Step 2: 运行相关测试并确认因缺少新校验/接口而失败**
  - Run: `npm run build && ./node_modules/.bin/mocha "dist/test/{repoIdentity,envSyncEngine}.test.js"`
- [ ] **Step 3: 实现完整身份解析和包含关系校验**
  - 保留 host 小写、`.git` 去除及现有 SCP/SSH/HTTPS 支持。
  - 哈希输入使用带版本的 UTF-8 字符串；物理路径不拼接未校验的 owner/repo/branch。
- [ ] **Step 4: 写旧分支、旧共享目录和中断迁移测试**
  - 新哈希分支目录按当前旧分支目录、旧共享目录顺序继承。
  - 模拟只复制部分文件后中断，下一次同步复制剩余文件。
  - 初始化标记提交后，删除远端文件不会从旧目录复活。
- [ ] **Step 5: 实现初始化标记和续传迁移**
  - 标记位于当前分支目录内，后续文件扫描始终排除。
  - 无旧数据也初始化；标记及数据由当前分支 pathspec 一起提交。
  - 更新现有测试中的存储路径断言，保留旧目录不变断言。
- [ ] **Step 6: 运行 Task 1 测试并确认通过**

### Task 2: 持久化基线与三方同步引擎

**Files:**
- Create: `src/core/syncStateStore.ts`
- Create: `src/core/threeWaySync.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/envSyncEngine.ts`
- Modify: `src/extension.ts`
- Create: `test/threeWaySync.test.ts`
- Create: `test/syncStateStore.test.ts`
- Modify: `test/envSyncEngine.test.ts`
- Modify: `test/gitIntegration.test.ts`

**Interfaces:**
- Produces: `SyncStateStore.read(settings, context): Promise<Map<string, string>>` 和 `write(settings, context, files): Promise<void>`。
- Produces: `ThreeWayDecision`，取值为 `none | pull | push | delete-local | delete-remote | conflict`。
- Produces: `decideThreeWay(baseHash, localHash, remoteHash, hasBaseline, trigger): ThreeWayDecision`。
- Consumes: Task 1 的安全分支目录与初始化标记。
- Later consumes: Task 4 的仓库事务锁包裹完整同步。

- [ ] **Step 1: 写三方决策表失败测试**
  - 覆盖无变化、仅本地新增/修改/删除、仅远端新增/修改/删除、两边收敛、两边冲突。
  - 覆盖无基线时 remote-only 必须 pull、local-only 在 open 时提示、两边不同必须 conflict。
  - 覆盖 local delete + remote modify 必须 conflict。
- [ ] **Step 2: 写 SyncStateStore 隔离和原子持久化测试**
  - 同一项目但不同 `configRepoBranch`、项目分支、本地真实路径使用不同状态。
  - 写入后可读回；非法/损坏 JSON 抛带路径的状态错误，不静默当作空基线。
- [ ] **Step 3: 运行新测试并确认失败**
- [ ] **Step 4: 实现 SyncStateStore 和纯三方决策函数**
  - 状态 JSON 带版本，使用临时文件 + rename。
  - 哈希统一 SHA-256；跳过路径不更新其基线。
- [ ] **Step 5: 写多设备与 skip 引擎回归测试**
  - A 上传 `.env.new`，B 保存其他文件后拉取该文件且远端仍存在。
  - 已同步本地删除才删除远端；无基线 remote-only 不删除。
  - open 冲突选择 skip 后，后台保存其他文件仍不覆盖 skip 路径。
  - push 失败不推进基线；后续收敛后可推进。
- [ ] **Step 6: 将 open/push 共用决策接入 EnvSyncEngine**
  - 打开时保留现有提示；后台远端变化自动应用，本地变化自动上传，双边变化提示。
  - 后台结果增加 pulled/deleted-local/skipped 信息，扩展据此抑制事件和展示摘要。
  - 每轮结束无条件检查当前分支未提交内容；事务成功后原子写基线。
- [ ] **Step 7: 运行完整引擎与 Git 集成测试并确认通过**

### Task 3: Git 分支安全、提交隔离与失败恢复

**Files:**
- Modify: `src/core/configRepoManager.ts`
- Modify: `src/core/git.ts`
- Modify: `test/gitIntegration.test.ts`

**Interfaces:**
- Consumes: Task 1 的当前分支存储路径。
- Produces: `refresh(repo)` 在 rebase 后推送已有 ahead 提交。
- Produces: `commitProjectChanges(...)` 只提交传入分支路径并保留其他 index 状态。
- Preserves: 当前工作区中显式 `rebase --autostash origin/<branch>` 修复。

- [ ] **Step 1: 写提交范围失败测试**
  - 配置仓库放入其他项目的 staged 和 unstaged 文件。
  - 当前项目提交后，验证其他 staged 文件未进入 commit 且仍 staged，unstaged 内容不变。
- [ ] **Step 2: 写本地分支和恢复失败测试**
  - 本地配置分支有未推送提交时切走再切回，提交仍存在。
  - 第一次 push 失败、第二次无任何文件变化时仍推送已有提交。
  - 初始化数据写入后模拟 commit 中断，下一次同步继续提交。
  - 无远端分支但本地有首个提交时可恢复 push。
- [ ] **Step 3: 运行测试并确认失败**
- [ ] **Step 4: 实现最小 Git 修复**
  - 本地分支优先 checkout；仅不存在时从远端创建。
  - commit 使用与 add 相同的 pathspec。
  - refresh 检查 ahead/无上游提交并 push；非快进失败时有限次 fetch/rebase/push，最终保留提交。
- [ ] **Step 5: 运行全部 Git 集成测试并确认通过**

### Task 4: 跨进程配置仓库锁

**Files:**
- Create: `src/core/fileLock.ts`
- Modify: `src/core/configRepoManager.ts`
- Modify: `src/core/envSyncEngine.ts`
- Create: `test/fileLock.test.ts`
- Modify: `test/gitIntegration.test.ts`

**Interfaces:**
- Produces: `FileLock.runExclusive(repoKey: string, task: () => Promise<T>): Promise<T>`。
- Consumes: 配置仓库 URL 哈希作为 repoKey。
- Wraps: ensureReady、refresh、同步、commit/push 和基线写入整个事务。

- [ ] **Step 1: 写互斥与释放失败测试**
  - 两个锁实例竞争同一 key，重叠计数最大必须为 1，第二个看到第一个结果。
  - task 抛错后锁可再次获取。
  - 持有 PID 存活且租约过期时不得接管；PID 已退出时可以清理死锁。
- [ ] **Step 2: 运行锁测试并确认失败**
- [ ] **Step 3: 实现原子 mkdir 锁、所有者 ID、PID 检查和心跳**
  - 进程存活时不因租约过期接管；释放校验所有者并在 finally 执行。
  - 等待方被唤醒后重新进入完整同步，不跳过任务。
- [ ] **Step 4: 将锁接入所有打开和本地同步**
  - 测试替身提供直接执行任务的同接口，真实 manager 使用文件锁。
- [ ] **Step 5: 写两个 manager 竞争同一 clone 的集成测试**
  - 验证无 index.lock 交叉错误、无交叉提交，最终远端包含双方应保留的变更。
- [ ] **Step 6: 运行锁与 Git 集成测试并确认通过**

### Task 5: watcher、worktree 与会话刷新可靠性

**Files:**
- Create: `src/core/writeEventSuppressor.ts`
- Create: `src/core/latestTaskRunner.ts`
- Modify: `src/core/workspaceResolver.ts`
- Modify: `src/extension.ts`
- Create: `test/writeEventSuppressor.test.ts`
- Create: `test/latestTaskRunner.test.ts`
- Modify: `test/workspaceResolver.test.ts`

**Interfaces:**
- Produces: `WriteEventSuppressor.expectWrite(path, content)`、`expectDelete(path)`、`shouldSuppress(path): Promise<boolean>`。
- Produces: `LatestTaskRunner.run(task: () => Promise<void>): Promise<void>`，合并重入并只保留最新任务。
- Produces: `resolveGitHeadPath(workspacePath, git): Promise<string | undefined>`。
- Extension 每次同步前重新解析 symbolic-ref，并监听真实 git HEAD。

- [ ] **Step 1: 写精确抑制失败测试**
  - 匹配扩展预期内容的事件只抑制一次。
  - 用户写入不同内容时不抑制；预期删除后若文件被重建则不抑制。
- [ ] **Step 2: 写 LatestTaskRunner 和 worktree 失败测试**
  - 多次重入不并行，过期任务不覆盖新会话，完成后只补跑最新任务。
  - 真实 worktree 中解析出的 HEAD 路径指向外部 gitdir，切换分支后上下文更新。
- [ ] **Step 3: 运行测试并确认失败**
- [ ] **Step 4: 实现并接入扩展生命周期**
  - 移除 10 秒时间抑制，所有本地 pull/delete 使用精确抑制。
  - 每次同步前重读分支，detached HEAD 跳过。
  - 监听 `resolveGitHeadPath` 结果；refreshSessions 使用 LatestTaskRunner，过期 session 立即 dispose，覆盖前 dispose。
- [ ] **Step 5: 运行 watcher、runner、workspaceResolver 和完整测试**

### Task 6: 扫描剪枝、凭据脱敏与配置文档

**Files:**
- Modify: `src/core/fileStore.ts`
- Modify: `src/core/git.ts`
- Modify: `src/core/errorSummary.ts`
- Modify: `src/core/types.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `test/envSyncEngine.test.ts`
- Create: `test/gitSecurity.test.ts`
- Modify: `README.md`
- Modify: `README.cn.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `envSync.syncIgnoreDirectories` 和 `WorkspaceSyncContext.ignoredDirectoryNames`。
- Produces: `redactRepoUrl(value: string): string`，供日志和 GitCommandError 使用。
- readMatchingFiles 增加目录名剪枝参数，并始终排除 Task 1 元数据。

- [ ] **Step 1: 写扫描与脱敏失败测试**
  - 忽略目录中放置匹配 env，验证不读取、不同步；嵌套项目仍排除。
  - 保留 130,000 文件测试。
  - HTTP(S)/SSH userinfo 和常见 token 查询参数在日志/错误中不泄露，原始 Git URL 不被修改。
- [ ] **Step 2: 运行测试并确认失败**
- [ ] **Step 3: 实现迭代扫描、目录剪枝和统一脱敏**
  - 不使用 `push(...array)` 或完整子目录数组。
  - 配置初始化日志及 GitCommandError 的 message/stdout/stderr/cause 全部脱敏。
- [ ] **Step 4: 更新 package 配置和中英文文档**
  - 说明三方同步、哈希目录、旧数据迁移、syncIgnoreDirectories、跨窗口锁和失败恢复。
  - CHANGELOG 补 0.2.x 已发布变更，并在 Unreleased 记录本次可靠性修复。
- [ ] **Step 5: 运行完整测试并确认通过**

### Task 7: 全局复审与交付验证

**Files:**
- Review all modified source, tests and docs.
- Modify only issues confirmed by review or verification.

- [ ] **Step 1: 检查设计逐项覆盖率**
  - 对照 spec 的必须实现和验收列表，确认每项有实现与测试。
  - 检查注释和文档没有描述旧行为。
- [ ] **Step 2: 运行完整验证**
  - Run: `npm test`
  - Expected: 全部测试通过，无 TypeScript 错误。
  - Run: `npm run package:vsix`
  - Expected: 生成 VSIX，包含最新 dist。
  - Run: `unzip -t <generated.vsix>` 和 `git diff --check`
  - Expected: 无压缩或格式错误。
- [ ] **Step 3: 进行独立代码复审**
  - 重点检查三方删除语义、状态推进时机、锁接管、pathspec 提交和迁移兼容性。
  - Critical/Important 问题必须回到对应 Task 补失败测试并修复。
- [ ] **Step 4: 检查工作区并报告**
  - 保留交付所需 VSIX，删除验证产生的临时文件。
  - 未经用户后续明确要求，不自行 commit、push 或发布。
