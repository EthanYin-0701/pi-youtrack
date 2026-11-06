import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showCard, WATCHED_FIELDS } from "./card.ts";
import type { ProjectSchema } from "./fields.ts";

/** Tools that ask the user before they run. Creating things is where a wrong field is both costly and easy to miss. */
const CONFIRM_TOOLS: Record<string, string> = {
	create_issue: "issue",
	create_draft_issue: "draft issue",
	create_article: "article",
};

export const REFUSAL_REASON =
	"The user cancelled this write. Nothing was created. Ask what to change — summary or the Type/Priority/Assignee/Subsystem fields — and call the tool again once they agree.";

/** In hosts that provide the `ask_user_question` card, a create must follow a confirmed questionnaire. */
export const ASK_FIRST_REASON =
	"The user has not confirmed the fields yet. Call ask_user_question with the Priority / Type / Assignee / Subsystem draft, wait for the answer, and only then call create_issue. Nothing was created.";

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

export interface ConfirmDeps {
	ctx: ExtensionContext;
	/** Custom-field values for the project, so the card can offer what YouTrack accepts. */
	lookupSchema?: (project: string) => Promise<ProjectSchema | undefined>;
}

export type ConfirmResult = { ok: true } | { ok: false; reason: string };

/**
 * Ask before creating, letting the user fix the fields in place. A host with no UI lets the call through:
 * blocking there would hang a scripted session.
 */
export async function confirmCreate(
	serverToolName: string,
	input: unknown,
	deps: ConfirmDeps,
): Promise<ConfirmResult> {
	if (!deps.ctx.hasUI) return { ok: true };

	const kind = CONFIRM_TOOLS[serverToolName] ?? "item";
	const draft = readDraft(input);
	// Only a full issue carries custom fields; a draft or an article has nothing to edit.
	const editable = serverToolName === "create_issue";
	const summary = editable
		? [draft.body ? `${draft.summary} · body ${draft.body.length} characters` : draft.summary]
		: [draft.summary];

	const lookup = deps.lookupSchema;
	const outcome = await showCard({
		ctx: deps.ctx,
		question: `Create ${kind} in ${draft.project || "?"}?`,
		summary: summary.filter((line) => line !== ""),
		kind,
		editable,
		fields: draft.fields,
		...(lookup
			? {
					loadValues: async (field: string) => {
						const schema = await lookup(draft.project);
						return schema?.[field]?.enum;
					},
				}
			: {}),
	});

	if (outcome === undefined) return { ok: true };
	if (outcome === null) return { ok: false, reason: REFUSAL_REASON };
	applyDraft(input, draft);
	return { ok: true };
}
