/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { services } from '../common/services';
import { InstalledPlugin, DataSourceCommands } from '../plugins/pluginService';
import { windowsToWsl } from '../common/dockerEnv';
import { wslAvailable } from '../vm/wsl';
import { builtinExec } from '../runtime/builtinServer';

/**
 * The Autopipe Viewer renders pipeline result files with the installed
 * AutoPipe plugins (CSV tables, images, PDFs, and genomics formats).
 *
 * MODEL (2026-08-07): results always live in the LOCAL `results/<run>/`
 * folder (written directly on Windows/WSL, SFTP-copied back for a VM or a
 * remote SSH server). So the viewer reads files with the extension host's
 * own `fs` - no SSH round trip - and renders ONE file at a time. The
 * Analysis tree is the file browser: "Open in viewer" on a `results/<run>/`
 * folder opens a viewer tab bound to that folder (a "scope"), and clicking a
 * file inside the scope routes the click into that tab (see the core
 * ariaViewerScope wiring). Several scopes can be open at once, each its own
 * tab.
 *
 * Plugins expose `window.AutoPipePlugin.render(container, fileUrl, filename)`.
 * Small files are handed a `blob:` URL built from the bytes we read. Big
 * paginated formats (BAM/CRAM/h5ad) instead call `fetch("/data/{filename}")`;
 * we intercept that and run the plugin's `data_source` shell/`docker`
 * commands locally (`sh -c` on posix, `wsl.exe sh -c` on Windows) so the
 * plugin never has to hold the whole file in memory.
 */

/** Bundled PDF.js library files (media/pdfjs/pdf.mjs + pdf.worker.mjs),
 *  resolved off `__dirname` (out/viewer at runtime) so the lookup works from
 *  the source tree or a built VSIX. */
function pdfjsDir(): string {
	return path.join(__dirname, '..', '..', 'media', 'pdfjs');
}

interface ViewerScope {
	/** The folder the viewer tab is bound to, as an absolute local path. */
	folder: string;
	panel: vscode.WebviewPanel;
}

/** Open viewer tabs keyed by their normalized folder path. */
const scopePanels = new Map<string, ViewerScope>();
/** The folder whose viewer tab was focused most recently - the routing
 *  fallback when a file is not inside any open scope. */
let lastActiveFolder: string | undefined;

/**
 * Files currently mounted in a viewer. Plugins fetch
 * `"/data/{filename}?page=..."`; we map `filename` back to its local path
 * and the plugin that owns it. Row-count and the winning data-source
 * candidate are cached so repeat page requests don't re-probe.
 */
interface RegisteredFile {
	localPath: string;
	plugin: InstalledPlugin;
	totalRows?: number;
	chosenDataSource?: DataSourceCommands;
}
const localFiles = new Map<string, RegisteredFile>();

/** Normalize a path for use as a scope key: absolute, and case-folded on
 *  Windows so `C:\R` and `c:\r` are the same scope. */
function normKey(p: string): string {
	const abs = path.resolve(p);
	return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** True when `child` is `parent` or lives underneath it. */
function isEqualOrUnder(child: string, parent: string): boolean {
	const c = normKey(child);
	const p = normKey(parent);
	if (c === p) {
		return true;
	}
	const withSep = p.endsWith(path.sep) ? p : p + path.sep;
	return c.startsWith(withSep) || (process.platform === 'win32' && c.startsWith(p + '/'));
}

/**
 * Open (or reveal) a viewer tab bound to `folderPath` and mark it as a scope
 * in the Analysis tree. Auto-renders the first viewable file so the tab is
 * never blank; further files arrive via `viewFileInViewer` as the user
 * clicks them in the highlighted folder.
 */
export async function openResultsViewer(folderPath: string): Promise<void> {
	const folder = path.resolve(folderPath);
	const key = normKey(folder);

	const existing = scopePanels.get(key);
	if (existing) {
		existing.panel.reveal(vscode.ViewColumn.Active);
		lastActiveFolder = folder;
		void vscode.commands.executeCommand('aria.viewer.setScopeActive', folder, true);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.viewer',
		`${path.basename(folder) || 'Results'} viewer`,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			// Only the bundled PDF.js needs to be reachable by URI; plugin JS
			// and file bytes are injected inline / as blobs, so their paths
			// never appear on the webview side.
			localResourceRoots: [vscode.Uri.file(pdfjsDir())],
		},
	);
	scopePanels.set(key, { folder, panel });
	lastActiveFolder = folder;

	panel.webview.html = renderShellHtml(panel.webview);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; reqId?: number; url?: string }) => {
		try {
			if (msg?.type === 'aria.viewer.ready') {
				// A `results/<run>/` folder produced by a pipeline carries a
				// `.qoka-pipeline.json` marker. If a pipeline-type plugin
				// claims it, render the whole folder as one dashboard;
				// otherwise land on the first viewable file.
				const marker = readPipelineMarker(folder);
				const names = marker ? listLocalFileNames(folder) : [];
				const pipePlugin = marker ? services().plugins.findForPipeline(marker, names) : null;
				if (pipePlugin && marker) {
					renderPipelineDashboard(panel, folder, pipePlugin, marker, names);
				} else {
					await openFirstFileInFolder(panel, folder);
				}
			} else if (msg?.type === 'aria.viewer.fetchData' && typeof msg.reqId === 'number' && typeof msg.url === 'string') {
				const result = await handleDataFetch(msg.url);
				panel.webview.postMessage({ type: 'aria.viewer.fetchData.response', reqId: msg.reqId, data: result });
			}
		} catch (err) {
			console.error('[aria-autopipe] viewer message handling failed', err);
			panel.webview.postMessage({ type: 'aria.viewer.error', error: (err as Error).message });
		}
	});

	panel.onDidChangeViewState(() => {
		if (panel.active) {
			lastActiveFolder = folder;
		}
		void vscode.commands.executeCommand('aria.viewer.setScopeActive', folder, panel.active);
	});

	panel.onDidDispose(() => {
		scopePanels.delete(key);
		if (lastActiveFolder && normKey(lastActiveFolder) === key) {
			lastActiveFolder = undefined;
		}
		void vscode.commands.executeCommand('aria.viewer.clearScope', folder);
	});

	// Draw the scope highlight box in the Analysis tree.
	void vscode.commands.executeCommand('aria.viewer.setScope', folder);
}

