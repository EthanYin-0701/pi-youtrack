---
id: pi-youtrack-architecture
type: architecture-design
title: pi-youtrack 架构：只管配置、默认值与知识，MCP 客户端交给 pi
status: active
depends-on: [pi-youtrack-goal]
---

# pi-youtrack 架构

目标与范围见 [goal-and-requirements.md](./goal-and-requirements.md)。本文只记录拓扑、边界与
不显然的取舍。

## 拓扑

```
pi 启动
└─ jiti 加载 extensions/youtrack/index.ts        （无构建步骤，TS 直接跑）
   ├─ 工厂体（同步）：读 youtrack.json → pi.registerMcpServer("youtrack", cfg)
   ├─ pi.registerCommand("youtrack", …)
   └─ pi.on("session_start") → 复位只读 + 必要时重注册

pi 内置 MCP 扩展（不是我们的代码）
   └─ 在 session_start 时读 pi.getMcpServers() → 连接 → 把工具注册为 mcp__youtrack__<tool>
```

**边界**：我们不实现传输、不解析 MCP、不持有连接。扩展只产出「一个 McpServerConfig + 一堆默认值 +
一条配置持久化路径」，其余全部由 pi 的内置 MCP 扩展接管——包括连接、重连、`/mcp` 面板、codemode、
tool_search、权限钩子，以及工具名 `mcp__youtrack__*` 的生成。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 注册时机 | 在扩展工厂体内**同步**注册 | 文档保证「加载期注册的 server 在 session 启动时连接」，与 `mcp.json` 的 server 同一批；放到 `session_start` 会晚一拍，首个 prompt 拿不到 `direct` 工具 |
| 配置放哪 | 自有文件 `<agentDir>/youtrack.json` | 不写 `mcp.json`：那是 pi 与人手共写的文件，回写会互相覆盖，且无法表达 profile/`active`。`agentDir` 由 `getAgentDir()` 提供，不硬编码 `~/.pi` |
| 默认只读的实现层 | 注册 URL 加 `?readOnlyTools=true` | 在**服务端**过滤，写工具根本不进工具表——不是"调用被拒"。比客户端权限门更硬，也不需要维护工具清单 |
| 工具暴露 | 服务器 `deferred` + 三个 `toolExposure: direct` | `deferred` 让 tool_search 自动激活、其余工具不占 prompt；`search_issues`/`get_issue`/`get_current_user` 是每次对话的入口，直连 |
| 切换/开写 | 用新 config **重注册同名** server | pi 文档与实现都保证：同名且配置不同 ⇒ 丢弃旧条目、`hideTools`、关连接、连新的。不需要 `unregister` 再 `register` 的竞态 |
| 写操作确认 | `tool_call` 钩子拦三个 `create_*` | 模型可以不遵守 skill，钩子在 pi 的工具管线里绕不过去；非交互模式（无 UI）放行，否则脚本会挂 |
| skill 触发 | frontmatter `disable-model-invocation: true` | 只在 `/skill:youtrack` 显式调用时加载，普通对话不自动命中（用户的要求） |
| 令牌校验 | 自己发一次 MCP `initialize` | 复用不了 pi 的连接（连接是异步且不回报失败的）；`initialize` 同时验证「地址是 MCP 端点」和「令牌有效」两件事 |
| 构建 | 无 | jiti 直接转译 TS 并解析相对 import，扩展目录内多文件可用。零依赖 ⇒ CI 只有 `npm publish` 一步 |

## 模块划分

`extensions/youtrack/` 内六个文件，依赖方向单向，无环：

```
index.ts ──┬─→ config.ts     读/写 youtrack.json、profile CRUD、原子写与 0600
           ├─→ register.ts   拼 McpServerConfig、register/unregister、防重复重连
           ├─→ probe.ts      发 initialize 做校验，返回结构化结果
           ├─→ confirm.ts    写入前确认的纯函数：哪些工具要拦、确认框里显示什么
           └─→ status.ts     拼 /youtrack 的输出文本、令牌脱敏、等待工具就绪
```

`register.ts` 依赖 `probe.ts`（拼 URL），`confirm.ts` 不依赖任何模块——它是纯函数，桩测直接打它。
`index.ts` 是唯一注册命令与事件的地方。

## 配置契约

`<agentDir>/youtrack.json`，权限 0600（目录已由 pi 创建）：

