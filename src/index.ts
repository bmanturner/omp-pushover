// @ts-nocheck
// omp extension: pushes to an iPhone through Pushover when the main agent
// finishes a turn, stops with an error or needs input, unless the user is at
// the Mac. The rules are in policy.ts; the shared state in state.ts.
import * as path from "node:path";
import { decideAtCheck, decideAtEvent } from "./policy.ts";
import { samplePresence } from "./presence.ts";
import { buildMessage, MISSING_CREDENTIALS, readCredentials, sendPush } from "./pushover.ts";
import { effectiveMode, formatRemaining, nowSec, readState, statusText, updateState } from "./state.ts";

const STATUS_KEY = "omp-pushover";
const STATUS_REFRESH_MS = 15000;
const DEFAULT_AWAY_SEC = 4 * 3600;
const DEFAULT_SNOOZE_SEC = 3600;
const USAGE = "Usage: /push [status|auto|always|off|away [dur]|snooze [dur]|arm|disarm|test], dur like 30m or 2h";

export default function ompPushover(pi) {
	// A nested omp (a subagent process) must not report its turns.
	if (process.env.OMPCODE === "1") return;

	let inTurn = false;
	let turnStartMs = 0;
	let pending = null; // { kind, eventMs, timer, ctx }
	let gen = 0;
	let lastDecision = "none yet";
	let statusTimer = null;

	const isMain = (ctx) => (ctx?.agent ? ctx.agent.kind === "main" : ctx?.hasUI === true);
	const log = (msg) => pi.logger?.warn?.(`omp-pushover: ${msg}`);
	const clock = () => new Date().toTimeString().slice(0, 5);

	function armKeys(ctx): string[] {
		const keys = [`session:${ctx.sessionManager.getSessionId()}`];
		if (process.env.TERN_PANE) keys.push(`pane:${process.env.TERN_PANE}`);
		return keys;
	}

	function refreshStatus(ctx) {
		try {
			const s = readState();
			const keys = armKeys(ctx);
			ctx.ui.setStatus(STATUS_KEY, statusText(s, nowSec(), s.armed.some((k) => keys.includes(k))));
		} catch (err) {
			log(`status: ${err?.message ?? err}`);
		}
	}

	function cancel(reason: string) {
		if (pending) {
			pending.ctx.clearTimer(pending.timer);
			lastDecision = `${clock()} ${pending.kind} → cancelled (${reason})`;
			pending = null;
		}
		gen++;
	}

	function setError(error: string | null) {
		try {
			updateState((s) => {
				s.last_error = error;
			});
		} catch (err) {
			log(`state: ${err?.message ?? err}`);
		}
	}

	function consumeArm(ctx) {
		const keys = armKeys(ctx);
		const s = readState();
		if (!s.armed.some((k) => keys.includes(k))) return;
		updateState((st) => {
			st.armed = st.armed.filter((k) => !keys.includes(k));
		});
	}

	/** Reads the state and presence for a decision; null if superseded meanwhile. */
	async function observe(ctx, myGen) {
		const s = readState();
		const keys = armKeys(ctx);
		const armed = s.armed.some((k) => keys.includes(k));
		const { p, errors } = await samplePresence(process.env.TERN_PANE);
		if (gen !== myGen) return null;
		if (errors.length) {
			for (const e of errors) log(`presence: ${e}`);
			setError(`presence probe failed: ${errors[0]}`);
		}
		return { s, armed, eff: effectiveMode(s, nowSec()), p };
	}

	async function apply(decision, kind, ctx, myGen, eventMs, turnSec) {
		if (decision.action === "wait") {
			lastDecision = `${clock()} ${kind} → wait ${decision.seconds}s (${decision.reason})`;
			const timer = ctx.setTimeout(async () => {
				if (gen !== myGen) return;
				pending = null;
				const o = await observe(ctx, myGen);
				if (!o) return;
				const ageSec = (Date.now() - eventMs) / 1000;
				const next = decideAtCheck({ kind, ageSec, armed: o.armed, eff: o.eff, p: o.p });
				await apply(next, kind, ctx, myGen, eventMs, turnSec);
			}, decision.seconds * 1000);
			pending = { kind, eventMs, timer, ctx };
			return;
		}
		if (decision.action === "drop") {
			lastDecision = `${clock()} ${kind} → dropped (${decision.reason})`;
			if (decision.reason === "stale" && kind !== "needs_input") consumeArm(ctx);
			refreshStatus(ctx);
			return;
		}
		const msg = buildMessage(kind, {
			project: path.basename(ctx.cwd),
			sessionName: await pi.getSessionName(),
			turnSec,
		});
		const result = await sendPush(msg);
		if (result.ok) {
			lastDecision = `${clock()} ${kind} → sent (${decision.reason})`;
			if (readState().last_error) setError(null);
		} else {
			lastDecision = `${clock()} ${kind} → send failed: ${result.error}`;
			setError(`${new Date().toISOString()} ${result.error}`);
			log(`send: ${result.error}`);
		}
		if (kind !== "needs_input") consumeArm(ctx);
		refreshStatus(ctx);
	}

	async function raise(kind, ctx, turnSec = 0) {
		cancel("superseded");
		const myGen = gen;
		const eventMs = Date.now();
		const o = await observe(ctx, myGen);
		if (!o) return;
		const decision = decideAtEvent({ kind, turnSec, armed: o.armed, eff: o.eff, p: o.p });
		await apply(decision, kind, ctx, myGen, eventMs, turnSec);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		refreshStatus(ctx);
		if (!statusTimer) statusTimer = ctx.setInterval(() => refreshStatus(ctx), STATUS_REFRESH_MS);
	});

	pi.on("session_switch", (_event, ctx) => {
		if (!isMain(ctx)) return;
		cancel("session switched");
		inTurn = false;
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancel("shutdown");
		inTurn = false;
		statusTimer = null;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		if (!inTurn) {
			inTurn = true;
			turnStartMs = Date.now();
		}
		cancel("resumed");
	});

	pi.on("auto_retry_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		cancel("retrying");
	});

	pi.on("tool_approval_requested", async (_event, ctx) => {
		if (!isMain(ctx)) return;
		await raise("needs_input", ctx);
	});

	pi.on("tool_approval_resolved", (_event, ctx) => {
		if (!isMain(ctx)) return;
		if (pending?.kind === "needs_input") cancel("answered");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isMain(ctx) || event?.toolName !== "ask") return;
		await raise("needs_input", ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isMain(ctx) || event?.toolName !== "ask") return;
		if (pending?.kind === "needs_input") cancel("answered");
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isMain(ctx)) return;
		if (event?.willContinue === true || event?.isTerminal === false || !inTurn) return;
		inTurn = false;
		const turnSec = (Date.now() - turnStartMs) / 1000;
		const last = [...(event?.messages ?? [])].reverse().find((m) => m?.role === "assistant");
		if (last?.stopReason === "aborted") {
			cancel("aborted by user");
			return;
		}
		await raise(last?.stopReason === "error" ? "error" : "done", ctx, turnSec);
	});

	pi.registerCommand("push", {
		description: "Phone push notifications: status|auto|always|off|away [dur]|snooze [dur]|arm|disarm|test",
		handler: async (args, ctx) => {
			const [sub = "status", arg] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const notify = (text) => ctx.ui.notify(text, "info");
			let dur = null;
			if (arg !== undefined) {
				const m = /^(\d+)(m|h)$/.exec(arg);
				if (!m || !["away", "snooze"].includes(sub)) return notify(`Error: ${USAGE}`);
				dur = Number(m[1]) * (m[2] === "h" ? 3600 : 60);
			}
			const keys = armKeys(ctx);
			switch (sub) {
				case "status": {
					const s = readState();
					const now = nowSec();
					const eff = effectiveMode(s, now);
					const until = eff === "away" ? s.away_until : eff === "snooze" ? s.snooze_until : null;
					notify(
						[
							`Phone push: ${eff}${until ? ` (${formatRemaining(until - now)} left, then ${s.mode})` : ""}`,
							`This session armed: ${s.armed.some((k) => keys.includes(k)) ? "yes" : "no"}`,
							`Credentials: ${(await readCredentials()) ? "present" : MISSING_CREDENTIALS}`,
							`Last error: ${s.last_error ?? "none"}`,
							`Last decision: ${lastDecision}`,
						].join("\n"),
					);
					break;
				}
				case "auto":
				case "always":
				case "off":
					updateState((s) => {
						s.mode = sub;
						s.away_until = null;
						s.snooze_until = null;
					});
					notify(`Phone push: ${sub}`);
					break;
				case "away":
				case "snooze": {
					const until = nowSec() + (dur ?? (sub === "away" ? DEFAULT_AWAY_SEC : DEFAULT_SNOOZE_SEC));
					updateState((s) => {
						s.away_until = sub === "away" ? until : null;
						s.snooze_until = sub === "snooze" ? until : null;
					});
					notify(`Phone push: ${sub} for ${formatRemaining(until - nowSec())}`);
					break;
				}
				case "arm":
					updateState((s) => {
						if (!s.armed.includes(keys[0])) s.armed.push(keys[0]);
					});
					notify("Phone push: armed; this session's next turn end will send");
					break;
				case "disarm":
					updateState((s) => {
						s.armed = s.armed.filter((k) => !keys.includes(k));
					});
					notify("Phone push: disarmed");
					break;
				case "test": {
					const result = await sendPush({ title: "omp · test", message: "Test notification from omp-pushover", priority: 0 });
					if (result.ok) {
						if (readState().last_error) setError(null);
						notify("Test sent");
					} else {
						setError(`${new Date().toISOString()} ${result.error}`);
						notify(`Error: ${result.error}`);
					}
					break;
				}
				default:
					notify(`Error: ${USAGE}`);
			}
			refreshStatus(ctx);
		},
	});
}