/**
 * Render `filePath` in the viewer tab whose scope contains it (innermost when
 * scopes nest). Falls back to the most-recently-focused viewer, and finally
 * to opening a fresh scope on the file's parent directory.
 */
export async function viewFileInViewer(filePath: string): Promise<void> {
	const file = path.resolve(filePath);

	// Innermost containing scope wins so a nested `results/<run>/sub` viewer
	// takes precedence over one opened on `results/<run>`.
	let target: ViewerScope | undefined;
	for (const scope of scopePanels.values()) {
		if (isEqualOrUnder(file, scope.folder)) {
			if (!target || scope.folder.length > target.folder.length) {
				target = scope;
			}
		}
	}
	if (!target && lastActiveFolder) {
		target = scopePanels.get(normKey(lastActiveFolder));
	}
	if (!target) {
		const first = scopePanels.values().next().value as ViewerScope | undefined;
		target = first;
	}

	if (!target) {
		// No viewer open yet: open one on the file's parent and let its
		// ready-handler render this file directly.
		await openResultsViewer(path.dirname(file));
		const opened = scopePanels.get(normKey(path.dirname(file)));
		if (opened) {
			await renderFileInPanel(opened.panel, file);
			opened.panel.reveal(vscode.ViewColumn.Active);
		}
		return;
	}

	target.panel.reveal(vscode.ViewColumn.Active);
	await renderFileInPanel(target.panel, file);
}

/**
 * Opens a single result file in its OWN editor tab through a VS Code custom
 * editor, reusing the same plugin rendering + data_source pipeline as the
 * scope viewer. Registered (in package.json) for the plugin-backed binary
 * formats, so clicking a result file in the Analysis tab lands directly in the
 * right viewer per extension - no eye icon / viewer scope needed. The data is
 * still read through the local run environment (WSL on Windows, vfkit on Mac),
 * exactly like handleDataFetch does for the scope viewer.
 */
export class QokaFileViewerProvider implements vscode.CustomReadonlyEditorProvider {
	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { /* no extra resources held per document */ } };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(pdfjsDir())],
		};
		webviewPanel.webview.html = renderShellHtml(webviewPanel.webview);
		const file = document.uri.fsPath;
		webviewPanel.webview.onDidReceiveMessage(async (msg: { type?: string; reqId?: number; url?: string }) => {
			try {
				if (msg?.type === 'aria.viewer.ready') {
					await renderFileInPanel(webviewPanel, file);
				} else if (msg?.type === 'aria.viewer.fetchData' && typeof msg.reqId === 'number' && typeof msg.url === 'string') {
					const result = await handleDataFetch(msg.url);
					webviewPanel.webview.postMessage({ type: 'aria.viewer.fetchData.response', reqId: msg.reqId, data: result });
				}
			} catch (err) {
				webviewPanel.webview.postMessage({ type: 'aria.viewer.error', error: (err as Error).message });
			}
		});
	}
}

/** Pick the first file in `folder` that a plugin can render and show it, so
 *  a freshly opened viewer tab lands on content instead of a blank pane. */