```json
{
  "version": 1,
  "active": "acme",
  "profiles": {
    "acme": {
      "baseUrl": "https://acme.youtrack.cloud",
      "token": "perm:…",
      "addedAt": "2026-05-01T09:00:00.000Z"
    }
  }
}
```

写入用「临时文件（0600）→ `rename`」，避免半写坏配置；Windows 上 0600 无效，只做尽力而为。
未知字段保留，`version` 不匹配时只读不写并提示升级。

## 注册契约

```ts
pi.registerMcpServer("youtrack", {
  url: `${baseUrl}/mcp${writeEnabled ? "" : "?readOnlyTools=true"}`,
  headers: { Authorization: `Bearer ${token}` },
  description: `YouTrack (${profile}) — issues, articles, projects, work items`,
  exposure: "deferred",
  toolExposure: {
    search_issues: "direct",
    get_issue: "direct",
    get_current_user: "direct",
  },
  timeout: 60,
});
```

- 服务名固定 `youtrack`，**不因冲突而改后缀**。用户在 `mcp.json` 里写了同名条目时 pi 以文件优先
  覆盖我们——这是 pi 的行为，`/mcp` 会显示 override；`/youtrack status` 必须把它标出来而不是假装
  连上了。代价已接受：两条来源在工具名上无法区分（同为 `mcp__youtrack__*`），`status` 只能提示
  「存在同名 server 配置，以 mcp.json 为准」。
- 环境的临时覆盖：`YOUTRACK_URL` + `YOUTRACK_TOKEN` 同时存在时，注册用它们（profile 记为 `env`），
  不读也不写文件。只给其中一个视为未配置，忽略。
- **防重复重连**：模块内记住上次注册的 config 指纹（`url|token|profile`）。`session_start` 复位只读后
  只在指纹变化时才重注册——pi 判断"配置是否变了"是按对象引用比较的，无条件重注册会在每个会话
  白掉一次连接。
- headers 里内联字面量令牌（`${…}` 会被 pi 做环境变量展开，令牌含 `$` 时会被误解析）；setup 阶段
  校验令牌形如 `perm:` 前缀，避免这个坑。

## 校验契约（setup / 探活）

`POST <base>/mcp`，头 `Authorization: Bearer <token>`、`Accept: application/json, text/event-stream`，
体为 JSON-RPC `initialize`（`protocolVersion: "2025-06-18"`，`clientInfo.name: "pi-youtrack"`），
超时 15s。响应体若是 `text/event-stream`，取首个 `data:` 行解析。

| 结果 | 判定 | 给用户的话 |
| --- | --- | --- |
| 200 且有 `result` | 通过 | — |
| 401 / 403 | 令牌无效或无权限 | 令牌无效，或该账号无权访问此站点 |
| 404 | 地址不对，或 YouTrack < 2025.3 没有 `/mcp` | 检查基址；老版本 YouTrack 不提供 MCP |
| 其他 4xx | 配置错 | 显示状态码与响应首行 |
| 5xx / 网络异常 | 站点不可达 | 显示底层错误，不回显令牌 |

**校验失败不落盘**：只在通过后写配置文件，旧配置保持不变。

## 命令面

单命令 `/youtrack`，`getArgumentCompletions` 补全子命令。

| 用法 | 行为 |
| --- | --- |
| `/youtrack` / `status` | active profile 名、基址、令牌尾 4 位、写权限状态、已连接工具数（数 `pi.getAllTools()` 里 `mcp__youtrack__*` 的条数）、是否被 `mcp.json` 覆盖 |
| `setup [name]` | 依次 `ui.input` 问基址 → 站点名 → 令牌 → 探活 → 落盘 → 重注册 → 等工具真的出现在 pi 的工具表里（最多 8 秒），把**真实注册数**写进回报；超时则报「仍在连接」。已存在同名则就地更新 |
| `list` | 所有 profile，标出 active，令牌一律只显示尾 4 位 |
| `use <name>` | 改 `active` 并重注册；不存在则报错列出可选值 |
| `write on\|off` | 仅改本会话的 `writeEnabled` 并重注册。`on` 时提示「仅本会话有效，工具正在重连」 |
| `remove <name>` | 确认后删除；删的是 active 则清空 `active` 并 `unregisterMcpServer("youtrack")` |

未配置时任何子命令都只输出一句「尚未配置，运行 `/youtrack setup`」，不主动弹窗、不在启动时打扰。

