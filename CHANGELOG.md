# Changelog

## [Unreleased]

## [0.1.4]

- Fix: the YouTrack MCP server is registered again after `/new`, `/resume`, or `/fork`. pi caches the
  extension factory, so the module-level registration fingerprint survived session replacement while
  the new session started with an empty MCP registry, and the server never came back. The fingerprint
  is now kept per extension API (#7).
- Fix: `/youtrack setup` no longer accepts any HTTP 2xx as a working endpoint. Validation now requires
  a JSON-RPC `initialize` result, so an SSO login or proxy page answering at `/mcp` is reported as
  "Not an MCP endpoint" instead of being saved (#6).
- Fix: `/youtrack use`, `remove`, and `list` re-read `youtrack.json` before acting, so writing back no
  longer drops sites added or changed outside the current session; a broken file is reported and left
  untouched (#4).
- The create-issue card's Subsystem hint now reads "Leave empty to unset" (#3).

## [0.1.3]

- The YouTrack skill now covers commenting on issues: resolving a pasted issue link, drafting the
  comment, confirming it (and its visibility) through the host's ask_user_question card, and posting
  with `add_issue_comment`.

## [0.1.2]

- Mark the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peer dependencies as optional
  (`peerDependenciesMeta`). npm 7+ auto-installs peers, so `npm i pi-youtrack` had been pulling the entire
  pi runtime (`@google/genai`, aws-sdk, `openai`, `protobufjs`, ~120 packages) into consumer projects. The
  host supplies these at runtime, so installing the package now adds only `pi-youtrack` itself.

## [0.1.1]

Republish of 0.1.0 with no functional changes, to get the package re-indexed by npm search
(and therefore listed on pi.dev/packages).

## [0.1.0]

First release.

- `/youtrack setup` validates a base URL and a permanent token with a real MCP `initialize`, then stores
  the token in `~/.pi/agent/youtrack.json` (0600, atomic write).
- Multiple sites with an active profile; `/youtrack use`, `list`, `status`, `remove`.
- Registers YouTrack's official MCP server through pi's own MCP support, read-only by default through
  `?readOnlyTools=true`; `/youtrack write on` unlocks write tools for one session.
- `search_issues`, `get_issue`, and `get_current_user` are declared directly, the rest load through
  `tool_search`.
- Bundled `youtrack` skill: query syntax, custom-field schema before creating issues, drafts, comment and
  attachment targets.

- Confirmations ride the host's `ask_user_question` card where one exists: the skill sends four questions
  (Priority / Type / Assignee / Subsystem, summary in the first question), and a `create_issue` that skips the
  questionnaire is blocked, counting the current or the previous turn. Without that tool, a terminal gets the
  extension's own card with in-place field editing; scripted sessions are never blocked.

- Bundled `youtrack` skill: the query section now matches what the server actually accepts. An unbraced
  multi-word value (`State: In Progress`) and three plausible-looking forms — multi-value braces, explicit
  `or`, and excluding a custom-field value — all return an empty page with no error; the skill names the
  working alternative (comma lists, two merged searches) and tells the agent to walk a query back clause by
  clause before reporting "nothing found".
