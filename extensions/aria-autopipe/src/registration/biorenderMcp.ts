/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec, spawn } from 'child_process';
import * as http from 'http';
import { URL } from 'url';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

/**
 * Built-in BioRender MCP (a REMOTE OAuth server at mcp.services.biorender.com).
 *
 * BioRender advertises OAuth, and the AI CLIs run their OWN OAuth for such a
 * server - a statically injected `Authorization` header is ignored, so the
 * earlier "Qoka owns the token" approach did NOT authenticate Claude. Instead we
 * register the server (built-in, headerless) and drive the CLI's own OAuth from
 * Settings via `claude mcp login` / `logout` (the CLI opens the browser and
 * stores the token itself - the same thing the chat's `/mcp` Authenticate does).
 */

export const BIORENDER_MCP_URL = 'https://mcp.services.biorender.com/mcp';
const NAME = 'biorender';

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) { return s; }
	return `"${s.replace(/"/g, '\\"')}"`;
}

async function resolveBinary(primary: string, candidates: string[]): Promise<string | null> {
	try { await execAsync(`${primary} --version`, { timeout: 5000 }); return primary; } catch { /* fall through */ }
	for (const c of candidates) {
		try { await execAsync(`"${c}" --version`, { timeout: 5000 }); return c; } catch { /* next */ }
	}
	return null;
}

function claudeScopeOpts(): { scope: 'local' | 'user'; opts: { timeout: number; cwd?: string } } {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return cwd ? { scope: 'local', opts: { timeout: 15000, cwd } } : { scope: 'user', opts: { timeout: 15000 } };
}

/** Ensure the built-in BioRender remote MCP is registered (headerless) with each
 *  present AI CLI, so it is there from the start and can be authenticated via the
 *  CLI's own OAuth. Idempotent: skips a CLI that already has it. */
export async function ensureBioRenderRegistered(): Promise<void> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude) {
		const q = quoteArg(claude);
		const { scope, opts } = claudeScopeOpts();
		let exists = false;
		try { await execAsync(`${q} mcp get ${NAME}`, opts); exists = true; } catch { /* not registered */ }
		if (!exists) {
			try {
				await execAsync(`${q} mcp add --scope ${scope} ${NAME} ${quoteArg(BIORENDER_MCP_URL)} --transport http`, opts);
				console.log('[aria-autopipe] registered built-in BioRender MCP with Claude Code');
			} catch (err) {
				console.error('[aria-autopipe] claude mcp add biorender failed:', (err as { stderr?: string }).stderr ?? String(err));
			}
		}
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		const q = quoteArg(codex);
		let exists = false;
		try { await execAsync(`${q} mcp get ${NAME}`, { timeout: 10000 }); exists = true; } catch { /* not registered */ }
		if (!exists) {
			try { await execAsync(`${q} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)}`, { timeout: 10000 }); } catch { /* best-effort */ }
		}
	}
}

/**
 * Run the CLI's own OAuth for BioRender. On Linux/macOS this happens WITHOUT
 * showing a terminal (Easy mode's goal is that users never touch one); on Windows,
 * where no headless PTY is available, it falls back to an integrated terminal (see
 * the win32 branch below). `claude mcp login` needs a TTY (a headless child fails
 * with "stdin isn't a terminal"), so we allocate a hidden pseudo-terminal with
 * `script` and drive the flow ourselves:
 *
 *  - Case A (loopback): the CLI opens the browser and catches the OAuth redirect
 *    on its own localhost listener. The PTY just satisfies its TTY check; the
 *    user only signs in.
 *  - Case B (paste redirect URL): the CLI prints an authorize URL and waits for
 *    the redirect URL to be pasted. We parse the redirect port from that URL,
 *    stand up a loopback listener there, capture the browser callback, and type
 *    the full URL back into the CLI's stdin - so the user still only signs in.
 *
 * We also open the authorize URL via `openExternal` (the sandboxed extension host
 * may not open it itself). Resolves once the CLI exits and status confirms the
 * connection, and shows a "start a new chat session" notice so the running
 * session (which connected its MCPs at spawn) picks up the now-authenticated MCP.
 */
