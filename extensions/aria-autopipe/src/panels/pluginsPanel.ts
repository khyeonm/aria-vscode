/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { qokaWebviewAccentCss } from './webviewTheme';

let activePanel: vscode.WebviewPanel | undefined;

/** Mirror of the extension's ResultViewerRow (the aria.resultViewer.list command). */
interface ResultViewerRow {
	name: string;
	description: string;
	extensions: string[];
	author: string;
	hubVersion: string | null;
	installedVersion: string | null;
	isDefault: boolean;
	isPipeline: boolean;
	installed: boolean;
	removed: boolean;
}

/**
 * Editor-area webview panel that manages the Result Viewers (the file viewers
 * that open result files by type). Lists default + Hub viewers, with search,
 * refresh, and Install / Remove. Backed by the `aria.resultViewer.*` commands,
 * so installing / removing here re-syncs the editor associations. Opened from
 * the Settings "Result Viewer" section.
 */
export async function openPluginsPanel(): Promise<void> {
	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.Active);
		return;
	}
	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.plugins',
		'Result Viewers',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	activePanel = panel;
	panel.onDidDispose(() => { activePanel = undefined; });

	panel.webview.html = renderHtml(panel.webview);

	const sendRows = async () => {
		try {
			const rows = (await vscode.commands.executeCommand<ResultViewerRow[]>('aria.resultViewer.list')) ?? [];
			panel.webview.postMessage({ type: 'aria.viewers.list.ok', rows });
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.viewers.list.error', error: (err as Error).message });
		}
	};

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; name?: string }) => {
		if (msg?.type === 'aria.viewers.list') {
			await sendRows();
		} else if (msg?.type === 'aria.viewers.install' && msg.name) {
			try {
				await vscode.commands.executeCommand('aria.resultViewer.install', msg.name);
				panel.webview.postMessage({ type: 'aria.viewers.action.ok', name: msg.name, verb: 'installed' });
				await sendRows();
			} catch (err) {
				panel.webview.postMessage({ type: 'aria.viewers.action.error', name: msg.name, error: (err as Error).message });
			}
		} else if (msg?.type === 'aria.viewers.remove' && msg.name) {
			try {
				await vscode.commands.executeCommand('aria.resultViewer.remove', msg.name);
				panel.webview.postMessage({ type: 'aria.viewers.action.ok', name: msg.name, verb: 'removed' });
				await sendRows();
			} catch (err) {
				panel.webview.postMessage({ type: 'aria.viewers.action.error', name: msg.name, error: (err as Error).message });
			}
		}
	});

	// Auto-fetch on open.
	await sendRows();
}

