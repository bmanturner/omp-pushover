// @ts-nocheck
// Whether the user is at the Mac. Every probe is a stock macOS tool that needs
// no privacy permission. A failed idle probe reads as "present", so a broken
// probe never causes a push.
import { execFile } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";
import type { Presence } from "./policy.ts";

const run = promisify(execFile);
const OPTS = { timeout: 2000, maxBuffer: 8 * 1024 * 1024 };
const TERN_APP = "/Applications/Tern.app/Contents/MacOS/tern";

async function idleSec(): Promise<number> {
	const { stdout } = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], OPTS);
	const m = /"HIDIdleTime" = (\d+)/.exec(stdout);
	if (!m) throw new Error("no HIDIdleTime");
	return Math.floor(Number(m[1]) / 1e9);
}

async function locked(): Promise<boolean> {
	const { stdout } = await run("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], OPTS);
	return (
		/<key>IOConsoleLocked<\/key>\s*<true\/>/.test(stdout) ||
		/<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(stdout)
	);
}

async function screensaver(): Promise<boolean> {
	try {
		await run("/usr/bin/pgrep", ["-x", "ScreenSaverEngine"], OPTS);
		return true;
	} catch (err) {
		if (err?.code === 1) return false;
		throw err;
	}
}

async function otherUser(): Promise<boolean> {
	const { stdout } = await run("/usr/bin/stat", ["-f%Su", "/dev/console"], OPTS);
	return stdout.trim() !== os.userInfo().username;
}

/** True when the pane is the focused block of the shown tab of a shown Tern session. */
async function paneVisible(ternPane: string): Promise<boolean> {
	let out;
	try {
		out = await run("tern", ["ls", "--json"], OPTS);
	} catch (err) {
		if (err?.code !== "ENOENT") throw err;
		out = await run(TERN_APP, ["ls", "--json"], OPTS);
	}
	const data = JSON.parse(out.stdout);
	for (const session of data.sessions ?? []) {
		if (session.shown !== true) continue;
		for (const tab of session.tabs ?? []) {
			if (tab.shown !== true) continue;
			for (const block of tab.blocks ?? []) {
				if (String(block.id) === ternPane && block.focused === true) return true;
			}
		}
	}
	return false;
}

export async function samplePresence(ternPane: string | undefined): Promise<{ p: Presence; errors: string[] }> {
	const errors = [];
	const probe = async (name, fn, fallback) => {
		try {
			return await fn();
		} catch (err) {
			errors.push(`${name}: ${err?.message ?? err}`);
			return fallback;
		}
	};
	const [idle, isLocked, saver, other, visible] = await Promise.all([
		probe("idle", idleSec, 0),
		probe("lock", locked, false),
		probe("screensaver", screensaver, false),
		probe("console user", otherUser, false),
		ternPane ? probe("tern pane", () => paneVisible(ternPane), false) : false,
	]);
	return {
		p: { locked: isLocked, screensaver: saver, otherUser: other, idleSec: idle, paneVisible: visible },
		errors,
	};
}