export async function loginBioRender(): Promise<{ ok: boolean; message: string }> {
	await ensureBioRenderRegistered();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { return { ok: false, message: 'Claude CLI not found on PATH or known install locations.' }; }
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const inner = `${quoteArg(claude)} mcp login ${NAME}`;

	// Windows has no `script`, and a headless child has no TTY (ConPTY is not
	// exposed to the extension host), so the invisible-PTY trick below cannot work.
	// Fall back to a real integrated terminal, which owns a ConPTY: the CLI gets its
	// TTY, opens the browser, and the user signs in. The Settings section polls the
	// status and turns green once the login completes.
	if (process.platform === 'win32') {
		const term = vscode.window.createTerminal({ name: 'BioRender login', cwd });
		term.show(true);
		term.sendText(inner);
		return { ok: true, message: 'Complete the BioRender sign-in in the terminal that just opened (a browser opens for sign-in). This updates once connected.' };
	}

	// `script` allocates the PTY. Its flags differ by platform: util-linux uses
	// `-qfc "<cmd>" <file>`, BSD/macOS uses `-q <file> <cmd> <args...>`.
	const isMac = process.platform === 'darwin';
	const args = isMac
		? ['-q', '/dev/null', claude, 'mcp', 'login', NAME]
		: ['-qfc', inner, '/dev/null'];

	const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
		let settled = false;
		let interceptor: http.Server | undefined;
		let browserOpened = false;
		let buf = '';

		const child = spawn('script', args, { cwd, env: process.env });

		const finish = (r: { ok: boolean; message: string }) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			try { interceptor?.close(); } catch { /* noop */ }
			try { child.kill(); } catch { /* noop */ }
			resolve(r);
		};

		const startInterceptor = (authUrl: string) => {
			// Case B: learn the loopback port the CLI expects from redirect_uri.
			let port = 0; let host = '127.0.0.1';
			try {
				const rd = new URL(authUrl).searchParams.get('redirect_uri');
				if (rd) {
					const r = new URL(rd);
					if (/^(127\.0\.0\.1|localhost)$/.test(r.hostname)) { port = Number(r.port) || 0; host = r.hostname; }
				}
			} catch { /* not a loopback redirect */ }
			if (!port) { return; }
			const srv = http.createServer((req, res) => {
				const full = `http://${host}:${port}${req.url ?? '/'}`;
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end('<html><body style="font-family:sans-serif;padding:2rem">BioRender connected. You can close this tab and return to Qoka.</body></html>');
				try { child.stdin?.write(full + '\n'); } catch { /* noop */ }
			});
			// If the CLI is already listening here (Case A), binding fails - that's fine.
			srv.on('error', () => { /* Case A: the CLI owns this port */ });
			srv.listen(port, '127.0.0.1', () => { interceptor = srv; });
		};

		const onOutput = (data: Buffer) => {
			buf += data.toString('utf8');
			if (browserOpened) { return; }
			const m = buf.match(/https?:\/\/[^\s'"]+/);
			if (m && /(authorize|oauth|auth|login|biorender)/i.test(m[0])) {
				browserOpened = true;
				const authUrl = m[0];
				// The CLI opens the browser itself; we do NOT also call openExternal - that
				// double-opened the page and popped VS Code's "open external website?"
				// prompt AFTER the sign-in had already completed. We only stand up the
				// loopback interceptor for the "paste redirect URL" flow (Case B).
				startInterceptor(authUrl);
			}
		};

		child.stdout?.on('data', onOutput);
		child.stderr?.on('data', onOutput);
		child.on('error', () => finish({ ok: false, message: 'Could not start the login helper (script/claude not found).' }));
		child.on('exit', async () => {
			const st = await bioRenderStatus();
			finish(st.connected
				? { ok: true, message: 'Connected to BioRender.' }
				: { ok: false, message: 'BioRender login did not complete. Click Connect to try again.' });
		});

		const timer = setTimeout(async () => {
			const st = await bioRenderStatus();
			finish(st.connected
				? { ok: true, message: 'Connected to BioRender.' }
				: { ok: false, message: 'BioRender login timed out. Click Connect to try again.' });
		}, 300000);
	});

	if (result.ok) {
		void vscode.window.showInformationMessage(
			'BioRender is connected. Start a new chat session so the assistant can use BioRender.',
		);
	}
	return result;
}

/** Clear the CLI's stored BioRender OAuth credentials. */
export async function logoutBioRender(): Promise<void> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude) {
		const { opts } = claudeScopeOpts();
		try { await execAsync(`${quoteArg(claude)} mcp logout ${NAME}`, opts); } catch { /* best-effort */ }
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) { try { await execAsync(`${quoteArg(codex)} mcp logout ${NAME}`, { timeout: 10000 }); } catch { /* best-effort */ } }
}

/** Connected when Claude Code has BioRender registered and NOT flagged as needing
 *  authentication (`claude mcp get biorender`). */
export async function bioRenderStatus(): Promise<{ connected: boolean }> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { return { connected: false }; }
	const q = quoteArg(claude);
	const { opts } = claudeScopeOpts();
	try {
		const out = await execAsync(`${q} mcp get ${NAME}`, opts);
		const s = out.stdout;
		return { connected: /biorender/i.test(s) && !/needs authentication/i.test(s) && !/not found/i.test(s) };
	} catch {
		return { connected: false };
	}
}