async function openFirstFileInFolder(panel: vscode.WebviewPanel, folder: string): Promise<void> {
	const { plugins } = services();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch (err) {
		panel.webview.postMessage({ type: 'aria.viewer.placeholder', text: `Could not read ${folder}: ${(err as Error).message}` });
		return;
	}
	const files = entries
		.filter(e => e.isFile() && !e.name.startsWith('.'))
		.map(e => e.name)
		.sort((a, b) => a.localeCompare(b));
	for (const name of files) {
		const ext = path.extname(name);
		if (ext && plugins.findForExtension(ext)) {
			await renderFileInPanel(panel, path.join(folder, name));
			return;
		}
	}
	panel.webview.postMessage({
		type: 'aria.viewer.placeholder',
		text: 'No file open.',
	});
}

/** Read the pipeline name from a `results/<run>/.qoka-pipeline.json` marker,
 *  or null when the folder has none (e.g. a run_code result). */
function readPipelineMarker(folder: string): string | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(folder, '.qoka-pipeline.json'), 'utf8'));
		return typeof raw?.pipeline === 'string' && raw.pipeline.trim() ? String(raw.pipeline).trim() : null;
	} catch {
		return null;
	}
}

/** Names of the visible files (not dirs, not dotfiles) directly in `folder`. */
function listLocalFileNames(folder: string): string[] {
	try {
		return fs.readdirSync(folder, { withFileTypes: true })
			.filter(e => e.isFile() && !e.name.startsWith('.'))
			.map(e => e.name);
	} catch {
		return [];
	}
}

/**
 * Render a whole result folder with a pipeline-type plugin (one dashboard for
 * the run). Every file is pre-registered so the plugin can pull any of them
 * through `/data/{filename}` using the plugin's own data_source.
 */
function renderPipelineDashboard(panel: vscode.WebviewPanel, folder: string, plugin: InstalledPlugin, pipelineName: string, fileNames: string[]): void {
	for (const name of fileNames) {
		localFiles.set(name, { localPath: path.join(folder, name), plugin });
	}
	const entryPath = path.join(plugin.dir, plugin.manifest.entry);
	const stylePath = plugin.manifest.style ? path.join(plugin.dir, plugin.manifest.style) : null;
	panel.webview.postMessage({
		type: 'aria.viewer.pipelineLoaded',
		pipeline: pipelineName,
		folderName: path.basename(folder),
		files: fileNames,
		plugin: {
			name: plugin.manifest.name,
			version: plugin.manifest.version,
			entryJs: readFileOrEmpty(entryPath),
			styleCss: stylePath ? readFileOrEmpty(stylePath) : '',
		},
	});
}

async function renderFileInPanel(panel: vscode.WebviewPanel, filePath: string): Promise<void> {
	const { plugins } = services();
	const ext = path.extname(filePath);
	const plugin = ext ? plugins.findForExtension(ext) : null;
	if (!plugin) {
		panel.webview.postMessage({
			type: 'aria.viewer.fileError',
			filePath,
			error: `No installed plugin handles "${ext || filePath}". Install one from the Plugins tab.`,
		});
		return;
	}

	const filename = path.basename(filePath);
	// Register before streaming any bytes so a plugin that issues its first
	// /data/ request from inside render() finds the lookup entry immediately.
	localFiles.set(filename, { localPath: filePath, plugin });

	// Paginated formats (BAM, CRAM, h5ad, ...) declare a data_source and pull
	// their content page-by-page through /data/ - never touching the blob
	// URL. Reading a multi-GB file just to hand it a blob would crash the
	// extension host, so skip the blob read when a data_source exists.
	const hasDataSource = !!plugin.manifest.data_source;
	// On Windows, data_source plugins read the file through a WSL shell
	// (sed/awk/wc); with WSL absent nothing can be read. Show a plain notice
	// (not the plugin's red "Error:") and skip mounting the plugin.
	if (process.platform === 'win32' && hasDataSource && !(await wslAvailable())) {
		panel.webview.postMessage({
			type: 'aria.viewer.fileNotice',
			filePath,
			text: `To open result files on Windows, Qoka needs WSL (the Windows Subsystem for Linux), which isn't installed on this machine yet. Install it from Settings > Connections (Local (WSL)), then reopen this file.`,
		});
		return;
	}
	let bytesBase64 = '';
	let byteLength = 0;
	if (!hasDataSource) {
		try {
			const buffer = fs.readFileSync(filePath);
			bytesBase64 = buffer.toString('base64');
			byteLength = buffer.length;
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.viewer.fileError', filePath, error: (err as Error).message });
			return;
		}
	}

	const entryPath = path.join(plugin.dir, plugin.manifest.entry);
	const stylePath = plugin.manifest.style ? path.join(plugin.dir, plugin.manifest.style) : null;
	const entryJs = readFileOrEmpty(entryPath);
	const styleCss = stylePath ? readFileOrEmpty(stylePath) : '';
	panel.webview.postMessage({
		type: 'aria.viewer.fileLoaded',
		filePath,
		filename,
		base64: bytesBase64,
		byteLength,
		mimeType: guessMimeType(filePath),
		plugin: {
			name: plugin.manifest.name,
			version: plugin.manifest.version,
			extensions: plugin.manifest.extensions,
			entryJs,
			styleCss,
		},
	});
}

