---
name: youtrack
description: Search, read, and update YouTrack issues, articles, projects, and work items through the YouTrack MCP server registered by the pi-youtrack extension. Use whenever the task involves YouTrack, an issue id like WEB-123, a YouTrack query, or logging work.
disable-model-invocation: true
---

# YouTrack

The tools come from the `youtrack` MCP server, so their names look like `mcp__youtrack__search_issues`.
Only `search_issues`, `get_issue`, and `get_current_user` are declared directly; everything else is reached
through `tool_search`. If a tool you expect is missing, run `tool_search` with the goal ("create a YouTrack
issue") instead of guessing a name.

Every YouTrack fact must come from a `mcp__youtrack__*` tool result. Never read or write YouTrack data with
`bash`, `curl`, or a raw HTTP call against `/mcp` — the token and the tool contract live inside these tools.

## Procedure

Follow these steps in order. They exist because each one has been skipped before.

1. **Check access.** If the write tools (`create_issue`, `update_issue`, `add_issue_comment`, `log_work`,
   `link_issues`, `manage_issue_tags`) are missing, the session is read-only: say so, ask the user to run
   `/youtrack write on`, and stop. Never retry a write under another tool name.
2. **Resolve the project.** `find_projects` for the key. Never invent a key, and never infer one from a
   summary or a URL.
3. **Read the schema.** `get_issue_fields_schema` for that project, every time before creating.
4. **Ask on the card, then wait.** Before anything that creates an issue, the user must confirm the fields:

   - If a tool named `ask_user_question` is available (host-provided): call it — and **nothing else in that
     response** — with four questions, in order:
     1. `Priority` — the question text starts with the summary you intend to write, e.g.
        `For "[test] 确认卡联调": Priority?`; the options are the schema's values, most likely first and
        labelled `(Recommended)` with a one-line reason.
     2. `Type` — same shape, values from the schema.
     3. `Assignee` — first option `Leave unassigned` (mark it `(Recommended)` when you have no strong
        proposal); the current user's login can be a second option; other people are typed through the
        automatic Other row.
     4. `Subsystem` — option `Leave empty (Recommended)`; the question text says a value can be typed
        through the automatic Other row.
     Wait for the answers, fill `customFields` from them, and call `create_issue` in a **later turn** — never
     in the same response as the questionnaire. Calling `create_issue` without the questionnaire gets the
     call blocked in such hosts.
   - If no `ask_user_question` tool exists: call the create tool directly — in a terminal the extension shows
     its own confirmation card before the call runs.
5. **Create, then report.** Call the tool and quote the returned id and URL exactly as returned.
6. **If a call comes back blocked,** the user declined it or the questionnaire is missing. Return to step 4
   with what they said; never retry the same call unchanged.

## Query syntax

Queries are attribute-based. Different attributes are ANDed by juxtaposition. Several values for one
attribute are ORed — as a **comma list**, never in braces. A single value that contains spaces must be in
braces.

- `project: WEB` (alias `in: WEB`), `State: {In Progress}`, `Priority: Major`
- `Priority: Critical, Major` — two values ORed; wrapped in braces, the same list matches nothing
- `Assignee: me`; the bare keyword `#me` means assigned to, reported by, or commented by the current user
- `#unresolved` / `#resolved`, `#<tag>`
- Free text is ANDed: `auth timeout` needs both words
- Ranges use `..`: `created: {minus 7d} .. Today`, `created: * .. 2026-01-01`
- Relative dates: `Today`, `Yesterday`, `{Last week}`, `{minus 2h}`
- Sorting: `sort by: updated desc`, `sort by: created asc`

### Three forms that silently return nothing

Checked against a live server (YouTrack 2026.2): the parser accepts these and matches **zero** issues — no
error, just an empty page. Never conclude "nothing found" from one of them.

| Don't | Do |
| --- | --- |
| a multi-value brace set: `Priority: {Critical, Major}` | `Priority: Critical, Major` |
| explicit logic: `project: WEB (State: Open or State: Reopened)` | two searches, merged by you |
| excluding a custom-field value: `-State: Fixed`, `-Priority: Minor` | drop the clause, or filter the results yourself |

An unbraced multi-word value (`State: In Progress`) also comes back empty — braces are required there, even
for a single value. Negating a system attribute still works (`#me -resolved`), and either half of a broken
query works on its own (`Priority: Critical` and `Priority: Major` each return their issues), so two
separate searches are the reliable way to OR custom-field values.

Working examples:

- `project: WEB #unresolved Assignee: me sort by: updated desc`
- `project: {Web Site} created: {Last week} Type: Bug`
- `#me -resolved updated: {minus 2h} .. *`

A query that returns nothing does not mean the project is empty. Walk the query back before saying so: drop
every clause but one, retry it alone, and add clauses back until the result goes empty — the culprit is
usually one of the three forms above. Check the project key with `find_projects` only after that.

`search_issues` fills `customFields` with only a few fields by default (Type / State / Assignee on the site
this was checked against). Pass `customFieldsToReturn` (for example `["Priority", "State"]`) when the answer
depends on another field.

`search_issues` returns at most 20 issues per page (`limit` is capped at 20). When a result says
`hasNextPage`, page with `offset` instead of narrowing the query just to fit one page.

## Creating an issue

`create_issue` takes `project`, `summary`, an optional Markdown `description`, and `customFields` as an
object of field name to value, for example `{"Type": "Task", "Priority": "Minor"}`. Values must come from
the schema — an unknown value makes YouTrack reject the whole call. If a required field the schema lists has
no obvious value, ask the user instead of guessing.

Prefer `create_draft_issue` when the user wants to review the text first: a draft is visible only to them,
takes only `project` and `summary`, and can be updated afterwards.

`add_attachment` takes the `createdIssue.id` from the create result as its target.

## Reading and commenting

- `get_issue` returns the summary, description, links, attachments, tags, votes, recent comments, and custom
  fields — but not the full comment history. Use `get_issue_comments` to page through it.
- `add_issue_comment` writes Markdown and returns a `commentId` that `add_attachment` can target.
- Quote ids and URLs exactly as they appear in tool results; never restate an id you have not seen.

## Work items

`log_work` needs an existing issue and a duration. Work types and their attributes come from project
settings — `get_project` lists the ones that are available.
