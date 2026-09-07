/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';
import { BIORENDER_MCP_URL } from '../biorender/bioRenderAuth';

const execAsync = promisify(exec);

/**
 * Register the built-in BioRender MCP (a REMOTE OAuth server) with the AI CLIs,
 * injecting the signed-in user's token as an `Authorization: Bearer` header.
 * Because Qoka supplies the header, the CLI does not run its OWN `/mcp` OAuth -
 * the whole login stays in Qoka's Settings button. Called after login and, for
 * a returning user, at activation once a token is available.
 *
 * Claude Code supports `--transport http --header "Authorization: Bearer ..."`.
 * Codex header support varies by version, so it is best-effort and never fails
 * the operation (Claude still works).
 */

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
	return cwd ? { scope: 'local', opts: { timeout: 10000, cwd } } : { scope: 'user', opts: { timeout: 10000 } };
}

/** (Re)register the built-in BioRender MCP with every AI CLI that is present.
 *  With a `token` it injects an `Authorization: Bearer` header so the chat uses
 *  the signed-in account and the CLI does NOT run its own OAuth. WITHOUT a token
 *  (not connected in Settings yet) it still registers the server so it is
 *  present from the start - Claude Code then offers its own `/mcp` login as a
 *  fallback until the user connects in Settings. Codex has no such fallback, so
 *  it is only registered once a token exists. Removes any prior entry first. */
export async function registerBioRenderWithProviders(token?: string): Promise<void> {
	await registerClaude(token);
	if (token) { await registerCodex(token); }
}

/** Remove the BioRender registration from every AI CLI (on logout). */
export async function unregisterBioRenderFromProviders(): Promise<void> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude) {
		const q = quoteArg(claude);
		for (const scope of ['user', 'project', 'local']) {
			try { await execAsync(`${q} mcp remove ${NAME} --scope ${scope}`, { timeout: 10000 }); } catch { /* best-effort */ }
		}
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* best-effort */ }
	}
}

async function registerClaude(token?: string): Promise<void> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { return; }
	const q = quoteArg(claude);
	const { scope, opts } = claudeScopeOpts();
	// Remove any prior entry (across scopes) so the refreshed header lands clean.
	for (const s of ['user', 'project', 'local']) {
		try { await execAsync(`${q} mcp remove ${NAME} --scope ${s}`, opts); } catch { /* expected when absent */ }
	}
	const headerArg = token ? ` --header ${quoteArg(`Authorization: Bearer ${token}`)}` : '';
	const addCmd = `${q} mcp add --scope ${scope} ${NAME} ${quoteArg(BIORENDER_MCP_URL)} --transport http${headerArg}`;
	try {
		await execAsync(addCmd, opts);
		console.log(`[aria-autopipe] registered BioRender MCP with Claude Code (${token ? 'with account token' : 'no token - Claude OAuth fallback'})`);
	} catch (err) {
		console.error('[aria-autopipe] claude mcp add biorender failed:', (err as { stderr?: string }).stderr ?? String(err));
	}
}

async function registerCodex(token: string): Promise<void> {
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (!codex) { return; }
	const q = quoteArg(codex);
	try { await execAsync(`${q} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* expected when absent */ }
	// Codex header/bearer support varies by version. Try the documented bearer
	// flag; if this Codex build does not accept it, skip (do NOT register a
	// header-less entry, which would 401 and trigger Codex's own OAuth prompt).
	const header = `Authorization: Bearer ${token}`;
	const attempts = [
		`${q} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)} --header ${quoteArg(header)}`,
		`${q} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)} --bearer-token ${quoteArg(token)}`,
	];
	for (const cmd of attempts) {
		try {
			await execAsync(cmd, { timeout: 10000 });
			console.log('[aria-autopipe] registered BioRender MCP with Codex');
			return;
		} catch { /* try next form */ }
	}
	console.warn('[aria-autopipe] Codex build does not accept a bearer header for remote MCP; BioRender left to Claude Code only.');
}