function renderHtml(webview: vscode.Webview): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:`;
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Result Viewers</title>
	<style>
		${qokaWebviewAccentCss()}
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
		h1 { font-size: 16px; margin: 0 0 4px 0; }
		.subtitle { font-size: 12px; opacity: 0.7; margin-bottom: 16px; }
		.toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
		.toolbar input {
			flex: 1;
			padding: 6px 8px;
			font-size: 13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			box-sizing: border-box;
		}
		.row { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; background: var(--vscode-editorWidget-background); margin-bottom: 8px; }
		.row .body { flex: 1; }
		.row .name { font-size: 13px; font-weight: 600; }
		.row .meta { font-size: 11px; opacity: 0.7; margin-top: 2px; }
		.row .desc { font-size: 12px; opacity: 0.9; margin-top: 4px; }
		.row .exts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
		.chip { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10.5px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 0.85; }
		.row .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
		.btn { padding: 5px 14px; font-size: 12px; cursor: pointer; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.btn.secondary { background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
		.btn[disabled] { opacity: 0.5; cursor: default; }
		.tag-default { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: transparent; border: 1px solid rgba(127,127,127,0.55); color: var(--vscode-descriptionForeground, var(--vscode-foreground)); vertical-align: middle; }
		.tag-pipeline { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(127,127,127,0.22); color: var(--vscode-foreground); vertical-align: middle; }
		.empty { padding: 24px; text-align: center; opacity: 0.6; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); color: var(--vscode-inputValidation-errorForeground, #c44); border-radius: 3px; }
		.toast { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; max-width: 320px; }
		.toast.error { color: var(--vscode-errorForeground); }
	</style>
</head>
<body>
	<h1>Result Viewers</h1>
	<div class="subtitle">Viewers that open result files by type. Default viewers install automatically; remove any you do not want (its files then open in VS Code or an installed extension). Install more from the Hub, including ones shared by other users. PDF and images use Qoka's built-in viewers by default; remove them here to open those files in VS Code instead.</div>
	<div class="toolbar">
		<input id="q" placeholder="Search by name, description, or extension…" />
		<button class="btn secondary" id="refresh">Refresh</button>
	</div>
	<div id="results"></div>
	<div id="toast"></div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		function escapeHtml(s) {
			return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		let allRows = [];
		function applyFilter() {
			const q = $('q').value.trim().toLowerCase();
			if (!q) { render(allRows); return; }
			const filtered = allRows.filter(r => {
				if (r.name && r.name.toLowerCase().includes(q)) return true;
				if (r.description && r.description.toLowerCase().includes(q)) return true;
				if (r.author && r.author.toLowerCase().includes(q)) return true;
				if (r.extensions && r.extensions.some(e => e.toLowerCase().includes(q))) return true;
				return false;
			});
			render(filtered);
		}
		$('q').addEventListener('input', applyFilter);
		$('refresh').addEventListener('click', () => { vscode.postMessage({ type: 'aria.viewers.list' }); });

		function render(rows) {
			if (!rows || rows.length === 0) {
				$('results').innerHTML = '<div class="empty">No viewers found.</div>';
				return;
			}
			const html = rows.map(row => {
				const tag = row.isDefault ? '<span class="tag-default">default</span>' : '';
				const pipeTag = row.isPipeline ? '<span class="tag-pipeline">pipeline</span>' : '';
				const meta = [
					row.author ? '@' + row.author : '',
					row.hubVersion ? 'v' + row.hubVersion + (row.installedVersion && row.installedVersion !== row.hubVersion ? ' (have v' + row.installedVersion + ')' : '') : (row.installedVersion ? 'v' + row.installedVersion : ''),
				].filter(Boolean).join(' \\u00b7 ');
				const exts = (row.extensions || []).map(e => '<span class="chip">.' + escapeHtml(e) + '</span>').join('');
				let actions = '';
				if (!row.installed) {
					actions = '<button class="btn" data-act="install" data-name="' + escapeHtml(row.name) + '">Install</button>';
				} else {
					if (row.hubVersion && row.installedVersion && row.installedVersion !== row.hubVersion) {
						actions += '<button class="btn" data-act="install" data-name="' + escapeHtml(row.name) + '">Update</button>';
					}
					actions += '<button class="btn secondary" data-act="remove" data-name="' + escapeHtml(row.name) + '">Remove</button>';
				}
				return '<div class="row">'
					+ '<div class="body">'
					+ '<div class="name">' + escapeHtml(row.name) + ' ' + tag + ' ' + pipeTag + '</div>'
					+ '<div class="meta">' + escapeHtml(meta) + '</div>'
					+ '<div class="desc">' + escapeHtml(row.description) + '</div>'
					+ (exts ? '<div class="exts">' + exts + '</div>' : '')
					+ '</div>'
					+ '<div class="actions">' + actions + '</div>'
					+ '</div>';
			}).join('');
			$('results').innerHTML = html;
			document.querySelectorAll('.btn[data-name]').forEach(btn => {
				btn.onclick = () => {
					const name = btn.getAttribute('data-name');
					const act = btn.getAttribute('data-act');
					btn.disabled = true;
					btn.textContent = act === 'remove' ? 'Removing…' : 'Working…';
					vscode.postMessage({ type: act === 'remove' ? 'aria.viewers.remove' : 'aria.viewers.install', name });
				};
			});
		}
		function toast(msg, error) {
			const t = $('toast');
			t.innerHTML = '<div class="toast' + (error ? ' error' : '') + '">' + escapeHtml(msg) + '</div>';
			setTimeout(() => { t.innerHTML = ''; }, 4000);
		}
		window.addEventListener('message', (e) => {
			if (e.data.type === 'aria.viewers.list.ok') { allRows = e.data.rows || []; applyFilter(); }
			else if (e.data.type === 'aria.viewers.list.error') $('results').innerHTML = '<div class="err">' + escapeHtml(e.data.error) + '</div>';
			else if (e.data.type === 'aria.viewers.action.ok') toast(e.data.name + ' ' + e.data.verb + '.', false);
			else if (e.data.type === 'aria.viewers.action.error') toast(e.data.name + ': ' + e.data.error, true);
		});
		vscode.postMessage({ type: 'aria.viewers.list' });
	</script>
</body>
</html>`;
}
