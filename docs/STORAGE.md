# Storage layout and migration / 存储布局与迁移

本文说明即将发布的 **0.3.0** 的 `readable-v2` 布局及其安全迁移边界。普通项目和分支恢复可读名称；纯 hash 目录只作为 0.2.2–0.2.7 的历史兼容来源保留。

实现依据：[路径与身份标记](../src/core/storagePaths.ts)、[迁移状态机](../src/core/storageMigration.ts)。本文不表示旧版客户端已支持新布局。

## 1. 在 GitHub 上去哪里找

业务项目：`github.com/NickBoomBoom/electron-ai-switch`；业务分支：`v3`。

准确的目录是：

```text
projects/github.com/NickBoomBoom/electron-ai-switch/branches/v3
```

该目录位于**配置仓库自己的 Git 分支**上，默认 `envSync.configRepoBranch = main`。业务分支 `v3` 是这个目录的一部分，**不是**配置仓库里的同名 Git 分支。查看 GitHub 时，应先选配置仓库的 `main`（或自己配置的分支），再逐层进入上述目录。

例如匹配的 `.env`、`.env.prod` 文件将直接位于这个 `v3` 目录中。输出面板会记录业务项目、业务分支、配置仓库分支及实际存储路径；特殊名称以日志中的实际路径为准。

**English:** In 0.3.0, the example above is the exact readable path. It lives on the config repository's `main` Git branch; `v3` identifies a business-branch directory, not a second Git branch in the config repository.

## 2. 命名规则：普通名称可读，边界情况防碰撞

基本结构：

```text
projects/<host>/<完整项目路径>/branches/<安全编码后的业务分支>
```

### host 和项目路径

- host 使用小写。
- 保留完整嵌套 group，不把 `group/subgroup/app` 压缩成最后两段 `subgroup/app`。通常可直接看到 `projects/gitlab.com/group/subgroup/app/branches/main`。
- GitHub 项目路径大小写不敏感，因此保留 `origin` 解析后的原始显示大小写：`NickBoomBoom/electron-ai-switch` 不会被强制转为小写或纯 hash。
- 其他 host 可能区分项目路径大小写。包含大写字母的项目段使用可读前缀加短 hash 后缀，例如 `Group~<16-hex>`，避免在 Windows 等大小写不敏感文件系统上覆盖另一个项目。
- `/` 在项目身份中表示 group 层级；对各项目段分别编码，而不是把完整嵌套 group 当成一个目录名。

### 分支名和单个目录段

安全的 ASCII 字符 `a-z`、`A-Z`、`0-9`、`.`、`_`、`-` 可直接显示。其他字符按 **UTF-8 字节**使用大写十六进制百分号编码；字面 `%`、`~` 也要编码，防止与转义或 hash 后缀混淆。

| 业务分支原名 | 目录名或形式 | 原因 |
| --- | --- | --- |
| `main` | `main` | 普通安全小写名称原样保留 |
| `v3` | `v3` | 普通安全小写名称原样保留 |
| `feature/login` | `feature%2Flogin` | slash 编码，不创建额外层级 |
| `topic%done` | `topic%25done` | 字面百分号编码，不能冒充转义 |
| `café` | `caf%C3%A9` | 非 ASCII 字符按 UTF-8 编码 |
| `topic~one` | `topic%7Eone` | 保留 `~` 作为受保护后缀分隔符 |
| `Feature` | `Feature~<16-hex>` | 分支区分大小写，保护大小写不同的名称 |
| `con` | `con~<16-hex>` | Windows 保留名保护 |
| 超长名称 | `<可读前缀>~<16-hex>` | 限制单段长度 |

`<16-hex>` 是说明占位符，不是实际目录文字：实际值是原始名称的 `SHA-256("v1:" + name)` 的前 **16 个十六进制字符**。

以下情况使用后缀：大小写敏感的名称含大写、Windows 保留名（`con`、`prn`、`aux`、`nul`、`com0`–`com9`、`lpt0`–`lpt9`，包括带扩展名的形式）、`.git`、名称以点结尾、编码后长度超过 96 个字符。可读前缀最多保留编码名称的前 64 个字符，且不截断一个百分号转义。

因此 `Feature` 仍然能一眼辨认，而不会退回整段不可读 hash；小写 `feature` 与其目录不同。带扩展名的 Windows 保留名（例如 `aux.txt`）及 `.git` 还会在前缀前加 `_`，因为只在扩展名之后追加 hash 仍无法避开 Windows 设备名规则。

### 极长或很深的项目路径

若编码后项目路径（含各 group 间的 `/`）超过 200 个字符，不继续无限加深目录，而回退为一个项目目录：

```text
projects/<host>/~project-<可读前缀>~<16-hex>/branches/<安全业务分支名>
```

