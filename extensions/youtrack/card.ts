import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type CardAction = { kind: "create" } | { kind: "cancel" } | { kind: "edit"; field: string };

export interface CardRow {
	action: CardAction;
	label: string;
	hint?: string;
}

export interface CardRequest {
	ctx: ExtensionContext;
	title: string;
	header: string[];
	rows: CardRow[];
}

/** `null` = the user backed out, `undefined` = this host cannot draw a card. */
export type CardOutcome = CardAction | null | undefined;

export class ConfirmMenu implements Component, Focusable {
	focused = false;
	private index = 0;

	constructor(
		private readonly title: string,
		private readonly header: string[],
		private readonly rows: CardRow[],
		private readonly theme: Theme,
		private readonly settle: (outcome: CardAction | null) => void,
	) {}

	invalidate(): void {
		/* nothing is cached; the menu renders straight from its rows */
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.index = (this.index + this.rows.length - 1) % this.rows.length;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = (this.index + 1) % this.rows.length;
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const row = this.rows[this.index];
			if (row) this.settle(row.action);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) this.settle(null);
	}

	render(width: number): string[] {
		const lines = [this.theme.fg("toolTitle", this.theme.bold(this.title))];
		for (const line of this.header) lines.push(this.theme.fg("muted", line));
		lines.push("");
		this.rows.forEach((row, index) => {
			const selected = index === this.index;
			const marker = selected ? "› " : "  ";
			const hint = row.hint ? this.theme.fg("dim", ` — ${row.hint}`) : "";
			const text = `${marker}${row.label}${hint}`;
			lines.push(selected ? this.theme.bold(text) : text);
		});
		lines.push("", this.theme.fg("dim", "↑↓ move · Enter select · Esc cancel"));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}

async function showCustomCard(request: CardRequest): Promise<CardOutcome> {
	const { ctx } = request;
	const signal = ctx.signal;
	return ctx.ui.custom<CardAction | null>((_tui, theme, _keybindings, done) => {
		let settled = false;
		const settle = (outcome: CardAction | null) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			done(outcome);
		};
		const onAbort = () => settle(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		return new ConfirmMenu(request.title, request.header, request.rows, theme, settle);
	});
}

async function showDialogsCard(request: CardRequest): Promise<CardOutcome> {
	const { ctx } = request;
	const labels = request.rows.map((row) => (row.hint ? `${row.label} — ${row.hint}` : row.label));
	const options = { ...(ctx.signal ? { signal: ctx.signal } : {}) };
	const chunks = [request.title, ...request.header, ""].join("\n");
	const choice = await ctx.ui.select(chunks, labels, options);
	if (choice === undefined) return ctx.signal?.aborted ? undefined : null;
	const index = labels.indexOf(choice);
	const row = index >= 0 ? request.rows[index] : undefined;
	return row?.action ?? null;
}

/**
 * Draw the confirmation card. A terminal gets a real menu; hosts that cannot render custom components fall
 * back to a select dialog; a host with no UI at all gets `undefined` so the caller can let the call through
 * instead of hanging on a question nobody can answer.
 */
export async function showCard(request: CardRequest): Promise<CardOutcome> {
	if (!request.ctx.hasUI) return undefined;
	const outcome = await showCustomCard(request);
	if (outcome !== undefined) return outcome;
	return showDialogsCard(request);
}
