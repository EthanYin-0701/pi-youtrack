import { callTool, openSession } from "./mcp.ts";

/** One custom field as YouTrack describes it. Only what the confirmation card needs. */
export interface FieldValueSchema {
	enum?: string[];
	type?: string;
	description?: string;
}

export type ProjectSchema = Record<string, FieldValueSchema>;

const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { schema: ProjectSchema; at: number }>();

function asSchema(value: unknown): ProjectSchema | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const schema: ProjectSchema = {};
	for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
		if (typeof definition !== "object" || definition === null) continue;
		const record = definition as Record<string, unknown>;
		const entry: FieldValueSchema = {};
		if (Array.isArray(record.enum)) {
			const values = record.enum.filter((item): item is string => typeof item === "string");
			if (values.length > 0) entry.enum = values;
		}
		if (typeof record.type === "string") entry.type = record.type;
		if (typeof record.description === "string") entry.description = record.description;
		schema[name] = entry;
	}
	return Object.keys(schema).length > 0 ? schema : undefined;
}

/**
 * A project's custom-field schema, so the card can offer the values YouTrack actually accepts. Cached per
 * site and project: the schema changes rarely and a create flow should not pay for it twice.
 */
export async function projectSchema(
	baseUrl: string,
	token: string,
	project: string,
	timeoutMs = 15_000,
): Promise<ProjectSchema | undefined> {
	const key = `${baseUrl}|${project}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < TTL_MS) return cached.schema;

	const opened = await openSession(baseUrl, token, "pi-youtrack", timeoutMs);
	if (!opened.ok || !opened.session) return undefined;

	let raw: unknown;
	try {
		raw = await callTool(opened.session, "get_issue_fields_schema", { projectKey: project }, timeoutMs);
	} catch {
		return undefined;
	}
	const schema = asSchema(raw);
	if (schema) cache.set(key, { schema, at: Date.now() });
	return schema;
}

export function clearSchemaCache(): void {
	cache.clear();
}
