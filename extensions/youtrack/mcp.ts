/**
 * The little bit of MCP this extension speaks on its own: just enough JSON-RPC over Streamable HTTP to
 * validate a site and to read a project's field schema for the confirmation card. The tools themselves
 * are still pi's to connect.
 */
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;

export function mcpUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

export async function postJson(
	url: string,
	token: string,
	body: unknown,
	sessionId: string | undefined,
	timeoutMs = DEFAULT_TIMEOUT_MS,
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
export async function readRpcPayload(response: Response): Promise<unknown> {
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

export interface McpSession {
	endpoint: string;
	token: string;
	sessionId?: string;
}

export interface OpenResult {
	ok: boolean;
	status: number;
	session?: McpSession;
	payload?: unknown;
	error?: unknown;
}

/** `initialize` + `notifications/initialized`; the payload is returned so callers can report RPC errors. */
export async function openSession(
	baseUrl: string,
	token: string,
	clientName: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OpenResult> {
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
					clientInfo: { name: clientName, version: "1" },
				},
			},
			undefined,
			timeoutMs,
		);
	} catch (error) {
		return { ok: false, status: 0, error };
	}

	const payload = await readRpcPayload(response);
	if (!response.ok) return { ok: false, status: response.status, payload };

	const sessionId = response.headers.get("mcp-session-id") ?? undefined;
	const session: McpSession = sessionId ? { endpoint, token, sessionId } : { endpoint, token };
	await postJson(
		endpoint,
		token,
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		sessionId,
		timeoutMs,
	).catch(() => undefined);

	return { ok: true, status: response.status, session, payload };
}

/** Calls an MCP method and returns its `result` payload. */
export async function callMethod(
	session: McpSession,
	method: string,
	params: unknown,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
	const response = await postJson(
		session.endpoint,
		session.token,
		{ jsonrpc: "2.0", id: 2, method, params },
		session.sessionId,
		timeoutMs,
	);
	const payload = await readRpcPayload(response);
	return (payload as { result?: unknown } | undefined)?.result;
}

/** Calls a tool and unwraps the JSON that YouTrack puts in the first text block. */
export async function callTool(
	session: McpSession,
	name: string,
	args: unknown,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
	const result = (await callMethod(
		session,
		"tools/call",
		{ name, arguments: args },
		timeoutMs,
	)) as { content?: { type?: string; text?: string }[] } | undefined;
	const text = result?.content?.find((block) => block.type === "text")?.text;
	if (typeof text !== "string") return result;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