/**
 * Plugin's `fetch("/data/{filename}?page=N&page_size=K")` lands here. Ports
 * autopipe-app's `data_handler`: runs the plugin's data_source template
 * against the LOCAL file (via `sh -c`, or `wsl.exe sh -c` on Windows) and
 * returns `{rows, total, page, page_size, meta?, header?, refs?,
 * col_headers?}` - the shape the plugins parse.
 */
async function handleDataFetch(url: string): Promise<unknown> {
	const parsed = parseDataUrl(url);
	if (!parsed) {
		return { error: `Unrecognized /data/ URL: ${url}` };
	}
	const { filename, page, pageSize } = parsed;
	console.log(`[aria-autopipe] /data/ request: filename=${filename} page=${page} size=${pageSize}`);

	const entry = localFiles.get(filename);
	if (!entry) {
		return { error: `File not registered: ${filename}` };
	}
	const ds = entry.plugin.manifest.data_source;
	if (!ds) {
		return { error: `Plugin "${entry.plugin.manifest.name}" has no data_source.` };
	}

	// The data_source shell templates are POSIX and run inside the local run
	// environment, so the substituted path must be that env's mount of the file:
	// Windows -> the WSL mount (/mnt/<drive>/...); Mac -> the vfkit whole-host
	// mount (/mnt/mac/...); Linux -> the local path as-is (host docker).
	const dataPath = process.platform === 'win32' ? windowsToWsl(entry.localPath)
		: process.platform === 'darwin' ? `/mnt/mac${entry.localPath}`
			: entry.localPath;

	const start = page * pageSize + 1; // sed is 1-indexed
	const end = start + pageSize - 1;

	const candidates: DataSourceCommands[] = [ds, ...(ds.fallback ?? [])];
	let active: DataSourceCommands | undefined = entry.chosenDataSource;

	// Docker-based plugins (samtools, bcftools, h5py) pay a one-off image
	// pull the first time; give docker probes a 5-minute budget and text 1.
	const probeTimeoutFor = (c: DataSourceCommands) => c.type === 'docker' ? 300000 : 60000;
	const rowsTimeoutFor = (c: DataSourceCommands) => c.type === 'docker' ? 600000 : 120000;

	if (!active) {
		for (const candidate of candidates) {
			if (!candidate.row_count) {
				active = candidate;
				break;
			}
			const probeCmd = buildDataCmd(candidate, candidate.row_count, dataPath, 0, 0);
			console.log(`[aria-autopipe] data probe (${candidate.type}): ${probeCmd}`);
			try {
				const probeResult = await localRun(probeCmd, probeTimeoutFor(candidate));
				console.log(`[aria-autopipe] probe exit=${probeResult.exitCode} stdout="${probeResult.stdout.slice(0, 200)}" stderr="${probeResult.stderr.slice(0, 200)}"`);
				if ((probeResult.exitCode === 0 || candidate.allow_nonzero_exit) && /^\d+/.test(probeResult.stdout.trim())) {
					active = candidate;
					break;
				}
			} catch (err) {
				console.warn(`[aria-autopipe] probe failed:`, err);
			}
		}
		if (active) {
			entry.chosenDataSource = active;
		}
	}
	if (!active) {
		// On Windows the data_source shell (sed/awk/wc) runs inside WSL, so when
		// WSL isn't installed the probe can never succeed. Surface a clear,
		// actionable message instead of the generic "no data source" error.
		if (process.platform === 'win32' && !(await wslAvailable())) {
			return {
				error: `To open result files on Windows, Qoka needs WSL (the Windows Subsystem for Linux), which isn't installed on this machine yet. Install it from Settings > Connections (Local (WSL)), then reopen this file.`,
			};
		}
		return {
			error: `No working data source for ${filename}. Plugin: ${entry.plugin.manifest.name}. Check the Qoka DevTools console (Ctrl+Shift+I) for the probe commands and their stderr.`,
		};
	}

	// 1) Row count - cached.
	let total = entry.totalRows;
	if (total === undefined && active.row_count) {
		const countCmd = buildDataCmd(active, active.row_count, dataPath, 0, 0);
		console.log(`[aria-autopipe] row_count cmd: ${countCmd}`);
		try {
			const countResult = await localRun(countCmd, probeTimeoutFor(active));
			if (countResult.exitCode === 0 || active.allow_nonzero_exit) {
				const n = parseInt(countResult.stdout.trim(), 10);
				if (Number.isFinite(n)) {
					total = n;
					entry.totalRows = n;
				}
			}
		} catch (err) {
			console.warn(`[aria-autopipe] row_count failed:`, err);
		}
	}

	// 2) Metadata (first page only).
	let meta: unknown = null;
	let header: unknown = null;
	let refs: unknown = null;
	let colHeaders: string[] = active.col_headers ? [...active.col_headers] : [];

	if (page === 0 && active.metadata) {
		const metaCmd = buildDataCmd(active, active.metadata, dataPath, 0, 0);
		try {
			const metaResult = await localRun(metaCmd, 300000);
			if (metaResult.exitCode === 0 || active.allow_nonzero_exit) {
				const m = metaResult.stdout.trim();
				const parseMode = active.meta_parse ?? 'none';
				if (parseMode === 'bam_style') {
					header = m;
					const refList: Array<{ name: string; length: number }> = [];
					for (const line of m.split('\n')) {
						if (!line.startsWith('@SQ')) {
							continue;
						}
						let name = '';
						let length = 0;
						for (const field of line.split('\t')) {
							if (field.startsWith('SN:')) {
								name = field.slice(3);
							} else if (field.startsWith('LN:')) {
								length = parseInt(field.slice(3), 10) || 0;
							}
						}
						if (name) {
							refList.push({ name, length });
						}
					}
					if (refList.length > 0) {
						refs = refList;
					}
				} else if (parseMode === 'vcf_style') {
					const lines = m.split('\n');
					if (colHeaders.length === 0) {
						const hdr = lines.find(l => l.startsWith('#CHROM'));
						if (hdr) {
							colHeaders = hdr.replace(/^#+/, '').split('\t');
						}
					}
					const metaLines = lines.filter(l => l.startsWith('##'));
					if (metaLines.length > 0) {
						meta = metaLines.join('\n');
					}
				} else if (m.length > 0) {
					meta = m;
				}
			} else if (metaResult.stderr.trim()) {
				console.warn(`[aria-autopipe] metadata exit ${metaResult.exitCode}: ${metaResult.stderr.trim()}`);
			}
		} catch (err) {
			console.warn(`[aria-autopipe] metadata failed:`, err);
		}
	}

	// 3) Data rows.
	let rows: string[][] = [];
	if (active.rows && active.rows !== 'true') {
		const rowsCmd = buildDataCmd(active, active.rows, dataPath, start, end);
		try {
			const rowsResult = await localRun(rowsCmd, rowsTimeoutFor(active));
			if (rowsResult.exitCode !== 0 && !active.allow_nonzero_exit) {
				return { error: rowsResult.stderr.trim() || rowsResult.stdout.trim() };
			}
			rows = rowsResult.stdout.split('\n').filter(l => l.length > 0).map(l => l.split('\t'));
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	const result: Record<string, unknown> = {
		rows,
		total: total ?? 0,
		page,
		page_size: pageSize,
	};
	if (meta !== null) { result.meta = meta; }
	if (header !== null) { result.header = header; }
	if (refs !== null) { result.refs = refs; }
	if (colHeaders.length > 0) { result.col_headers = colHeaders; }
	return result;
}

/** Run a data_source shell command against the LOCAL result file, INSIDE the
 *  local run environment where Docker lives (the same target run_code uses):
 *  Windows runs it in WSL via `wsl.exe -e sh -c`; Mac has no host Docker, so it
 *  runs inside the built-in vfkit VM over `ssh.run` (the file is visible there
 *  at /mnt/mac/...); Linux runs it directly with `sh -c` on the host. */
async function localRun(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (process.platform === 'darwin') {
		try {
			const r = await builtinExec(cmd, { timeoutMs });
			return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		} catch (err) {
			return { stdout: '', stderr: `[qoka] could not reach the built-in run environment (vfkit): ${(err as Error).message}`, exitCode: 127 };
		}
	}
	return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
		const child = process.platform === 'win32'
			? spawn('wsl.exe', ['-e', 'sh', '-c', cmd])
			: spawn('sh', ['-c', cmd]);
		let stdout = '';
		let stderr = '';
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			try { child.kill('SIGKILL'); } catch { /* ignore */ }
			resolve({ stdout, stderr: stderr + `\n[timed out after ${timeoutMs}ms]`, exitCode: 124 });
		}, timeoutMs);
		child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
		child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
		child.on('error', (err) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr: (err as Error).message, exitCode: 127 });
		});
		child.on('close', (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

function parseDataUrl(url: string): { filename: string; page: number; pageSize: number } | null {
	const m = url.match(/^\/data\/([^?]+)(\?(.*))?$/);
	if (!m) {
		return null;
	}
	const filename = decodeURIComponent(m[1]);
	let page = 0;
	let pageSize = 100;
	if (m[3]) {
		for (const part of m[3].split('&')) {
			const [k, v] = part.split('=');
			if (k === 'page') {
				page = parseInt(decodeURIComponent(v ?? ''), 10) || 0;
			} else if (k === 'page_size') {
				pageSize = parseInt(decodeURIComponent(v ?? ''), 10) || 100;
			}
		}
	}
	return { filename, page, pageSize };
}

/**
 * Substitute the placeholders in a data_source template. `docker` commands
 * are wrapped in `docker run --rm -v $dir:/data:ro $image sh -c "..."`; text
 * commands run as-is with `{file}` set to the local (WSL, on Windows) path.
 */
function buildDataCmd(ds: DataSourceCommands, template: string, filePath: string, start: number, end: number): string {
	if (ds.type === 'docker') {
		const dir = filePath.replace(/\/[^/]*$/, '') || '/';
		const file = filePath.split('/').pop() ?? '';
		const inner = template
			.replace(/\{file\}/g, `/data/${file}`)
			.replace(/\{start\}/g, String(start))
			.replace(/\{end\}/g, String(end));
		return `docker run --rm -v "${dir}:/data:ro" ${ds.image ?? ''} sh -c "${inner}"`;
	}
	return template
		.replace(/\{file\}/g, filePath)
		.replace(/\{start\}/g, String(start))
		.replace(/\{end\}/g, String(end));
}

/** Minimal MIME-type guesser - enough for blob-URL plugins (PDF/image need
 *  the right Content-Type). Everything else is octet-stream and plugins
 *  parse it themselves. */
function guessMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
	const map: Record<string, string> = {
		pdf: 'application/pdf',
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
		svg: 'image/svg+xml', tiff: 'image/tiff', bmp: 'image/bmp', webp: 'image/webp',
		json: 'application/json', txt: 'text/plain', log: 'text/plain', csv: 'text/csv',
		yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain', md: 'text/markdown',
	};
	return map[ext] ?? 'application/octet-stream';
}

function readFileOrEmpty(p: string): string {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

function renderShellHtml(webview: vscode.Webview): string {
	const cspSource = webview.cspSource;
	const pdfjsLibUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDir(), 'pdf.mjs')));
	const pdfjsWorkerUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDir(), 'pdf.worker.mjs')));
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`media-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
		`script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
		`worker-src ${cspSource} blob:`,
		`frame-src ${cspSource} blob: data:`,
		`object-src ${cspSource} blob: data:`,
		`child-src ${cspSource} blob: data:`,
		`connect-src ${cspSource} data: blob:`,
	].join('; ');

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Autopipe Viewer</title>
	<style>
		html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
		.wrap { display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
		/* Fixed guide at the top of every viewer tab - two lines, always visible.
		   Blue left accent ties it to the highlighted (blue-outlined) folder scope. */
		.guide { flex-shrink: 0; padding: 8px 14px; border-bottom: 1px solid var(--vscode-widget-border, transparent); border-left: 3px solid var(--vscode-focusBorder, #40a0ff); background: var(--vscode-editorWidget-background); font-size: 11.5px; line-height: 1.5; opacity: 0.92; }
		.guide div { white-space: normal; }
		.header { padding: 8px 14px; border-bottom: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; display: flex; gap: 8px; align-items: baseline; flex-shrink: 0; }
		.header .name { font-weight: 600; }
		.header .meta { opacity: 0.7; font-size: 11px; }
		.viewer-host { flex: 1; overflow: auto; position: relative; }
		.placeholder { padding: 32px; text-align: center; opacity: 0.6; font-size: 12px; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); color: var(--vscode-inputValidation-errorForeground, #c44); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); border-radius: 3px; margin: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
		.notice { padding: 16px; margin: 12px; color: var(--vscode-foreground); font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
	</style>
</head>
<body>
	<div class="wrap">
		<div class="guide">
			<div>To open this file type with the VS Code built-in viewer instead, go to the Settings tab's Result Viewer section, click "Manage Result Viewers", and remove the viewer plugin you do not want.</div>
		</div>
		<div class="header" id="right-header"><span class="meta">No file selected</span></div>
		<div class="viewer-host" id="viewer-host">
			<div class="placeholder">No file open.</div>
		</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

		// Plugins call \`fetch("/data/{filename}?...")\` expecting an HTTP
		// endpoint. We intercept, ask the extension to run the data_source
		// command locally, and hand back a Response-shaped object.
		const _fetchPending = {};
		let _fetchSeq = 0;
		const _origFetch = window.fetch.bind(window);
		window.fetch = function(input, opts) {
			const url = typeof input === 'string' ? input : (input && input.url);
			if (typeof url === 'string' && url.startsWith('/data/')) {
				return new Promise(function(resolve) {
					const reqId = ++_fetchSeq;
					_fetchPending[reqId] = (payload) => {
						const body = JSON.stringify(payload);
						resolve({
							ok: !(payload && payload.error),
							status: payload && payload.error ? 500 : 200,
							statusText: payload && payload.error ? 'error' : 'ok',
							headers: { get: function() { return null; } },
							json: function() { return Promise.resolve(payload); },
							text: function() { return Promise.resolve(body); },
						});
					};
					vscode.postMessage({ type: 'aria.viewer.fetchData', reqId: reqId, url: url });
				});
			}
			return _origFetch(input, opts);
		};

		let currentBlobUrl = null;
		let pluginInstance = null;
		let currentPayload = null;

		function bytesFromBase64(b64) {
			const binary = atob(b64);
			const len = binary.length;
			const bytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
			return bytes;
		}

		function tearDownCurrentPlugin() {
			try {
				if (window.AutoPipePlugin && typeof window.AutoPipePlugin.destroy === 'function') {
					window.AutoPipePlugin.destroy();
				}
			} catch (e) { /* ignore */ }
			window.AutoPipePlugin = undefined;
			if (currentBlobUrl) {
				try { URL.revokeObjectURL(currentBlobUrl); } catch (e) { /* ignore */ }
				currentBlobUrl = null;
			}
			if (pluginInstance && pluginInstance.parentNode) {
				pluginInstance.parentNode.removeChild(pluginInstance);
			}
			pluginInstance = null;
		}

		// PDF.js - loaded once, lazily. workerSrc must be set BEFORE the
		// first getDocument() call.
		let pdfjsLibPromise = null;
		function getPdfjs() {
			if (!pdfjsLibPromise) {
				pdfjsLibPromise = import(${JSON.stringify(pdfjsLibUri.toString())}).then(mod => {
					mod.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pdfjsWorkerUri.toString())};
					return mod;
				}).catch(err => {
					console.error('[aria-autopipe] PDF.js load failed', err);
					throw err;
				});
			}
			return pdfjsLibPromise;
		}

		const ARIA_PDF_HANDLED = '__ariaPdfHandled';
		async function replacePdfEmbeds() {
			const embeds = document.querySelectorAll('embed[type="application/pdf"]');
			for (const embed of embeds) {
				if (embed[ARIA_PDF_HANDLED]) continue;
				embed[ARIA_PDF_HANDLED] = true;
				try {
					await intercept(embed);
				} catch (err) {
					embed.replaceWith(makePdfError(err));
				}
			}
		}
		function makePdfError(err) {
			const fb = document.createElement('div');
			fb.style.padding = '24px';
			fb.style.color = 'var(--vscode-inputValidation-errorForeground, #c44)';
			fb.textContent = 'PDF render failed: ' + (err && err.message ? err.message : String(err));
			return fb;
		}
		async function intercept(embed) {
			const src = (embed.getAttribute('src') || '').split('#')[0];
			if (!src) return;
			const wrap = embed.parentElement;
			const wrapHeightPx = (wrap && wrap.style && parseFloat(wrap.style.height)) || 500;
			const zoomFactor = wrapHeightPx / 500;
			const container = document.createElement('div');
			container.style.width = '100%';
			container.style.height = '100%';
			container.style.overflow = 'auto';
			container.style.background = 'var(--vscode-editor-background)';
			container.style.cursor = 'grab';
			embed.replaceWith(container);
			const loading = document.createElement('div');
			loading.style.padding = '16px';
			loading.style.opacity = '0.7';
			loading.style.fontSize = '12px';
			loading.textContent = 'Rendering PDF…';
			container.appendChild(loading);
			const lib = await getPdfjs();
			const buffer = await fetch(src).then(r => r.arrayBuffer());
			const pdf = await lib.getDocument({ data: buffer }).promise;
			container.removeChild(loading);
			const firstPage = await pdf.getPage(1);
			const baseViewport = firstPage.getViewport({ scale: 1.0 });
			const fitScale = (container.clientWidth - 24) / baseViewport.width;
			const renderScale = Math.max(0.25, fitScale * zoomFactor);
			for (let p = 1; p <= pdf.numPages; p++) {
				const page = p === 1 ? firstPage : await pdf.getPage(p);
				const viewport = page.getViewport({ scale: renderScale });
				const canvas = document.createElement('canvas');
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				canvas.style.display = 'block';
				canvas.style.margin = '0 auto 12px';
				canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
				container.appendChild(canvas);
				await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
			}
			let dragging = false;
			let startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;
			container.addEventListener('mousedown', (e) => {
				dragging = true; startX = e.clientX; startY = e.clientY;
				startScrollLeft = container.scrollLeft; startScrollTop = container.scrollTop;
				container.style.cursor = 'grabbing'; e.preventDefault();
			});
			window.addEventListener('mousemove', (e) => {
				if (!dragging) return;
				container.scrollLeft = startScrollLeft - (e.clientX - startX);
				container.scrollTop = startScrollTop - (e.clientY - startY);
			});
			window.addEventListener('mouseup', () => {
				if (!dragging) return;
				dragging = false; container.style.cursor = 'grab';
			});
		}
		new MutationObserver(replacePdfEmbeds).observe(document.body, { childList: true, subtree: true });

		function mountPlugin(payload) {
			tearDownCurrentPlugin();
			currentPayload = payload;
			const bytes = bytesFromBase64(payload.base64);
			const blob = new Blob([bytes], { type: payload.mimeType || 'application/octet-stream' });
			currentBlobUrl = URL.createObjectURL(blob);
			$('right-header').innerHTML = '<span class="name">' + escapeHtml(payload.filename) + '</span><span class="meta">' + escapeHtml(payload.plugin.name + ' v' + payload.plugin.version) + '</span>';
			const host = $('viewer-host');
			host.innerHTML = '';
			const container = document.createElement('div');
			container.style.height = '100%';
			container.style.width = '100%';
			container.style.padding = '8px';
			container.style.boxSizing = 'border-box';
			host.appendChild(container);
			if (payload.plugin.styleCss) {
				const style = document.createElement('style');
				style.textContent = payload.plugin.styleCss;
				host.appendChild(style);
			}
			const script = document.createElement('script');
			script.textContent = payload.plugin.entryJs;
			pluginInstance = script;
			host.appendChild(script);
			if (window.AutoPipePlugin && typeof window.AutoPipePlugin.render === 'function') {
				try {
					window.AutoPipePlugin.render(container, currentBlobUrl, payload.filename);
					setTimeout(replacePdfEmbeds, 0);
				} catch (err) {
					host.innerHTML = '<div class="err">Plugin render failed: ' + escapeHtml(String(err)) + '</div>';
				}
			} else {
				host.innerHTML = '<div class="err">Plugin "' + escapeHtml(payload.plugin.name) + '" did not register AutoPipePlugin.render</div>';
			}
		}

		// A pipeline-type plugin renders the WHOLE result folder as one
		// dashboard. It pulls each file through /data/{filename} using its own
		// data_source (pre-registered on the extension side). We call
		// renderPipeline(container, {folderName, files, pipeline}) when the
		// plugin exposes it, falling back to render(container, null, folderName).
		function mountPipeline(payload) {
			tearDownCurrentPlugin();
			$('right-header').innerHTML = '<span class="name">' + escapeHtml(payload.folderName) + '</span><span class="meta">' + escapeHtml(payload.plugin.name + ' v' + payload.plugin.version) + '</span>';
			const host = $('viewer-host');
			host.innerHTML = '';
			const container = document.createElement('div');
			container.style.height = '100%';
			container.style.width = '100%';
			container.style.padding = '8px';
			container.style.boxSizing = 'border-box';
			host.appendChild(container);
			if (payload.plugin.styleCss) {
				const style = document.createElement('style');
				style.textContent = payload.plugin.styleCss;
				host.appendChild(style);
			}
			const script = document.createElement('script');
			script.textContent = payload.plugin.entryJs;
			pluginInstance = script;
			host.appendChild(script);
			try {
				if (window.AutoPipePlugin && typeof window.AutoPipePlugin.renderPipeline === 'function') {
					window.AutoPipePlugin.renderPipeline(container, { folderName: payload.folderName, files: payload.files, pipeline: payload.pipeline });
				} else if (window.AutoPipePlugin && typeof window.AutoPipePlugin.render === 'function') {
					window.AutoPipePlugin.render(container, null, payload.folderName);
				} else {
					host.innerHTML = '<div class="err">Plugin "' + escapeHtml(payload.plugin.name) + '" did not register AutoPipePlugin.render</div>';
				}
				setTimeout(replacePdfEmbeds, 0);
			} catch (err) {
				host.innerHTML = '<div class="err">Plugin render failed: ' + escapeHtml(String(err)) + '</div>';
			}
		}

		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'aria.viewer.fetchData.response') {
				const cb = _fetchPending[msg.reqId];
				if (cb) { delete _fetchPending[msg.reqId]; cb(msg.data); }
				return;
			}
			if (msg.type === 'aria.viewer.fileLoaded') {
				mountPlugin(msg);
			} else if (msg.type === 'aria.viewer.pipelineLoaded') {
				mountPipeline(msg);
			} else if (msg.type === 'aria.viewer.fileError') {
				$('right-header').innerHTML = '<span class="name">' + escapeHtml(String(msg.filePath).split('/').pop()) + '</span>';
				$('viewer-host').innerHTML = '<div class="err">' + escapeHtml(msg.error) + '</div>';
			} else if (msg.type === 'aria.viewer.fileNotice') {
				$('right-header').innerHTML = '<span class="name">' + escapeHtml(String(msg.filePath).split('/').pop()) + '</span>';
				$('viewer-host').innerHTML = '<div class="notice">' + escapeHtml(msg.text) + '</div>';
			} else if (msg.type === 'aria.viewer.placeholder') {
				$('right-header').innerHTML = '<span class="meta">No file selected</span>';
				$('viewer-host').innerHTML = '<div class="placeholder">' + escapeHtml(msg.text) + '</div>';
			} else if (msg.type === 'aria.viewer.error') {
				$('viewer-host').innerHTML = '<div class="err">' + escapeHtml(msg.error) + '</div>';
			}
		});

		vscode.postMessage({ type: 'aria.viewer.ready' });
	</script>
</body>
</html>`;
}
