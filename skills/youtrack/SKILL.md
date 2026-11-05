---
name: youtrack
description: Search, read, and update YouTrack issues, articles, projects, and work items through the YouTrack MCP server registered by the pi-youtrack extension. Use whenever the task involves YouTrack, an issue id like WEB-123, a YouTrack query, or logging work.
---

# YouTrack

The tools come from the `youtrack` MCP server, so their names look like `mcp__youtrack__search_issues`.
Only `search_issues`, `get_issue`, and `get_current_user` are declared directly; everything else is reached
through `tool_search`. If a tool you expect is missing, run `tool_search` with the goal ("create a YouTrack
issue") instead of guessing a name.

## Access mode

If the write tools (`create_issue`, `update_issue`, `add_issue_comment`, `log_work`, `link_issues`,
`manage_issue_tags`) are missing, the session is read-only. Tell the user to run `/youtrack write on` and
continue once they have. Never retry with a different tool name, and never report a change as made when no
write tool ran.

## Query syntax

Queries are attribute-based. Different attributes are ANDed; several values for one attribute are ORed;
values that contain spaces go in braces.

- `project: WEB` (alias `in: WEB`), `State: Open`, `Priority: {Critical, Major}`
- `Assignee: me`; the bare keyword `#me` means assigned to, reported by, or commented by the current user
- `#unresolved` / `#resolved`, `#<tag>`, and `-<value>` to exclude
- Free text is ANDed: `auth timeout` needs both words
- Ranges use `..`: `created: {minus 7d} .. Today`, `created: * .. 2026-01-01`
- Relative dates: `Today`, `Yesterday`, `{Last week}`, `{minus 2h}`
- Sorting: `sort by: updated desc`
- Explicit logic: `project: WEB (State: Open or State: Reopened)`

Working examples:

- `project: WEB #unresolved Assignee: me sort by: updated desc`
- `project: {Web Site} created: {Last week} Type: Bug`
- `#me -resolved updated: {minus 2h} .. *`

A query that returns nothing does not mean the project is empty: confirm the project key with
`find_projects` before concluding anything.

`search_issues` returns at most 20 issues per page (`limit` is capped at 20). When a result says
`hasNextPage`, page with `offset` instead of narrowing the query just to fit one page.

## Creating an issue

1. `find_projects` to resolve the project key. Never invent one.
2. `get_issue_fields_schema` for that project to learn the required custom fields and their allowed values.
3. `create_issue` with a summary, a Markdown description, and every required field. If a required value is
   not in the schema, ask the user instead of guessing — an unknown value makes YouTrack reject the call.
4. `add_attachment` takes the `createdIssue.id` from step 3 as its target.

Prefer `create_draft_issue` when the user wants to review the text first: a draft is visible only to them and
can be updated afterwards.

## Reading and commenting

- `get_issue` returns the summary, description, links, attachments, tags, votes, recent comments, and custom
  fields — but not the full comment history. Use `get_issue_comments` to page through it.
- `add_issue_comment` writes Markdown and returns a `commentId` that `add_attachment` can target.
- Quote ids and URLs exactly as they appear in tool results; never restate an id you have not seen.

## Work items

`log_work` needs an existing issue and a duration. Work types and their attributes come from project
settings — `get_project` lists the ones that are available.
