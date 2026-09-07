/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/**
 * "Figures" section of the Manuscript tab: a SEPARATE collapsible view (like the
 * Analysis tab's Changes/Snapshots) that shows the generated figures kept hidden
 * in `.qoka/figures/` as thumbnails. Clicking one opens it in VS Code's built-in
 * image preview - the hidden path never appears in the Analysis file tree.
 */
export class AriaFiguresView extends ViewPane {

	static readonly ID = 'aria.manuscript.figures';

	private viewBody: HTMLElement | undefined;
	private seq = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => { const d = this.figuresDir(); if (d && e.affects(d)) { void this.refresh(); } }));
	}

	private folderUri(): URI | undefined { return this.workspaceContextService.getWorkspace().folders[0]?.uri; }
	private figuresDir(): URI | undefined { const f = this.folderUri(); return f ? joinPath(f, '.qoka', 'figures') : undefined; }

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-figures-view'));
		Object.assign(root.style, { padding: '8px 10px', boxSizing: 'border-box' });
		this.viewBody = root;
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		const seq = ++this.seq;
		const figures = await this.loadFigures();
		if (seq !== this.seq) { return; }
		clearNode(root);
		if (figures.length === 0) {
			const p = append(root, $('div'));
			p.textContent = localize('aria.figures.empty', "No figures yet. Ask the chat to create one.");
			Object.assign(p.style, { opacity: '0.7', fontSize: '12.5px', margin: '2px 6px' });
			return;
		}
		const grid = append(root, $('div'));
		Object.assign(grid.style, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
		for (const f of figures) {
			const cell = append(grid, $('div'));
			Object.assign(cell.style, { width: '78px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '3px' });
			cell.title = f.name;
			const thumb = append(cell, $('img')) as HTMLImageElement;
			thumb.src = FileAccess.uriToBrowserUri(f.resource).toString();
			Object.assign(thumb.style, { width: '78px', height: '78px', objectFit: 'cover', border: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.3))', borderRadius: '4px', background: 'var(--vscode-editorWidget-background)' });
			const cap = append(cell, $('div')); cap.textContent = f.name;
			Object.assign(cap.style, { fontSize: '10px', opacity: '0.7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
			// Built-in image preview (centers/fits correctly), not the result-viewer plugin.
			cell.onclick = () => { void this.editorService.openEditor({ resource: f.resource, options: { pinned: true, override: 'imagePreview.previewEditor' } }); };
		}
	}

	private async loadFigures(): Promise<{ name: string; resource: URI }[]> {
		const dir = this.figuresDir();
		if (!dir) { return []; }
		try {
			const stat = await this.fileService.resolve(dir);
			const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
			const files = (stat.children ?? []).filter(c => !c.isDirectory && isImg.test(c.name)).map(c => ({ name: c.name, resource: c.resource }));
			files.sort((a, b) => a.name.localeCompare(b.name));
			return files;
		} catch {
			return [];
		}
	}
}
