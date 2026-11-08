# Env Sync 中文说明

Env Sync 用于把每个 Git 项目中命中的环境变量文件，同步到一个专用的配置仓库里。

适合这样的场景：你希望用一个私有仓库统一备份、共享和恢复各个项目的 `.env` 类文件，而不是手工拷贝。

如需英文说明，见 `README.md`。

## 功能特性

- 配置一个已有的私有 Git 仓库作为环境变量配置仓库
- 递归发现当前工作区中的 Git 项目
- 自动读取每个 Git 项目的 `origin` 和当前分支，映射到配置仓库中的分支独立目录
- 打开工作区时自动拉取匹配的 env 文件
- 本地 env 文件变更后自动提交并推送到配置仓库
- 本地与远端内容冲突时提示用户选择，不静默覆盖
- 使用多个“Git 项目相对路径正则”匹配需要同步的文件
- 在 VS Code 状态栏显示当前同步状态
- 递归发现 Git 项目时跳过指定目录
- 对常见 Git 错误做分类提示，例如认证失败、网络失败、push 被拒绝、rebase 冲突

## 工作原理

Env Sync 会在当前工作区目录下，按可配置的最大深度递归查找 Git 项目，并读取每个项目的 `remote.origin.url` 和当前分支。项目身份保留完整组路径，例如 `gitlab.com/group/subgroup/app`，不会因为多级 group 而碰撞。

从 **0.3.0** 起恢复普通项目和分支的可读目录。例如业务项目 `github.com/NickBoomBoom/electron-ai-switch` 的 `v3` 分支，准确路径为：

```text
projects/github.com/NickBoomBoom/electron-ai-switch/branches/v3
```

该目录位于**配置仓库的 Git 分支**中，通常是 `main`。业务分支只是目录，插件不会在配置仓库创建同名的 `v3` Git 分支。

完整的嵌套 group 路径会保留。安全的小写分支名 `main`、`v3` 原样使用；`/` 编码为 `%2F`，字面 `%` 编码为 `%25`，其他特殊字符按 UTF-8 字节百分号编码。含大写的分支（如 `Feature`）、Windows 保留名或超长名称使用“可读前缀 + `~` + 16 位十六进制 hash”。GitHub 项目保留 `origin` 中的原始大小写；其他可能大小写敏感的 host，对混合大小写的项目段增加可读前缀和短 hash 后缀。极长、过深的项目路径回退为 `~project-<可读前缀>~<hash>`，标记文件仍保存真实项目和分支身份。完整规则和示例见[存储布局与迁移设计](docs/STORAGE.md)。

### 从 0.2.2–0.2.7 升级

这些历史版本使用纯 hash 目录：

```text
projects/<host>/<项目路径哈希>/branches/<分支名哈希>/
```

**旧目录保留，不会删除。** 迁移优先采用完整 hash 分支快照，整份复制；不会再从更老的 shared 目录补齐“缺少”的文件，因为缺失可能代表用户已经删除。已有可读目录中的 version-1 marker 不能跳过对 hash 来源的检查。目标与来源同名文件内容不同、或目标含来源没有的文件时，会先弹出独立的模态确认：采用来源快照、保留可读目标且不合并来源，或取消本轮同步且不推进基线。采用存在冲突的来源前，先把目标旧数据归档到目标内部 `.env-sync-archive`，再替换活动快照；旧来源始终保留。归档包含 env 密钥，会随该分支目录一起 commit 到配置仓库，但 scanner 不把归档作为活动 env 数据扫描。

迁移使用 `env-sync-migration.json` 日志，中断后可以重试；重试时来源变化、身份不匹配或路径包含符号链接/重定向会停止处理。旧 owner/repo 目录无法证明嵌套 group 的完整项目身份时，必须确认来源。最后才写入 version-2 / `readable-v2` marker。只有等价复制完整 hash 快照才复用旧 baseline；选择不同于原 hash 快照的可读目标、或从更老 legacy 来源迁移时，用 `baselineGeneration` 隔离旧基线。仅在 commit/push 成功处理后保存 state。冲突选择、恢复和基线规则详见设计文档。

