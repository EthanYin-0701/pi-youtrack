const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;

export type ProbeResult =
	| { ok: true; toolCount?: number }
	| { ok: false; code: "token" | "endpoint" | "http" | "network"; message: string };

export function mcpUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

async function postJson(
	url: string,
	token: string,
	body: unknown,
	sessionId: string | undefined,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

/** A Streamable HTTP reply may be SSE: take the first `data:` line that parses. */
async function readRpcPayload(response: Response): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		for (const line of text.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "") continue;
			try {
				return JSON.parse(data);
			} catch {
				/* a keep-alive or a partial frame; keep looking */
			}
		}
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function rpcError(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const error = (payload as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? message : "unknown error";
}

function firstLine(text: string): string {
	return text.split(/\r?\n/)[0]?.slice(0, 200) ?? "";
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

	let response: Response;
	try {
		response = await postJson(
			endpoint,
			token,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-youtrack", version: "1" },
				},
			},
			undefined,
			timeoutMs,
		);
	} catch (error) {
		return { ok: false, code: "network", message: describeNetworkError(error, endpoint, timeoutMs) };
	}

	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			code: "token",
			message: `Token rejected (HTTP ${response.status}): the token is invalid, or this account cannot access the site`,
		};
	}
	if (response.status === 404) {
		return {
			ok: false,
			code: "endpoint",
			message: `No MCP endpoint at ${endpoint} (HTTP 404): check the base URL, and that YouTrack is 2025.3 or newer`,
		};
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		return { ok: false, code: "http", message: `The site returned HTTP ${response.status}${body ? `: ${firstLine(body)}` : ""}` };
	}

	const payload = await readRpcPayload(response);
	const error = rpcError(payload);
	if (error) return { ok: false, code: "http", message: `MCP initialize failed: ${error}` };

	const sessionId = response.headers.get("mcp-session-id") ?? undefined;
	if (sessionId) {
		await postJson(endpoint, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, timeoutMs).catch(
			() => undefined,
		);
	}

	let toolCount: number | undefined;
	try {
		const listResponse = await postJson(
			endpoint,
			token,
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
			sessionId,
			timeoutMs,
		);
		if (listResponse.ok) {
			const listPayload = await readRpcPayload(listResponse);
			const tools = (listPayload as { result?: { tools?: unknown } } | undefined)?.result?.tools;
			if (Array.isArray(tools)) toolCount = tools.length;
		}
	} catch {
		/* validation only needs initialize; the tool count is a bonus */
	}

	return toolCount === undefined ? { ok: true } : { ok: true, toolCount };
}
