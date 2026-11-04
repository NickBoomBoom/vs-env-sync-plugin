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

当前分支的数据使用项目和分支的 SHA-256 隔离存储：

```text
projects/<host>/<项目路径哈希>/branches/<分支名哈希>/
```

哈希目录避免多级 group、大小写分支名和大小写不敏感文件系统造成覆盖。日志和提示仍使用完整、可读的 origin 与分支名。

为了兼容旧数据，插件会从旧的 `projects/<host>/<owner>/<repo>/branches/<编码分支名>/` 或更早的项目共享目录继承匹配文件。迁移带初始化标记，中断后可以续传；完成后不再读取旧目录，因此旧文件保持不变，已删除文件也不会被旧数据复活。detached HEAD 状态下没有分支名，对应项目会跳过同步。

## 同步行为

打开工作区时：

- 在当前工作区下搜索 Git 项目，并在每次同步前重新解析当前分支
- 初始化缺失的分支目录，支持从旧分支或旧共享数据续传迁移
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
- 项目映射使用完整 origin 与当前分支的哈希目录，不提供自定义存储布局
- 旧版本扩展仍可读取保留下来的旧共享文件，但无法读取按分支保存的新数据

## Release Notes

见 `CHANGELOG.md`。
