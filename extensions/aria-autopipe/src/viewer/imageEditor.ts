/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * A read-only in-app image viewer (zoom / pan / rotate / fit), bundled INTO Qoka
 * like the PDF viewer - NOT a downloaded Hub plugin. This exists so images always
 * open correctly inside Qoka regardless of the shared autopipe image-viewer
 * plugin: the plugin renders fine in the autopipe web app but its centering math
 * is fragile inside Qoka's webview host, and it is shared with autopipe (so we
 * must not change it). A native custom editor lets Qoka control both the host and
 * the rendering. Registered as the DEFAULT editor for common raster image types;
 * `image-viewer` is therefore in NATIVE_VIEWER_NAMES so the Hub plugin is neither
 * installed nor used. Local files only - served via the webview's asWebviewUri.
 */
export class QokaImageEditorProvider implements vscode.CustomReadonlyEditorProvider {

	static readonly viewType = 'qoka.imageViewer';

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { /* no per-document resources */ } };
	}

	resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const fileDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
		panel.webview.options = { enableScripts: true, localResourceRoots: [fileDir] };
		panel.webview.html = buildHtml(panel.webview, document.uri);
	}
}

function buildHtml(webview: vscode.Webview, file: vscode.Uri): string {
	const imgUri = webview.asWebviewUri(file);
	const cspSource = webview.cspSource;
	const csp = [
		`default-src 'none'`,
		`img-src ${cspSource} data: blob:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src ${cspSource} 'unsafe-inline'`,
	].join('; ');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	html,body{margin:0;padding:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);}
	#toolbar{position:sticky;top:0;display:flex;gap:6px;align-items:center;padding:6px 10px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border,transparent);font-size:12px;z-index:1;}
	#toolbar button{cursor:pointer;background:var(--vscode-button-secondaryBackground,rgba(127,127,127,.2));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border:none;border-radius:3px;padding:3px 10px;font-size:12px;}
	#toolbar button:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(127,127,127,.32));}
	#toolbar .sep{flex:1;}
	#toolbar .stat{opacity:.7;font-size:11px;}
	/* The stage fills the editor and CENTERS the image with flexbox (this is the
	   part the shared plugin got wrong inside Qoka). The transform only zooms /
	   pans / rotates - no absolute positioning, so a large image never lands
	   off-screen and Fit truly re-centers. */
	#stage{position:absolute;top:37px;left:0;right:0;bottom:0;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:grab;
		background-image:linear-gradient(45deg,rgba(127,127,127,.12) 25%,transparent 25%),linear-gradient(-45deg,rgba(127,127,127,.12) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,rgba(127,127,127,.12) 75%),linear-gradient(-45deg,transparent 75%,rgba(127,127,127,.12) 75%);
		background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
	#stage.grabbing{cursor:grabbing;}
	#img{position:static;max-width:none;user-select:none;-webkit-user-drag:none;transform-origin:center center;}
	#status{padding:12px;opacity:.7;font-size:12px;}
</style>
</head>
<body>
<div id="toolbar">
	<button id="zoomout" title="Zoom out">-</button>
	<span class="stat" id="zoom">100%</span>
	<button id="zoomin" title="Zoom in">+</button>
	<button id="fit" title="Fit to window">Fit</button>
	<button id="actual" title="Actual size">1:1</button>
	<button id="rotate" title="Rotate 90&deg;">Rotate</button>
	<button id="reset" title="Reset">Reset</button>
	<span class="sep"></span>
	<span class="stat" id="dims"></span>
</div>
<div id="stage"><img id="img" alt="" src="${imgUri}"></div>
<div id="status" style="display:none">Could not load this image.</div>
<script>
	const stage = document.getElementById('stage');
	const img = document.getElementById('img');
	const zoomEl = document.getElementById('zoom');
	const dimsEl = document.getElementById('dims');
	let zoom = 1, rot = 0, panX = 0, panY = 0, iw = 0, ih = 0;

	function apply() {
		img.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ') rotate(' + rot + 'deg)';
		zoomEl.textContent = Math.round(zoom * 100) + '%';
	}
	function fit() {
		const cw = stage.clientWidth, ch = stage.clientHeight;
		if (!iw || !ih || !cw || !ch) { return; }
		// Account for rotation: at 90/270 the image's width/height swap.
		const rotated = (rot % 180) !== 0;
		const w = rotated ? ih : iw, h = rotated ? iw : ih;
		zoom = Math.min(cw / w, ch / h, 1);
		panX = 0; panY = 0;
		apply();
	}
	function setZoom(next) { zoom = Math.min(10, Math.max(0.05, Math.round(next * 100) / 100)); apply(); }

	document.getElementById('zoomin').onclick = () => setZoom(zoom * 1.25);
	document.getElementById('zoomout').onclick = () => setZoom(zoom / 1.25);
	document.getElementById('fit').onclick = fit;
	document.getElementById('actual').onclick = () => { zoom = 1; panX = 0; panY = 0; apply(); };
	document.getElementById('rotate').onclick = () => { rot = (rot + 90) % 360; fit(); };
	document.getElementById('reset').onclick = () => { zoom = 1; rot = 0; panX = 0; panY = 0; apply(); };

	stage.addEventListener('wheel', (e) => {
		e.preventDefault();
		setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
	}, { passive: false });

	let dragging = false, sx = 0, sy = 0;
	stage.addEventListener('mousedown', (e) => { dragging = true; sx = e.clientX - panX; sy = e.clientY - panY; stage.classList.add('grabbing'); e.preventDefault(); });
	window.addEventListener('mousemove', (e) => { if (!dragging) { return; } panX = e.clientX - sx; panY = e.clientY - sy; apply(); });
	window.addEventListener('mouseup', () => { dragging = false; stage.classList.remove('grabbing'); });

	img.onload = () => { iw = img.naturalWidth; ih = img.naturalHeight; dimsEl.textContent = iw + ' x ' + ih; fit(); };
	img.onerror = () => { stage.style.display = 'none'; document.getElementById('status').style.display = 'block'; };
	window.addEventListener('resize', () => { fit(); });
</script>
</body>
</html>`;
}
