# Env Sync

Env Sync 是一个 VS Code 插件，用来把当前工作区命中的环境变量文件同步到一个独立的 Git 仓库，并在打开项目时自动拉回对应文件。

## 功能

- 初始化一个已有的私有 Git 仓库作为配置仓库
- 打开新的 Git 项目时，根据当前项目 `origin` 自动映射到配置仓库目录
- 自动从配置仓库拉取命中的环境变量文件到当前项目
- 本地命中的环境变量文件发生变化时，自动 `commit` 并 `push` 到配置仓库
- 冲突时进入安全模式，不静默覆盖本地或远端内容
- 使用路径正则数组配置匹配规则，任一正则命中即同步

## 工作方式

### 项目映射规则

插件会读取当前工作区根目录 Git 仓库的 `remote.origin.url`，并将其归一化成：

```text
github.com/<owner>/<repo>
```

例如：

- `git@github.com:team/app.git`
- `https://github.com/team/app.git`
- `ssh://git@github.com/team/app.git`

都会映射成：

```text
github.com/team/app
```

配置仓库中的存储路径固定为：

```text
projects/<host>/<owner>/<repo>/
```

例如：

```text
projects/github.com/team/app/.env.local
projects/github.com/team/app/config/.env.dev
```

### 同步触发时机

1. 打开工作区时
2. 命中的文件在本地创建、修改或删除时

### 打开工作区时的行为

- 远端有、本地无：自动拉取到本地
- 本地有、远端无：提示 `Upload local` 或 `Skip`
- 本地和远端内容一致：跳过
- 本地和远端同名但内容不同：提示 `Pull remote`、`Upload local`、`Skip`

### 本地变更时的行为

- 命中的文件创建或修改后，插件会在 3 秒防抖后自动同步
- 命中的文件被删除后，配置仓库对应文件也会被删除
- 所有上传任务都会进入全局串行队列，避免多个工作区并发操作同一个配置仓库

## 要求

- VS Code 1.112.0+
- 本机已安装 `git`
- 本机 `git` 已配置好认证能力
  - SSH key
  - 或 credential helper
- 本机 `git` 已配置 `user.name` 和 `user.email`
- 配置仓库已存在，且建议使用私有仓库

## 配置

### `envSync.configRepoUrl`

配置仓库地址。

示例：

```text
git@github.com:your-org/env-config.git
```

或：

```text
https://github.com/your-org/env-config.git
```

### `envSync.configRepoBranch`

配置仓库使用的分支，默认值：

```text
main
```

### `envSync.pathRegexes`

用于匹配工作区相对路径的 JavaScript 正则数组。只要任意一个正则命中，该文件就会参与同步。

默认值：

```json
[
  "^\\.env[^/]*$"
]
```

这表示只匹配当前项目根目录下以 `.env` 开头的文件，例如：

- `.env`
- `.env.local`
- `.env.production.local`

不会匹配：

- `config/.env`
- `nested/.env.local`

#### 配置示例

只同步根目录 `.env` 系列：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$"
  ]
}
```

同步根目录 `.env` 系列和 `config/` 下的 `.env` 系列：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^config/\\.env[^/]*$"
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

同步根目录 `.env*` 和 `secrets/.runtime.env`：

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^secrets/\\.runtime\\.env$"
  ]
}
```

### 兼容设置：`envSync.pathRegex`

旧版本的单个正则配置仍会作为回退读取，但已经废弃。新配置应使用 `envSync.pathRegexes`。

## 使用方法

### 1. 安装依赖并编译

```bash
cd /Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin
npm install
npm run build
```

### 2. 启动插件开发宿主

这个仓库已经包含调试配置：

- [launch.json](/Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin/.vscode/launch.json)

在 VS Code 中打开仓库后，按 `F5`，选择 `Run Env Sync Extension`。

### 3. 初始化配置仓库

在 Extension Development Host 窗口中执行命令：

```text
Env Sync: Initialize Config Repo
```

然后输入：

- Config Repo URL
- Config Repo Branch

插件会先执行 `git ls-remote` 验证仓库可访问，再将配置保存到全局设置。

## 手工测试

### 准备一个本地 bare repo 模拟配置仓库

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

### 准备一个测试项目

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

### 设置插件配置

如果要同时同步根目录 `.env*` 和 `config/.env*`，可在设置中写入：

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

### 验证首次上传

打开测试项目后，插件会因为远端缺少对应文件而提示 `Upload local`。

选择上传后，在 seed clone 中执行：

```bash
cd /tmp/env-sync-demo/config-seed
git pull
find projects -type f | sort
```

应看到：

```text
projects/github.com/team/app/.env.local
projects/github.com/team/app/config/.env.dev
```

### 验证本地修改自动推送

修改测试项目中的文件并保存：

```bash
cd /tmp/env-sync-demo/app
echo "A=2" > .env.local
```

等待 3 秒以上后执行：

```bash
cd /tmp/env-sync-demo/config-seed
git pull
cat projects/github.com/team/app/.env.local
```

### 验证删除同步

```bash
cd /tmp/env-sync-demo/app
rm .env.local
```

等待 3 秒以上后执行：

```bash
cd /tmp/env-sync-demo/config-seed
git pull
find projects/github.com/team/app -type f | sort
```

### 验证远端拉取

```bash
cd /tmp/env-sync-demo/config-seed
echo "REMOTE=1" > projects/github.com/team/app/.env.remote
git add .
git commit -m add-remote
git push
```

然后重新打开测试项目窗口，或执行 `Developer: Reload Window`。插件会尝试把 `.env.remote` 拉回当前项目根目录。

## 自动化测试

执行：

```bash
npm test
```

当前测试覆盖：

- Git `origin` URL 归一化
- 路径正则数组匹配
- Windows 路径转 POSIX 后的匹配
- 串行队列顺序
- 打开工作区时的拉取/上传决策
- 本地变更后的推送和删除
- 基于真实 Git bare repo 的集成流程

## 调试和日志

插件运行日志会输出到 VS Code `Output` 面板中的：

```text
Env Sync
```

常见问题优先看这里：

- 配置仓库认证失败
- `git pull --rebase` 失败
- `push` 被拒绝
- 正则配置非法
- 当前工作区没有 `origin`

## 当前限制

- 只支持文件系统工作区，不支持远程虚拟工作区
- 只支持已有配置仓库，不会自动创建 GitHub 仓库
- 不做内容加密，建议配置仓库使用私有仓库
- 项目映射规则固定为 `origin -> projects/<host>/<owner>/<repo>/`
- 同步依赖本机 Git 认证状态

## 代码入口

- 扩展入口：[extension.ts](/Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin/src/extension.ts)
- 同步引擎：[envSyncEngine.ts](/Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin/src/core/envSyncEngine.ts)
- 配置仓库管理：[configRepoManager.ts](/Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin/src/core/configRepoManager.ts)
- 路径匹配：[pathRegex.ts](/Users/q.chen.jcjy/Documents/code/github/vs-env-autoimport-plugin/src/core/pathRegex.ts)
