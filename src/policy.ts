// @ts-nocheck
// When to push. Pure functions: the caller supplies the state and presence.

export type Kind = "done" | "needs_input" | "error";
export type EffMode = "auto" | "always" | "off" | "away" | "snooze";

export interface Presence {
	locked: boolean;
	screensaver: boolean;
	otherUser: boolean;
	idleSec: number;
	paneVisible: boolean;
}

export type Decision =
	| { action: "send" | "drop"; reason: string }
	| { action: "wait"; seconds: number; reason: string };

/** Turns shorter than this are not reported unless armed or away. */
export const MIN_TURN_SEC = 60;
/** The first wait after an event, and the idle time needed when the pane is not on screen. */
export const WAIT_DONE_SEC = 60;
export const WAIT_INPUT_SEC = 30;
/** Idle time needed when the agent's pane is on screen. */
export const VISIBLE_DONE_SEC = 300;
export const VISIBLE_INPUT_SEC = 120;
/** A notification still undecided after this long is dropped. */
export const STALE_SEC = 1800;

function hardAway(p: Presence): boolean {
	return p.locked || p.screensaver || p.otherUser;
}

/** Snooze beats everything; an armed finish sends whatever the mode or presence. */
function gate(kind: Kind, eff: EffMode, armed: boolean): Decision | null {
	if (eff === "snooze") return { action: "drop", reason: "snoozed" };
	if (armed && kind !== "needs_input") return { action: "send", reason: "armed" };
	if (eff === "off" && !armed) return { action: "drop", reason: "off" };
	return null;
}

export function decideAtEvent(i: { kind: Kind; turnSec: number; armed: boolean; eff: EffMode; p: Presence }): Decision {
	const g = gate(i.kind, i.eff, i.armed);
	if (g) return g;
	if (i.kind === "done" && i.turnSec < MIN_TURN_SEC && !hardAway(i.p)) {
		return { action: "drop", reason: "short turn" };
	}
	if (i.eff === "always" || i.eff === "away") return { action: "send", reason: i.eff };
	if (hardAway(i.p)) return { action: "send", reason: "away (locked/screensaver/other user)" };
	return { action: "wait", seconds: i.kind === "needs_input" ? WAIT_INPUT_SEC : WAIT_DONE_SEC, reason: "waiting" };
}

export function decideAtCheck(i: { kind: Kind; ageSec: number; armed: boolean; eff: EffMode; p: Presence }): Decision {
	const g = gate(i.kind, i.eff, i.armed);
	if (g) return g;
	if (i.ageSec > STALE_SEC) return { action: "drop", reason: "stale" };
	if (i.eff === "always" || i.eff === "away") return { action: "send", reason: i.eff };
	if (hardAway(i.p)) return { action: "send", reason: "away (locked/screensaver/other user)" };
	const input = i.kind === "needs_input";
	const required = i.p.paneVisible ? (input ? VISIBLE_INPUT_SEC : VISIBLE_DONE_SEC) : input ? WAIT_INPUT_SEC : WAIT_DONE_SEC;
	if (i.p.idleSec >= required) return { action: "send", reason: `idle ${i.p.idleSec}s` };
	return {
		action: "wait",
		seconds: Math.max(5, Math.ceil(required - i.p.idleSec)),
		reason: `present (idle ${i.p.idleSec}s < ${required}s)`,
	};
}
