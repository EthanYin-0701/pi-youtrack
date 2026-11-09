# pi-youtrack

Connect [pi](https://pi.dev) to [YouTrack](https://www.jetbrains.com/youtrack/) through its official
[MCP server](https://www.jetbrains.com/help/youtrack/server/model-context-protocol-server.html), with one
permanent token and one command.

```bash
pi install npm:pi-youtrack
```

Then, inside pi:

```bash
/youtrack setup
```

Answer three prompts — base URL, site name, permanent token — and the agent can search, read, and (when you
allow it) update your issues.

> **Best in [ThinkRail](https://thinkrail.ai/).** The bundled `youtrack` skill is nicest there: ThinkRail
> renders its confirmation questionnaire as an inline interactive card in the chat, instead of a terminal
> menu. The skill behaves the same everywhere — invoke it with `/skill:youtrack` — only the card differs.

## Why this package

pi can already reach YouTrack with `pi mcp add --url https://acme.youtrack.cloud/mcp --bearer-token-env-var YOUTRACK_TOKEN`.
This package is what that route leaves you to do by hand:

- **Credentials once, per machine, for several sites.** Profiles live in `~/.pi/agent/youtrack.json` (0600);
  `/youtrack use <name>` switches between a customer site and your own. No environment variables needed —
  `YOUTRACK_URL` / `YOUTRACK_TOKEN` still win when you want them for one session.
- **Read-only by default.** The registered endpoint carries `?readOnlyTools=true`, so write tools are filtered
  out by YouTrack itself and never reach the model. `/youtrack write on` unlocks them for the current session.
- **A skill that knows YouTrack.** Query syntax, the "read the custom-field schema before creating an issue"
  order, drafts versus issues, and the attachment target convention are all in the bundled `youtrack` skill,
  instead of being rediscovered by trial and error every session.

## Commands

| Command | Effect |
| --- | --- |
| `/youtrack` or `/youtrack status` | Active site, endpoint, token tail, access mode, tool count |
| `/youtrack setup` | Ask for base URL, site name, and token, validate them, save, register |
| `/youtrack list` | Every saved site, with the active one marked |
| `/youtrack use <name>` | Switch the active site (returns to read-only) |
| `/youtrack write on\|off` | Allow or block write tools for this session only |
| `/youtrack remove <name>` | Delete a site and its token |

Everything after `/youtrack setup` is optional: the extension registers the active site on every session
start.

## Confirming before it writes

> **Use this skill in ThinkRail if you can.** The inline interactive card is rendered by ThinkRail's web
> chat (it draws the `ask_user_question` tool as a multi-tab questionnaire), which is a friendlier
> confirmation than a terminal menu or a modal dialog. The skill is the same everywhere — only the card
> differs.

Creating an issue asks the user first, wherever pi runs. Two paths, one contract.

**In ThinkRail — or any host that provides the `ask_user_question` tool — the questionnaire card is the
confirmation.** The bundled skill makes the agent call `ask_user_question` with four questions — Priority,
Type, Assignee, Subsystem — the summary sitting in the first question's text and a recommended value first in
every list. The host renders it as its familiar interactive card, the answers arrive as the next message, and
the agent fills `customFields` from them. An agent that skips the questionnaire and calls `create_issue`
anyway gets the call blocked with an instruction to ask first — the gate counts a questionnaire from the
current or the previous turn, because that is when the answers land. Drafts and articles have no fields to
confirm, so they are not gated this way.

**In a plain terminal without that tool**, the extension draws its own card before the call runs:

```
──────────────────────────────────────────────────────────────
 Create issue in PYP?
 Login times out · body 120 characters

 › ● Create issue
     Type Task · Priority Major · Assignee unset · Subsystem unset
   ○ Edit Type — Task
     Pick from the values this project accepts
   ○ Edit Priority — Major
     Pick from the values this project accepts
   ○ Edit Assignee — unset
     YouTrack login, for example john.doe
   ○ Edit Subsystem — unset
     Free text; leave empty to unset

 ↑↓ move & select · Enter select · Esc cancel
──────────────────────────────────────────────────────────────
```

`Edit Type` and `Edit Priority` open the project's real values (read from `get_issue_fields_schema` once per
project and cached) in the same card; `Assignee` and `Subsystem` edit inline. Esc backs out one level, and Esc
on the top level cancels. Whatever you pick is written into the call in place.

Sessions without any UI (`pi -p`) are never blocked. Updates, tags, links, and work items run without a
prompt. The bundled skill also asks before a comment: it shows the draft plus a visibility choice and posts
only after approval (a scripted session with no user posts directly and says so). The extension itself gates
only creation.

## Requirements

- pi with built-in MCP support (streamable HTTP). No other extension replaces `/mcp`.
- YouTrack **2025.3 or newer** — earlier versions have no `/mcp` endpoint. `setup` says so if it gets a 404.
- A YouTrack permanent token with the YouTrack scope: *Avatar menu → Profile → Account Security →
  Authentication → New token*.

## How it works

The extension is a thin layer over pi's MCP support. It calls `pi.registerMcpServer("youtrack", …)` while it
loads, so pi connects your site alongside the servers from `mcp.json`. Transport, reconnects, the `/mcp`
panel, `tool_search`, and codemode all stay pi's. This package owns the config file, the defaults, and the
skill — nothing else.

Server tools appear as `mcp__youtrack__<tool>`. `search_issues`, `get_issue`, and `get_current_user` are
declared directly; the rest load through `tool_search`.

## Security

- The token is written to `~/.pi/agent/youtrack.json` with mode `0600` and only ever displayed as its last
  four characters.
- The extension makes network requests to exactly one host: the base URL you configured.
- No telemetry, no third-party calls.
- `setup` types the token into a normal prompt, so it is visible on your screen while you paste it. Use
  `YOUTRACK_URL` + `YOUTRACK_TOKEN` instead if that matters to you — those are never written to disk.

## Limitations

- **Custom MCP tools disappear in read-only mode.** `?readOnlyTools=true` filters on YouTrack's read-only
  annotation, which custom MCP tools do not carry.
- **A same-named `mcp.json` entry wins.** If you also define a server called `youtrack` there, pi prefers the
  file and `/youtrack status` can only warn you — tool names cannot reveal which definition is connected.
- **A site switch or `/youtrack write on` needs a reconnect.** The new tool set may only appear on the next
  turn.
- **Start a new session after installing.** The three directly-declared tools are only put in front of
  the model when the server is already connected as the session's tool list is built. Install the package
  in a running session and those three may stay invisible for the rest of it — the rest still arrive
  through `tool_search`. A fresh session has all of them.
- **Windows has no `0600`.** The file is still written atomically, but it is not protected by filesystem
  permissions there.
- **`/youtrack setup` does not verify that the token's account can see the project you ask about.** YouTrack
  applies the account's own permissions per call.

## Development

```bash
npm install
npm run typecheck
pi -e .          # load this package from disk for one session
```

No build step: pi loads the TypeScript extension directly.

Release: `npm version patch && git push --follow-tags`. The `Release` workflow publishes to npm with
provenance once the `NPM_TOKEN` secret is set. The `pi-package` keyword in `package.json` is what makes the
package appear on [pi.dev/packages](https://pi.dev/packages).

## License

MIT
