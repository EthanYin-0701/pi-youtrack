import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	configPath,
	defaultProfileName,
	isLoopbackHost,
	loadConfig,
	normalizeBaseUrl,
	redactToken,
	saveConfig,
	type LoadResult,
	type YouTrackConfig,
} from "./config.ts";
import { probeEndpoint } from "./probe.ts";
import { confirmCreate, shouldConfirm } from "./confirm.ts";
import { projectSchema } from "./fields.ts";
import { syncRegistration, SERVER_NAME, type Desired } from "./register.ts";
import {
	countServerTools,
	formatProfileList,
	formatStatus,
	hasConflictingMcpEntry,
	waitForServerTools,
	type StatusInput,
} from "./status.ts";

const SUBCOMMANDS = ["status", "setup", "list", "use", "write", "remove"] as const;

const REPORT_TYPE = "pi-youtrack";

/** The narrowest notification surface both a command ctx and a session-event ctx satisfy. */
type Notifier = { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } };

export default async function youtrack(pi: ExtensionAPI) {
	let writeEnabled = false;
	let loaded: LoadResult = loadConfig();
	let notice: string | undefined;

	function desiredCurrent(): Desired | undefined {
		loaded = loadConfig();
		notice = undefined;

		const envUrl = process.env.YOUTRACK_URL;
		const envToken = process.env.YOUTRACK_TOKEN;
		if (envUrl && envToken) {
			const baseUrl = normalizeBaseUrl(envUrl);
			if (baseUrl) return { profile: "env", baseUrl, token: envToken, writeEnabled, source: "env" };
			notice = `YOUTRACK_URL is not a usable base URL and was ignored: ${envUrl}`;
		}

		if (loaded.kind !== "ok") return undefined;
		const name = loaded.config.active;
		if (!name) return undefined;
		const profile = loaded.config.profiles[name];
		if (!profile) return undefined;
		return { profile: name, baseUrl: profile.baseUrl, token: profile.token, writeEnabled, source: "file" };
	}

	/** Hand pi what should be registered, and swallow failures into a notice: an extension must not block pi. */
	function apply(desired: Desired | undefined, ctx?: Notifier): boolean {
		try {
			return syncRegistration(pi, desired);
		} catch (error) {
			notice = `Registering the YouTrack MCP server failed: ${(error as Error).message}`;
			ctx?.ui.notify(notice, "error");
			return false;
		}
	}

	function report(content: string): void {
		pi.sendMessage({ customType: REPORT_TYPE, content, display: true });
	}

	function knownSites(): string {
		if (loaded.kind !== "ok") return "(none)";
		const names = Object.keys(loaded.config.profiles);
		return names.length === 0 ? "(none)" : names.join(", ");
	}

	// Register while the extension loads: pi connects these alongside the servers from mcp.json when
	// the session starts, so the first prompt already sees the direct tools.
	apply(desiredCurrent());

	pi.on("session_start", async (_event, ctx) => {
		// Write access is session-scoped: every session starts read-only again.
		writeEnabled = false;
		apply(desiredCurrent(), ctx);
		if (notice) ctx.ui.notify(notice, "warning");
	});

	// MCP calls run through pi's tool pipeline, so this covers what the agent writes however it decided
	// to call the tool. Only creation is gated: a wrong field is costly there and easy to miss.
	pi.on("tool_call", async (event, ctx) => {
		const prefix = `mcp__${SERVER_NAME}__`;
		if (!event.toolName.startsWith(prefix)) return;
		const tool = event.toolName.slice(prefix.length);
		if (!shouldConfirm(tool)) return;

		const outcome = await confirmCreate(tool, event.input, {
			ctx,
			lookupSchema: (project: string) => {
				const desired = desiredCurrent();
				return desired
					? projectSchema(desired.baseUrl, desired.token, project)
					: Promise.resolve(undefined);
			},
		});
		if (outcome.ok) return;
		return { block: true, reason: outcome.reason };
	});

	function showStatus(cwd: string): void {
		const desired = desiredCurrent();
		const input: StatusInput = {
			loaded,
			writeEnabled,
			toolCount: countServerTools(pi, "youtrack"),
			source: desired?.source ?? "none",
			conflictingMcpEntry: hasConflictingMcpEntry(cwd),
			...(desired ? { active: desired.profile, baseUrl: desired.baseUrl, token: desired.token } : {}),
			...(notice ? { loadError: notice } : {}),
		};
		report(formatStatus(input));
	}

	async function runSetup(ctx: ExtensionCommandContext): Promise<void> {
		const baseInput = await ctx.ui.input("YouTrack base URL", "https://acme.youtrack.cloud");
		if (baseInput === undefined) return;
		const baseUrl = normalizeBaseUrl(baseInput);
		if (!baseUrl) {
			ctx.ui.notify(`Cannot parse that base URL: ${baseInput}`, "error");
			return;
		}
		if (baseUrl.startsWith("http://") && !isLoopbackHost(baseUrl)) {
			ctx.ui.notify("Not HTTPS: the token would travel in clear text.", "warning");
		}

		const suggested = defaultProfileName(baseUrl);
		const nameInput = await ctx.ui.input("Site name (used by /youtrack use)", suggested);
		if (nameInput === undefined) return;
		const name = nameInput.trim() === "" ? suggested : nameInput.trim();

		const tokenInput = await ctx.ui.input("Permanent token (starts with perm:)");
		if (tokenInput === undefined) return;
		const token = tokenInput.trim();
		if (token === "") {
			ctx.ui.notify("No token entered, nothing changed.", "warning");
			return;
		}
		if (!token.startsWith("perm:")) {
			ctx.ui.notify("That does not look like a permanent token (they start with perm:). Validating anyway.", "warning");
		}

		ctx.ui.notify(`Validating ${baseUrl}/mcp …`, "info");
		const probe = await probeEndpoint(baseUrl, token);
		if (!probe.ok) {
			ctx.ui.notify(`Validation failed: ${probe.message}`, "error");
			return;
		}

		const current = loadConfig();
		if (current.kind === "invalid") {
			ctx.ui.notify(`The config file is broken, nothing written: ${current.reason}`, "error");
			return;
		}
		const config: YouTrackConfig = current.kind === "ok" ? current.config : { version: 1, profiles: {} };
		config.profiles[name] = { baseUrl, token, addedAt: new Date().toISOString() };
		config.active = name;
		try {
			saveConfig(config);
		} catch (error) {
			ctx.ui.notify(`Could not write ${configPath()}: ${(error as Error).message}`, "error");
			return;
		}

		writeEnabled = false;
		apply(desiredCurrent(), ctx);

		// Report what pi actually connected, not what the probe saw: those two numbers disagree while
		// the connection is still in flight, and seeing both is what confused the first user.
		const connected = await waitForServerTools(pi, SERVER_NAME, 8_000);
		const lines = [
			connected.timedOut
				? `Saved site \`${name}\` → ${baseUrl}/mcp, still connecting.`
				: `Saved site \`${name}\` → ${baseUrl}/mcp, ${connected.count} tools connected.`,
		];
		if (connected.timedOut) {
			lines.push("Run `/youtrack status` in a moment; `/mcp` shows the connection detail.");
		}
		lines.push(
			`Token stored in ${configPath()} (0600, showing only ${redactToken(token)}).`,
			"Read-only by default — run `/youtrack write on` before asking the agent to change issues.",
		);
		report(lines.join("\n"));
	}

	async function runUse(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
		if (loaded.kind !== "ok") {
			ctx.ui.notify("Not configured yet — run `/youtrack setup`.", "warning");
			return;
		}
		if (!name) {
			ctx.ui.notify(`Usage: /youtrack use <name>. Known sites: ${knownSites()}`, "warning");
			return;
		}
		if (!Object.hasOwn(loaded.config.profiles, name)) {
			ctx.ui.notify(`No site named ${name}. Known sites: ${knownSites()}`, "error");
			return;
		}
		const config: YouTrackConfig = { ...loaded.config, active: name };
		try {
			saveConfig(config);
		} catch (error) {
			ctx.ui.notify(`Could not write ${configPath()}: ${(error as Error).message}`, "error");
			return;
		}
		writeEnabled = false;
		apply(desiredCurrent(), ctx);
		ctx.ui.notify(`Switched to ${name} (read-only again).`, "info");
	}

	async function runWrite(ctx: ExtensionCommandContext, mode: string | undefined): Promise<void> {
		if (mode !== "on" && mode !== "off") {
			ctx.ui.notify(`Usage: /youtrack write on|off (currently ${writeEnabled ? "read-write" : "read-only"})`, "warning");
			return;
		}
		if (mode === "on") {
			if (!desiredCurrent()) {
				ctx.ui.notify("Not configured yet — run `/youtrack setup`.", "warning");
				return;
			}
			writeEnabled = true;
			apply(desiredCurrent(), ctx);
			ctx.ui.notify(
				"Write access enabled for this session only. MCP is reconnecting, so write tools may appear on the next turn.",
				"info",
			);
			return;
		}
		writeEnabled = false;
		apply(desiredCurrent(), ctx);
		ctx.ui.notify("Back to read-only.", "info");
	}

	async function runRemove(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
		if (loaded.kind !== "ok") {
			ctx.ui.notify("Not configured yet — run `/youtrack setup`.", "warning");
			return;
		}
		if (!name) {
			ctx.ui.notify(`Usage: /youtrack remove <name>. Known sites: ${knownSites()}`, "warning");
			return;
		}
		if (!Object.hasOwn(loaded.config.profiles, name)) {
			ctx.ui.notify(`No site named ${name}. Known sites: ${knownSites()}`, "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Remove YouTrack site",
			`Remove \`${name}\`? Its token is deleted from the config file.`,
		);
		if (!confirmed) return;

		const remaining = { ...loaded.config.profiles };
		delete remaining[name];
		const fallback = Object.keys(remaining)[0];
		const config: YouTrackConfig = { version: loaded.config.version, profiles: remaining };
		if (loaded.config.active !== name && loaded.config.active) config.active = loaded.config.active;
		else if (fallback) config.active = fallback;

		try {
			saveConfig(config);
		} catch (error) {
			ctx.ui.notify(`Could not write ${configPath()}: ${(error as Error).message}`, "error");
			return;
		}
		writeEnabled = false;
		const changed = apply(desiredCurrent(), ctx);
		const tail = config.active ? `Active site is now ${config.active}.` : "No sites left.";
		ctx.ui.notify(`Removed ${name}. ${tail}${changed ? "" : " (no reconnect needed)"}`, "info");
	}

	pi.registerCommand("youtrack", {
		description: "Connect pi to a YouTrack site over its official MCP server",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			return SUBCOMMANDS.filter((name) => name.startsWith(trimmed)).map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";
			const rest = parts.slice(1);

			switch (sub) {
				case "status":
					showStatus(ctx.cwd);
					return;
				case "list":
					report(formatProfileList(loaded));
					return;
				case "setup":
					await runSetup(ctx);
					return;
				case "use":
					await runUse(ctx, rest[0]);
					return;
				case "write":
					await runWrite(ctx, rest[0]);
					return;
				case "remove":
					await runRemove(ctx, rest[0]);
					return;
				default:
					ctx.ui.notify(`Unknown subcommand ${sub}. Try one of: ${SUBCOMMANDS.join(", ")}`, "error");
			}
		},
	});
}
