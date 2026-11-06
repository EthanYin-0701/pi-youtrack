---
id: pi-youtrack-goal
type: goal-and-requirements
title: pi-youtrack — 用 YouTrack 令牌直连官方 MCP 的 pi 包
status: active
---

# pi-youtrack

一条 YouTrack 永久令牌，让 pi 里的 agent 直接读写 YouTrack。

## Overview

`pi-youtrack` 是一个发布到 npm、并被 pi.dev/packages 收录的 pi 包。它做三件事：用一条
`pi install` 把 YouTrack 官方远程 MCP 接进 pi；用 `/youtrack setup` 把站点地址和永久令牌一次存好；
用自带的 skill 教 agent 怎么写 YouTrack 查询、怎么在建单前拿对自定义字段。

它不实现 MCP 客户端——pi 已内置 Streamable HTTP 支持。这个包负责的是**配置、默认值、使用知识**
这三层。

## Problem Statement

pi 今天就能连 YouTrack：`pi mcp add --url https://acme.youtrack.cloud/mcp --bearer-token-env-var YOUTRACK_TOKEN`。
但要让 agent 真正干活，中间隔着几步没人替你做：

- 要先去 YouTrack 生成永久令牌，再决定它放哪（环境变量？`mcp.json` 的 `headers`？），每换一台机器重来一遍；
  同时维护多个站点（客户站点 + 自家站点）时尤其难受。
- 配好之后模型拿到 23 个工具，但 YouTrack 的查询语法（`#unresolved #me project: WEB`）和
  「建 issue 前必须先查项目的必填自定义字段」这两件事不在工具描述里，agent 只能试错、反复报错重试。
- 默认全权限意味着 agent 在跑重构任务时可能顺手 `create_issue` 或改状态，而且很难撤销。

## Target Users

- 日常用 pi 写代码、issue 记在 YouTrack 的开发者（YouTrack Cloud 或自建站点）。
- 在同一台机器上切换多个 YouTrack 站点的人（甲方站点 + 自家站点，或工作 / 个人账号）。
- 想把团队 issue 工作流接进 agent、但不愿意每人手写 `mcp.json` 的小团队。

## Jobs to Be Done

- 当我在 pi 里改完一个 bug，我想直接把结论写回对应的 YouTrack issue，这样不用切浏览器。
- 当我要开始一天的工作，我想让 agent 直接列出分配给我的未解决 issue，而不是我手写查询语句。
- 当我在客户站点和自家站点之间切换，我想一条命令换过去，而不是重配一遍令牌。
- 当我让 agent 新建 issue，我想它一次就把项目必填字段填对，而不是在缺字段的报错里打转。

## Key User Story

小李在 `acme.youtrack.cloud` 上有永久令牌。他 `pi install npm:pi-youtrack`，然后 `/youtrack setup`：
填站点名 `acme`、基址 `https://acme.youtrack.cloud`、粘贴令牌。扩展立刻连一次 MCP 的 `tools/list` 校验，
通过后写入 `~/.pi/agent/youtrack.json`（0600）。

他新开一个会话问「WEB 项目里分配给我、还没解决的 bug 有哪些」。agent 直接调用 `search_issues`，
拿到真实列表。他挑一个说「帮我加条评论说已定位到 auth 超时」。agent 先试写，发现写工具当前不可见，
提示他 `/youtrack write on`；打开后评论成功落库，链接回到会话里。

## Goals

- 让新用户从 `pi install` 到拿到第一条真实 issue 列表，只需三条命令、零环境变量。
- 让默认会话里的 agent 无法写入 YouTrack（不是"写入被拒"，而是写工具根本不可见）。
- 让 agent 第一次尝试建 issue 时就带上项目必填自定义字段，不靠报错重试。
- 让同一台机器上的多个 YouTrack 站点切换是一次命令，且令牌不必重输。

## Non-Goals

- **不实现 MCP 客户端**：复用 pi 内置的 Streamable HTTP 支持、`/mcp` 面板、codemode 与权限钩子。
- **不做 OAuth 登录流程**：只支持永久令牌；YouTrack 的 CIMD 自动注册不做，也不假装支持。
- **不做"一次会话连多个站点"**：同一时刻只有一个 active profile。
- **不做写操作逐次确认的权限门**：只做"会话级只读/可写"两档。
- **不代理、不缓存 YouTrack 数据**：没有离线模式，也没有本地索引。
- **不接管 pi 的 `/mcp` 命令**：不注册同名命令、不替换内置 MCP 支持。

## Alternatives Considered

