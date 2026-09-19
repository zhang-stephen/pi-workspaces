# pi-workspaces

[English](README.md) | **中文**

为 [pi coding agent](https://pi.dev) 提供的多根工作区（multi-root workspace）扩展。一个工作区把多个目录（称为"根"）合并为一个命名单元，让单个 pi 会话可以跨根读写文件、搜索代码、执行 shell 命令 —— 相当于 VS Code 的多根文件夹，但面向你的 agent。

没有激活工作区时，本扩展完全不做任何事：所有工具行为与原生的 pi 一模一样。

## 功能

- **多根文件工具** —— `read`、`write`、`edit`、`grep`、`find`、`ls` 接受 `@根名/` 路径前缀，把调用路由进任意工作区根；结果结构与渲染与内置实现完全一致。
- **跨根 shell** —— `bash` 新增可选 `cwd` 参数，接受 `@根名/子目录`，命令在该根内启动（安全：pi 每次调用都新建 shell 进程）。
- **提示词注入** —— 工作区激活期间，系统提示词追加工作区块（根映射、语法规则）；每个根的 AGENTS.md / CLAUDE.md 在首次触达时注入一次（每根每会话一次），没有自己约束文件的根回退到会话根的文件。
- **编辑器补全** —— 敲 `@` 列出根切换项和当前根文件；`/workspace` 支持子命令、工作区名、根名和路径补全。
- **底部状态栏** —— `[ws] <workspace> (3 roots)`；某根在磁盘上缺失时降级为 `[ws] <workspace> (2/3 roots) ! <root>missing`。
- **会话状态持久化** —— 激活的工作区写入会话日志，`/resume` 自动还原。
- **对无头模式友好** —— 所有 `/workspace` 命令在 RPC 模式可用，通知以 JSON 事件输出，便于脚本化。

## 安装

本扩展是由 pi 直接加载的纯 TypeScript（无需构建），安装方式与任何 pi 包相同。

### 全局安装（个人、跨项目）

```bash
pi install npm:pi-workspaces
# 或固定到某个 git ref
pi install git:github.com/zhang-stephen/pi-workspaces@v0.1.0
```

无论会话从哪个目录启动都会加载。适合个人机器和私人工作区。

### 项目级安装（绑定单个仓库）

```bash
pi install -l npm:pi-workspaces
```

依赖写入仓库的 `.pi/settings.json`，随仓库一起走：项目被信任后 pi 会在启动时自动安装，且扩展只在从该仓库内启动的会话中加载。

### 免安装试用 / 开发

把仓库 clone 到任意位置，用 `pi -e` 指向它 —— 扩展只在当前这次运行中加载：

```bash
git clone https://github.com/zhang-stephen/pi-workspaces.git
pi -e ./pi-workspaces
```

**信任说明。** 项目级安装（`.pi/settings.json`）只有在项目被信任后才会加载。pi 先查已保存的 `trust.json` 决定，再由 `defaultProjectTrust` 设置决定是询问、信任还是拒绝。项目被信任之前，扩展根本不会被加载。

> [!WARNING] 不要为同一批会话重复安装!
> 如果 pi 同时通过用户设置和项目设置（或再加 `pi -e`）发现本扩展，会加载**两个实例**，七个工具覆盖会重复注册（`bash`、`read`、`write`……），导致工具分发和渲染错乱。每台机器/仓库组合只保留一种安装方式；如需迁移，先删除另一份。

### 安装作用域决定可见范围

扩展会检测自身的加载方式，并据此限定所有配置访问的范围：

| 加载方式 | 定义来源 | 配置文件 | `/workspace create` 写入 |
|---|---|---|---|
| 全局安装（`pi install`，用户设置） | 全局 + 项目（按名合并） | 读取 | 全局来源 |
| 项目安装（`pi install -l`，项目设置） | 仅项目来源 | 从不读取 | 项目来源 |
| `pi -e <路径>`（开发模式） | 仅项目来源 | 从不读取 | 项目来源 |

项目级作用域的加载不会读写 `~/.pi/agent/` 下的任何内容 —— 不读工作区定义，也不读配置文件。你的个人全局工作区对仓库共享的扩展安装完全不可见；开发模式（`pi -e ...`）行为相同。如需针对全局定义做开发调试，请真正地全局安装扩展。

## 快速开始

```text
/workspace create my-project     # 当前目录成为第一个根
/workspace add-root frontend C:/repos/frontend
/workspace add-root backend C:/repos/backend
```

或者手写定义文件（格式见下文）放到 `~/.pi/agent/workspaces/`（全局、个人）或项目内的 `.pi/workspaces/`（可随 git 共享）。然后在任意根目录里启动 pi —— 或使用 `/workspace load my-project`。

## 工作区定义

定义为 JSON 文件，一个文件一个工作区。工作区是**无序的等值根集合** —— 没有主根概念：

- 全局来源：`~/.pi/agent/workspaces/<名字>.json`（仅全局安装可见）
- 项目来源：被发现的项目目录下的 `.pi/workspaces/<名字>.json`（所有安装作用域可见）。项目目录通过**标记上溯**发现：从会话目录向上最多走 `projectRootAscend` 层（内置默认 3），停在第一个包含 `.pi`、`.git` 或 `.agents` 标记的目录。最近的标记目录胜出，即使它没有 `.pi/workspaces` 子目录（此时项目来源为空）；发现永远不会上溯越过用户主目录，层数内没有标记时使用会话目录本身。

### 格式

```json
{
  "name": "my-workspace",
  "version": 1,
  "roots": [
    { "name": "backend",  "path": "C:/repos/backend" },
    { "name": "frontend", "path": "C:/repos/frontend" }
  ]
}
```

- `name`：工作区名称。必须匹配 `^[A-Za-z0-9_-]+$`（字母、数字、`-`、`_`；不允许路径分隔符）。
- `version`：格式版本，当前为 `1`。版本未知的文件在启动时静默跳过（可通过 `/workspace list` 查看）。
- `roots`：非空根对象数组。每个根有 `name`（同样规则，工作区内唯一）和绝对路径 `path`。根名非法或重复会导致整个定义被拒绝。Windows 下请用正斜杠写路径（`C:/repos/backend`）—— JSON 不接受 `\U` 这类转义，反斜杠路径是非法的。
- 定义文件不携带选项 —— 格式只有 `name`/`version`/`roots`，任何其它顶层键（包括已移除的 `options`）都会让文件被拒绝，并指明该键名。

校验会以带说明的错误拒绝格式错误的文件；启动时损坏或不兼容的文件被**静默**跳过 —— 通过 `/workspace list` 重新扫描即可看到（坏文件不应污染无关会话）。所有对定义文件的写回都是原子的（临时文件 + 重命名）。

### 配置及其解析链

插件配置是一个扁平结构体。全局文件为 `~/.pi/agent/pi-workspaces.json`；项目可通过 `<项目根>/.pi/pi-workspaces.json` 覆盖其中任意键：

```json
{
  "activation": "auto",
  "warnOnUnrelatedLoad": true,
  "projectRootAscend": 3
}
```

每个键独立解析：先看项目配置，再看全局文件，最后看内置默认值；缺失或类型错误的值静默回退：

```text
项目配置.<键>  ??  全局配置.<键>  ??  内置默认值
```

内置默认值：`activation: "auto"`、`warnOnUnrelatedLoad: true`、`projectRootAscend: 3`。

- `activation`：`"auto"` 表示会话在该工作区任意根内启动时静默加载；`"prompt"` 表示先询问。当多个工作区同时包含会话目录时一定弹窗（消除歧义），即使配置是 `"auto"`。激活方式属于项目/目录上下文 —— 不能按单个工作区设置。
- `warnOnUnrelatedLoad`：`/workspace load` 激活一个根不包含会话目录的工作区时发出警告（裸相对路径仍锚定在会话目录）。无论是否警告，加载都会执行。
- `projectRootAscend`（仅全局）：项目来源发现的上溯层数上限。它只能放在全局配置里 —— 它控制定义如何被发现，项目级覆盖会造成循环（项目级写它无效）；项目级作用域的安装总是使用内置值。

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

1. **自动加载**：如果恰好有一个工作区包含会话目录（任意根内）且会话配置的 `activation` 解析为 `"auto"`，立即加载该工作区。若该工作区在两个来源中同名存在，会追加一条提示：项目定义优先生效。
2. **日志恢复**：如果会话是 `/resume` 恢复而来，重新激活上次记录的工作区。`session_start` 重复触发（如扩展重载）不会重复写日志。
3. **询问**：否则，如果至少一个工作区包含会话目录，弹出选择列表，只列出这些工作区，并带"不加载"逃生项 —— 涵盖 `activation: "prompt"` 的项目和多匹配消歧。在所有工作区根之外启动的会话**绝不弹窗** —— 从无关目录加载只能显式执行 `/workspace load`（默认会警告，见 `warnOnUnrelatedLoad`）。

坏的定义文件绝不会产生启动警告：诊断信息只在你执行 `/workspace list`（会重新扫描并报告）时出现。唯一的目录相关例外：若会话目录只命中一个**被覆盖**的定义（名称冲突的落选方），pi 会警告项目来源已覆盖、不予加载。

同一时间只能激活一个工作区；加载另一个会替换当前的（并有通知提示）。

## 命令参考

所有命令都是 `/workspace` 的子命令；输出通过 pi 通知展示。

| 命令 | 行为 |
|------|------|
| `/workspace`（或 `status`） | 显示当前工作区：名称、来源，以及每个根（目录缺失时带 `(MISSING)` 标记）。 |
| `/workspace list` | 列出两个来源的全部定义，各自标注 `origin`（`global` 或 `project`）。 |
| `/workspace load <名字>` | 按名称激活工作区。根不包含会话目录时发出警告（`warnOnUnrelatedLoad`），但加载仍会执行。 |
| `/workspace unload` | 卸载当前工作区；状态栏随之清除。 |
| `/workspace create <名字>` | 以当前目录为唯一根创建定义并激活。写入与安装作用域匹配的来源（全局安装写全局来源；其余写项目来源）。 |
| `/workspace add [名字] <路径>` | 给当前工作区添加根（别名：`add-root`）。名字可省略（默认取目录 basename）；相对路径锚定在会话目录。定义会持久化写回其来源。 |
| `/workspace remove <名字>` | 从当前工作区移除根并持久化（别名：`remove-root`）。最后一个根不可移除。 |
| `/workspace config` | 显示生效配置及其来源 —— 每个键的值来自项目文件、全局文件还是内置默认值。 |
| `/workspace config set <键> <值> [global\|project]` | 校验并设置一个配置键（`activation`、`warnOnUnrelatedLoad`、`projectRootAscend`）。级别默认 `global`；传 `project` 则写入项目级覆盖。`projectRootAscend` 只接受 `global` 级。写入保留文件中的其他键，且为原子操作。 |
| `/workspace config unset <键> [global\|project]` | 移除一个键的覆盖，使解析链回退到下一级；并报告新的生效值。 |

交互式参数选择器（例如无参数 `load` 时的模糊选择器）属于 MVP 之后的功能 —— 目前缺参数时会打印用法说明。

## 无头用法（print / RPC 模式）

所有命令都可以在无头模式下使用，本扩展的冒烟测试就是这么做的。有两点须知：

- **观察命令输出请用 RPC 模式。** print 模式（`pi -p`）下 `ctx.ui.notify` 是空操作，命令输出不可见。RPC 模式（`pi --mode rpc`）下，每条通知和状态栏更新都会作为 JSON 事件发出：`printf '%s\n' '{"type":"prompt","message":"/workspace list"}' | pi --mode rpc`。
- **Windows / Git Bash 参数改写。** 把斜杠命令作为参数传入时（如 `pi -p "/workspace list"`），MSYS 路径转换会把 `/workspace` 改写成 `C:/Program Files/Git/workspace`。请先设置 `MSYS_NO_PATHCONV=1`（或 `MSYS2_ARG_CONV_EXCL="*"`）。
- **无头模式没有询问弹窗。** 选择列表激活需要 UI；无头会话请依赖自动加载（在 `activation: "auto"` 工作区的任意根内启动 pi）或日志恢复（`-c` / `/resume`）。`pi -c` 会忽略没有任何消息的会话文件。
- **管道喂入的 RPC prompt 不会串行执行。** pi 不会等上一条管道输入的命令处理器执行完再开始下一条，因此同一批背靠背的修改类命令可能在定义文件上发生竞争。修改类命令请一次发一条（交互使用不受影响）。

## 定义如何合并

全局安装在 `session_start` 时扫描两个来源并**按名称合并**：同名时项目定义覆盖全局定义 —— 项目来源按名胜出。永远不会发生整体覆盖：项目文件无法遮蔽你无关的全局工作区，它们会并行加载。项目级作用域的安装（项目安装或 `-e` 开发加载）只能看到项目来源，因此不发生合并。

- 每个合并后的定义记录其 `origin`（`global` 或 `project`），`/workspace list` 和 `/workspace status` 会显示。
- 名称冲突提示按相关性触发：只有当一个同名冲突的工作区真正被激活时（自动加载、日志恢复、选择框、`/workspace load`），才会追加一条"项目定义优先生效"的提示；目录只命中被覆盖的全局副本时才警告不予加载；其余情况一律静默。

## 项目级安装的注意事项

项目级安装有两个后果，都是预期行为而非 bug：

- **发现机制**：pi 从会话自身目录发现项目扩展，因此仅当会话从该仓库内启动时才加载。从其他目录启动的会话 —— 包括从同一工作区另一个根启动 —— 没有自动加载、询问弹窗、工具覆盖和状态栏。希望扩展随处可用请用全局安装。
- **隔离性**：项目级安装（与 `-e` 开发加载一样）是项目级作用域：只能看到被发现的项目来源（最近标记目录下的 `.pi/workspaces/`），从不读写 `~/.pi/agent/` 下的全局配置。仓库共享的扩展无法窥探你的个人工作区。

## 运行时存储位置

| 内容 | 位置 |
|------|------|
| 全局定义 | `~/.pi/agent/workspaces/*.json`（仅全局安装可见） |
| 项目定义 | 被发现的项目目录下 `.pi/workspaces/*.json`（所有安装作用域可见） |
| 全局默认选项 | `~/.pi/agent/pi-workspaces.json`（仅全局安装读取） |
| 激活工作区日志 | pi 会话文件内（自定义条目 `pi-workspaces:active`） |

## 已知限制

- **pi-fff 冲突。** `@ff-labs/pi-fff`（或任何带其 mention provider 的 fork）在默认 `tools-and-ui` 模式下，它自己的 @ 模糊搜索会接管所有 `@` 查询，pi-workspaces 的根补全不会出现。将 pi-fff 切到 `tools-only` 模式（`/fff-mode tools-only`）即可恢复。

- **显式 `cwd` 会丢失会话环境变量。** 带显式 `cwd` 的 `bash` 调用不会注入 `PI_*` 会话环境变量（把运行时 ctx 传过去会覆盖已解析的目录）。不带 `cwd` 的调用 —— 即默认分支 —— 会正常注入。
- **符号链接的定义文件会被跳过。** 来源扫描只接受普通 `.json` 文件，符号链接形式的工作区定义会被静默忽略（请用真实文件，或改为链接目录）。
- **符号链接目录按文件补全。** 在根内，自动补全按目录标志分类条目，因此符号链接的子目录补全后不会带尾部 `/`。

## 开发

```bash
# 从任意目录以开发模式加载扩展
pi -e /path/to/pi-workspaces/index.ts

# 运行测试
node --test "test/**/*.ts"
```

TypeScript 由 pi 通过 jiti 直接加载 —— 无构建步骤、无第三方运行时依赖（仅用 Node 内置模块 + pi 导出）。

## 许可证

MIT - 见 [LICENSE](./LICENSE)。