**已知限制**：`ctx.ui.input` 不掩码，setup 时令牌在终端可见（不回显进 transcript、不发给模型）。
写入配置契约里的 `YOUTRACK_TOKEN` 覆盖是给介意的人的后路。

## Skill 契约

`skills/youtrack/SKILL.md` 以一段**固定流程（Procedure）**开头，后面才是知识库。流程是六步：
检查写权限 → `find_projects` 定项目 → `get_issue_fields_schema` 读 schema → **贴字段草稿并等用户回复**
→ 调用工具并原样引用返回的 id/URL → 被确认框拦下时回到第 4 步而不是原样重试。

流程之外必须覆盖的知识：

1. 工具前缀 `mcp__youtrack__`，不认识的工具先用 `tool_search` 搜，别猜工具名。
2. 查询语法：`project: WEB`、`#unresolved`、`#me`、`sort by: updated desc`、日期区间、单页 20 条要 `offset`。
3. `create_issue` 的 `customFields` 是「字段名 → 值」的对象，值必须来自 schema；草稿 issue 只有
   `project` + `summary`；`add_attachment` 用返回的 `createdIssue.id` 作 target。
4. 一条硬规则：**所有 YouTrack 数据必须来自 `mcp__youtrack__*` 的工具结果**，不许用 bash/curl 直接打
   `/mcp` 端点——这条来自真实事故：agent 曾经绕过 MCP 去直连端点。

## 安全不变量

- 令牌只出现在 `youtrack.json`、进程内存、以及发往该站点的 `Authorization` 头里。不进 prompt、
  不进 `sendMessage`、不进错误文案；所有展示走尾 4 位脱敏。
- 除用户配置的那个 base URL 外没有网络出口，无遥测。
- 加载失败（配置损坏、注册抛错）只让 YouTrack 工具缺席，不影响 pi 启动与其它 MCP server。

## 验证状态

- **已实测（yt-air-demo.youtrack.cloud / YouTrack MCP 2026.2，2026-11）**：探活返回 23 个工具；真实 pi 会话里
  拿到恰好三个 `direct` 工具（`mcp__youtrack__search_issues` / `get_issue` / `get_current_user`），
  其余经 `tool_search`；只读模式下列表从 23 降到 13（`readOnlyTools=true` 在服务端滤掉 10 个写工具）；`/youtrack write on` 后写工具出现，并在 `PYP` 项目实建 issue（PYP-1）。
- **已实测（本地）**：jiti 解析扩展目录内的相对 `import`，多文件可用；`getAgentDir()` 返回真实的 agent 目录；
  加载期 `registerMcpServer` 被 pi 接受；配置读写、0600、非法 profile 整文件拒绝、URL 拼装、`/youtrack`
  全命令面、重注册与指纹去抖、env 覆盖均有桩测覆盖（`tests/behavior.test.mjs`，用 pi 自己那份 jiti，
  与加载器同一实现）。
- **已知时序**：注册后的连接是异步的。`setup` 已经等到工具出现才回报（上限 8 秒，轮询 200ms，因为 pi 没有
  「server 工具就绪」的扩展事件）；`write on` / `use` 不等，所以紧接着跑 `/youtrack status` 仍可能读到
  0 个工具——这不是故障。探活拿到的工具数不参与展示，避免两个数字互相矛盾。
  `direct` 工具只在「请求构建工具表时 server 已连接」的情况下被声明：在已运行的会话里装包，那三个会一直缺席
  且不进 `tool_search` 池（它们按 direct 分类），`deferred` 的其余工具仍可检索到。
- **已知限制**：`?readOnlyTools=true` 会一并过滤没有 read-only 标注的自定义 MCP 工具（README 已写）。

## 包与发布

```
package.json          name pi-youtrack, keywords ["pi-package"], pi.extensions / pi.skills
extensions/youtrack/  index.ts config.ts register.ts probe.ts status.ts
skills/youtrack/      SKILL.md
.github/workflows/    release.yml：push v* tag → npm publish --provenance --access public
README.md CHANGELOG.md LICENSE(MIT)
```

`pi-package` keyword 是 pi.dev/packages 收录的唯一条件（它索引 npm，不是独立注册表）。
宿主提供的 `@earendil-works/pi-coding-agent` 只作 `peerDependencies: "*"`（仅类型引用），
不进 `dependencies`；运行时无第三方依赖。发布需要仓库侧一次性配置 `NPM_TOKEN` secret。
