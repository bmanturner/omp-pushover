// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { decideAtCheck, decideAtEvent } from "../src/policy.ts";
import { DEFAULT_STATE, effectiveMode, statusText } from "../src/state.ts";

const P = (o = {}) => ({ locked: false, screensaver: false, otherUser: false, idleSec: 0, paneVisible: false, ...o });
const ev = (o) => decideAtEvent({ kind: "done", turnSec: 300, armed: false, eff: "auto", p: P(), ...o });
const ck = (o) => decideAtCheck({ kind: "done", ageSec: 60, armed: false, eff: "auto", p: P(), ...o });

describe("decideAtEvent", () => {
	test("drops a short turn while present", () => {
		expect(ev({ turnSec: 30 })).toEqual({ action: "drop", reason: "short turn" });
	});
	test("sends a short turn at once when locked", () => {
		expect(ev({ turnSec: 30, p: P({ locked: true }) }).action).toBe("send");
	});
	test("waits 60 s after a long turn while present", () => {
		expect(ev({})).toMatchObject({ action: "wait", seconds: 60 });
	});
	test("waits 30 s for needs_input", () => {
		expect(ev({ kind: "needs_input", turnSec: 0 })).toMatchObject({ action: "wait", seconds: 30 });
	});
	test("off drops", () => {
		expect(ev({ eff: "off" })).toEqual({ action: "drop", reason: "off" });
	});
	test("an armed finish sends at once, even off, short and present", () => {
		expect(ev({ eff: "off", armed: true, turnSec: 5, p: P({ paneVisible: true }) })).toEqual({ action: "send", reason: "armed" });
	});
	test("an armed error sends at once", () => {
		expect(ev({ kind: "error", armed: true })).toEqual({ action: "send", reason: "armed" });
	});
	test("an arm does not hurry needs_input", () => {
		expect(ev({ kind: "needs_input", eff: "off", armed: true })).toMatchObject({ action: "wait", seconds: 30 });
	});
	test("snooze overrides an arm", () => {
		expect(ev({ eff: "snooze", armed: true })).toEqual({ action: "drop", reason: "snoozed" });
	});
	test("away sends at once", () => {
		expect(ev({ eff: "away" }).action).toBe("send");
	});
	test("always still skips short turns", () => {
		expect(ev({ eff: "always", turnSec: 30 })).toEqual({ action: "drop", reason: "short turn" });
	});
});

describe("decideAtCheck", () => {
	test("sends after 60 s idle with the pane hidden", () => {
		expect(ck({ p: P({ idleSec: 61 }) }).action).toBe("send");
	});
	test("waits for the rest of the idle time", () => {
		expect(ck({ p: P({ idleSec: 10 }) })).toMatchObject({ action: "wait", seconds: 50 });
	});
	test("needs 300 s idle with the pane on screen", () => {
		expect(ck({ p: P({ idleSec: 100, paneVisible: true }) })).toMatchObject({ action: "wait", seconds: 200 });
	});
	test("needs_input needs 120 s idle with the pane on screen", () => {
		expect(ck({ kind: "needs_input", p: P({ idleSec: 125, paneVisible: true }) }).action).toBe("send");
	});
	test("drops after 30 minutes", () => {
		expect(ck({ ageSec: 1801 })).toEqual({ action: "drop", reason: "stale" });
	});
	test("sends when the screensaver runs", () => {
		expect(ck({ p: P({ screensaver: true }) }).action).toBe("send");
	});
});

describe("state", () => {
	test("snooze wins over away", () => {
		expect(effectiveMode({ ...DEFAULT_STATE, away_until: 2000, snooze_until: 1500 }, 1000)).toBe("snooze");
	});
	test("status text for away and armed", () => {
		const s = { ...DEFAULT_STATE, away_until: 1000 + 3 * 3600 + 12 * 60 };
		expect(statusText(s, 1000, true)).toBe("push: away 3h12m · armed");
	});
});
