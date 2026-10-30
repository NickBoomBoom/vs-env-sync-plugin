# Branch-specific Env Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按项目当前 Git 分支隔离 env 数据，并在分支首次同步时继承旧共享数据。

**Architecture:** 项目发现阶段同时解析 `origin` 与当前分支，将分支名加入同步上下文。同步引擎把新数据写入项目下的 `branches/<encodeURIComponent(branch)>/`，首次访问时复制旧目录中的匹配文件；旧目录保留且扫描时排除 `branches/`。

**Tech Stack:** TypeScript、Node.js `fs/path`、Git CLI、Mocha、VS Code Extension API。

**Spec:** `docs/superpowers/specs/2026-10-30-branch-env-storage-design.md`

## Global Constraints

- 沿用 `envSync.configRepoBranch`，不按项目分支切换配置仓库分支。
- 旧共享数据不删除；分支目录存在后不再回退旧数据。
- detached HEAD 跳过同步并记录警告。
- 不新增依赖，不改变现有冲突提示、防抖与串行队列行为。
- 未经用户要求不执行 Git commit 或其他 Git 历史修改。

## Review Focus

- 含 `/` 的分支名必须映射为单个安全目录段：Task 2 Step 1 的路径断言。
- detached HEAD 不得写入共享或分支数据：Task 1 Step 1 的解析测试。
- 已存在但为空的分支目录不得再次继承：Task 2 Step 1 的初始化断言。
- 自定义嵌套正则不得把 `branches/` 内容识别为旧共享数据：Task 2 Step 1 的排除断言。
- 继承后旧数据及其他分支数据不得被当前分支修改：Task 2 Step 1 的隔离断言。

---

### Task 1: 当前分支识别与同步上下文

**Files:**
- Modify: `src/core/workspaceResolver.ts`
- Modify: `src/core/types.ts:36-43`
- Modify: `src/extension.ts:416-433`
- Test: `test/workspaceResolver.test.ts`
- Test: `test/envSyncEngine.test.ts`
- Test: `test/gitIntegration.test.ts`

**Interfaces:**
- Produces: `resolveWorkspaceBranch(workspacePath: string, git: GitCli): Promise<string | undefined>`。
- Produces: `DiscoveredWorkspaceProject.branch: string | undefined`。
- Produces: `WorkspaceSyncContext.branch: string`，供 Task 2 生成存储路径。

- [ ] **Step 1: 写失败测试**

在 `workspaceResolver.test.ts` 增加：在 `feature/login` 分支调用 `resolveWorkspaceBranch` 返回 `feature/login`；detached HEAD 返回 `undefined`；`discoverWorkspaceProjects` 返回对应分支名。为现有同步测试的 `createContext` 增加 `branch: "main"`，先观察 TypeScript 因接口尚未实现而失败。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --grep "workspaceResolver"`
Expected: 编译失败或新增分支解析断言失败，因为 `resolveWorkspaceBranch` 尚不存在。

- [ ] **Step 3: 实现分支解析与上下文传递**

在 `workspaceResolver.ts` 用 `git symbolic-ref --quiet --short HEAD` 实现 `resolveWorkspaceBranch`，让发现结果携带 `branch`。在 `types.ts` 增加必填 `WorkspaceSyncContext.branch`。在 `extension.ts` 构造上下文时跳过无分支项目并用 `logger.warn` 记录原因，其余项目传入当前分支；保留现有 Git 监听缓存失效逻辑。

- [ ] **Step 4: 运行分支解析测试**

Run: `npm test -- --grep "workspaceResolver"`
Expected: 所有 workspace resolver 测试 PASS，同步测试上下文可编译。

### Task 2: 分支存储路径与旧数据首次继承

**Files:**
- Modify: `src/core/envSyncEngine.ts`
- Test: `test/envSyncEngine.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSyncContext.branch: string`。
- Produces: 新存储路径 `projects/<host>/<owner>/<repo>/branches/<encodeURIComponent(branch)>/`。
- Produces: 打开同步与推送同步共用的分支存储准备逻辑，返回分支根目录及是否发生继承。

- [ ] **Step 1: 写失败测试**

调整现有测试的远端路径到 `.../app/branches/main/`。新增测试并断言：
- `feature/login` 写入 `branches/feature%2Flogin/`，不写入 `branches/feature/login/`。
- 分支目录不存在时复制旧目录匹配文件并调用一次提交，旧文件内容不变。
- 已存在空分支目录时不复制旧文件。
- 当前分支更新不会改动旧目录或另一分支目录。
- 旧目录继承读取排除 `branches/`，即使嵌套路径正则可能命中其中的 env 文件。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --grep "EnvSyncEngine"`
Expected: 新路径及继承断言 FAIL，现有实现仍读写旧项目根目录。

- [ ] **Step 3: 实现分支路径和继承**

在 `envSyncEngine.ts` 增加旧项目根目录与分支根目录两个路径函数，分支段使用 `encodeURIComponent(context.branch)`。同步前检查分支目录：不存在且旧目录有匹配文件时复制到分支目录；旧目录读取的忽略项加入 `branches`。之后所有读取、写入、删除和 `git add` 仅针对分支根目录。继承或普通上传任一发生时提交；保留原同步结果语义，并记录继承日志。

- [ ] **Step 4: 运行同步引擎测试**

Run: `npm test -- --grep "EnvSyncEngine"`
Expected: 所有 EnvSyncEngine 测试 PASS，包括首次继承、已初始化、分支隔离和旧数据排除。

### Task 3: Git 端到端验证与用户文档

**Files:**
- Modify: `test/gitIntegration.test.ts`
- Modify: `README.md`
- Modify: `README.cn.md`

**Interfaces:**
- Consumes: Task 1 的 `WorkspaceSyncContext.branch` 和 Task 2 的分支存储、继承行为。

- [ ] **Step 1: 写失败的 Git 集成测试**

扩展现有集成测试：远端 main 分支数据从 `branches/main/` 拉取并推回该目录。增加旧目录首次同步用例，验证继承提交被推送后，新克隆的配置仓库同时保留旧文件和 `branches/main/` 文件。

- [ ] **Step 2: 运行集成测试确认变化覆盖有效**

Run: `npm test -- --grep "git integration"`
Expected: Task 2 完成后 PASS；若路径或继承提交未进入真实 Git 远端则 FAIL。

- [ ] **Step 3: 更新中英文说明**

在 README 的功能、存储路径和限制部分说明分支目录、分支名编码、首次继承、旧数据保留、detached HEAD 跳过，以及旧版本插件不能读取新分支数据。

- [ ] **Step 4: 运行完整验证**

Run: `npm test`
Expected: TypeScript 构建成功，全部单元测试和 Git 集成测试 PASS。

Run: `git status --short`
Expected: 只显示本次设计、实现、测试和文档修改，以及原有未跟踪 `.DS_Store`；不删除用户原有文件。
