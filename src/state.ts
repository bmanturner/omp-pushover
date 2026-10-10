// @ts-nocheck
// The state shared with the Tern plugin: ~/.config/omp-pushover/state.json.
// Times are Unix seconds.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Mode = "auto" | "always" | "off";
export type EffMode = Mode | "away" | "snooze";

export interface State {
	mode: Mode;
	away_until: number | null;
	snooze_until: number | null;
	armed: string[];
	last_error: string | null;
}

export const DEFAULT_STATE: State = {
	mode: "auto",
	away_until: null,
	snooze_until: null,
	armed: [],
	last_error: null,
};

const MODES = ["auto", "always", "off"];

export function statePath(): string {
	return path.join(os.homedir(), ".config", "omp-pushover", "state.json");
}

export function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/** Fills every missing or invalid field from the defaults. */
export function normalizeState(raw: unknown): State {
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const time = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return {
		mode: MODES.includes(r.mode) ? r.mode : DEFAULT_STATE.mode,
		away_until: time(r.away_until),
		snooze_until: time(r.snooze_until),
		armed: Array.isArray(r.armed) ? r.armed.filter((k) => typeof k === "string") : [],
		last_error: typeof r.last_error === "string" ? r.last_error : null,
	};
}

/** Never throws: a missing or unreadable file gives the defaults. */
export function readState(): State {
	let text;
	try {
		text = fs.readFileSync(statePath(), "utf8");
	} catch {
		return normalizeState(null);
	}
	try {
		return normalizeState(JSON.parse(text));
	} catch {
		return normalizeState(null);
	}
}

/** Reads, applies `fn`, and replaces the file atomically. */
export function updateState(fn: (s: State) => void): State {
	const s = readState();
	fn(s);
	const file = statePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
	fs.renameSync(tmp, file);
	return s;
}

export function effectiveMode(s: State, now: number): EffMode {
	if (s.snooze_until !== null && s.snooze_until > now) return "snooze";
	if (s.away_until !== null && s.away_until > now) return "away";
	return s.mode;
}

export function formatRemaining(sec: number): string {
	if (sec >= 3600) {
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		return `${h}h${String(m).padStart(2, "0")}m`;
	}
	return `${Math.max(1, Math.floor(sec / 60))}m`;
}

export function statusText(s: State, now: number, armedHere: boolean): string {
	const eff = effectiveMode(s, now);
	let text;
	if (eff === "snooze") text = `push: snoozed ${formatRemaining(s.snooze_until - now)}`;
	else if (eff === "away") text = `push: away ${formatRemaining(s.away_until - now)}`;
	else text = `push: ${eff}`;
	if (armedHere) text += " · armed";
	if (s.last_error) text += " · error";
	return text;
}