安装 0.3.0 并重载 VS Code 后，打开目标项目、切换到目标业务分支，运行 **Env Sync：立即重新同步** 即可触发迁移。范围是当前打开工作区中发现的项目及其**当前分支**，不会一次迁移所有未打开项目或尚未切换到的分支。请先阅读迁移确认弹窗，再到配置仓库 `main`（或自行配置的分支）查看可读目录。

使用同一配置仓库的**所有客户端都应一并升级**。某分支完成迁移后，可读目录成为权威；若检测到旧来源内容变化，只警告，不自动合并或双向镜像。旧目录仅保留供查阅，不再是第二份权威数据；完成后不会自动重导入旧源，也不会把已删除文件复活。detached HEAD 状态下没有业务分支名，对应项目会跳过同步。

## 同步行为

打开工作区时：

- 在当前工作区下搜索 Git 项目，并在每次同步前重新解析当前分支
- 准备当前分支的可读存储，必要时安全迁移已有 hash/旧版快照，并支持中断恢复
- 每台设备保存上次同步成功的文件基线，通过本地、远端和基线三方比较判断变化
- 仅远端新增或修改：拉取到本地；仅远端删除：删除本地文件
- 仅本地新增或修改：上传；只有基线证明是本地删除时才删除远端文件
- 两边同时变化且内容不同：提示 `拉取远端文件`、`上传本地文件` 或 `跳过`
- 冲突选择跳过后保留旧基线，后续保存其他文件不会静默覆盖该冲突

本地文件变化时：

- 命中的文件 create/change/delete 事件会做 3 秒防抖
- 配置仓库自动 commit 并 push，提交范围严格限定当前项目分支目录
- push 被拒绝时自动 fetch/rebase 重试；此前未推送的提交会在后续同步中补发
- 多 VS Code 窗口通过跨进程锁串行操作同一个配置仓库副本
- worktree 的真实 HEAD 会被监听，扩展自身的写入事件与用户编辑通过内容哈希区分

## 状态栏与错误提示

Env Sync 会在状态栏放一个入口：

- `$(check)`：空闲状态
- `$(sync~spin)`：正在进行打开工作区同步或 push 同步
- `$(error)`：最近一次同步失败

点击状态栏项会打开 `Env Sync` 输出面板。

当前会对常见 Git 失败做更明确的分类提示，包括：

- 仓库访问被拒绝
- 网络访问失败
- 远端拒绝 push
- rebase 或 merge 冲突
- Git 可执行文件不可用

## 诊断与修复命令

