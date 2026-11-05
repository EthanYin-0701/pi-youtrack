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

	check("creates are gated", ["create_issue", "create_draft_issue", "create_article"].every((t) => confirm.shouldConfirm(t)));
	check("reads and updates are not", !["search_issues", "get_issue", "update_issue", "add_issue_comment"].some((t) => confirm.shouldConfirm(t)));

	const full = confirm.describeCall("create_issue", {
		project: "PYP",
		summary: "Login times out",
		description: "x".repeat(120),
		customFields: { Type: "Bug", Priority: "Major", "Fix versions": ["1.0"] },
	});
	eq("confirm title names project and kind", full.title, "Create issue in PYP?");
	check("shows the filled fields", /Type: Bug/.test(full.message) && /Priority: Major/.test(full.message), full.message);
	check("shows the unset fields", /Assignee: —/.test(full.message) && /Subsystem: —/.test(full.message), full.message);
	check("shows other custom fields", /Other fields: Fix versions=1\.0/.test(full.message), full.message);
	check("measures the body instead of printing it", /Body: 120 characters/.test(full.message), full.message);

	const bare = confirm.describeCall("create_issue", { project: "PYP", summary: "s" });
	check("bare create still lists all four fields", ["Priority", "Type", "Assignee", "Subsystem"].every((f) => bare.message.includes(`${f}: —`)), bare.message);

	const draft = confirm.describeCall("create_draft_issue", { project: "PYP", summary: "s" });
	eq("drafts have no field block", draft.title, "Create draft issue in PYP?");
	check("drafts do not invent fields", !/Priority:/.test(draft.message), draft.message);

	const h = harness();
	await (await loadFactory(dir))(h.api);
	const gate = h.handlers.get("tool_call");
	check("tool_call handler registered", typeof gate === "function");

	const deny = { ...h.ctx, ui: { ...h.ctx.ui, confirm: async () => false } };
	const blocked = await gate({ toolName: "mcp__youtrack__create_issue", input: { project: "PYP", summary: "s" } }, deny);
	eq("declining blocks the call", blocked?.block, true);
	eq("declining explains what to do next", blocked?.reason, confirm.REFUSAL_REASON);

	const allowed = await gate({ toolName: "mcp__youtrack__create_issue", input: { project: "PYP", summary: "s" } }, h.ctx);
	eq("confirming lets it through", allowed, undefined);

	eq("read tools pass untouched", await gate({ toolName: "mcp__youtrack__search_issues", input: {} }, deny), undefined);
	eq("update tools are not gated", await gate({ toolName: "mcp__youtrack__update_issue", input: {} }, deny), undefined);
	eq("other servers are ignored", await gate({ toolName: "mcp__other__create_issue", input: {} }, deny), undefined);
	eq("no UI means no block", await gate({ toolName: "mcp__youtrack__create_issue", input: { project: "PYP" } }, { ...deny, hasUI: false }), undefined);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
