/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Qoka Loops tab (loop_engine_design.md section on the Loop panel + detail tab). A single
// DISPLAY-ONLY webview: a master list of this project's loops on the left, and the selected
// loop's live detail on the right (status, iteration history, flow, budget, the sha256-locked
// evaluator, and a file tree of its .qoka/loops/<id>/ artifacts). There are deliberately NO
// approval/start buttons here - all loop control happens in the chat (decision B); the tab is
// just a live window onto the loops the engine persists. It refreshes automatically whenever a
// loop's JSON changes on disk, so a running loop's iterations appear as they happen.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { LoopRun } from '../schema';
import { listLoops, loopsDir, readLoop } from '../state';
import { resolveGitBinary, gitEnv, GIT_SAFE_ARGS } from '../gitBin';
import { loopLog } from '../log';

/** URI scheme for read-only loop-artifact documents (registered in extension.ts). Opening loop
 *  files through this scheme keeps the hidden .qoka path out of the Analysis explorer. */
export const LOOP_FILE_SCHEME = 'qoka-loop-file';

let panel: vscode.WebviewPanel | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let focusId: string | undefined;
/** One-shot: set when the tab is opened for a specific loop, to force that loop selected. */
let forceSelectId: string | undefined;

/** A file inside a loop's .qoka/loops/<id>/ artifact folder, shown in the code tree. */
interface LoopFile { rel: string; abs: string; }

/** One git version (commit) of the loop's code = one iteration's attempt, with the files it captured. */
interface LoopVersion { hash: string; iter: number; verdict: 'pass' | 'fail' | ''; subject: string; files: string[]; }

/** The loop's git-versioned code folder (loops/<folder>/code), or undefined. */
function loopCodeDir(run: LoopRun): string | undefined {
	const proot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return (proot && run.rootDir) ? path.join(proot, run.rootDir, 'code') : undefined;
}

