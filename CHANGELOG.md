# Changelog

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
