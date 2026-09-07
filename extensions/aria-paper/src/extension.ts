/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTools } from './mcp/tools';
import { buildReviewTools, exportReviewPaper, ReviewExportFormat } from './reviews';
import { AriaPaperMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { ExportFormat, exportPaper, getPandoc, setCacheDir, setResourceRoot } from './exporter';
import { addAsset, addCitationCleanKey, generatedFiguresDir, PaperAsset, removeAsset, setAssetSummary, syncManuscriptTitle } from './papers';
import { PAPER_MCP_INSTRUCTIONS } from './guide';

const execFileAsync = promisify(execFile);

/**
 * True when the given reviewer CLI (`claude` or `codex`) is on this machine. The
 * Manuscript tab gates each reviewer on THIS (not the VS Code extension): the
 * review skill runs `claude --print` / `codex exec` via the shell, so the CLI is
 * the real requirement - installing the extension does not install the CLI. We
 * probe the same locations the skill's resolver checks (abs install dirs, PATH,
 * nvm) so the UI gate and the actual run agree even when the app's PATH is thin.
 */
function cliAvailable(name: 'claude' | 'codex'): boolean {
	const home = os.homedir();
	const isWin = process.platform === 'win32';
	// On Windows the CLIs are `.cmd`/`.exe` shims, never a bare extension-less
	// file, and they land under the npm prefix root (~/.qoka/npm or %APPDATA%/npm)
	// or Claude's ~/.local/bin - none on the GUI process PATH. Probe all of these
	// with the right extensions so the reviewer gate matches reality on Windows.
	const names = isWin ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
	const dirs = isWin
		? [
			path.join(home, '.qoka', 'npm'),
			path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
			path.join(home, '.qoka', 'node'),
			path.join(home, '.local', 'bin'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude'), // Claude's Windows alt location, matching aria-skills so an installed CLI is always found (no installed-but-not-found)
		]
		: [
			'/usr/local/bin',
			'/opt/homebrew/bin',
			path.join(home, '.local/bin'),
			...(name === 'claude' ? [path.join(home, '.claude/local')] : []),
		];
	for (const dir of dirs) {
		for (const n of names) {
			try { if (fs.existsSync(path.join(dir, n))) { return true; } } catch { /* ignore */ }
		}
	}
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (!dir) { continue; }
		for (const n of names) {
			try { if (fs.existsSync(path.join(dir, n))) { return true; } } catch { /* ignore */ }
		}
	}
	try {
		const nvm = path.join(home, '.nvm/versions/node');
		for (const v of fs.readdirSync(nvm)) {
			if (fs.existsSync(path.join(nvm, v, 'bin', name))) { return true; }
		}
	} catch { /* no nvm */ }
	return false;
}

/** Static, instant samples of how citations look per style (for the wizard's
 *  Format-step preview - no pandoc download needed). */
const CITATION_PREVIEWS: Record<string, string> = {
	ieee: 'In-text:\n… as reported previously [1].\n\nBibliography:\n[1] J. Kim and S. Lee, “Tau aggregation drives neuronal loss,” Nature Neuroscience, vol. 27, pp. 100–110, 2024.',
	apa: 'In-text:\n… as reported previously (Kim & Lee, 2024).\n\nBibliography:\nKim, J., & Lee, S. (2024). Tau aggregation drives neuronal loss. Nature Neuroscience, 27, 100–110.',
	nature: 'In-text:\n… as reported previously¹.\n\nBibliography:\n1. Kim, J. & Lee, S. Tau aggregation drives neuronal loss. Nature Neuroscience 27, 100–110 (2024).',
	chicago: 'In-text:\n… as reported previously (Kim and Lee 2024).\n\nBibliography:\nKim, Jiyoung, and Soo Lee. 2024. “Tau aggregation drives neuronal loss.” Nature Neuroscience 27: 100–110.',
};

/** Family classification for styles without a hand-written sample above, so the
 *  preview is representative (numeric/superscript/author-date/MLA). */
const STYLE_FAMILY: Record<string, 'numbracket' | 'superscript' | 'authordate' | 'mla'> = {
	ieee: 'numbracket', vancouver: 'numbracket', ama: 'numbracket', nejm: 'numbracket', lancet: 'numbracket', bmj: 'numbracket', plos: 'numbracket', pnas: 'numbracket', nar: 'numbracket',
	nature: 'superscript', science: 'superscript',
	apa: 'authordate', harvard: 'authordate', chicago: 'authordate', bioinformatics: 'authordate', cell: 'authordate',
	mla: 'mla',
};

const FAMILY_SAMPLE: Record<string, string> = {
	numbracket: 'In-text:\n… as reported previously [1].\n\nBibliography:\n[1] J. Kim and S. Lee, “Tau aggregation drives neuronal loss,” Nature Neuroscience, vol. 27, pp. 100–110, 2024.',
	superscript: 'In-text:\n… as reported previously¹.\n\nBibliography:\n1. Kim, J. & Lee, S. Tau aggregation drives neuronal loss. Nature Neuroscience 27, 100–110 (2024).',
	authordate: 'In-text:\n… as reported previously (Kim and Lee, 2024).\n\nBibliography:\nKim, J., and S. Lee. 2024. “Tau aggregation drives neuronal loss.” Nature Neuroscience 27: 100–110.',
	mla: 'In-text:\n… as reported previously (Kim and Lee 102).\n\nBibliography:\nKim, Jiyoung, and Soo Lee. “Tau Aggregation Drives Neuronal Loss.” Nature Neuroscience, vol. 27, 2024, pp. 100–110.',
};

let mcpServer: AriaPaperMcpServer | undefined;

/**
 * Register the paper MCP with every AI provider whose CLI is available
 * (Claude Code, Codex). The server serves /sse (Claude) and /mcp
 * (Codex) on the same port; missing CLIs are silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean; summary: string }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	const registered: string[] = [];
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-paper] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-paper] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Paper MCP registered with ${registered.join(', ')}`
		: 'Paper MCP - no AI provider CLI found yet';
	return { changed, registered: registered.length > 0, summary };
}

/**
 * Qoka Paper Writer - boots a local MCP server so an AI assistant can draft,
 * cite, and export scientific manuscripts. Reads/structure/export are
 * deterministic; the prose is written by the agent following get_writing_guide.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-paper] activate()');

	// Lets the exporter find bundled CSL styles and (later) a bundled pandoc,
	// and a writable cache dir for an auto-downloaded pandoc.
	setResourceRoot(context.extensionPath);
	setCacheDir(context.globalStorageUri.fsPath);

	// Lets the workbench Paper Writer pane's Export buttons run pandoc (which
	// lives in the extension host). Returns a human-readable result string.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.export', async (id: string, format: string) => {
		const res = await exportPaper(id, format as ExportFormat);
		return `Exported ${format} → ${res.outputPath} (style: ${res.style}).`;
	}));

	// Save the current AI Peer Review paper (working copy) to md/docx/latex
	// inside the review's own directory. Invoked by the Peer Review pane.
	context.subscriptions.push(vscode.commands.registerCommand('aria.peerReview.exportPaper', (execId: string, format: string, docKey?: string) =>
		exportReviewPaper(execId, format as ReviewExportFormat, docKey ?? 'main')));

	// Whether the Codex CLI is available - the Manuscript tab uses this to gate
	// its Codex reviewer checkbox (the reviewer runs `codex exec`).
	context.subscriptions.push(vscode.commands.registerCommand('aria.peerReview.codexAvailable', () => cliAvailable('codex')));
	context.subscriptions.push(vscode.commands.registerCommand('aria.peerReview.claudeAvailable', () => cliAvailable('claude')));

	// Instant citation-style preview for the wizard's Format step.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.previewCitation', (style: string) =>
		CITATION_PREVIEWS[style] ?? FAMILY_SAMPLE[STYLE_FAMILY[style]] ?? CITATION_PREVIEWS.ieee));

	// Import a .bib file → CSL-JSON (via pandoc) → add to the paper's citations.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.importBibtex', async (id: string) => {
		const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import BibTeX', filters: { BibTeX: ['bib'] } });
		if (!uris || uris.length === 0) { return 0; }
		const pandoc = await getPandoc();
		const { stdout } = await execFileAsync(pandoc, [uris[0].fsPath, '-t', 'csljson'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
		let items: Array<Record<string, unknown>> = [];
		try { items = JSON.parse(stdout); } catch { throw new Error('Could not parse the BibTeX file.'); }
		if (!Array.isArray(items)) { items = []; }
		// Regenerate clean `familyYear` citekeys - reference managers (e.g.
		// RefWorks) export opaque keys like `RefWorks:RefID:149-lu2026towards`.
		for (const item of items) { addCitationCleanKey(id, item); }
		return items.length;
	}));

	// Re-sync the manuscript's leading H1 with the paper title (called by the
	// wizard when the user edits the title, so manuscript.md stays in sync).
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.syncTitle', (id: string) => {
		syncManuscriptTitle(id);
	}));

	// Add figures (images) or supplementary sources: pick files, copy them into
	// the paper's figures/ or sources/ dir, and register them (summary pending).
	// Upload a figure/source from disk (a file dialog).
	const uploadAssets = async (id: string, kind: 'figure' | 'source'): Promise<PaperAsset[]> => {
		const filters: { [name: string]: string[] } = kind === 'figure'
			? { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tiff'] }
			: { Documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'ipynb'] };
		const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: kind === 'figure' ? 'Upload figure' : 'Add files', filters });
		if (!uris || uris.length === 0) { return []; }
		return uris.map(u => addAsset(id, kind, u.fsPath));
	};
	// Add a figure from the generated store (.qoka/figures) - the same figures the
	// Manuscript tab's Figures section shows (BioRender / AI figures land there).
	const addFiguresFromSaved = async (id: string): Promise<PaperAsset[]> => {
		const genDir = generatedFiguresDir();
		let gen: string[] = [];
		try {
			if (genDir && fs.existsSync(genDir)) {
				gen = fs.readdirSync(genDir).filter(n => /\.(png|jpe?g|gif|svg|webp|bmp|tiff)$/i.test(n)).sort();
			}
		} catch { /* none */ }
		if (gen.length === 0) {
			void vscode.window.showInformationMessage('No generated figures yet. Ask the chat to create one; it appears in the Manuscript tab\'s Figures section.');
			return [];
		}
		type Item = vscode.QuickPickItem & { fsPath: string };
		const items: Item[] = gen.map(n => ({ label: n, fsPath: path.join(genDir!, n) }));
		const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select figures to add from the Figures section' });
		if (!picked || picked.length === 0) { return []; }
		return picked.map(p => addAsset(id, 'figure', p.fsPath));
	};
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addFigures', (id: string) => uploadAssets(id, 'figure')));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addFiguresFromSaved', (id: string) => addFiguresFromSaved(id)));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addSources', (id: string) => uploadAssets(id, 'source')));
	// List the generated figures (.qoka/figures) so the writer can show an inline
	// checkbox picker; add the chosen ones by path.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.listGeneratedFigures', () => {
		const genDir = generatedFiguresDir();
		if (!genDir || !fs.existsSync(genDir)) { return [] as { name: string; path: string }[]; }
		try {
			return fs.readdirSync(genDir).filter(n => /\.(png|jpe?g|gif|svg|webp|bmp|tiff)$/i.test(n)).sort()
				.map(n => ({ name: n, path: path.join(genDir, n) }));
		} catch { return [] as { name: string; path: string }[]; }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addFiguresByPath', (id: string, paths: string[]) => {
		const added: PaperAsset[] = [];
		for (const p of (paths ?? [])) { try { added.push(addAsset(id, 'figure', p)); } catch { /* skip bad path */ } }
		return added;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.removeAsset', (id: string, assetId: string) => {
		removeAsset(id, assetId);
	}));
	// Save a user-edited figure/source summary from the wizard.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.setAssetSummary', (id: string, assetId: string, summary: string) => {
		setAssetSummary(id, assetId, summary);
	}));

	const tools = buildTools().concat(buildReviewTools());
	mcpServer = new AriaPaperMcpServer(tools, PAPER_MCP_INSTRUCTIONS);

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-paper-mcp');
		let summary = 'Paper MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-paper] MCP up on ${port}`);
			summary = `Paper MCP up on ${port}`;
		} catch (e) {
			summary = `Paper MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-paper-mcp', summary, changed);
		}
	})();

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Qoka MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by the IIFE) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	// Reports this MCP server's { name, port } so the startup coordinator can
	// batch-register every Qoka MCP in one direct config write (see aria.mcp.applyConfig).
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-paper', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		const { changed, registered } = await registerAllProviders(port);
		return { changed, registered };
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-paper] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