从 0.2.5 起提供以下命令。按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`），搜索 `Env Sync`：

| 命令 ID | 命令面板标题 | 用途 |
| --- | --- | --- |
| `envSync.diagnoseConfigRepo` | Env Sync：诊断配置仓库 | 不联网、不 clone、不修改仓库；在输出面板展示插件缓存路径、分支、工作树状态、stash 和 rebase 状态。 |
| `envSync.repairConfigRepo` | Env Sync：修复未完成的 rebase | 仅修复插件缓存中的配置仓库，不操作业务项目仓库。弹窗确认后先完整备份，再撤销未完成的 rebase；没有 rebase 时不做修改。 |
| `envSync.syncNow` | Env Sync：立即重新同步 | 重新执行当前工作区同步流程，可能拉取、提交和推送 env 文件，并非只读检查。 |
| `envSync.showOutput` | Env Sync：显示输出 | 查看诊断信息、错误及备份路径。 |
| `envSync.openConfigRepo` | Env Sync：打开配置仓库目录 | 在扩展宿主机器上定位插件缓存，方便手动检查；不会打开或修改业务项目。 |

修复流程与安全边界：

1. 检查插件缓存配置仓库的 rebase 状态；没有未完成的 rebase 时不修改仓库。
2. 弹窗说明影响并要求用户确认。取消后不执行备份或撤销。
3. 在同一个扩展 `globalStorage` 的 `repair-backups` 下完整备份配置仓库，包含 `.git`、未跟踪及忽略的 env 文件；备份失败不运行撤销。备份可能包含 env 密钥，请妥善保管。
4. 备份成功后运行 `git rebase --abort`，而不是删除 rebase 状态目录。不会自动 `pop` stash，也不会强制 push 或 reset；撤销会放弃本次变基及冲突解决进度。
5. 如果 abort 失败，保留备份并在输出面板查看错误及备份路径；不要直接删除 rebase 目录。
6. 成功后由用户选择“立即重新同步”，不静默开始同步。实际内容冲突仍可能出现，需要人工处理；保留的 stash 不会自动恢复。

针对 `already a rebase-merge directory`，建议先运行诊断，确认备份并修复后检查保留的 stash，再选择是否重新同步。

如果诊断已显示“rebase 状态：无”、工作树干净，却在 0.2.5 遇到“配置仓库未能提交本轮 env 变更”，请升级到 0.2.6 后运行“立即重新同步”，不必再次撤销 rebase。Git 换行规范化（例如 `core.autocrlf=true`）可能使暂存后无新增差异，这属于成功且无需新提交；真正的 Git 错误仍会中止同步并保留原基线。升级不会自动恢复或删除已有 stash。

## 使用要求

- VS Code 1.112.0 或更高版本
- 运行扩展宿主的机器已安装 `git`
- 已经存在一个用于保存 env 数据的私有 Git 仓库
- 已配置好可用的 Git 认证方式，例如 SSH key 或 credential helper
- 已配置 `git config user.name` 和 `git config user.email`

## 配置项

### `envSync.configRepoUrl`

用于保存同步 env 文件的私有 Git 仓库地址。

示例：

```text
git@github.com:your-org/env-config.git
```

### `envSync.configRepoBranch`

配置仓库使用的分支名。

默认值：

```text
main
```

### `envSync.pathRegexes`

一个字符串数组，每一项都是 JavaScript 正则，匹配对象是“相对于 Git 项目根目录的 POSIX 路径”。任意一个正则命中时，该文件会被同步。

默认值：

```json
[
  "^\\.env[^/]*$"
]
```

默认规则只匹配项目根目录下以 `.env` 开头的文件，例如：

- `.env`
- `.env.local`
- `.env.production.local`

不会匹配 `config/.env.local` 这种子目录文件。

### `envSync.gitProjectSearchDepth`

控制在工作区根目录下向下递归查找 Git 项目的层级深度。

默认值：

```json
2
```

示例：

- `0`：只检查工作区根目录自身
- `1`：检查根目录和一级子目录
- `2`：检查根目录、一级子目录和二级子目录

如果你打开的是一个父目录，里面包含多个同级 Git 仓库，这个配置决定了 Env Sync 会往下找多深。

### `envSync.gitProjectIgnoreDirectories`

递归发现 Git 项目时需要跳过的目录名列表。

默认值：

```json
[
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store"
]
```

这个配置只影响“Git 项目发现”，不影响 env 文件匹配。适合在打开大型父目录时，排除构建产物目录、包缓存目录等无意义扫描路径。

### `envSync.syncIgnoreDirectories`

扫描要同步的 env 文件时按目录名称跳过，本地项目和配置仓库中的扫描都会生效。默认值与项目发现忽略项相同：

```json
[
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store"
]
```

该配置用于减少大型项目的遍历和内存占用；嵌套 Git 项目根目录及插件内部元数据始终排除。

### `envSync.notificationLevel`

控制 Env Sync 通过 VS Code 通知弹窗展示多少信息。

默认值：

```json
"summary"
```

可选值：

- `errors`：只显示错误通知
- `summary`：只在实际发生拉取、上传、更新、删除时显示成功摘要
- `all`：连“检查了但没有变化”的情况也显示

### 配置示例

只同步根目录下的 `.env*` 文件：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$"
  ]
}
```

同步根目录 `.env*` 文件和 `config/.env*` 文件：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^config/\\.env[^/]*$"
  ],
  "envSync.gitProjectIgnoreDirectories": [
    "node_modules",
    "dist",
    "coverage"
  ]
}
```

只同步 `.env` 和 `.env.local`：

```json
{
  "envSync.pathRegexes": [
    "^\\.env$",
    "^\\.env\\.local$"
  ]
}
```

同步根目录 `.env*` 文件和一个指定的 secret 文件：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^secrets/\\.runtime\\.env$"
  ]
}
```

### `envSync.pathRegex`

