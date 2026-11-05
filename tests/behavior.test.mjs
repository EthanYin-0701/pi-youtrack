/**
 * Behaviour tests for the extension, run through jiti the same way pi loads it.
 * No test framework and no network: `pi.registerMcpServer` and friends are stubbed.
 *
 *   npm test
 */
import { createJiti } from "jiti";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = fileURLToPath(new URL("../extensions/youtrack/", import.meta.url));
const ENTRY = join(EXT_DIR, "index.ts");

let failures = 0;
function check(label, condition, detail = "") {
	if (!condition) failures++;
	console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` → ${detail}`}`);
}
const eq = (label, actual, expected) =>
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

async function load(modulePath, dir) {
	process.env.PI_CODING_AGENT_DIR = dir;
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	return jiti.import(modulePath);
}

async function loadFactory(dir) {
	const mod = await load(ENTRY, dir);
	return mod.default;
}

function harness() {
	const commands = new Map();
	const handlers = new Map();
	const registrations = [];
	const messages = [];
	const notices = [];
	const api = {
		registerCommand: (name, opts) => commands.set(name, opts),
		registerMcpServer: (name, config) => registrations.push({ name, url: config.url, headers: config.headers }),
		unregisterMcpServer: (name) => registrations.push({ name, url: null }),
		getAllTools: () => [],
		sendMessage: (message) => messages.push(message.content),
		on: (event, handler) => handlers.set(event, handler),
	};
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			notify: (message, type) => notices.push(`${type ?? "info"}:${message}`),
			input: async () => undefined,
			confirm: async () => true,
		},
	};
	return { api, commands, handlers, registrations, messages, notices, ctx };
}

const dir = mkdtempSync(join(tmpdir(), "pi-youtrack-test-"));
const clearEnv = () => {
	delete process.env.YOUTRACK_URL;
	delete process.env.YOUTRACK_TOKEN;
};
const seed = (profiles, active) =>
	writeFileSync(join(dir, "youtrack.json"), JSON.stringify({ version: 1, active, profiles }));

// ---------------------------------------------------------------- config ---
clearEnv();
{
	const config = await load(join(EXT_DIR, "config.ts"), dir);

	eq("bare host gets https", config.normalizeBaseUrl("acme.youtrack.cloud"), "https://acme.youtrack.cloud");
	eq("trailing slash dropped", config.normalizeBaseUrl("https://yt.acme.com/"), "https://yt.acme.com");
	eq("pasted /mcp dropped", config.normalizeBaseUrl("https://yt.acme.com/mcp/"), "https://yt.acme.com");
	eq("subpath kept", config.normalizeBaseUrl("https://acme.com/youtrack/"), "https://acme.com/youtrack");
	eq("http kept for self-hosted", config.normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080");
	eq("blank rejected", config.normalizeBaseUrl("   "), undefined);
	eq("non-http scheme rejected", config.normalizeBaseUrl("ftp://x"), undefined);

	eq("name from cloud host", config.defaultProfileName("https://acme.youtrack.cloud"), "acme");
	eq("name from self-hosted host", config.defaultProfileName("https://yt.acme.com"), "yt");
	eq("www is skipped", config.defaultProfileName("https://www.acme.com"), "acme");
	eq("token redacted to tail", config.redactToken("perm:abcdefgh1234"), "…1234");
	eq("short token fully hidden", config.redactToken("abc"), "****");

	eq("missing before any save", config.loadConfig().kind, "missing");
	config.saveConfig({
		version: 1,
		active: "acme",
		profiles: { acme: { baseUrl: "https://acme.youtrack.cloud", token: "perm:zzzz9999", addedAt: "2026-01-01T00:00:00.000Z" } },
	});
	eq("file is 0600", (statSync(config.configPath()).mode & 0o777).toString(8), "600");
	const roundTrip = config.loadConfig();
	eq("round trip reads the site", roundTrip.config?.active, "acme");
	eq("round trip reads the token", roundTrip.config?.profiles.acme?.token, "perm:zzzz9999");

	writeFileSync(join(dir, "youtrack.json"), JSON.stringify({ version: 1, profiles: { a: { baseUrl: "https://a.com", token: "perm:x" }, b: { baseUrl: "https://b.com" } } }));
	eq("one invalid profile invalidates the file", config.loadConfig().kind, "invalid");
	writeFileSync(join(dir, "youtrack.json"), JSON.stringify({ version: 2, profiles: {} }));
	eq("unknown version is not overwritten", config.loadConfig().kind, "invalid");
	writeFileSync(join(dir, "youtrack.json"), "{not json");
	eq("broken JSON is reported", config.loadConfig().kind, "invalid");
}

// ------------------------------------------------------------ registration ---
{
	const register = await load(join(EXT_DIR, "register.ts"), dir);
	const readOnly = register.buildServerConfig({ profile: "acme", baseUrl: "https://acme.youtrack.cloud", token: "perm:1", writeEnabled: false });
	eq("read-only uses readOnlyTools", new URL(readOnly.url).searchParams.get("readOnlyTools"), "true");
	check("token never appears in the url", !readOnly.url.includes("perm:1"), readOnly.url);
	eq("bearer header", readOnly.headers.Authorization, "Bearer perm:1");
	eq("server exposure", readOnly.exposure, "deferred");
	eq("direct tools", Object.entries(readOnly.toolExposure), [
		["search_issues", "direct"],
		["get_issue", "direct"],
		["get_current_user", "direct"],
	]);
	const writable = register.buildServerConfig({ profile: "acme", baseUrl: "https://acme.youtrack.cloud", token: "perm:1", writeEnabled: true });
	check("write mode drops the filter", !new URL(writable.url).searchParams.has("readOnlyTools"), writable.url);
	check("endpoint ends in /mcp", writable.url.endsWith("/mcp"), writable.url);
}

// ------------------------------------------------------------- no config ---
clearEnv();
rmSync(join(dir, "youtrack.json"), { force: true });
{
	const h = harness();
	await (await loadFactory(dir))(h.api);
	eq("no config registers nothing", h.registrations.length, 0);
	const command = h.commands.get("youtrack");
	check("command registered", Boolean(command));
	eq("autocomplete lists every subcommand", command.getArgumentCompletions("").length, 6);
	await command.handler("status", h.ctx);
	check("status says not configured", /not configured/.test(h.messages.join("\n")), h.messages.join("|"));
	await command.handler("write on", h.ctx);
	check("write on without config warns", h.notices.some((n) => /Not configured/.test(n)), JSON.stringify(h.notices));
	eq("write on without config registers nothing", h.registrations.length, 0);
}

// ------------------------------------------------------ session behaviour ---
clearEnv();
seed({ acme: { baseUrl: "https://acme.youtrack.cloud", token: "perm:abcd1234", addedAt: "2026-01-01T00:00:00.000Z" } }, "acme");
{
	const h = harness();
	await (await loadFactory(dir))(h.api);
	eq("configured registers once at load", h.registrations.length, 1);
	check("load registration is read-only", h.registrations[0]?.url.includes("readOnlyTools=true"), h.registrations[0]?.url);
	eq("load registration carries the token", h.registrations[0]?.headers.Authorization, "Bearer perm:abcd1234");

	await h.handlers.get("session_start")({ type: "session_start", reason: "startup" }, h.ctx);
	eq("unchanged config does not reconnect", h.registrations.length, 1);

	const command = h.commands.get("youtrack");
	await command.handler("write on", h.ctx);
	eq("write on re-registers", h.registrations.length, 2);
	check("write on removes the filter", !h.registrations[1]?.url.includes("readOnlyTools"), h.registrations[1]?.url);

	await h.handlers.get("session_start")({ type: "session_start", reason: "new" }, h.ctx);
	eq("a new session re-registers", h.registrations.length, 3);
	check("a new session is read-only again", h.registrations[2]?.url.includes("readOnlyTools=true"), h.registrations[2]?.url);

	await command.handler("status", h.ctx);
	const status = h.messages.at(-1) ?? "";
	check("status names the site", /acme/.test(status), status);
	check("status redacts the token", status.includes("…1234") && !status.includes("perm:abcd1234"), status);
	check("status counts tools", /0 registered/.test(status), status);
}

// --------------------------------------------------------------- profiles ---
clearEnv();
seed(
	{
		acme: { baseUrl: "https://acme.youtrack.cloud", token: "perm:aaaa1111", addedAt: "2026-01-01T00:00:00.000Z" },
		cust: { baseUrl: "https://yt.customer.com", token: "perm:bbbb2222", addedAt: "2026-01-02T00:00:00.000Z" },
	},
	"acme",
);
{
	const h = harness();
	await (await loadFactory(dir))(h.api);
	const command = h.commands.get("youtrack");

	await command.handler("list", h.ctx);
	const list = h.messages.at(-1) ?? "";
	check("list shows every site", list.includes("acme") && list.includes("cust"), list);
	check("list marks the active site", /→ `acme`/.test(list), list);

	await command.handler("use nope", h.ctx);
	check("unknown site is rejected", h.notices.some((n) => /No site named nope/.test(n)), JSON.stringify(h.notices));

	await command.handler("use cust", h.ctx);
	check("use re-registers the new site", h.registrations.at(-1)?.url.startsWith("https://yt.customer.com/mcp"), JSON.stringify(h.registrations.at(-1)));
	eq("use persists active", JSON.parse(readFileSync(join(dir, "youtrack.json"), "utf8")).active, "cust");

	await command.handler("remove cust", h.ctx);
	const afterRemove = JSON.parse(readFileSync(join(dir, "youtrack.json"), "utf8"));
	check("remove deletes the site", !afterRemove.profiles.cust, JSON.stringify(afterRemove));
	eq("remove falls back to the remaining site", afterRemove.active, "acme");
}

// ------------------------------------------------------- wait for tools ---
{
	const { waitForServerTools } = await load(join(EXT_DIR, "status.ts"), dir);

	const never = { getAllTools: () => [] };
	eq("times out when nothing ever connects", await waitForServerTools(never, "youtrack", 120, 20), {
		count: 0,
		timedOut: true,
	});

	let calls = 0;
	const eventually = {
		getAllTools: () => {
			calls += 1;
			return calls < 3
				? []
				: [{ name: "mcp__youtrack__search_issues" }, { name: "mcp__youtrack__get_issue" }];
		},
	};
	eq("reports the real count once tools land", await waitForServerTools(eventually, "youtrack", 2000, 10), {
		count: 2,
		timedOut: false,
	});
	check("kept polling until they appeared", calls >= 3, `calls=${calls}`);
}

// ---------------------------------------------------------- env override ---
{
	const h = harness();
	process.env.YOUTRACK_URL = "https://env.youtrack.cloud";
	process.env.YOUTRACK_TOKEN = "perm:env9999";
	await (await loadFactory(dir))(h.api);
	check("env override registers", h.registrations.at(-1)?.url.startsWith("https://env.youtrack.cloud/mcp"), JSON.stringify(h.registrations.at(-1)));
	eq("env override uses the env token", h.registrations.at(-1)?.headers.Authorization, "Bearer perm:env9999");
	await h.commands.get("youtrack").handler("status", h.ctx);
	check("status says it came from the environment", /environment, not stored/.test(h.messages.at(-1) ?? ""), h.messages.at(-1));
	eq("env override does not touch the file", JSON.parse(readFileSync(join(dir, "youtrack.json"), "utf8")).active, "acme");
}

// ------------------------------------------------------ write confirmation ---
clearEnv();
seed({ acme: { baseUrl: "https://acme.youtrack.cloud", token: "perm:abcd1234", addedAt: "2026-01-01T00:00:00.000Z" } }, "acme");
{
	const confirm = await load(join(EXT_DIR, "confirm.ts"), dir);
	const card = await load(join(EXT_DIR, "card.ts"), dir);

	check("creates are gated", ["create_issue", "create_draft_issue", "create_article"].every((t) => confirm.shouldConfirm(t)));
	check("reads and updates are not", !["search_issues", "get_issue", "update_issue", "add_issue_comment"].some((t) => confirm.shouldConfirm(t)));

	// ---- draft plumbing ----
	const input = {
		project: "PYP",
		summary: "Login times out",
		description: "x".repeat(120),
		customFields: { Type: "task", Priority: "Major", "Fix versions": ["1.0"] },
	};
	const draft = confirm.readDraft(input);
	eq("draft reads the watched fields case-insensitively", draft.fields, {
		Type: "task",
		Priority: "Major",
		Assignee: "",
		Subsystem: "",
	});

	const rows = confirm.buildRows("create_issue", draft);
	eq("card offers create, four edits, cancel", rows.map((r) => r.label), [
		"Create issue",
		"Edit Type",
		"Edit Priority",
		"Edit Assignee",
		"Edit Subsystem",
		"Cancel",
	]);
	eq("rows show the current values", rows.slice(1, 5).map((r) => r.hint), ["task", "Major", "unset", "unset"]);
	eq("articles have nothing to edit", confirm.buildRows("create_article", draft).map((r) => r.label), [
		"Create article",
		"Cancel",
	]);

	const head = confirm.describeDraft("create_issue", draft);
	eq("card title names the kind", head.title, "Create issue");
	check("header has project, summary, body size", head.header.join("|") === "Project: PYP|Summary: Login times out|Body: 120 characters", head.header.join("|"));

	// ---- the loop, driven through the dialog fallback ----
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	function cardCtx({ picks = [], custom = "unsupported", hasUI = true, schema } = {}) {
		const seen = { select: [], input: [] };
		const ctx = {
			cwd: "/tmp",
			hasUI,
			ui: {
				custom: async () => (custom === "unsupported" ? undefined : custom),
				select: async (title, options) => {
					seen.select.push({ title, options });
					// Pick by name the way a user would: rows carry a " — hint" suffix, so match by prefix.
					const wanted = picks.shift();
					return options.find((option) => option === wanted || option.startsWith(wanted));
				},
				input: async (title) => {
					seen.input.push(title);
					return picks.shift();
				},
				notify: () => {},
			},
		};
		return { ctx, seen, schema };
	}

	// create as drafted, no edits
	{
		const { ctx } = cardCtx({ picks: ["Create issue"] });
		const call = { project: "PYP", summary: "s", customFields: { Type: "Task", "Fix versions": ["1.0"] } };
		const result = await confirm.confirmCreate("create_issue", call, { ctx });
		eq("create passes", result, { ok: true });
		eq("untouched fields survive", call.customFields, { Type: "Task", "Fix versions": ["1.0"] });
	}

	// cancel blocks and writes nothing
	{
		const { ctx } = cardCtx({ picks: ["Cancel"] });
		const call = { project: "PYP", summary: "s" };
		const result = await confirm.confirmCreate("create_issue", call, { ctx });
		eq("cancel blocks", result.ok, false);
		eq("cancel explains the next step", result.reason, confirm.REFUSAL_REASON);
		eq("cancel leaves the call alone", call.customFields, undefined);
	}

	// edit Type from the project schema, then create
	{
		const { ctx, seen } = cardCtx({ picks: ["Edit Type", "Bug", "Create issue"] });
		const call = { project: "PYP", summary: "s" };
		const result = await confirm.confirmCreate("create_issue", call, {
			ctx,
			lookupSchema: async () => ({ Type: { enum: ["Bug", "Task"] } }),
		});
		eq("edit then create passes", result, { ok: true });
		eq("the chosen value lands in the call", call.customFields, { Type: "Bug" });
		eq("the field dialog offers the schema values", seen.select[1].options, ["Bug", "Task", "(leave empty)"]);
	}

	// a free-text field takes an input instead of a select
	{
		const { ctx, seen } = cardCtx({ picks: ["Edit Assignee", "john.doe", "Create issue"] });
		const call = { project: "PYP", summary: "s" };
		await confirm.confirmCreate("create_issue", call, { ctx, lookupSchema: async () => ({}) });
		eq("assignee goes through input", call.customFields, { Assignee: "john.doe" });
		eq("no select for a free-text field", seen.select.length, 2);
	}

	// clearing a field removes it
	{
		const { ctx } = cardCtx({ picks: ["Edit Priority", "(leave empty)", "Create issue"] });
		const call = { project: "PYP", summary: "s", customFields: { Priority: "Major" } };
		await confirm.confirmCreate("create_issue", call, {
			ctx,
			lookupSchema: async () => ({ Priority: { enum: ["Major", "Minor"] } }),
		});
		eq("leaving a field empty drops it", call.customFields, undefined);
	}

	// host cannot draw a card, and no UI at all
	{
		const { ctx } = cardCtx({ custom: null });
		eq("custom returning null blocks", (await confirm.confirmCreate("create_issue", {}, { ctx })).ok, false);
		const silent = cardCtx({ hasUI: false });
		eq("no UI lets the call through", await confirm.confirmCreate("create_issue", {}, { ctx: silent.ctx }), { ok: true });
	}

	// ---- the terminal menu itself ----
	{
		const menuRows = [
			{ action: { kind: "create" }, label: "Create issue" },
			{ action: { kind: "cancel" }, label: "Cancel" },
		];
		let settled;
		const menu = new card.ConfirmMenu("Create issue", ["Project: PYP"], menuRows, theme, (v) => {
			settled = v;
		});
		const lines = menu.render(80);
		check("menu renders the title", lines.some((l) => l.includes("Create issue")), lines.join("\n"));
		check("menu renders the header", lines.some((l) => l.includes("Project: PYP")), lines.join("\n"));
		check("menu renders every row", menuRows.every((r) => lines.some((l) => l.includes(r.label))), lines.join("\n"));

		menu.handleInput("\u001b[B");
		menu.handleInput("\r");
		eq("down then enter picks the second row", settled, { kind: "cancel" });

		let escaped;
		const menu2 = new card.ConfirmMenu("t", [], menuRows, theme, (v) => {
			escaped = v;
		});
		menu2.handleInput("\u001b");
		eq("escape backs out", escaped, null);
	}

	// ---- the gate registered on the extension ----
	{
		const h = harness();
		await (await loadFactory(dir))(h.api);
		const gate = h.handlers.get("tool_call");
		check("tool_call handler registered", typeof gate === "function");
		eq("read tools pass untouched", await gate({ toolName: "mcp__youtrack__search_issues", input: {} }, { ...h.ctx, ui: { ...h.ctx.ui, custom: async () => null } }), undefined);
		eq("other servers are ignored", await gate({ toolName: "mcp__other__create_issue", input: {} }, { ...h.ctx, ui: { ...h.ctx.ui, custom: async () => null } }), undefined);
		const blocked = await gate(
			{ toolName: "mcp__youtrack__create_issue", input: { project: "PYP", summary: "s" } },
			{ ...h.ctx, ui: { ...h.ctx.ui, custom: async () => null } },
		);
		eq("declining at the card blocks the call", blocked?.block, true);
		eq("the block carries the refusal reason", blocked?.reason, confirm.REFUSAL_REASON);
	}
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
