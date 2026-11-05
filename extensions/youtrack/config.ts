import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Only this version of the config file is read or written; anything else is reported, never overwritten. */
export const SUPPORTED_VERSION = 1;

export interface YouTrackProfile {
	baseUrl: string;
	token: string;
	addedAt: string;
}

export interface YouTrackConfig {
	version: number;
	active?: string;
	profiles: Record<string, YouTrackProfile>;
}

export type LoadResult =
	| { kind: "ok"; path: string; config: YouTrackConfig }
	| { kind: "missing"; path: string }
	| { kind: "invalid"; path: string; reason: string };

export function configPath(): string {
	return join(getAgentDir(), "youtrack.json");
}

function parseProfile(value: unknown): YouTrackProfile | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.baseUrl !== "string" || record.baseUrl === "") return undefined;
	if (typeof record.token !== "string" || record.token === "") return undefined;
	const normalized = normalizeBaseUrl(record.baseUrl);
	if (!normalized) return undefined;
	return {
		baseUrl: normalized,
		token: record.token,
		addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date(0).toISOString(),
	};
}

/**
 * Read the config file. One invalid profile makes the whole file invalid: better to show the user a
 * problem than to silently drop a site and its token.
 */
export function loadConfig(): LoadResult {
	const path = configPath();
	if (!existsSync(path)) return { kind: "missing", path };

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { kind: "invalid", path, reason: `not valid JSON (${(error as Error).message})` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "invalid", path, reason: "the top level is not an object" };
	}

	const record = raw as Record<string, unknown>;
	if (record.version !== SUPPORTED_VERSION) {
		return {
			kind: "invalid",
			path,
			reason: `version ${String(record.version)} is not supported (this extension reads ${SUPPORTED_VERSION})`,
		};
	}

	const profiles: Record<string, YouTrackProfile> = {};
	if (record.profiles !== undefined) {
		if (typeof record.profiles !== "object" || record.profiles === null) {
			return { kind: "invalid", path, reason: "profiles is not an object" };
		}
		for (const [name, value] of Object.entries(record.profiles as Record<string, unknown>)) {
			const profile = parseProfile(value);
			if (!profile) {
				return { kind: "invalid", path, reason: `profile "${name}" is missing baseUrl or token, or its baseUrl is invalid` };
			}
			profiles[name] = profile;
		}
	}

	const activeName = typeof record.active === "string" && profiles[record.active] ? record.active : undefined;
	const config: YouTrackConfig = { version: SUPPORTED_VERSION, profiles };
	if (activeName !== undefined) config.active = activeName;
	return { kind: "ok", path, config };
}

/** Atomic write: temp file (0600) then rename. A half-written config is worse than none. */
export function saveConfig(config: YouTrackConfig): void {
	const path = configPath();
	const tmp = `${path}.${process.pid}.tmp`;
	const payload = `${JSON.stringify(config, null, "\t")}\n`;
	try {
		writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Every display path goes through here: a token only ever shows its last four characters. */
export function redactToken(token: string): string {
	return token.length <= 4 ? "****" : `…${token.slice(-4)}`;
}

/** Accepts `acme.youtrack.cloud`, a trailing slash, or a pasted `/mcp` suffix. */
export function normalizeBaseUrl(raw: string): string | undefined {
	let value = raw.trim();
	if (value === "") return undefined;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (url.hostname === "") return undefined;

	const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "").replace(/\/+$/, "");
	return `${url.protocol}//${url.host}${path}`;
}

export function defaultProfileName(baseUrl: string): string {
	let host = baseUrl;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		/* normalizeBaseUrl already ran, so this should not happen */
	}
	const labels = host
		.toLowerCase()
		.replace(/\.youtrack\.cloud$/, "")
		.split(".")
		.filter(Boolean);
	if (labels[0] === "www") labels.shift();
	const name = labels[0]?.replace(/[^a-z0-9_-]/g, "");
	return name ? name : "youtrack";
}

export function isLoopbackHost(baseUrl: string): boolean {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}
