import { callMethod, mcpUrl, openSession } from "./mcp.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export type ProbeResult =
	| { ok: true; toolCount?: number }
	| { ok: false; code: "token" | "endpoint" | "http" | "network"; message: string };

function rpcError(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const error = (payload as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? message : "unknown error";
}

function describeNetworkError(error: unknown, endpoint: string, timeoutMs: number): string {
	const name = (error as { name?: string }).name;
	if (name === "AbortError" || name === "TimeoutError") {
		return `${endpoint} did not respond within ${Math.round(timeoutMs / 1000)}s`;
	}
	return `Cannot reach ${endpoint}: ${(error as Error).message}`;
}

/**
 * Validate with a real MCP `initialize` call: it proves both that the URL is an MCP endpoint and that
 * the token passes authentication. Then try `tools/list` so setup can report how many tools exist.
 */
export async function probeEndpoint(
	baseUrl: string,
	token: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
	const endpoint = mcpUrl(baseUrl);
	const opened = await openSession(baseUrl, token, "pi-youtrack", timeoutMs);

	if (!opened.ok) {
		if (opened.error) {
			return { ok: false, code: "network", message: describeNetworkError(opened.error, endpoint, timeoutMs) };
		}
		if (opened.status === 401 || opened.status === 403) {
			return {
				ok: false,
				code: "token",
				message: `Token rejected (HTTP ${opened.status}): the token is invalid, or this account cannot access the site`,
			};
		}
		if (opened.status === 404) {
			return {
				ok: false,
				code: "endpoint",
				message: `No MCP endpoint at ${endpoint} (HTTP 404): check the base URL, and that YouTrack is 2025.3 or newer`,
			};
		}
		const rpc = rpcError(opened.payload);
		return {
			ok: false,
			code: "http",
			message: rpc ? `MCP initialize failed: ${rpc}` : `The site returned HTTP ${opened.status}`,
		};
	}

	const problem = rpcError(opened.payload);
	if (problem) return { ok: false, code: "http", message: `MCP initialize failed: ${problem}` };
	if (!opened.session) return { ok: true };

	let toolCount: number | undefined;
	try {
		const result = (await callMethod(opened.session, "tools/list", {}, timeoutMs)) as
			| { tools?: unknown }
			| undefined;
		if (Array.isArray(result?.tools)) toolCount = result.tools.length;
	} catch {
		/* validation only needs initialize; the tool count is a bonus */
	}

	return toolCount === undefined ? { ok: true } : { ok: true, toolCount };
}
