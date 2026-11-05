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

Creating things is the one place a wrong field is both costly and easy to miss, so the extension gates it in
pi's tool pipeline (`create_issue`, `create_draft_issue`, `create_article`). Before the call runs, a
confirmation lists the project, the summary, and Priority / Type / Assignee / Subsystem — with `—` where the
agent left them empty — plus any other custom fields. Decline it and the call is blocked; the agent is told
to go back and ask you about those fields instead of retrying.

Only creation is gated. Updates, comments, tags, links, and work items run without a prompt. Sessions
without a UI (`pi -p`, RPC) are never blocked.

The bundled skill describes the same order as a procedure — check access, resolve the project, read the field
schema, post a field draft and wait, then create — and it is loaded only through `/skill:youtrack`, never
automatically.

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
