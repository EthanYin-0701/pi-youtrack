import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	type TUI,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

/** The four fields a user wants a say in. Everything else follows from the project schema. */
export const WATCHED_FIELDS = ["Type", "Priority", "Assignee", "Subsystem"] as const;

const LEAVE_EMPTY = "(leave empty)";

export interface CardRequest {
	ctx: ExtensionContext;
	/** The headline, e.g. `Create issue in PYP?` */
	question: string;
	/** Muted lines under the headline. */
	summary: string[];
	/** What is being created, used in the action label. */
	kind: string;
	/** Whether field editing is offered at all (draft issues and articles have no custom fields). */
	editable: boolean;
	/** Working copy; edits are applied here in place. */
	fields: Record<string, string>;
	/** Allowed values for a field, when the project schema is reachable. */
	loadValues?: (field: string) => Promise<string[] | undefined>;
}

/** `{ kind: "create" }` = go ahead, `null` = the user backed out, `undefined` = this host cannot ask. */
export type CardOutcome = { kind: "create" } | null | undefined;

type Level = { kind: "actions" } | { kind: "values"; field: string; values: string[] } | { kind: "text"; field: string };

interface Row {
	key: string;
	label: string;
	hint?: string;
	description?: string;
	field?: string;
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

/** Word wrap on plain text, so colouring never gets cut in half by a line break. */
function wrapPlain(text: string, width: number): string[] {
	const limit = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (current === "") current = word;
		else if (`${current} ${word}`.length <= limit) current = `${current} ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "") lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function describeValue(value: string): string {
	return value === "" ? "unset" : value;
}

export class ConfirmCard implements Component, Focusable {
	focused = false;
	private level: Level = { kind: "actions" };
	private cursor = 0;
	private loading = false;
	private editor: Editor | undefined;
	private settled = false;

	constructor(
		private readonly request: CardRequest,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly settle: (outcome: CardOutcome) => void,
	) {}

	dispose(): void {
		this.editor = undefined;
	}

	invalidate(): void {
		/* rendered straight from state on every pass */
	}

	handleInput(data: string): void {
		if (this.level.kind === "text") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
				this.openLevel({ kind: "actions" });
				return;
			}
			this.editor?.handleInput(data);
			return;
		}

		const rows = this.rows();
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor + rows.length - 1) % Math.max(1, rows.length);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % Math.max(1, rows.length);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
			if (this.level.kind === "values") this.openLevel({ kind: "actions" });
			else this.finish(null);
			return;
		}
		if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.return)) return;

		const row = rows[this.cursor];
		if (!row) return;
		if (this.level.kind === "values") {
			const value = row.key === LEAVE_EMPTY ? "" : row.key;
			if (this.level.field) this.request.fields[this.level.field] = value;
			this.openLevel({ kind: "actions" });
			return;
		}
		if (row.key === "create") {
			this.finish({ kind: "create" });
			return;
		}
		if (row.field) void this.editField(row.field);
	}

	render(width: number): string[] {
		const theme = this.theme;
		const rule = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const lines: string[] = [rule, ...this.block(theme.bold(this.request.question), width, 1)];
		for (const line of this.request.summary) {
			lines.push(...this.block(theme.fg("muted", line), width, 1));
		}
		lines.push("");
		lines.push(...this.renderLevel(width));

		lines.push("");
		lines.push(...this.block(theme.fg("dim", this.hint()), width, 1));
		lines.push(rule);
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	private block(text: string, width: number, indent: number): string[] {
		return wrapPlain(text, width - indent).map((line) => `${" ".repeat(indent)}${line}`);
	}

	private rows(): Row[] {
		if (this.level.kind === "values") {
			return [
				...this.level.values.map((value) => ({ key: value, label: value })),
				{ key: LEAVE_EMPTY, label: LEAVE_EMPTY, description: "Leave this field unset" },
			];
		}
		if (this.level.kind === "text") return [];

		const rows: Row[] = [{ key: "create", label: `Create ${this.request.kind}`, description: this.summaryOfFields() }];
		if (this.request.editable) {
			for (const field of WATCHED_FIELDS) {
				rows.push({
					key: `edit:${field}`,
					label: `Edit ${field}`,
					hint: describeValue(this.request.fields[field] ?? ""),
					field,
					description:
						field === "Assignee"
							? "YouTrack login, for example john.doe"
							: field === "Subsystem"
								? "Leave empty to unset"
								: "Pick from the values this project accepts",
				});
			}
		}
		return rows;
	}

	private summaryOfFields(): string {
		if (!this.request.editable) return "As drafted";
		return WATCHED_FIELDS.map((field) => `${field} ${describeValue(this.request.fields[field] ?? "")}`).join(" · ");
	}

	private renderLevel(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];

		if (this.level.kind === "text") {
			const field = this.level.field;
			lines.push(...this.row(`${field}`, describeValue(this.request.fields[field] ?? ""), undefined, true, width));
			const editorLines = this.editor?.render(Math.max(1, width - 4)) ?? [];
			for (const line of editorLines) lines.push(`    ${line}`);
			return lines;
		}

		if (this.loading) {
			lines.push(...this.block(theme.fg("muted", "Loading the project's allowed values…"), width, 5));
			return lines;
		}

		this.rows().forEach((row, index) => {
			lines.push(...this.row(row.label, row.hint, row.description, index === this.cursor, width));
		});
		return lines;
	}

	private row(label: string, hint: string | undefined, description: string | undefined, focused: boolean, width: number): string[] {
		const theme = this.theme;
		const pointer = focused ? theme.fg("accent", "›") : " ";
		const mark = focused ? theme.fg("accent", "●") : theme.fg("muted", "○");
		const prefix = ` ${pointer} ${mark} `;
		const body = hint ? `${label}  ${theme.fg("dim", `— ${hint}`)}` : label;
		const text = focused ? theme.bold(body) : body;
		const out = wrapPlain(text, width - prefix.length - 4).map((line, index) =>
			index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`,
		);
		if (description) {
			for (const line of wrapPlain(description, width - prefix.length - 4)) {
				out.push(`${" ".repeat(prefix.length)}${theme.fg("muted", line)}`);
			}
		}
		return out;
	}

	private hint(): string {
		if (this.level.kind === "text") return "Enter save · Esc back";
		if (this.level.kind === "values") return "↑↓ move & select · Enter choose · Esc back";
		return "↑↓ move & select · Enter select · Esc cancel";
	}

	private openLevel(level: Level): void {
		if (level.kind !== "text") this.editor = undefined;
		this.level = level;
		this.cursor = 0;
		this.tui.requestRender();
	}

	private async editField(field: string): Promise<void> {
		const load = this.request.loadValues;
		if (!load) {
			this.startEditor(field);
			return;
		}

		this.loading = true;
		this.tui.requestRender();
		let values: string[] | undefined;
		try {
			values = await load(field);
		} catch {
			values = undefined;
		}
		this.loading = false;
		if (this.settled) return;

		if (values && values.length > 0) this.openLevel({ kind: "values", field, values });
		else this.startEditor(field);
	}

	private startEditor(field: string): void {
		const editor = new Editor(this.tui, editorTheme(this.theme));
		editor.setText(this.request.fields[field] ?? "");
		editor.onSubmit = (text: string) => {
			this.request.fields[field] = text.trim();
			this.openLevel({ kind: "actions" });
		};
		this.editor = editor;
		this.focused = true;
		this.openLevel({ kind: "text", field });
	}

	private finish(outcome: CardOutcome): void {
		if (this.settled) return;
		this.settled = true;
		this.settle(outcome);
	}
}

