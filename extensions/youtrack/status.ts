import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactToken, type LoadResult } from "./config.ts";
import { SERVER_NAME } from "./register.ts";

export function countServerTools(pi: ExtensionAPI, server: string): number {
	const prefix = `mcp__${server}__`;
	return pi.getAllTools().filter((tool) => tool.name.startsWith(prefix)).length;
}

/**
 * A same-named server in `mcp.json` silently wins over our registration (pi prefers the file). Since
 * tool names cannot tell the two sources apart, status has to say so out loud.
 */
export function hasConflictingMcpEntry(cwd: string): boolean {
	const candidates = [join(getAgentDir(), "mcp.json"), join(cwd, ".pi", "mcp.json")];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
			if (parsed.mcpServers && Object.hasOwn(parsed.mcpServers, SERVER_NAME)) return true;
		} catch {
			/* a broken mcp.json is pi's to report, not ours to duplicate */
		}
	}
	return false;
}

export interface StatusInput {
	loaded: LoadResult;
	active?: string;
	baseUrl?: string;
	token?: string;
	writeEnabled: boolean;
	toolCount: number;
	source: "file" | "env" | "none";
	conflictingMcpEntry: boolean;
	loadError?: string;
}

export function formatStatus(input: StatusInput): string {
	const lines: string[] = ["**YouTrack MCP status**"];

	if (input.loadError) lines.push(`- ⚠️ registration: ${input.loadError}`);
	if (input.loaded.kind === "invalid") lines.push(`- ⚠️ config file ${input.loaded.path}: ${input.loaded.reason}`);
	if (input.loaded.kind === "ok") {
		const sites = Object.keys(input.loaded.config.profiles);
		lines.push(`- Config: ${input.loaded.path} (${sites.length} site${sites.length === 1 ? "" : "s"})`);
	}

	if (!input.active || !input.baseUrl || !input.token) {
		lines.push("- Status: **not configured** — run `/youtrack setup`");
		return lines.join("\n");
	}

	const access = input.writeEnabled ? "read-write (this session only)" : "read-only (default)";
	const fromEnv = input.source === "env" ? " (from `YOUTRACK_*` environment, not stored)" : "";
	lines.push(`- Site: \`${input.active}\`${fromEnv}`);
	lines.push(`- Endpoint: ${input.baseUrl}/mcp`);
	lines.push(`- Token: ${redactToken(input.token)}`);
	lines.push(`- Access: ${access}`);
	lines.push(
		`- Tools: ${input.toolCount} registered \`mcp__${SERVER_NAME}__*\`${
			input.toolCount === 0 ? " — still connecting, or the connection failed (see `/mcp`)" : ""
		}`,
	);
	if (input.conflictingMcpEntry) {
		lines.push(
			"- ⚠️ `mcp.json` has its own `youtrack` entry, which pi prefers — the connected site may differ from the one shown here",
		);
	}
	return lines.join("\n");
}

export function formatProfileList(loaded: LoadResult): string {
	if (loaded.kind === "missing") return "No site configured yet — run `/youtrack setup`.";
	if (loaded.kind === "invalid") return `Cannot read the config file: ${loaded.path} — ${loaded.reason}`;

	const names = Object.keys(loaded.config.profiles).sort();
	if (names.length === 0) return "No site configured yet — run `/youtrack setup`.";

	const lines = ["**YouTrack sites**"];
	for (const name of names) {
		const profile = loaded.config.profiles[name];
		if (!profile) continue;
		const marker = name === loaded.config.active ? "→" : " ";
		lines.push(`${marker} \`${name}\`  ${profile.baseUrl}  ${redactToken(profile.token)}`);
	}
	lines.push("", "Switch with `/youtrack use <name>`.");
	return lines.join("\n");
}