/** Read the git history of the loop's code folder = the per-iteration version tree (newest first). */
function loopVersions(run: LoopRun): LoopVersion[] {
	const codeDir = loopCodeDir(run);
	if (!codeDir) { return []; }
	// No repo yet = the normal "No versions yet" state (a not-yet-committed or a pre-git loop). Return
	// quietly WITHOUT spawning git - this runs on every UI refresh for every loop, so spawning MinGit and
	// logging a failure here just floods the channel and wastes processes. Only a real failure ON an
	// existing repo is worth logging.
	if (!fs.existsSync(path.join(codeDir, '.git'))) { return []; }
	const gitBin = resolveGitBinary();
	let out: string;
	try { out = execFileSync(gitBin, [...GIT_SAFE_ARGS, '-C', codeDir, 'log', '--format=%H%x09%s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }); }
	catch (e) {
		loopLog(`loopVersions: git log failed on an existing repo. gitBin=${gitBin} codeDir=${codeDir} err=${(e as Error).message}`);
		return [];
	}
	return out.trim().split('\n').filter(Boolean).map(line => {
		const tab = line.indexOf('\t');
		const hash = tab >= 0 ? line.slice(0, tab) : line;
		const subject = tab >= 0 ? line.slice(tab + 1) : '';
		const m = /^iter (\d+):\s*(pass|fail)?/.exec(subject);
		let files: string[] = [];
		try { files = execFileSync(gitBin, [...GIT_SAFE_ARGS, '-C', codeDir, 'ls-tree', '-r', '--name-only', hash], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).split('\n').filter(Boolean); }
		catch { /* leave empty */ }
		return { hash, iter: m ? parseInt(m[1], 10) : -1, verdict: (m && (m[2] as 'pass' | 'fail')) || '', subject, files };
	});
}

/** One loop, flattened for the webview (spec + run state + its on-disk artifact files). */
interface LoopView {
	id: string;
	title: string;
	goal: string;
	status: string;
	iteration: number;
	budget: { maxIter: number; maxMin: number; startedAt?: string };
	createdAt: string;
	updatedAt: string;
	reason?: string;
	flow: LoopRun['spec']['flow'];
	evaluator: LoopRun['spec']['evaluator'];
	lockedHash?: string;
	history: LoopRun['history'];
	provider?: string;
	liveStep?: LoopRun['liveStep'];
	evaluatorFile?: LoopFile;
	results: ResultFile[];
	versions: LoopVersion[];
	codeDir?: string;
	/** The loop's folder name (from run.rootDir = loops/<folder>), shown as the shared parent of the
	 *  evaluator + the per-iteration versions in the Code tree. */
	folder?: string;
}

/** The locked evaluator file (hidden .qoka/loops/<id>/evaluator.<ext>) - a SHARED file: the same
 *  evaluator judges every iteration, so it is not tied to a single version. Shown as a pinned
 *  "Evaluator (locked)" entry in the Code section, separate from the per-iteration versions. */
function loopEvaluatorFile(run: LoopRun): LoopFile | undefined {
	const dir = loopsDir();
	if (!dir) { return undefined; }
	const base = path.join(dir, run.id);
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return undefined; }
	const ev = entries.find(e => e.isFile() && e.name.startsWith('evaluator.'));
	return ev ? { rel: ev.name, abs: path.join(base, ev.name) } : undefined;
}

/** A result file, tagged with a display CATEGORY so the Results view can group them into folders
 *  (results / logs / meta) without moving anything on disk. */
type ResultCategory = 'results' | 'logs' | 'meta';
interface ResultFile { rel: string; abs: string; category: ResultCategory; size: number; }

/** Classify a result file for display: logs (*.log), meta (run scaffolding / metadata), else results. */
function classifyResult(name: string): ResultCategory {
	if (name.endsWith('.log')) { return 'logs'; }
	if (name === 'main.sh' || name === 'main.py' || name === 'main.js' || name === '.autopipe-run.json'
		|| name.startsWith('mcp-config') || name.startsWith('.') || name.endsWith('.tmp')) { return 'meta'; }
	return 'results';
}

/** The loop's OUTPUT files (loops/<folder>/results/**). Nothing is hidden - each file is tagged with a
 *  category so the Results view can organize logs/meta into their own folders instead of dropping them. */
function loopResultFiles(run: LoopRun): ResultFile[] {
	const proot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!proot || !run.rootDir) { return []; }
	const out: ResultFile[] = [];
	const walk = (abs: string, rel: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const childAbs = path.join(abs, e.name);
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) { walk(childAbs, childRel); }
			else {
				let size = 0;
				try { size = fs.statSync(childAbs).size; } catch { /* keep 0 */ }
				// Always use '/' in rel so the webview can split the folder tree the same on every OS.
				out.push({ rel: childRel.split(path.sep).join('/'), abs: childAbs, category: classifyResult(e.name), size });
			}
		}
	};
	walk(path.join(proot, run.rootDir, 'results'), '');
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function toView(run: LoopRun): LoopView {
	return {
		id: run.id,
		title: run.spec.title,
		goal: run.spec.goal,
		status: run.status,
		iteration: run.iteration,
		budget: run.budget,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		reason: run.reason,
		flow: run.spec.flow,
		evaluator: run.spec.evaluator,
		lockedHash: run.lockedEvaluatorRef?.hash ?? run.spec.evaluator.hash,
		history: run.history,
		provider: run.provider,
		liveStep: run.liveStep,
		evaluatorFile: loopEvaluatorFile(run),
		results: loopResultFiles(run),
		versions: loopVersions(run),
		codeDir: loopCodeDir(run),
		folder: run.rootDir ? run.rootDir.replace(/^loops\//, '') : undefined,
	};
}

function postData(): void {
	if (!panel) { return; }
	const loops = listLoops().map(toView);
	// Keep focus on the last-requested loop if it still exists, else the newest.
	const selectedId = (focusId && loops.some(l => l.id === focusId)) ? focusId : (loops[0]?.id);
	// `select` (one-shot) FORCES the client to switch selection - used when the tab is opened for a
	// specific loop (from the finish notification / save_loop / start_loop), so its detail shows even
	// if another loop was already selected. Cleared after sending so a live refresh doesn't hijack.
	const select = (forceSelectId && loops.some(l => l.id === forceSelectId)) ? forceSelectId : undefined;
	forceSelectId = undefined;
	panel.webview.postMessage({ type: 'data', loops, selectedId, select });
}

/**
 * Open (or reveal) the Qoka Loops tab, optionally focused on a specific loop. Called from the
 * command, and from the chat tools right after a loop is saved or started so the user sees it.
 */
/** Tell the Loops SIDEBAR which loop's detail is currently open, so it can grey out that row. Undefined
 *  when the detail panel is closed. Best-effort - the sidebar view may not be registered yet. */
function markSidebarOpen(id: string | undefined): void {
	void Promise.resolve(vscode.commands.executeCommand('qoka.loop.markOpen', id)).then(undefined, () => { /* view not ready */ });
}

export function openLoopPanel(context: vscode.ExtensionContext, loopId?: string): void {
	if (loopId) { focusId = loopId; forceSelectId = loopId; }
	// Also reveal the Loops SIDEBAR list (not just the editor detail) so the user sees both when a
	// loop is opened/started - the sidebar view auto-registers a `<viewId>.focus` command.
	try { void vscode.commands.executeCommand('workbench.view.qoka.loop.list.focus'); } catch { /* view not ready */ }
	// Title the editor tab after the focused loop (the sidebar list opens this per loop).
	const title = (loopId ? readLoop(loopId)?.spec.title : undefined) || 'Loop';
	if (panel) {
		panel.title = title;
		panel.reveal(vscode.ViewColumn.Active);
		postData();
		markSidebarOpen(focusId);
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'qoka.loop.panel',
		title,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = renderHtml(panel.webview);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; path?: string; id?: string; text?: string; codeDir?: string; hash?: string; file?: string }) => {
		if (msg?.type === 'ready') {
			postData();
		} else if (msg?.type === 'select' && msg.id) {
			focusId = msg.id;
			markSidebarOpen(focusId);
		} else if (msg?.type === 'openVersion' && msg.codeDir && msg.hash) {
			try {
				// A version file is a git blob, not a real file. Materialize it to a temp file named after the
				// real filename, then open it the SAME way the Analysis tab opens files (vscode.open) - so a
				// supported extension routes through the Qoka viewer / custom editors, others to the editor.
				const gitBin = resolveGitBinary();
				let target = msg.file;
				if (!target) {
					const list = execFileSync(gitBin, [...GIT_SAFE_ARGS, '-C', msg.codeDir, 'ls-tree', '-r', '--name-only', msg.hash], { encoding: 'utf8', env: gitEnv() }).split('\n').filter(Boolean);
					target = list.find(f => f.startsWith('solution.')) || list[0] || 'solution';
				}
				const buf = execFileSync(gitBin, [...GIT_SAFE_ARGS, '-C', msg.codeDir, 'show', `${msg.hash}:${target}`], { encoding: 'buffer', env: gitEnv() });
				const name = target.split('/').pop() || 'file';
				const dir = path.join(os.tmpdir(), 'qoka-loop-versions', msg.hash.slice(0, 8));
				fs.mkdirSync(dir, { recursive: true });
				const tmp = path.join(dir, name);
				fs.writeFileSync(tmp, buf);
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(tmp), { viewColumn: vscode.ViewColumn.Beside, preview: true });
			} catch (e) {
				void vscode.window.showErrorMessage(`Cannot open version: ${(e as Error).message}`);
			}
		} else if (msg?.type === 'openFile' && msg.path) {
			try {
				if (/[\\/]\.qoka[\\/]/.test(msg.path)) {
					// The locked evaluator lives under the hidden .qoka - open it read-only via our scheme so
					// the Analysis explorer never reveals that internal path.
					const name = msg.path.split(/[\\/]/).pop() || 'file';
					const uri = vscode.Uri.from({ scheme: LOOP_FILE_SCHEME, path: `/${name}`, query: msg.path });
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
				} else {
					// Visible result files: open exactly like the Analysis tab - vscode.open routes supported
					// extensions through the Qoka viewer / custom editors, everything else to the text editor.
					await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { viewColumn: vscode.ViewColumn.Beside, preview: true });
				}
			} catch (e) {
				void vscode.window.showErrorMessage(`Cannot open file: ${(e as Error).message}`);
			}
		} else if (msg?.type === 'copy' && typeof msg.text === 'string') {
			await vscode.env.clipboard.writeText(msg.text);
			void vscode.window.showInformationMessage('Copied the example prompt to the clipboard.');
		}
	}, undefined, context.subscriptions);

	// Live refresh: re-post whenever any loop JSON under .qoka/loops changes.
	const dir = loopsDir();
	if (dir && !watcher) {
		watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.json'));
		const refresh = () => postData();
		watcher.onDidChange(refresh);
		watcher.onDidCreate(refresh);
		watcher.onDidDelete(refresh);
		context.subscriptions.push(watcher);
	}

	// The detail panel now shows this loop - tell the sidebar to grey its row.
	markSidebarOpen(focusId);

	panel.onDidDispose(() => {
		panel = undefined;
		watcher?.dispose();
		watcher = undefined;
		markSidebarOpen(undefined);
	});
}

