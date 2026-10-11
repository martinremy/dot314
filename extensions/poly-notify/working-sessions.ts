/**
 * Tracks which Pi sessions on this machine are in the middle of an agent run.
 *
 * Each working session listens on a Unix socket in a per-user folder. A socket that accepts a
 * connection belongs to a live, working session. One that refuses was left behind by a process
 * that exited without cleaning up (crash, kill, reboot), and whoever finds it deletes it.
 * The folder therefore only ever holds the sockets of sessions that are working right now.
 *
 * Socket names are `<pid>-<groupStart>.sock`, where groupStart (base-36 epoch ms) is when the
 * current stretch of overlapping runs began: a session that starts while others are working
 * inherits their earliest groupStart, so the last session to finish knows how long the whole
 * group has been busy.
 */

import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// Short names keep socket paths under macOS's 104-byte limit inside the long per-user $TMPDIR.
// Longer paths are silently truncated when bound, so they are rejected instead.
const MAX_SOCKET_PATH_BYTES = 103;
const SOCKET_DIR = join(tmpdir(), `poly-notify-${userInfo().uid}`);
const SOCKET_SUFFIX = ".sock";
const PENDING_SUFFIX = ".tmp";
const SOCKET_NAME = /^(\d+)-([0-9a-z]+)\.sock$/;
const GROUP_START_RADIX = 36;

export interface WorkingSession {
	/** Epoch ms when the current group of overlapping runs began. */
	readonly groupStartMs: number;
	/** Stop being visible to other sessions. Idempotent. */
	leave(): Promise<void>;
}

/** Group starts of the other sessions that are working right now. Deletes sockets of dead sessions. */
async function liveGroupStarts(): Promise<number[]> {
	let names: string[];
	try {
		names = readdirSync(SOCKET_DIR);
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
		throw err;
	}

	const checks = names.flatMap((name) => {
		const match = SOCKET_NAME.exec(name);
		if (!match) return [];
		const path = join(SOCKET_DIR, name);
		const groupStartMs = parseInt(match[2], GROUP_START_RADIX);
		return [isLive(path).then((live) => (live ? [groupStartMs] : []))];
	});
	return (await Promise.all(checks)).flat();
}

function isLive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (err: NodeJS.ErrnoException) => {
			// Refused means nothing is listening: the owner exited without removing its socket.
			if (err.code === "ECONNREFUSED") rmSync(path, { force: true });
			resolve(false);
		});
	});
}

/** True if any other Pi session on this machine is in the middle of an agent run. */
export async function hasWorkingSessions(): Promise<boolean> {
	return (await liveGroupStarts()).length > 0;
}

/** Become visible to other sessions as working, until `leave()` is called or the process exits. */
export async function joinWorkingSessions(startMs: number): Promise<WorkingSession> {
	mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
	const groupStartMs = Math.min(startMs, ...(await liveGroupStarts()));

	const path = join(SOCKET_DIR, `${process.pid}-${groupStartMs.toString(GROUP_START_RADIX)}${SOCKET_SUFFIX}`);
	const pendingPath = path + PENDING_SUFFIX;
	if (Buffer.byteLength(pendingPath) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(`poly-notify: socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes (set a shorter TMPDIR): ${pendingPath}`);
	}
	const server = createServer((connection) => connection.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(pendingPath, resolve);
	});
	// Listen under a name the scan ignores, then rename: a peer can never see the socket
	// between bind and listen, when it would refuse and look dead.
	renameSync(pendingPath, path);

	let left = false;
	return {
		groupStartMs,
		async leave() {
			if (left) return;
			left = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(path, { force: true });
		},
	};
}
