import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CardRow, showCard } from "./card.ts";
import type { ProjectSchema } from "./fields.ts";

/** Tools that ask the user before they run. Creating things is where a wrong field is both costly and easy to miss. */
const CONFIRM_TOOLS: Record<string, string> = {
	create_issue: "issue",
	create_draft_issue: "draft issue",
	create_article: "article",
};

/** The four fields a user actually wants a say in. Everything else follows from the project schema. */
const WATCHED_FIELDS = ["Type", "Priority", "Assignee", "Subsystem"];

const LEAVE_EMPTY = "(leave empty)";

export const REFUSAL_REASON =
	"The user cancelled this write. Nothing was created. Ask what to change — summary or the Type/Priority/Assignee/Subsystem fields — and call the tool again once they agree.";

export function shouldConfirm(serverToolName: string): boolean {
	return Object.hasOwn(CONFIRM_TOOLS, serverToolName);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
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

export interface Draft {
	project: string;
	summary: string;
	body?: string;
	/** Watched field → value. An empty string means the user wants it left unset. */
	fields: Record<string, string>;
}

/** The arguments a confirmation works on, pulled out of the tool call the model is about to make. */
export function readDraft(input: unknown): Draft {
	const args = asRecord(input) ?? {};
	const draft: Draft = {
		project: text(args.project) ?? "",
		summary: text(args.summary) ?? "",
		fields: {},
	};
	const body = text(args.description) ?? text(args.content);
	if (body) draft.body = body;

	const customFields = asRecord(args.customFields);
	for (const name of WATCHED_FIELDS) {
		const key = customFields
			? Object.keys(customFields).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
			: undefined;
		draft.fields[name] = key ? (text(customFields?.[key]) ?? "") : "";
	}
	return draft;
}

/**
 * Write the agreed values back into the call. Only the watched fields are touched: anything else the model
 * set (`Fix versions`, visibility) stays exactly as it was.
 */
export function applyDraft(input: unknown, draft: Draft): void {
	const args = asRecord(input);
	if (!args) return;

	const existing = asRecord(args.customFields) ?? {};
	const next: Record<string, unknown> = { ...existing };
	for (const name of WATCHED_FIELDS) {
		const key = Object.keys(next).find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
		const value = draft.fields[name]?.trim() ?? "";
		if (value === "") delete next[key];
		else next[key] = value;
	}
	if (Object.keys(next).length > 0) args.customFields = next;
	else delete args.customFields;
}

export function buildRows(serverToolName: string, draft: Draft): CardRow[] {
	const kind = CONFIRM_TOOLS[serverToolName] ?? "item";
	const rows: CardRow[] = [{ action: { kind: "create" }, label: `Create ${kind}` }];
	// A draft issue or an article has no custom fields to offer.
	if (serverToolName === "create_issue") {
		for (const field of WATCHED_FIELDS) {
			const value = draft.fields[field] ?? "";
			rows.push({
				action: { kind: "edit", field },
				label: `Edit ${field}`,
				hint: value === "" ? "unset" : value,
			});
		}
	}
	rows.push({ action: { kind: "cancel" }, label: "Cancel" });
	return rows;
}

export function describeDraft(serverToolName: string, draft: Draft): { title: string; header: string[] } {
	const kind = CONFIRM_TOOLS[serverToolName] ?? "item";
	const header = [`Project: ${draft.project === "" ? "?" : draft.project}`, `Summary: ${draft.summary === "" ? "(none)" : draft.summary}`];
	if (draft.body) header.push(`Body: ${draft.body.length} characters`);
	return { title: `Create ${kind}`, header };
}

export interface ConfirmDeps {
	ctx: ExtensionContext;
	/** Custom-field values for the project, so the card can offer what YouTrack accepts. */
	lookupSchema?: (project: string) => Promise<ProjectSchema | undefined>;
}

async function editField(draft: Draft, field: string, deps: ConfirmDeps): Promise<void> {
	const schema = await deps.lookupSchema?.(draft.project).catch(() => undefined);
	const values = schema?.[field]?.enum;
	const options = deps.ctx.signal ? { signal: deps.ctx.signal } : {};

	if (values && values.length > 0) {
		const choice = await deps.ctx.ui.select(
			`${field} for ${draft.project}`,
			[...values, LEAVE_EMPTY],
			options,
		);
		if (choice === undefined) return;
		draft.fields[field] = choice === LEAVE_EMPTY ? "" : choice;
		return;
	}

	const current = draft.fields[field] ?? "";
	const answer = await deps.ctx.ui.input(`${field} for ${draft.project} (empty to unset)`, current || undefined);
	if (answer === undefined) return;
	draft.fields[field] = answer.trim();
}

export type ConfirmResult = { ok: true } | { ok: false; reason: string };

/**
 * Show the card until the user either creates or cancels, applying any field edits to the call in place.
 * A host with no UI lets the call through: blocking there would hang a scripted session.
 */
export async function confirmCreate(
	serverToolName: string,
	input: unknown,
	deps: ConfirmDeps,
): Promise<ConfirmResult> {
	if (!deps.ctx.hasUI) return { ok: true };

	const draft = readDraft(input);
	for (;;) {
		const { title, header } = describeDraft(serverToolName, draft);
		const outcome = await showCard({ ctx: deps.ctx, title, header, rows: buildRows(serverToolName, draft) });

		if (outcome === undefined) return { ok: true };
		if (outcome === null || outcome.kind === "cancel") return { ok: false, reason: REFUSAL_REASON };
		if (outcome.kind === "create") {
			applyDraft(input, draft);
			return { ok: true };
		}
		await editField(draft, outcome.field, deps);
	}
}
