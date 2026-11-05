/** Tools that ask the user before they run. Creating things is where a wrong field is both costly and easy to miss. */
const CONFIRM_TOOLS: Record<string, string> = {
	create_issue: "issue",
	create_draft_issue: "draft issue",
	create_article: "article",
};

/** The four fields a user actually wants a say in. Everything else follows from the project schema. */
const WATCHED_FIELDS = ["Priority", "Type", "Assignee", "Subsystem"];

export const REFUSAL_REASON =
	"The user declined this write. Nothing was created. Ask them which of Priority, Type, Assignee and Subsystem to set (or to leave unset), confirm the summary, then call the tool again.";

export function shouldConfirm(serverToolName: string): boolean {
	return Object.hasOwn(CONFIRM_TOOLS, serverToolName);
}

function text(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	// Custom fields can hold several values (`Fix versions`), so an array is a value, not a mistake.
	if (Array.isArray(value)) {
		const parts = value.map((item) => text(item)).filter((item): item is string => item !== undefined);
		return parts.length > 0 ? parts.join(", ") : undefined;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * A preview of what the model is about to write. Body fields are only measured: a draft description can
 * be thousands of characters and a confirmation box is not the place for it.
 */
export function describeCall(serverToolName: string, input: unknown): { title: string; message: string } {
	const args = asRecord(input) ?? {};
	const project = text(args.project) ?? "?";
	const kind = CONFIRM_TOOLS[serverToolName] ?? "item";
	const lines = [`Project: ${project}`, `Summary: ${text(args.summary) ?? "(none)"}`];

	const customFields = asRecord(args.customFields);
	const isIssue = serverToolName === "create_issue";

	if (customFields) {
		const used = new Set<string>();
		for (const name of WATCHED_FIELDS) {
			const key = Object.keys(customFields).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
			if (key) used.add(key);
			lines.push(`${name}: ${key ? (text(customFields[key]) ?? "—") : "—"}`);
		}
		const others = Object.entries(customFields)
			.filter(([key, value]) => !used.has(key) && text(value) !== undefined)
			.map(([key, value]) => `${key}=${text(value)}`);
		if (others.length > 0) lines.push(`Other fields: ${others.join(", ")}`);
	} else if (isIssue) {
		for (const name of WATCHED_FIELDS) lines.push(`${name}: —`);
	}

	const body = text(args.description) ?? text(args.content);
	if (body) lines.push(`Body: ${body.length} characters`);

	return { title: `Create ${kind} in ${project}?`, message: lines.join("\n") };
}
