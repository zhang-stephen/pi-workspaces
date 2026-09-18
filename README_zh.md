# pi-workspaces

[English](README.md) | **中文**

为 [pi coding agent](https://pi.dev) 提供的多根工作区（multi-root workspace）扩展。一个工作区把多个目录（称为"根"）合并为一个命名单元，让单个 pi 会话可以跨根读写文件、搜索代码、执行 shell 命令 —— 相当于 VS Code 的多根文件夹，但面向你的 agent。

没有激活工作区时，本扩展完全不做任何事：所有工具行为与原生的 pi 一模一样。

## 功能一览

- **多根文件工具。** 内置的 `read`、`write`、`edit`、`grep`、`find`、`ls` 工具新增 `@根名/` 路径前缀，可以把调用路由到任意工作区根。工具的其他行为（渲染、写入串行化、结果结构）完全继承内置实现。
- **跨根 shell。** `bash` 工具新增可选 `cwd` 参数，接受绝对路径或 `@根名/子目录`，命令会在该根内启动。pi 每次调用都会新建 shell 进程，因此按调用指定 cwd 是安全的。
- **提示词注入。** 工作区激活期间，系统提示词会追加一个工作区块（根目录映射并标注主根、语法规则、bash 用法、约束策略）。会话中首次触达某个根时，该根的 AGENTS.md / CLAUDE.md 会追加到工具结果中（每根每会话一次）；没有自己约束文件的根会回退到主根的约束文件。
- **编辑器自动补全。** 在输入框敲 `@` 会列出根名；输入 `@根名/` 后补全该根内的文件和目录路径。其他输入一律委托给 pi 的内置补全。（补全只服务于你手动输入的路径 —— 模型生成工具调用路径时不经过它。）
- **底部状态栏。** 状态栏常驻显示当前工作区：`[ws] my-workspace (3 roots) primary: backend`。当某个根目录在磁盘上缺失时状态会降级显示：`[ws] my-workspace (2/3 roots) primary: backend ! frontend missing`。没有激活工作区时该条目自动清除。
- **会话状态持久化。** 激活的工作区会写入会话日志文件，因此 `/resume` 恢复会话时会自动还原。
- **对无头模式友好。** 所有 `/workspace` 命令在 RPC 模式下可用，交互式通知会以 JSON 事件形式输出 —— 可用于脚本化和自动化冒烟测试。

## 安装

本扩展是一个由 pi 直接加载的 TypeScript 目录（无需构建）。把整个目录 —— `index.ts` 加上 `src/` —— 复制到以下两个自动发现位置中的**恰好一个**：

### 全局安装（个人、跨项目）

```
~/.pi/agent/extensions/pi-workspaces/index.ts
```

无论会话从哪个目录启动都会加载。适合个人机器和私人工作区。

### 项目级安装（绑定单个仓库）

```
<repo>/.pi/extensions/pi-workspaces/index.ts
```

仅当会话从该仓库内启动时才加载。适合团队共享：扩展随仓库一起分发。

**信任说明。** 项目本地 `.pi/extensions` 只有在项目被信任后才会加载。pi 先查已保存的 `trust.json` 决定，再由 `defaultProjectTrust` 设置决定是询问、信任还是拒绝。项目被信任之前，扩展根本不会被加载。

> **警告：永远不要同时安装在两个位置。**
> pi 会自动发现两个目录并加载**两个扩展实例**。七个工具覆盖会重复注册（`bash`、`read`、`write`……），导致工具分发和渲染错乱。每台机器/仓库组合只选一个位置；如需迁移，先删除另一份拷贝。

### 安装作用域决定可见范围

扩展会检测自身的加载方式，并据此限定所有配置访问的范围：

| 加载方式 | 定义来源 | 全局默认配置 | `/workspace create` 写入 |
|---|---|---|---|
| 全局安装（`~/.pi/agent/extensions/`） | 全局 + 项目（按名合并） | 读取 | 全局来源 |
| 项目安装（`<repo>/.pi/extensions/`） | 仅项目来源 | 从不读取 | 项目来源 |
| `pi -e <路径>`（开发模式） | 仅项目来源 | 从不读取 | 项目来源 |

项目级作用域的加载不会读写 `~/.pi/agent/` 下的任何内容 —— 不读工作区定义，也不读默认配置。你的个人全局工作区对仓库共享的扩展安装完全不可见；开发模式（`pi -e ...`）行为相同。如需针对全局定义做开发调试，请真正地全局安装扩展。

## 快速开始

```text
/workspace create my-project     # 当前目录成为主根
/workspace add-root frontend C:/repos/frontend
/workspace add-root backend C:/repos/backend
```

或者手写定义文件（格式见下文）放到 `~/.pi/agent/workspaces/`（全局、个人）或 `<repo>/.pi/workspaces/`（项目级、可随 git 共享）。然后在任意根目录里启动 pi —— 或使用 `/workspace load my-project`。

## 工作区定义

定义为 JSON 文件，一个文件一个工作区：

- 全局来源：`~/.pi/agent/workspaces/<名字>.json`（仅全局安装可见）
- 项目来源：`<repo>/.pi/workspaces/<名字>.json`（所有安装作用域可见）

### 格式

```json
{
  "name": "my-workspace",
  "version": 1,
  "roots": [
    { "name": "backend",  "path": "C:/repos/backend" },
    { "name": "frontend", "path": "C:/repos/frontend" }
  ],
  "primary": "backend",
  "options": {
    "autoLoadInPrimary": true,
    "promptInOtherDirs": true
  }
}
```

- `name`：工作区名称。必须匹配 `^[A-Za-z0-9_-]+$`（字母、数字、`-`、`_`；不允许路径分隔符）。
- `version`：格式版本，当前为 `1`。版本未知的文件会被跳过并给出警告。
- `roots`：非空根对象数组。每个根有 `name`（同样规则，工作区内唯一）和绝对路径 `path`。根名非法或重复会导致整个定义被拒绝。Windows 下请用正斜杠写路径（`C:/repos/backend`）—— JSON 不接受 `\U` 这类转义，反斜杠路径是非法的。
- `primary`：必须指向已声明的某个根。主根的 AGENTS.md / CLAUDE.md 会作为其他没有约束文件的根的回退约束。
- `options`：可选的按工作区覆盖项。只识别 `autoLoadInPrimary` 和 `promptInOtherDirs`，且必须是布尔值。

校验会以带说明的错误拒绝格式错误的文件；损坏或不兼容的文件会被跳过并给出警告，其余文件正常加载。所有对定义文件的写回都是原子的（临时文件 + 重命名）。

### 选项及其解析链

全局默认选项存放在 `~/.pi/agent/pi-workspaces.json`：

```json
{
  "defaults": {
    "autoLoadInPrimary": true,
    "promptInOtherDirs": true
  }
}
```

每个选项独立解析：先看工作区定义，再看全局默认文件，最后看内置默认值：

```text
workspace.options.<键>  ??  全局 defaults.<键>  ??  内置默认值
```

内置默认值：`autoLoadInPrimary: true`、`promptInOtherDirs: true`。

- `autoLoadInPrimary`：会话在某工作区主根内启动时，直接加载该工作区，不再询问。
- `promptInOtherDirs`：会话在该工作区的*非主根*内启动时，在加载询问中列出该工作区。在所有根之外启动的会话绝不弹窗，无一例外。

## 路径语法与 bash cwd

工作区激活后，工具路径接受三种形式：

1. `@根名/相对路径` —— 相对该根的绝对路径解析。结果必须留在根内：`@backend/../../etc` 会被拒绝，错误信息说明根内约束规则。未知根名会报错并列出可用根。
2. **裸相对路径** —— 相对会话启动目录（`ctx.cwd`）解析，与原生 pi 完全一致。此规则永不改变。
3. **绝对路径** —— 到处可用。落在某根内时按最长前缀归属到该根；落在所有根之外时按原生 pi 行为原样放行（允许写入所有根之外的路径）。

`bash` 工具的 `cwd` 参数接受同样三种形式；省略时命令在会话启动目录执行：

```text
bash(command: "npm test", cwd: "@frontend")
bash(command: "git status", cwd: "C:/repos/backend")
bash(command: "pwd")                 # 会话启动目录
```

解析失败会以工具错误的形式抛出，模型可以看到并自行纠正。

## 工作区如何激活

`session_start` 时扩展扫描其安装作用域可见的定义来源，然后：

1. **自动加载**：如果会话目录等于某工作区的主根，且其 `autoLoadInPrimary` 解析为真，立即加载该工作区。
2. **日志恢复**：如果会话是 `/resume` 恢复而来，重新激活上次记录的工作区。
3. **询问**：否则，如果会话目录位于某工作区的*非主根*内，且该工作区的 `promptInOtherDirs` 解析为真，弹出选择列表，只列出包含该目录的工作区，并带"不加载"逃生项。在所有工作区根之外启动的会话**绝不弹窗** —— 从无关目录加载只能显式执行 `/workspace load`。

同一时间只能激活一个工作区；加载另一个会替换当前的（并有通知提示）。

## 命令参考

所有命令都是 `/workspace` 的子命令；输出通过 pi 通知展示。

| 命令 | 行为 |
|------|------|
| `/workspace`（或 `status`） | 显示当前工作区：名称、来源、主根，以及每个根（目录缺失时带 `(MISSING)` 标记）。 |
| `/workspace list` | 列出两个来源的全部定义，各自标注 `origin`（`global` 或 `project`）和主根。 |
| `/workspace load <名字>` | 按名称激活工作区。 |
| `/workspace unload` | 卸载当前工作区；状态栏随之清除。 |
| `/workspace create <名字>` | 以当前目录为唯一主根创建定义并激活。写入与安装作用域匹配的来源（全局安装写全局来源；其余写项目来源）。 |
| `/workspace add [名字] <路径>` | 给当前工作区添加根（别名：`add-root`）。名字可省略（默认取目录 basename）；相对路径锚定在会话目录。定义会持久化写回其来源。 |
| `/workspace remove <名字>` | 从当前工作区移除根并持久化（别名：`remove-root`）。主根不可移除。 |

交互式参数选择器（例如无参数 `load` 时的模糊选择器）属于 MVP 之后的功能 —— 目前缺参数时会打印用法说明。

## 无头用法（print / RPC 模式）

所有命令都可以在无头模式下使用，本扩展的冒烟测试就是这么做的。有两点须知：

- **观察命令输出请用 RPC 模式。** print 模式（`pi -p`）下 `ctx.ui.notify` 是空操作，命令输出不可见。RPC 模式（`pi --mode rpc`）下，每条通知和状态栏更新都会作为 JSON 事件发出：`printf '%s\n' '{"type":"prompt","message":"/workspace list"}' | pi --mode rpc`。
- **Windows / Git Bash 参数改写。** 把斜杠命令作为参数传入时（如 `pi -p "/workspace list"`），MSYS 路径转换会把 `/workspace` 改写成 `C:/Program Files/Git/workspace`。请先设置 `MSYS_NO_PATHCONV=1`（或 `MSYS2_ARG_CONV_EXCL="*"`）。
- **无头模式没有询问弹窗。** 选择列表激活需要 UI；无头会话请依赖自动加载（在主根目录启动 pi）或日志恢复（`-c` / `/resume`）。`pi -c` 会忽略没有任何消息的会话文件。
- **管道喂入的 RPC prompt 不会串行执行。** pi 不会等上一条管道输入的命令处理器执行完再开始下一条，因此同一批背靠背的修改类命令可能在定义文件上发生竞争。修改类命令请一次发一条（交互使用不受影响）。

## 定义如何合并

全局安装在 `session_start` 时扫描两个来源并**按名称合并**：同名时项目定义覆盖全局定义 —— 项目来源按名胜出。永远不会发生整体覆盖：项目文件无法遮蔽你无关的全局工作区，它们会并行加载。项目级作用域的安装（项目安装或 `-e` 开发加载）只能看到项目来源，因此不发生合并。

- 每个合并后的定义记录其 `origin`（`global` 或 `project`），`/workspace list` 和 `/workspace status` 会显示。
- 名称冲突触发每会话一次的警告："workspace 'X' from project overrides global"。

## 项目级安装的注意事项

项目级安装有两个后果，都是预期行为而非 bug：

- **发现机制**：pi 从会话自身目录发现项目扩展，因此仅当会话从该仓库内启动时才加载。从其他目录启动的会话 —— 包括从同一工作区另一个根启动 —— 没有自动加载、询问弹窗、工具覆盖和状态栏。希望扩展随处可用请用全局安装。
- **隔离性**：项目级安装（与 `-e` 开发加载一样）是项目级作用域：只能看到 `<repo>/.pi/workspaces/`，从不读写 `~/.pi/agent/` 下的全局配置。仓库共享的扩展无法窥探你的个人工作区。

## 运行时存储位置

| 内容 | 位置 |
|------|------|
| 全局定义 | `~/.pi/agent/workspaces/*.json`（仅全局安装可见） |
| 项目定义 | `<repo>/.pi/workspaces/*.json`（所有安装作用域可见） |
| 全局默认选项 | `~/.pi/agent/pi-workspaces.json`（仅全局安装读取） |
| 激活工作区日志 | pi 会话文件内（自定义条目 `pi-workspaces:active`） |

## 已知限制

- **显式 `cwd` 会丢失会话环境变量。** 带显式 `cwd` 的 `bash` 调用不会注入 `PI_*` 会话环境变量（把运行时 ctx 传过去会覆盖已解析的目录）。不带 `cwd` 的调用 —— 即默认分支 —— 会正常注入。
- **符号链接的定义文件会被跳过。** 来源扫描只接受普通 `.json` 文件，符号链接形式的工作区定义会被静默忽略（请用真实文件，或改为链接目录）。
- **符号链接目录按文件补全。** 在根内，自动补全按目录标志分类条目，因此符号链接的子目录补全后不会带尾部 `/`。
- **共享主根路径：先到先得。** 当两个工作区定义声明了相同的主根路径时，自动加载扫描按合并顺序激活第一个，没有歧义警告。

## MVP 之后的路线图

本版本未包含、后续计划或希望加入的：

- `/workspace set-primary` —— 重新指定当前工作区的主根。
- `/workspace config` —— 在会话内编辑全局默认选项（`~/.pi/agent/pi-workspaces.json`）。
- 交互式选择器 —— 创建向导和无参数 `load` 选择器。
- 定义文件的 `fs.watch` 热重载（目前定义只在 `session_start` 读取一次；请用 `/workspace load` 重新读取）。
- 跨根聚合搜索的便利功能（一次 grep 搜索所有根并合并结果）。
- 内部 `samePath` 去重重构（路径归一化目前在解析器和激活检查中各有一份）。

## 开发

```bash
# 从任意目录以开发模式加载扩展
pi -e /path/to/pi-workspaces/index.ts

# 运行测试
node --test "test/**/*.ts"
```

TypeScript 由 pi 通过 jiti 直接加载 —— 无构建步骤、无第三方运行时依赖（仅用 Node 内置模块 + pi 导出）。
