# Changelog

## [Unreleased]

- Confirmations ride the host's `ask_user_question` card where one exists: the skill sends four questions
  (Priority / Type / Assignee / Subsystem, summary in the first question), and a `create_issue` that skips the
  questionnaire is blocked, counting the current or the previous turn. Without that tool, a terminal gets the
  extension's own card with in-place field editing; scripted sessions are never blocked.

- Bundled `youtrack` skill: the query section now matches what the server actually accepts. An unbraced
  multi-word value (`State: In Progress`) and three plausible-looking forms — multi-value braces, explicit
  `or`, and excluding a custom-field value — all return an empty page with no error; the skill names the
  working alternative (comma lists, two merged searches) and tells the agent to walk a query back clause by
  clause before reporting "nothing found".

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