function renderHtml(webview: vscode.Webview): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${webview.cspSource} data:`;
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Qoka Loops</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; }
		.list { width: 260px; flex-shrink: 0; border-right: 1px solid var(--vscode-widget-border, transparent); overflow-y: auto; background: var(--vscode-editorWidget-background); }
		.list-head { padding: 14px 16px 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
		.loop-item { padding: 10px 16px; cursor: pointer; border-left: 2px solid transparent; }
		.loop-item:hover { background: var(--vscode-list-hoverBackground); }
		.loop-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
		.loop-item .lt { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.loop-item .lm { font-size: 11px; opacity: 0.8; margin-top: 3px; display: flex; align-items: center; gap: 6px; }
		.badge { font-size: 10px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
		.b-running { background: #2d6cdf22; color: #4c8dff; border: 1px solid #4c8dff66; }
		.b-success { background: #1e8e3e22; color: #4caf72; border: 1px solid #4caf7266; }
		.b-failed { background: #c5303022; color: #e06666; border: 1px solid #e0666666; }
		.b-paused { background: #b8860022; color: #e0b050; border: 1px solid #e0b05066; }
		.b-pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.b-stopped { background: #6b6b6b22; color: #9a9a9a; border: 1px solid #9a9a9a55; }

		/* Draggable divider between the loop list and the detail pane. */
		.gutter { flex: 0 0 6px; cursor: ew-resize; position: relative; }
		.gutter::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--vscode-widget-border, transparent); opacity: 0.6; }
		.gutter:hover::after { opacity: 1; }
		.detail { flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px; box-sizing: border-box; }
		/* Flow diagram */
		/* Flow (HTML boxes - text wraps, nothing truncated). */
		/* position:relative + a right gutter so the "fail -> back to step 1" return line (drawn as an
		   absolutely-positioned SVG by drawLoopback()) has room without overlapping the boxes. */
		.flowh { display: flex; flex-direction: column; max-width: 640px; margin-bottom: 10px; position: relative; padding-right: 48px; }
		.fnode { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35)); border-radius: 7px; background: var(--vscode-editorWidget-background); padding: 8px 12px; font-size: 12px; line-height: 1.45; word-break: break-word; }
		.fnode.fstep { font-weight: 600; }
		/* Evaluator: just a subtle tint (the EVALUATE tag now carries the emphasis, so no bright border). */
		.fnode.feval { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.07)); }
		/* Colored tags marking the key boxes (INPUT / EVALUATE / RESULT). */
		.ftag { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; padding: 1px 5px; border-radius: 4px; margin-right: 4px; vertical-align: middle; }
		.tag-in { color: #4c8dff; background: #4c8dff22; }
		.tag-eval { color: #d8a02e; background: #d8a02e22; }
		.tag-out { color: #3f9e68; background: #3f9e6822; }
		.farrow { text-align: center; color: #888; font-size: 13px; line-height: 1; padding: 3px 0; }
		/* PASS is just a green down-arrow + label leading into RESULT (no box). FAIL is the red return
		   line drawn on the right by drawLoopback() from EVALUATE up to step 1. */
		.fpass { text-align: center; color: #3f9e68; font-size: 12px; font-weight: 600; padding: 4px 0 2px; }
		.fpass .ar { font-weight: 700; margin-right: 3px; }
		.loopback-svg { position: absolute; top: 0; pointer-events: none; overflow: visible; }
		.loopback-svg .lb-label { fill: #e06666; font-size: 10px; font-weight: 700; }
		/* Progress bar: N segments (planned steps) filled left-to-right; current segment pulses. */
		.pbar { display: flex; gap: 6px; align-items: flex-end; }
		.pseg { flex: 1; min-width: 0; position: relative; }
		.pseg .pbarnode { height: 6px; border-radius: 3px; background: var(--vscode-widget-border, rgba(127,127,127,0.35)); }
		.pseg.done .pbarnode { background: #4caf72; }
		.pseg.cur .pbarnode { background: #4c8dff; animation: qpulse 1.2s ease-in-out infinite; }
		.pseg .plabel { font-size: 10px; opacity: 0.7; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
		.pseg.cur .plabel { opacity: 1; color: #4c8dff; }
		/* Hover box: the short "step N" bar reveals the full step text on hover. */
		.pseg .ptip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 6px; z-index: 20;
			max-width: 260px; width: max-content; padding: 6px 9px; border-radius: 6px; font-size: 11px; line-height: 1.4; white-space: normal;
			background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc);
			border: 1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.35)); box-shadow: 0 2px 8px rgba(0,0,0,0.35); pointer-events: none; }
		.pseg:hover .ptip { display: block; }
		/* Keep the edge segments' hover box inside the panel instead of clipping past its border. */
		.pseg.pedge-l .ptip { left: 0; transform: none; }
		.pseg.pedge-r .ptip { left: auto; right: 0; transform: none; }
		.pout { font-size: 11px; opacity: 0.75; margin-top: 8px; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		@keyframes qpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
		.lock-line { font-size: 12px; opacity: 0.8; display: flex; align-items: center; gap: 8px; }
		.lock-line .lk { color: #e0b050; }
		.lock-line .hashmini { opacity: 0.6; font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; }
		.detail h1 { font-size: 19px; margin: 0 0 4px; }
		.goal { font-size: 13px; opacity: 0.9; margin-bottom: 14px; }
		.meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; margin-bottom: 20px; }
		.meta div strong { opacity: 0.6; margin-right: 5px; font-weight: 500; }
		.reason { font-size: 12px; padding: 8px 12px; border-radius: 4px; margin-bottom: 18px; background: var(--vscode-inputValidation-warningBackground, #4a3c00); border: 1px solid var(--vscode-inputValidation-warningBorder, #b8860055); }
		.section { margin-bottom: 22px; }
		.section > h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
		.steps { margin: 0; padding-left: 18px; font-size: 13px; }
		.steps li { margin-bottom: 3px; }
		.checks { display: flex; flex-direction: column; gap: 7px; }
		.check { font-size: 12px; border-left: 2px solid var(--vscode-focusBorder); padding-left: 10px; }
		.check .cw { opacity: 0.7; margin-top: 2px; }
		.flowline { font-size: 12px; opacity: 0.9; margin-bottom: 4px; }
		.flowline strong { opacity: 0.6; margin-right: 5px; font-weight: 500; }
		pre.code { margin: 0; padding: 12px 14px; background: var(--vscode-textCodeBlock-background, #00000022); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 5px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; tab-size: 4; }
		.hash { font-size: 11px; opacity: 0.6; margin-top: 6px; font-family: var(--vscode-editor-font-family); word-break: break-all; }
		table.hist { border-collapse: collapse; width: 100%; font-size: 12px; }
		table.hist th, table.hist td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, transparent); vertical-align: top; }
		table.hist th { opacity: 0.6; font-weight: 500; }
		td.hist-empty { opacity: 0.5; text-align: center; padding: 12px 8px; }
		.v-pass { color: #4caf72; font-weight: 600; }
		.v-fail { color: #e06666; font-weight: 600; }
		.files { display: flex; flex-direction: column; gap: 1px; }
		.file { font-size: 12px; padding: 4px 8px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; gap: 7px; font-family: var(--vscode-editor-font-family); }
		.file:hover { background: var(--vscode-list-hoverBackground); }
		.file .fi { opacity: 0.7; }
		.prompt-box { font-size: 12px; background: var(--vscode-textBlockQuote-background, #00000018); border-left: 3px solid var(--vscode-focusBorder); padding: 10px 12px; border-radius: 0 4px 4px 0; }
		.prompt-box .pe { font-style: italic; opacity: 0.85; margin: 6px 0; }
		.copy { font-size: 11px; padding: 3px 10px; cursor: pointer; border: 1px solid var(--vscode-widget-border, currentColor); background: transparent; color: var(--vscode-foreground); border-radius: 3px; }
		.copy:hover { background: var(--vscode-list-hoverBackground); }
		/* Code version tree (git history): one row per iteration commit, dot = pass/fail. */
		.versions { display: flex; flex-direction: column; gap: 1px; }
		.ver { font-size: 12px; padding: 4px 8px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; gap: 8px; font-family: var(--vscode-editor-font-family); }
		.ver:hover { background: var(--vscode-list-hoverBackground); }
		.vdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #9a9a9a; }
		.vdot.v-pass { background: #4caf72; }
		.vdot.v-fail { background: #e06666; }
		/* Code section: ONE wide box split into a directory rail (LEFT) and the selected directory's files
		   (RIGHT), with a vertical divider. Plain text - no icons, no status colors. */
		/* Code + Results shown side by side, each as a single inline tree (folders expand, files are leaves). */
		.treecols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
		.treecol { flex: 1 1 240px; min-width: 240px; }
		.treecol h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
		.treepane { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); border-radius: 6px; overflow: auto; max-height: 340px; min-height: 80px; background: transparent; padding: 4px 0; }
				/* Folder tree (LEFT): one row per folder, chevron + indent. Files (RIGHT) are plain names, no tag. */
		.tfolder { font-size: 12px; padding: 4px 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; border-left: 2px solid transparent; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.tfolder:hover { background: var(--vscode-list-hoverBackground); }
		.tfolder.tsel { background: var(--vscode-list-activeSelectionBackground, rgba(90,140,255,0.18)); border-left-color: #4c8dff; }
		.tchev { display: inline-block; width: 10px; flex-shrink: 0; opacity: 0.7; font-size: 9px; text-align: center; }
		.tfname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.crnote { font-size: 11px; opacity: 0.55; padding: 6px 8px; line-height: 1.4; }
		.tfile { font-size: 12px; padding: 4px 8px; cursor: pointer; border-radius: 3px; font-family: var(--vscode-editor-font-family); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
		.tfile:hover { background: var(--vscode-list-hoverBackground); }
		.rname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.rsize { flex-shrink: 0; opacity: 0.5; font-size: 11px; font-variant-numeric: tabular-nums; }		.empty { opacity: 0.6; padding: 40px; text-align: center; font-size: 13px; }
	</style>
</head>
<body>
	<div class="detail" id="detail"><div class="empty">Loading loop...</div></div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		// Timestamps are stored as UTC ISO strings; show them in the VIEWER'S local timezone
		// (toLocaleString uses the browser/system locale + zone) so everyone sees their own clock.
		const fmtTime = (iso) => { try { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString(); } catch (e) { return ''; } };
		let loops = [];
		let selectedId = null;
		const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
		// Inline-tree state for the Code and Results sections: which folders are expanded (open), plus a
		// one-time "inited" flag that opens the top-level folders on first render. Kept across refreshes so
		// the view does not jump while a loop runs.
		const treeState = { code: { open: {}, inited: false }, results: { open: {}, inited: false } };

		// Build a folder tree from items [{ segs: [folder...], file: {...} }]. Returns the root node.
		function buildTree(rootName, items) {
			const root = { name: rootName, folders: {}, files: [] };
			for (const it of items) {
				let node = root;
				for (const seg of it.segs) {
					if (!node.folders[seg]) { node.folders[seg] = { name: seg, folders: {}, files: [] }; }
					node = node.folders[seg];
				}
				node.files.push(it.file);
			}
			return root;
		}
		// Flatten the tree into inline rows (folders AND files together, DFS), honoring the expanded set.
		// The synthetic root ("code"/"results") is NOT shown; its child folders (.shared/iter0, or the run
		// dirs under results/) AND its direct files become the top-level rows. Folders come before files at
		// each level; a folder expands in place, a file is a leaf that opens on click.
		function flattenInline(root, openMap) {
			const rows = [];
			function walk(node, pathStr, depth) {
				for (const name of Object.keys(node.folders).sort()) {
					const child = node.folders[name];
					const cpath = pathStr ? pathStr + '/' + name : name;
					const open = !!openMap[cpath];
					const hasKids = Object.keys(child.folders).length > 0 || (child.files && child.files.length > 0);
					rows.push({ type: 'folder', name, path: cpath, depth, open, hasKids });
					if (open) { walk(child, cpath, depth + 1); }
				}
				for (const fo of (node.files || [])) { rows.push({ type: 'file', file: fo, depth }); }
			}
			walk(root, '', 0);
			return rows;
		}
		// Render one section as a SINGLE inline tree: folders expand in place (chevron), files are leaves
		// that open on click. onFileClick(fileObj) posts the open message; showSize adds a byte size.
		function renderTree(root, el, state, showSize, onFileClick) {
			// First render: open the top-level folders so the user sees one level in without clicking.
			if (!state.inited) { state.inited = true; for (const name of Object.keys(root.folders)) { state.open[name] = true; } }
			const rows = flattenInline(root, state.open);
			const files = [];
			el.innerHTML = rows.map(r => {
				const pad = 6 + r.depth * 14;
				if (r.type === 'folder') {
					const chev = r.hasKids ? (r.open ? '&#9662;' : '&#9656;') : '';
					return '<div class="tfolder" data-path="' + esc(r.path) + '" style="padding-left:' + pad + 'px">'
						+ '<span class="tchev">' + chev + '</span><span class="tfname">' + esc(r.name) + '</span></div>';
				}
				const i = files.push(r.file) - 1;
				const size = (showSize && typeof r.file.size === 'number') ? '<span class="rsize">' + fmtSize(r.file.size) + '</span>' : '';
				return '<div class="tfile" data-i="' + i + '" style="padding-left:' + (pad + 16) + 'px">'
					+ '<span class="rname">' + esc(r.file.name) + '</span>' + size + '</div>';
			}).join('') || '<div class="crnote">No files.</div>';
			el.querySelectorAll('.tfolder').forEach(elem => {
				elem.onclick = () => { const p = elem.getAttribute('data-path'); state.open[p] = !state.open[p]; renderTree(root, el, state, showSize, onFileClick); };
			});
			el.querySelectorAll('.tfile').forEach(elem => {
				elem.onclick = () => { const fo = files[parseInt(elem.getAttribute('data-i'), 10)]; if (fo) { onFileClick(fo); } };
			});
		}

		const badgeClass = (s) => ({ running:'b-running', success:'b-success', failed:'b-failed', paused:'b-paused', stopped:'b-stopped', 'pending-approval':'b-pending' }[s] || 'b-pending');
		const statusLabel = (s) => s === 'pending-approval' ? 'pending' : s;
		// While running, show which iteration is in flight (the engine works iteration-by-iteration;
		// it cannot see individual steps inside a sub-agent turn, so the iteration is the live unit).
		const statusText = (l) => l.status === 'running' ? ('running \\u00b7 iter ' + (l.iteration + 1)) : statusLabel(l.status);

		// Build an inline SVG of THIS loop's actual cycle: (Input ->) each real step -> Evaluator
		// (labelled with its first check) -> Output/Done on pass, with a red "fail -> retry" arrow
		// from the Evaluator back up to the first step. Vertical so any number of steps fits; each
		// node shows the loop's own text (truncated, full text on hover) so the diagram is specific
		// to this loop, not a generic template.
		// Width-aware truncation: CJK/full-width glyphs count as 2 (they render ~2x wider than Latin),
		// so a Korean label is cut at the right visual length to fit a node box. A clipPath in the SVG
		// is the safety net that hard-clips anything still over.
		function charW(ch) {
			const c = ch.charCodeAt(0);
			return (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
				|| (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
		}
		function trunc(s, units) {
			s = String(s || '');
			let w = 0, out = '';
			for (const ch of s) { const cw = charW(ch); if (w + cw > units) { return out + '\\u2026'; } w += cw; out += ch; }
			return out;
		}
		// Tidy a raw flow label for the DIAGRAM (hover title keeps the original): only collapse
		// whitespace. We do NOT strip parentheses - many steps put the real content inside them.
		function refine(s) {
			return String(s || '').replace(/\\s+/g, ' ').trim();
		}
		// Flow as HTML boxes (text WRAPS, nothing truncated). Colored TAGS mark the key boxes: INPUT,
		// EVALUATE, RESULT; the step boxes are left plain. PASS goes down to the result, FAIL goes up
		// (back to step 1) - the up-arrow shows the loop-back.
		function flowDiagram(l) {
			const f = l.flow || {};
			const steps = (f.steps || []);
			const box = (cls, label, tag, tagcls, id) => '<div class="fnode ' + cls + '"' + (id ? ' id="' + id + '"' : '') + '>'
				+ (tag ? '<span class="ftag ' + tagcls + '">' + tag + '</span> ' : '') + esc(refine(label)) + '</div>';
			const arrow = '<div class="farrow">&#8595;</div>';
			const parts = [];
			if (f.input) { parts.push(box('fio', f.input, 'INPUT', 'tag-in')); }
			if (steps.length) { steps.forEach((st, i) => parts.push(box('fstep', (i + 1) + '. ' + st, '', '', i === 0 ? 'fstep1-node' : ''))); }
			else { parts.push(box('fstep', 'do the work', '', '', 'fstep1-node')); }
			const check0 = (f.checks && f.checks[0] && f.checks[0].c) ? f.checks[0].c : 'pass / fail test';
			parts.push(box('feval', check0, 'EVALUATE', 'tag-eval', 'feval-node'));
			let h = '<div class="flowh" id="flowh">' + parts.join(arrow)
				+ '<div class="fpass"><span class="ar">&#8595;</span>pass</div>'
				+ box('fio', f.output ? f.output : 'goal met', 'RESULT', 'tag-out')
				+ '</div>';
			return h;
		}

		// Draw the red "fail -> back to step 1" line in the flow's right gutter: from the EVALUATE box's
		// middle up to step 1, arrowhead pointing back into step 1. Built with createElementNS (no HTML
		// string) so the template's regex escaping never touches it.
		function drawLoopback() {
			try {
				const cont = document.getElementById('flowh');
				const evalN = document.getElementById('feval-node');
				const step1 = document.getElementById('fstep1-node');
				if (!cont || !evalN || !step1) { return; }
				const old = cont.querySelector('.loopback-svg'); if (old) { old.remove(); }
				const cr = cont.getBoundingClientRect();
				const er = evalN.getBoundingClientRect();
				const sr = step1.getBoundingClientRect();
				const NS = 'http://www.w3.org/2000/svg';
				const H = cont.clientHeight;
				const gutter = 48;
				const boxEdge = cr.width - gutter;
				const evalY = (er.top - cr.top) + er.height / 2;
				const step1Y = (sr.top - cr.top) + sr.height / 2;
				const svg = document.createElementNS(NS, 'svg');
				svg.setAttribute('class', 'loopback-svg');
				svg.setAttribute('width', String(gutter + 4));
				svg.setAttribute('height', String(H));
				svg.style.left = boxEdge + 'px';
				const x0 = 0, xr = 26;
				const path = document.createElementNS(NS, 'path');
				path.setAttribute('d', 'M ' + x0 + ' ' + evalY + ' H ' + xr + ' V ' + step1Y + ' H ' + x0);
				path.setAttribute('fill', 'none');
				path.setAttribute('stroke', '#e06666');
				path.setAttribute('stroke-width', '1.5');
				path.setAttribute('stroke-dasharray', '4 3');
				svg.appendChild(path);
				const head = document.createElementNS(NS, 'path');
				head.setAttribute('d', 'M ' + (x0 + 7) + ' ' + (step1Y - 4) + ' L ' + x0 + ' ' + step1Y + ' L ' + (x0 + 7) + ' ' + (step1Y + 4) + ' Z');
				head.setAttribute('fill', '#e06666');
				svg.appendChild(head);
				const label = document.createElementNS(NS, 'text');
				label.setAttribute('class', 'lb-label');
				label.setAttribute('x', String(xr + 3));
				label.setAttribute('y', String((evalY + step1Y) / 2));
				label.setAttribute('text-anchor', 'start');
				label.textContent = 'fail';
				svg.appendChild(label);
				cont.appendChild(svg);
			} catch (e) { /* best-effort decoration */ }
		}

		// Progress bar (below Flow): N segments = the loop's PLANNED steps (flow.steps); filled left-to-right
		// by the sub-agent's [QOKA_STEP k/N] markers. Shown only while the loop is running. The current step
		// pulses; the last stdout line shows below so a long single step still shows live movement.
		function progressBar(l) {
			const running = l.status === 'running' || l.status === 'pending-approval';
			const ls = l.liveStep;
			const steps = (l.flow && l.flow.steps) ? l.flow.steps : [];
			const n = (ls && ls.n) ? ls.n : steps.length;
			if ((!running && !ls) || !n) { return ''; }
			const k = ls ? ls.k : 0;
			let seg = '';
			for (let i = 1; i <= n; i++) {
				// Edge segments anchor their hover box to the panel edge so it is not clipped:
				// the first left-aligns, the last right-aligns; the middle ones stay centered.
				const edge = i === 1 ? ' pedge-l' : (i === n ? ' pedge-r' : '');
				const cls = (i < k ? 'pseg done' : (i === k ? 'pseg cur' : 'pseg')) + edge;
				// Short label ("step N") on the bar; the full step text shows in a hover box (.ptip).
				const detail = steps[i - 1] ? esc(refine(steps[i - 1])) : '';
				const tip = detail ? '<div class="ptip">' + detail + '</div>' : '';
				seg += '<div class="' + cls + '"><div class="pbarnode"></div><div class="plabel">step ' + i + '</div>' + tip + '</div>';
			}
			let out = '';
			if (ls && ls.out) { out = '<div class="pout">' + esc(ls.out) + '</div>'; }
			else if (running && !ls) { out = '<div class="pout" style="opacity:0.55">Waiting for the first [QOKA_STEP] marker...</div>'; }
			// Header text: which iteration + which step within it (iteration is 1-based for display).
			const iterNo = (typeof l.iteration === 'number' ? l.iteration : 0) + 1;
			const hdr = ls ? (' - iteration ' + iterNo + ', step ' + ls.k + ' of ' + ls.n + (ls.label ? ' (' + esc(ls.label) + ')' : '')) : (' - iteration ' + iterNo);
			return '<div class="section"><h2>Progress' + hdr + '</h2><div class="pbar">' + seg + '</div>' + out + '</div>';
		}

		function renderDetail() {
			const l = loops.find(x => x.id === selectedId);
			if (!l) { $('detail').innerHTML = '<div class="empty">Select a loop.</div>'; return; }
			const f = l.flow || {};
			const running = l.status === 'running' || l.status === 'pending-approval';
			const totalMs = (l.history || []).reduce((a, h) => a + (typeof h.durationMs === 'number' ? h.durationMs : 0), 0);
			const fmtDurTop = (ms) => ms < 1000 ? ms + 'ms' : (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's');
			const checks = (f.checks || []).map(c => '<div class="check"><div>' + esc(c.c) + '</div><div class="cw">' + esc(c.why) + '</div></div>').join('');
			const steps = (f.steps || []).map(s => '<li>' + esc(s) + '</li>').join('');
			const fmtDur = (ms) => (typeof ms !== 'number') ? '' : (ms < 1000 ? ms + 'ms' : (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's'));
			const cleanDetail = (d) => { d = String(d || '').replace(/\\s+/g, ' ').trim(); return d.length > 140 ? d.slice(0, 139) + '...' : d; };
			const hist = (l.history || []).map(h => '<tr><td>' + h.iteration + '</td><td class="' + (h.verdict === 'pass' ? 'v-pass' : 'v-fail') + '">' + esc(h.verdict || '') + '</td><td>' + fmtDur(h.durationMs) + '</td><td>' + esc(cleanDetail(h.detail)) + '</td><td>' + fmtTime(h.at) + '</td></tr>').join('');
			// Code folder tree: a ".shared" folder (the locked evaluator) + one folder per iteration
			// (iter0, iter1, ...), each holding that iteration's real files (which may have their own subdirs).
			// The evaluator folder is named ".shared" so it sorts ABOVE iter0 and always sits at the top.
			const codeItems = [];
			if (l.evaluatorFile) { codeItems.push({ segs: ['.shared'], file: { name: l.evaluatorFile.rel, kind: 'file', path: l.evaluatorFile.abs } }); }
			(l.versions || []).slice().sort((a, b) => a.iter - b.iter).forEach(v => {
				const iterName = 'iter' + (v.iter >= 0 ? v.iter : '?');
				(v.files || []).forEach(fp => {
					const parts = String(fp).split('/');
					codeItems.push({ segs: [iterName].concat(parts.slice(0, -1)), file: { name: parts[parts.length - 1], kind: 'version', hash: v.hash, file: fp } });
				});
			});
			const codeTree = buildTree('code', codeItems);
			// Make sure every iteration shows as a folder even if it captured no files.
			(l.versions || []).forEach(v => { const n = 'iter' + (v.iter >= 0 ? v.iter : '?'); if (!codeTree.folders[n]) { codeTree.folders[n] = { name: n, folders: {}, files: [] }; } });

			// Results folder tree: the real directory structure under loops/<folder>/results (nothing hidden).
			const resItems = (l.results || []).map(fl => {
				const parts = String(fl.rel).split('/');
				return { segs: parts.slice(0, -1), file: { name: parts[parts.length - 1], kind: 'file', path: fl.abs, size: fl.size } };
			});
			const resultsTree = buildTree('results', resItems);

			let h = '<h1>' + esc(l.title) + '</h1><div class="goal">' + esc(l.goal) + '</div>';
			h += '<div class="meta">'
				+ '<div><strong>Status</strong><span class="badge ' + badgeClass(l.status) + '">' + esc(statusText(l)) + '</span></div>'
				+ '<div><strong>Iteration</strong>' + l.iteration + ' / ' + l.budget.maxIter + '</div>'
				+ '<div><strong>Budget</strong>' + l.budget.maxIter + ' iters, ' + l.budget.maxMin + ' min</div>'
				// While the loop is still running (or awaiting approval), the totals are partial and keep
				// changing, so show "-"; the finalized Tokens / Total time appear once the loop ends.
				+ '<div><strong>Tokens</strong>' + (running ? '-' : ((l.budget.usedTokens && l.budget.usedTokens > 0) ? l.budget.usedTokens.toLocaleString() : '0')) + '</div>'
				+ '<div><strong>Total time</strong>' + (running ? '-' : (totalMs > 0 ? fmtDurTop(totalMs) : '0s')) + '</div>'
				+ (l.provider ? '<div><strong>Provider</strong>' + esc(l.provider) + '</div>' : '')
				+ '<div><strong>Updated</strong>' + fmtTime(l.updatedAt) + '</div>'
				+ '</div>';
			if (l.reason) { h += '<div class="reason">' + esc(l.reason) + '</div>'; }

			// Input / Output are shown as nodes in the diagram (with full text on hover), so we do not
			// repeat them as text lines here - that was the cluttered part. Keep the readable step list.
			h += '<div class="section"><h2>Flow</h2>';
			h += flowDiagram(l);
			h += '</div>';
			h += progressBar(l);

			// Stops on the FIRST of these; derived from the budget + engine rules so it always matches what
			// the engine does. Kept short - the goal (the success condition) is already shown at the top.
			const stopItems = [
				'The evaluator passes &#8594; success',
				l.budget.maxIter + ' iterations reached',
				l.budget.maxMin + ' minutes elapsed',
				'No progress: the same failure 3 times',
			];
			h += '<div class="section"><h2>Loop stop conditions (whichever comes first)</h2><ul class="steps">'
				+ stopItems.map(x => '<li>' + x + '</li>').join('') + '</ul></div>';

			// Always show the History frame (headers) so it is there from the start; the body is empty
			// until the first iteration finishes.
			h += '<div class="section"><h2>History</h2><table class="hist"><tr><th>#</th><th>verdict</th><th>time</th><th>detail</th><th>at</th></tr>'
				+ (hist || '<tr><td colspan="5" class="hist-empty">No iterations yet.</td></tr>') + '</table></div>';

			// Code + Results side by side, each a single inline tree (folders expand, files open on click).
			h += '<div class="section"><div class="treecols">'
				+ '<div class="treecol"><h2>Code</h2><div class="treepane" id="codetree"></div></div>'
				+ '<div class="treecol"><h2>Results</h2><div class="treepane" id="resulttree"></div></div>'
				+ '</div></div>';

			$('detail').innerHTML = h;

			const codeTreeEl = document.getElementById('codetree');
			if (codeTreeEl) {
				if (!Object.keys(codeTree.folders).length && !(codeTree.files || []).length) {
					codeTreeEl.innerHTML = '<div class="empty" style="padding:8px;text-align:left">No code yet (no iterations, or git unavailable).</div>';
				} else {
					renderTree(codeTree, codeTreeEl, treeState.code, false, (fo) => {
						if (fo.kind === 'version') { vscode.postMessage({ type: 'openVersion', codeDir: l.codeDir, hash: fo.hash, file: fo.file }); }
						else { vscode.postMessage({ type: 'openFile', path: fo.path }); }
					});
				}
			}
			const resTreeEl = document.getElementById('resulttree');
			if (resTreeEl) {
				if (!Object.keys(resultsTree.folders).length && !resultsTree.files.length) {
					resTreeEl.innerHTML = '<div class="empty" style="padding:8px;text-align:left">No result files yet.</div>';
				} else {
					renderTree(resultsTree, resTreeEl, treeState.results, true, (fo) => vscode.postMessage({ type: 'openFile', path: fo.path }));
				}
			}
			// The fail-return line needs the boxes' measured positions, so draw it after layout.
			requestAnimationFrame(drawLoopback);
		}

		// Keep the fail-return line aligned when the panel is resized.
		window.addEventListener('resize', () => requestAnimationFrame(drawLoopback));

		// This webview shows ONE loop's detail (the loop list lives in the left sidebar view, which
		// opens this editor for the clicked loop). The server pushes the focused loop; we render it.
		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'data') {
				loops = msg.loops || [];
				if (msg.select && loops.some(l => l.id === msg.select)) { selectedId = msg.select; }
				else if (!selectedId || !loops.some(l => l.id === selectedId)) { selectedId = msg.selectedId || (loops[0] && loops[0].id) || null; }
				renderDetail();
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}