- **什么都不装，直接用 pi 内置的 `pi mcp add`** —— `pi mcp add --url <base>/mcp --bearer-token-env-var YOUTRACK_TOKEN`
  已经能连（[pi MCP 文档](https://pi.dev/docs/latest/mcp)）。零依赖、零维护；代价是每台机器手工配 URL 与令牌，
  没有默认只读，也没有查询语法与自定义字段的使用知识——而这三点正是本包的全部价值。
- **`@vitalyostanin/youtrack-mcp`** —— 社区 stdio MCP server，走 YouTrack REST API，工具最全
  （[仓库](https://github.com/VitalyOstanin/youtrack-mcp)）。功能超出官方 MCP，但需要在 pi 里配一个
  `npx` 子进程和一套自己的 API key 变量，且不是 pi 包、不会出现在 pi.dev/packages。
- **`pi-mcp-adapter`** —— pi 的通用 MCP 扩展，支持 stdio / SSE / Streamable HTTP（列于
  [pi.dev/packages](https://pi.dev/packages)）。覆盖面最广，但它不知道 YouTrack 的存在，没有站点 profile、
  没有默认只读、没有 YouTrack 专属 skill。

## Success Conditions

- 一台全新机器、没有任何 `YOUTRACK_*` 环境变量，`pi install` + `/youtrack setup` 后能查到真实 issue。
- `~/.pi/agent/youtrack.json` 权限为 0600；`/youtrack status`、日志、prompt 中令牌只显示尾 4 位。
- 默认会话中 `create_issue` / `update_issue` / `add_issue_comment` / `log_work` 不出现在模型可用工具里；
  `/youtrack write on` 之后出现。
- `/youtrack setup` 校验失败时配置文件不被改写，旧配置继续可用。
- 发布后 `pi install npm:pi-youtrack` 在 pi.dev/packages 能被搜到并一键安装。

## Capabilities

最小的可用第一版就是下面这一组，每一项都对应上面某个 Goal：

1. **安装即注册**：扩展在会话启动时用 `pi.registerMcpServer("youtrack", …)` 注册 active profile 的站点，
   端点 `<base>/mcp`，头 `Authorization: Bearer <token>`。未配置时静默不注册，不打扰已有用户。
2. **多站点 profile**：配置文件存多个命名站点与 `active` 字段；`/youtrack use <name>` 切换并重新注册。
3. **凭证落盘**：`/youtrack setup` 交互收集站点名 / 基址 / 令牌，校验通过后原子写入
   `~/.pi/agent/youtrack.json`（0600）。`YOUTRACK_URL` / `YOUTRACK_TOKEN` 可临时覆盖 active profile，不落盘。
4. **默认只读**：注册的 URL 带 `?readOnlyTools=true`，写工具在服务端就被过滤掉；
   `/youtrack write on` 在当前会话内换成不带该参数的 URL（重启回到只读）。
5. **工具暴露分级**：`search_issues`、`get_issue`、`get_current_user` 声明为 `direct`，
   其余工具按需经 `tool_search` 加载，避免每次请求都带上全部 schema。
6. **管理命令**：`/youtrack` 覆盖 `setup` / `list` / `use` / `status` / `remove` / `write on|off`，
   `status` 显示 active 站点、写权限状态、工具数量与连接状态。
7. **附带 skill**：一个 `youtrack` skill，以固定流程开头（查权限 → 定项目 → 读 schema → 贴字段草稿等回复
   → 调用 → 被拦则回上一步），再写清楚查询语法、`customFields` 的取值来源、草稿 issue 与正式 issue 的区别、
   评论/附件的 `target` 约定。只在 `/skill:youtrack` 显式调用时加载。
8. **新建前确认**：在提供 `ask_user_question` 工具的主机（如 ThinkRail）里，skill 让 agent 建单前先发四问
   问卷（Priority / Type / Assignee / Subsystem，题干带 summary），主机渲染成内联选项卡，答案回填
   `customFields`；跳过问卷直接建单会被扩展硬拦（记本回合与上一回合的问卷）。纯终端没有该工具时，扩展在
   执行前弹自己的确认卡（卡内可改字段、列项目真实枚举）；无 UI 的会话不拦。只拦新建类。
9. **发布链路**：npm 包声明 `pi-package` keyword，推 `v*` tag 由 GitHub Actions 发布，
   仓库带 MIT LICENSE 与 CHANGELOG。

## Non-Functional Requirements

- **令牌不外泄**：令牌只存在于 0600 文件与进程内存；不进 prompt、不进日志、不进错误信息；
  任何展示（`/youtrack status`、setup 回显、报错）都只给尾 4 位。
- **不向第三方发请求**：除用户配置的 YouTrack 站点外无任何网络出口，无遥测。
- **失败不放大**：扩展加载或校验失败时不影响 pi 启动、不影响其他 MCP server，只让 YouTrack 工具缺席。
- **跨平台**：macOS / Linux / Windows 上文件权限路径与原子写都成立。

## Onboarding Assumptions（未确认）

以下为推断，用户未逐条确认：

- 未配置时 `/youtrack` 只输出一句"尚未配置，运行 `/youtrack setup`"，不在每次启动时主动提示。
- 允许 `http://` 自建站点（内网），但对非 `localhost` 的非 HTTPS 基址在 setup 时给一条警告而不阻断。
- 不提供 prompt 模板，只有扩展与 skill。

## Technology

| 方面 | 选择 | 理由 |
| --- | --- | --- |
| 交付形态 | pi 包（extension + skill） | 一条 `pi install` 同时拿到配置逻辑和使用知识，二者缺一价值减半 |
| 接入方式 | `pi.registerMcpServer(name, config)` | 复用 pi 内置 MCP 客户端、`/mcp` 面板、codemode 与权限钩子，不自己实现传输 |
| 端点与鉴权 | `<base>/mcp` + `Authorization: Bearer <token>` | YouTrack 官方 MCP 接口；`?readOnlyTools=true` 天然实现默认只读 |
| 语言 | TypeScript | pi 扩展即 TS 模块，宿主提供 `@earendil-works/pi-agent-core` 等 |
| 配置存放 | `~/.pi/agent/youtrack.json`（0600） | 与 pi 其他配置同目录，且不塞进 `mcp.json` 以免与手写配置互相覆盖 |
| 发布 | npm + `pi-package` keyword，tag 触发 GitHub Actions | pi.dev/packages 只索引带该 keyword 的 npm 包 |