已废弃的单正则回退配置。新配置请使用 `envSync.pathRegexes`。

## 命令

### `Env Sync：初始化配置仓库`

会依次提示输入：

- 配置仓库地址
- 配置仓库分支

保存前会先通过 `git ls-remote` 验证仓库是否可访问。

## 开发

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

运行测试：

```bash
npm test
```

在 VS Code 中调试扩展：

- 用 VS Code 打开这个仓库
- 按 `F5`
- 选择 `Run Env Sync Extension`

仓库已经包含 `.vscode/launch.json`，可直接用于扩展调试。

## 打包

本地打包 VSIX：

```bash
npm run package:vsix
```

该命令会使用本地安装的 `@vscode/vsce` 生成 `.vsix` 包。

## 发布到 Marketplace

发布前需要：

1. 创建或确认你的 Marketplace publisher ID
2. 确保 `package.json` 中的 `publisher` 与该 publisher ID 完全一致
3. 创建一个带有 `Marketplace > Manage` 权限的 Azure DevOps Personal Access Token
4. 使用 `vsce` 登录
5. 发布扩展

常用命令：

```bash
npx @vscode/vsce login <publisher-id>
npm run deploy
```

如果你更倾向手动上传：

```bash
npm run package:vsix
```

然后到 Marketplace 的 publisher 管理页面上传生成的 `.vsix` 文件。

## GitHub Actions 发布流程

仓库已经包含发布工作流：`.github/workflows/publish.yml`。

行为如下：

- 向 `main` 发起 Pull Request：只执行安装和测试
- 向 `main` push：只执行安装和测试
- push 符合 `v*` 的 tag：执行校验、打包扩展、上传 VSIX artifact，并发布到 Visual Studio Marketplace
- 手动触发：可选择发布当前 `main` 分支

### 必需的 GitHub Secret

需要在仓库中配置：

- `VSCE_PAT`：你的 Azure DevOps Marketplace Personal Access Token，权限需包含 `Marketplace > Manage`

### 推荐发布流程

1. 更新 `package.json` 版本和 `CHANGELOG.md`
2. 提交到 `main`
3. 创建对应版本的 Git tag，例如 `v0.1.0`
4. push 分支和 tag

示例：

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

工作流会在发布前校验 Git tag 版本与 `package.json` 中的版本是否一致。

### 手动发布

也可以在 GitHub Actions 页面手动运行工作流，并开启 `publish` 输入项。工作流中限制了手动发布只能基于 `main` 分支执行。

## 手工测试流程

先创建一个本地 bare repo，模拟配置仓库：

```bash
mkdir -p /tmp/env-sync-demo
cd /tmp/env-sync-demo
git init --bare config.git

git clone /tmp/env-sync-demo/config.git config-seed
cd config-seed
git config user.name tester
git config user.email tester@example.com
echo "# seed" > README.md
git add README.md
git commit -m init
git branch -M main
git push -u origin main
```

再创建一个测试项目：

```bash
cd /tmp/env-sync-demo
mkdir app
cd app
git init
git config user.name tester
git config user.email tester@example.com
git remote add origin git@github.com:team/app.git
echo "A=1" > .env.local
mkdir -p config
echo "B=2" > config/.env.dev
```

示例配置：

```json
{
  "envSync.configRepoUrl": "/tmp/env-sync-demo/config.git",
  "envSync.configRepoBranch": "main",
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^config/\\.env[^/]*$"
  ]
}
```

在扩展开发宿主中打开测试项目，初始化配置仓库后，重点验证：

- 首次上传提示
- 保存后的自动 push
- 删除同步
- 重新打开或 reload 后自动 pull

## 限制

- 仅支持文件系统工作区
- 不支持未受信任工作区
- 不支持虚拟工作区
- 扩展不会替你创建 GitHub 仓库
- 提交前不会对 secrets 做加密
- 存储采用[设计文档](docs/STORAGE.md)中的 readable-v2 可读命名及冲突保护规则，不提供任意自定义布局
- 迁移后的 hash/legacy 旧目录是历史快照，不是双向镜像；依赖 readable-v2 数据前应升级所有客户端

## Release Notes

见 `CHANGELOG.md`。
