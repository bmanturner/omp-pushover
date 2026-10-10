// @ts-nocheck
// Sends through Pushover with credentials from the login Keychain
// (service omp-pushover, accounts app-token and user-key).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Kind } from "./policy.ts";

const run = promisify(execFile);
const API = "https://api.pushover.net/1/messages.json";
const RETRY_DELAYS_MS = [5000, 30000];
export const MISSING_CREDENTIALS =
	"Pushover credentials not in Keychain (service omp-pushover, accounts app-token and user-key)";

let cached = null;

async function keychain(account: string): Promise<string> {
	const { stdout } = await run(
		"/usr/bin/security",
		["find-generic-password", "-s", "omp-pushover", "-a", account, "-w"],
		{ timeout: 5000 },
	);
	return stdout.trim();
}

export async function readCredentials(): Promise<{ token: string; user: string } | null> {
	if (cached) return cached;
	try {
		const [token, user] = await Promise.all([keychain("app-token"), keychain("user-key")]);
		if (!token || !user) return null;
		cached = { token, user };
		return cached;
	} catch {
		return null;
	}
}

type Attempt = { ok: true } | { ok: false; error: string; retry: boolean };

function interpret(status: number, body: string): Attempt {
	if (status === 200) return { ok: true };
	let detail = body.slice(0, 200);
	try {
		const errors = JSON.parse(body).errors;
		if (Array.isArray(errors)) detail = errors.join("; ");
	} catch {}
	return { ok: false, error: `HTTP ${status}: ${detail}`, retry: status === 429 || status >= 500 };
}

async function postFetch(fields: Record<string, string>): Promise<Attempt> {
	try {
		const res = await fetch(API, {
			method: "POST",
			body: new URLSearchParams(fields),
			signal: AbortSignal.timeout(10000),
		});
		return interpret(res.status, await res.text());
	} catch (err) {
		return { ok: false, error: `network: ${err?.message ?? err}`, retry: true };
	}
}

/** curl reads its options from stdin, so the secrets never appear on argv. */
function postCurl(fields: Record<string, string>): Promise<Attempt> {
	const quote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	const config = [`url = ${quote(API)}`, ...Object.entries(fields).map(([k, v]) => `form-string = ${quote(`${k}=${v}`)}`)];
	const { promise, resolve } = Promise.withResolvers<Attempt>();
	const child = spawn("/usr/bin/curl", ["-sS", "-m", "10", "-w", "\n%{http_code}", "-K", "-"]);
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.on("error", (err) => resolve({ ok: false, error: `curl: ${err.message}`, retry: false }));
	child.on("close", (code) => {
		if (code !== 0) return resolve({ ok: false, error: `curl exit ${code}`, retry: true });
		const nl = out.lastIndexOf("\n");
		resolve(interpret(Number(out.slice(nl + 1)), out.slice(0, nl)));
	});
	child.stdin.end(`${config.join("\n")}\n`);
	return promise;
}

export async function sendPush(msg: { title: string; message: string; priority: number }): Promise<{ ok: true } | { ok: false; error: string }> {
	const creds = await readCredentials();
	if (!creds) return { ok: false, error: MISSING_CREDENTIALS };
	const fields = {
		token: creds.token,
		user: creds.user,
		title: msg.title.slice(0, 250),
		message: msg.message.slice(0, 1024),
		priority: String(msg.priority),
	};
	const post = typeof fetch === "function" ? postFetch : postCurl;
	let attempt = await post(fields);
	for (const delay of RETRY_DELAYS_MS) {
		if (attempt.ok || !attempt.retry) break;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, delay);
		await promise;
		attempt = await post(fields);
	}
	return attempt.ok ? { ok: true } : { ok: false, error: attempt.error };
}

/** "45s", "12m", "1h 05m". */
export function formatDuration(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function buildMessage(
	kind: Kind,
	i: { project: string; sessionName: string | undefined; turnSec: number },
): { title: string; message: string; priority: number } {
	const name = (i.sessionName || "untitled session").slice(0, 200);
	const title = `omp · ${i.project}`;
	if (kind === "needs_input") return { title, message: `Needs your input: ${name}`, priority: 1 };
	if (kind === "error") return { title, message: `Stopped with an error: ${name}`, priority: 0 };
	return { title, message: `Finished: ${name} (${formatDuration(i.turnSec)})`, priority: 0 };
}
