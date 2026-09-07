/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
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

/** Run the CLI's own OAuth for BioRender (opens the browser, stores the token in
 *  the CLI). This is what makes the chat actually authenticated - no `/mcp`
 *  needed. Claude is required; Codex is best-effort (its build may lack login). */
export async function loginBioRender(): Promise<{ ok: boolean; message: string }> {
	await ensureBioRenderRegistered();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { return { ok: false, message: 'Claude CLI not found on PATH or known install locations.' }; }
	const q = quoteArg(claude);
	const { opts } = claudeScopeOpts();
	try {
		// Opens the browser and waits for the OAuth redirect; give it a long budget.
		await execAsync(`${q} mcp login ${NAME}`, { ...opts, timeout: 300000 });
	} catch (err) {
		return { ok: false, message: `BioRender login failed: ${(err as { stderr?: string }).stderr ?? (err as Error).message}` };
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) { try { await execAsync(`${quoteArg(codex)} mcp login ${NAME}`, { timeout: 300000 }); } catch { /* codex may not support mcp login */ } }
	return { ok: true, message: 'Connected to BioRender.' };
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