前缀来自真实项目路径，将 group 间 `/` 显示为 `--` 后编码并截短；hash 来自完整原始项目路径。真实 host、完整项目路径和原始分支名仍保存在最终身份 marker 中，不能只靠截短后的显示名推断身份。

**English:** Safe lowercase branches stay unchanged. Slash and literal percent encode to `%2F` and `%25`; other special characters are UTF-8 percent-encoded. Case-sensitive mixed-case names, Windows-reserved names and long names keep a readable prefix with a 16-hex hash suffix. GitHub preserves origin display casing; other hosts protect mixed-case project components. Full nested groups remain visible except for the documented extremely-long-path fallback.

## 3. 历史布局与优先级

### 0.2.2–0.2.7：纯 hash 分支目录

```text
projects/<host>/<project-path-hash>/branches/<branch-name-hash>
```

这两个历史 hash 是完整项目路径和分支名各自的 `SHA-256("v1:" + value)`。它们**不会被删除**，但在迁移完成后不再是活动权威目录。

### 更早的布局

```text
projects/<host>/<owner>/<repo>/branches/<encodeURIComponent(branch)>
projects/<host>/<owner>/<repo>
```

第二种是项目共享目录，没有独立业务分支快照。更老的 owner/repo 布局也可能缺少完整嵌套 group 身份。

### 迁移来源选择

1. 优先检查当前完整项目身份、当前业务分支对应的 hash 快照。
2. 没有可用 hash 来源时，才检查更早的分支来源。
3. 更老 shared 来源只用于尚无活动分支快照的初始化，不能给已存在的 hash/可读分支“补缺”。

分支来源按**完整活动分支快照**复制，而不按今天可能变窄的 env 正则重新挑选部分文件。内部 marker、迁移日志与归档目录不是活动数据文件。

**不能合并多个年代的来源来凑齐文件。** 某文件未出现在完整分支快照中，可能说明它已经被删除；从更老 shared 目录补回会把删除复活。即使可读目标已有 version-1 marker，也不能因此跳过 hash 来源检查，忽略后续在 hash 目录中发生的更新。

## 4. 独立的迁移确认：不是普通 env 冲突弹窗

当目标与来源的同名文件内容不同，或目标有来源不存在的文件时，先弹出**独立模态确认**，列出来源路径、目标路径和需核对的文件。这一步在普通本地/配置仓库 env 文件冲突选择之前。来源仅有目标缺少的新增文件、且不会覆盖或移除任何目标文件时，可以直接复制，无需额外确认。

| 选择 | 行为 |
| --- | --- |
| **采用来源快照** | 对存在差异的目标，先归档其旧活动数据，再用来源快照替换活动目标；不保留 target-only 文件作为活动数据；旧来源不删除 |
| **保留可读目录** | 保留当前可读目标，不把来源独有文件合并进来；后续与本地工作区的差异仍按普通同步规则确认 |
| 取消/关闭弹窗 | 停止本轮同步，不推进同步基线，不把“未确认”当作迁移成功 |

身份不能靠目录外观猜测。旧 owner/repo 路径无法证明嵌套 group 的完整身份时，即使看起来没有内容冲突，也必须确认来源；可能混淆大小写分支的旧身份同样需要确认。

正式执行前会重新核对来源、目标和 marker，避免用户停留在模态弹窗期间发生的外部编辑被静默覆盖。身份不匹配或路径包含符号链接/重定向时，迁移停止，不借此写入其他项目或外部目录。

## 5. 目标归档：包含密钥，会提交到配置仓库

采用有差异的来源时，旧目标数据先保存到**目标分支目录内部**：

```text
projects/<host>/<project>/branches/<branch>/.env-sync-archive/<archive-id>/
```

归档完成记录写入迁移日志之后，才可以替换活动目标或移除 target-only 活动文件。旧目标 marker 也可随归档保留。旧来源目录始终保持原样。

重要安全边界：

- 这是分支数据内的归档，不是只保存在本机、永不上 Git 的备份。
- 归档可能包含完整 env 密钥和旧凭据，**会随该分支目录一起 commit/push 到配置仓库**。必须使用访问权限合适的私有仓库。
- scanner 排除 `.env-sync-archive`、`env-sync-branch.json`、`env-sync-migration.json` 等内部数据，不把归档再次当作活动 env 导入工作区或参与普通文件比较。
- 正常 Git 历史中仍可能存在旧密钥；文件迁移/归档不等同于加密、密钥撤销或清理 Git 历史。

## 6. 中断恢复与最后写入的身份 marker

迁移中的状态记录在目标内的 `env-sync-migration.json`，包括来源、来源类型、快照指纹、用户选择、目标 metadata 和归档进度。日志的 `version: 1` 是**日志格式版本**，不要与旧分支 version-1 marker 混淆。

