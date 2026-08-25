# dsh-crosstalk

**DSH 跨会话消息。** 机器上的任意会话都能列出并给其他会话发消息 —— 类 Claude Code 的水平消息机制，无需守护进程。

`dsh-crosstalk` 是一个 DeepSeek Harness bundle。每个运行该 bundle 的会话都会向本地注册表（`~/.dsh/crosstalk/`，文件 + 原子重命名，无守护进程 —— 只要两个会话能看到同一个 home 目录，它们就能互发消息）发布心跳。每个会话获得稳定名称（`<仓库或目录-slug>-<形容词>`，例如 `dsh-cowork-amber`）和一个持久 ref id；任何会话都可以列出在线会话，并向目标发送一条**清晰标记的 turn** —— `[message from session dsh-cowork-amber (/Users/me/projects/dsh-cowork)]`，发送者名称随消息携带，因此回复只需 `send_message` 回去。

## 工作原理

1. **身份**：启动时根据工作目录派生出 `<slug>-<形容词>` 名称，加上进程唯一的 ref（`ct-…`）。同一目录的两个会话会得到不同的形容词与名称；ref 用于消歧，也是收件箱路径。
2. **注册表**：每个在线会话一个心跳 JSON 文件，位于 `<home>/registry/<ref>.json`（`name`、`ref`、`pid`、`cwd`、`status`、`startedAt`、`heartbeatAt`、`uid`、`inbox`）。定时刷新；超过 2× 间隔没有心跳的条目视为死亡并被垃圾回收。
3. **工具 —— 扩展而非复制**：
   - `list_agents` 新增 `scope: peers`（本机其他在线会话：名称、状态、cwd、最后活动）与 `scope: all`（后代 + peers）。原有 children/descendants 作用域委托给捕获的原始定义。
   - `send_message` 的 `to` 除子代理 id 外，还接受 peer 名称或 ref，并支持可选 `summary`（5–10 字摘要，显示在目标 UI 中）。
   - 原始工具保持注册；本 bundle 按 agent 作用域**遮蔽**它们（可逆的 Cordis 效果），卸载后精确恢复原行为。
4. **投递**：消息是追加到目标收件箱（`<home>/inbox/<ref>/`）的一个 JSON 文件，原子写入（临时文件 + 重命名），崩溃中断不会产生半条消息。目标端的 watcher 轮询收件箱，并通过 `followup` 注入在线会话：**空闲目标会被唤醒处理一个 turn；忙碌目标在下一个 turn 边界收到**。投递是尽力而为 —— `list_agents` 状态不是投递承诺。
5. **注入**：turn 带有 `[message from session <name> (<cwd>)]` 标签和 `crosstalk` 来源（`form: relay`），因此 append-only 日志天然记录来源，DSH UI 会渲染为带标签的 relay 卡片 —— 绝不会渲染成用户文本。系统提示会告知模型：这些是来自同级 agent 的请求，而非用户的指令。

## 安装

从 GitHub 安装前，先在 profile 所在的 pnpm workspace 允许该包执行构建脚本：

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
packages:
  - .
allowBuilds:
  '@dsh-crosstalk/bundle': true
```

然后给每个需要参与的 profile 添加 bundle：

```sh
dsh plugin --profile web add github:Jesse-njx/dsh-crosstalk
dsh plugin --profile <other-profile> add github:Jesse-njx/dsh-crosstalk
```

本地检出时，链接仓库根目录：

```sh
git clone https://github.com/Jesse-njx/dsh-crosstalk
cd dsh-crosstalk
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
dsh plugin --profile <other-profile> add "$PWD"
```

GitHub 安装会通过包内的 `postinstall` 钩子从 `src/` 编译出 `lib/`。目录链接加载的是编译后的 `lib/`；源码变更后运行 `pnpm build` 并重启 DSH 即可，不需要重装。

## 配置

添加 bundle 会自动挂载插件（其 `cordis.patch.yml` 会插入 `crosstalk` 条目）。如需覆盖字段，在 profile 的 `cordis.patch.yml` 中按 id 定位该条目 —— **不要**再插入第二个 `crosstalk` 行（会报重复条目错误）：

```yaml
# 位于 <DSH_HOME>/profiles/<name>/cordis.patch.yml
- id: crosstalk
  config:
    homeDir: ~/.dsh/crosstalk   # 注册表根目录（默认 $DSH_HOME/crosstalk 或 ~/.dsh/crosstalk）
    cwd: /path/to/repo          # 对外公布的目录（默认进程 cwd）
    name: my-custom-name        # 显式名称覆盖（须匹配 [a-z0-9][a-z0-9-]*）
    accept: same-user           # v0.1 固定：仅同 OS 用户
    mode: open                  # open | allowlist
    allowlist: []               # allowlist 模式：精确会话名或 cwd glob
    notifyUser: true            # 在 UI 中以 relay 卡片显示入站消息
    heartbeatIntervalMs: 10000
    inboxPollMs: 1000
    staleAfterMs: 20000
    maxInboxAttempts: 30
```

（未设置的字段回退到默认值；loader 会整体替换 `config`，所以只列出要改的字段即可。）

### 信任模型

来自其他会话的消息**不是**用户的指令。注入的 turn 被标记为 peer 请求，系统提示指示 agent 仅在用户既有指令范围内处理，并把有副作用的事项上报给用户。v0.1 仅接受**同 OS 用户**（发送与接收两侧都会比对 uid），并可用名称/cwd **allowlist** 进一步过滤入站。v0.1 无网络传输：同一台机器、同一个用户。

## 开发

```sh
pnpm install
pnpm typecheck && pnpm build
pnpm test   # 49 个测试：身份、注册表、消息编解码、收件箱 watcher、
            # 工具遮蔽（真实 Cordis 作用域）、双会话往返
```

## 路线图

- **v0.3**：远程/云端会话（网络传输 —— 不是加一个配置项就能实现的）。
- 协调者「驱动 worker 会话」的能力（例如结构化任务回复）。
