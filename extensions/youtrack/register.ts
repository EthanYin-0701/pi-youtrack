import type { ExtensionAPI, McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { mcpUrl } from "./mcp.ts";

/** Fixed registration name; it does not step aside for a same-named entry in `mcp.json`. */
export const SERVER_NAME = "youtrack";

/** Entry points the model needs every turn: declared directly, the rest loaded through `tool_search`. */
const DIRECT_TOOLS = ["search_issues", "get_issue", "get_current_user"] as const;

export interface Registration {
	profile: string;
	baseUrl: string;
	token: string;
	writeEnabled: boolean;
}

export type Desired = Registration & { source: "file" | "env" };

/**
 * Read-only by default is enforced server-side through `readOnlyTools=true` on the URL: write tools
 * never reach the tool table, instead of being refused when called.
 */
export function buildServerConfig(desired: Registration): McpServerConfig {
	const url = new URL(mcpUrl(desired.baseUrl));
	if (!desired.writeEnabled) url.searchParams.set("readOnlyTools", "true");

	const toolExposure: Record<string, McpExposure> = {};
	for (const name of DIRECT_TOOLS) toolExposure[name] = "direct";

	return {
		url: url.toString(),
		headers: { Authorization: `Bearer ${desired.token}` },
		description: `YouTrack (${desired.profile}) — issues, articles, projects, work items`,
		exposure: "deferred",
		toolExposure,
		timeout: 60,
	};
}

function fingerprintOf(desired: Registration): string {
	return [desired.profile, desired.baseUrl, desired.token, desired.writeEnabled ? "rw" : "ro"].join("\u0000");
}

/**
 * pi decides whether a re-registration changed the config by object identity, so registering again
 * unconditionally would drop and reconnect the server on every session. Track the fingerprint here.
 */
let lastFingerprint: string | undefined;

/** Whether a change was actually handed to pi. */
export function syncRegistration(pi: ExtensionAPI, desired: Registration | undefined): boolean {
	if (!desired) {
		if (lastFingerprint === undefined) return false;
		pi.unregisterMcpServer(SERVER_NAME);
		lastFingerprint = undefined;
		return true;
	}

	const next = fingerprintOf(desired);
	if (next === lastFingerprint) return false;
	pi.registerMcpServer(SERVER_NAME, buildServerConfig(desired));
	lastFingerprint = next;
	return true;
}