- 先写日志，再按需要完成归档和活动快照替换。
- 中断后重新同步可读取日志继续；不会依赖“目录已经存在”来假定完成。
- 若恢复时来源已消失或其指纹变化，停止并要求核对，不把新的来源内容悄悄合进半完成迁移。
- 如果日志身份或来源路径不属于当前项目/分支，或 marker 身份不匹配，则拒绝迁移。
- 活动数据处理完成后，**最后**写入 `env-sync-branch.json` 的 version-2 / `readable-v2` marker，再清理迁移日志。

最终 marker 保存真实身份，迁移时还保存来源信息。示意：

```json
{
  "version": 2,
  "layout": "readable-v2",
  "project": {
    "host": "github.com",
    "path": "NickBoomBoom/electron-ai-switch"
  },
  "branch": "v3",
  "migration": {
    "source": "projects/github.com/<project-path-hash>/branches/<branch-name-hash>",
    "sourceKind": "hashed",
    "fingerprint": "<snapshot-fingerprint>",
    "selection": "source"
  }
}
```

需要隔离基线时另有 `baselineGeneration`；产生目标归档时 migration 另有 `archive` 路径。示例中的尖括号值是说明占位符，实际由插件生成，不应手工照抄 marker。

写完迁移 marker 不代表远端 push 已成功。提交/推送失败仍会报告同步失败，原同步 state 不前进；修复实际 Git 错误后再重试。

## 7. 基线隔离与删除安全

- 只有**等价复制完整 hash 分支快照**，才可复用对应旧 baseline，保持已有删除历史。
- 选择保留不同于完整 hash 快照的可读目标、从更老 legacy 来源迁移或来源不具备完整快照证明时，使用新的 `baselineGeneration` 隔离旧 baseline，避免旧快照中的删除判断应用到新的权威内容上。采用完整 hash 来源时，即使先前的可读旧目标不同，采用的仍是原 hash 基线对应的快照，因此可继续复用该基线。
- 隔离后按首次/上下文变化方式重新确认本地与所选快照的差异，而不是凭旧基线直接覆盖或删除。
- 同步 state 只在成功完成 commit/push 处理后写入；合法的 Git 无新增差异不等同于提交失败。
- 迁移来源确认和普通文件冲突处理各自生效；完成来源迁移不代表自动同意上传/拉取所有本地差异。

## 8. 安装后怎么迁移

1. 备份或确认配置仓库已有可靠 Git 历史，并升级共享该配置仓库的所有客户端到 0.3.0。
2. 安装扩展后重载 VS Code。
3. 打开需要迁移的业务项目，并切到目标业务分支，例如 `v3`。
4. 运行 **Env Sync：立即重新同步**，先处理存储迁移模态确认，再处理可能出现的普通 env 冲突提示。
5. 在输出面板检查实际目录及同步结果；成功后到配置仓库配置的 Git 分支（默认 `main`）查看可读目录。

迁移范围仅为**当前打开工作区中发现的项目及各项目当前分支**。不会一次遍历所有未打开项目、所有 Git 分支或所有历史目录。需要其他分支时，切换过去再同步；需要其他项目时，打开项目后再同步。

## 9. 完成后只有一个权威来源

version-2 marker 表明该业务分支已采用可读布局。后续同步以可读活动目录为准：

- 不自动重导入 hash/legacy 来源，不从旧 shared 补缺，也不复活已经删除的文件。
- 旧来源保留供查阅，不再是权威数据。
- 若检测到 marker 记录的旧来源内容发生变化，只输出警告并要求升级其他客户端、人工核对；不会自动选择谁新谁旧。
- 这不是旧目录与新目录之间的双向镜像。旧版客户端仍写旧目录时，新旧数据可能分叉，必须统一升级；仅升级一台不能保证其他旧客户端的数据进入新布局。
- 不要为“恢复同步”盲目删除 marker、迁移日志、归档或旧目录，也不要手工把旧 shared 文件合并到新目录。

**English migration summary:** Keep old sources unchanged. Prefer and copy one complete hash branch snapshot; never fill missing files from an older shared directory. Resolve differing snapshots in a separate modal choice; cancel stops sync without advancing state. A conflicting target is archived inside `.env-sync-archive` before source adoption; retaining the target does not merge the source. Archives contain secrets and are committed, but excluded from active scanning. A resumable journal protects retries, source changes stop recovery, and the version-2 identity marker is written last. A complete hash-source adoption reuses the baseline for that hash store; selecting a different readable target or adopting legacy/incomplete data gets generation isolation. Source-only additions may copy without a modal when they overwrite or remove no target files. Install 0.3.0 on every client and sync each open project/current branch as needed. Completed readable branches do not re-import or mirror old sources; changes there only warn.