async function showCustomCard(request: CardRequest): Promise<CardOutcome> {
	const signal = request.ctx.signal;
	return request.ctx.ui.custom<{ kind: "create" } | null>((tui, theme, _keybindings, done) => {
		let settled = false;
		const settle = (outcome: CardOutcome) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			done(outcome as { kind: "create" } | null);
		};
		const onAbort = () => settle(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		return new ConfirmCard(request, tui, theme, settle);
	});
}

/** The same flow through plain dialogs, for hosts that cannot render custom components. */
async function showDialogsCard(request: CardRequest): Promise<CardOutcome> {
	const options = request.ctx.signal ? { signal: request.ctx.signal } : {};
	const actions: Row[] = [
		{ key: "create", label: `Create ${request.kind}` },
		...(request.editable
			? WATCHED_FIELDS.map((field) => ({
					key: `edit:${field}`,
					label: `Edit ${field} — ${describeValue(request.fields[field] ?? "")}`,
					field,
				}))
			: []),
	];

	for (;;) {
		const header = [request.question, ...request.summary].join("\n");
		const choice = await request.ctx.ui.select(header, actions.map((row) => row.label), options);
		if (choice === undefined) return null;
		const row = actions.find((candidate) => candidate.label === choice);
		if (!row) continue;
		if (row.key === "create") return { kind: "create" };
		if (!row.field) continue;
		await editThroughDialogs(request, row.field, options);
		actions.splice(1, actions.length - 1, ...(request.editable
			? WATCHED_FIELDS.map((field) => ({
					key: `edit:${field}`,
					label: `Edit ${field} — ${describeValue(request.fields[field] ?? "")}`,
					field,
				}))
			: []));
	}
}

async function editThroughDialogs(
	request: CardRequest,
	field: string,
	options: { signal?: AbortSignal },
): Promise<void> {
	let values: string[] | undefined;
	try {
		values = await request.loadValues?.(field);
	} catch {
		values = undefined;
	}
	if (values && values.length > 0) {
		const choice = await request.ctx.ui.select(`${field} for this issue`, [...values, LEAVE_EMPTY], options);
		if (choice === undefined) return;
		request.fields[field] = choice === LEAVE_EMPTY ? "" : choice;
		return;
	}
	const current = request.fields[field] ?? "";
	const answer = await request.ctx.ui.input(`${field} (empty to unset)`, current || undefined);
	if (answer === undefined) return;
	request.fields[field] = answer.trim();
}

/**
 * Ask for confirmation. A terminal gets the card with inline field editing; hosts without custom components
 * get the same flow through select dialogs; a host with no UI gets `undefined` so the call passes through
 * instead of hanging on a question nobody can answer.
 */
export async function showCard(request: CardRequest): Promise<CardOutcome> {
	if (!request.ctx.hasUI) return undefined;
	const outcome = await showCustomCard(request);
	if (outcome !== undefined) return outcome;
	return showDialogsCard(request);
}
