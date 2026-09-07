/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { renderAriaTabSummary, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

interface ReviewEntry { execId: string; title: string; when: number; whenStr: string; draft: boolean }

/**
 * Sidebar "Manuscript" view: the merged Paper Writing + Peer Review list. The "+"
 * lets the user choose whether to start writing a paper or run a peer review; the
 * body then shows a "Writing" section (papers in `paper/<id>/`) and a "Reviews"
 * section (runs in `reviews/<execId>/`). Rows reuse the existing
 * `aria.paperWriter.*` / `aria.peerReview.*` commands, so the editor panes are
 * unchanged.
 */
export class AriaManuscriptView extends ViewPane {

	static readonly ID = 'aria.manuscript.main';

	private viewBody: HTMLElement | undefined;
	/** Guards against overlapping refresh() runs. Each async refresh loads its data,
	 *  then bails if a newer refresh started meanwhile - otherwise two interleaved
	 *  runs both append their sections and the list duplicates (e.g. a second
	 *  "Reviews" header on top). */
	private refreshSeq = 0;

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
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			const papers = this.papersDir();
			const reviews = this.reviewsDir();
			if ((papers && e.affects(papers)) || (reviews && e.affects(reviews))) { void this.refresh(); }
		}));
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'manuscript', options ?? {})
			?? super.createActionViewItem(action, options);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-manuscript-view'));
		root.style.padding = '8px 10px';
		root.style.boxSizing = 'border-box';
		this.viewBody = root;
		void this.refresh();
	}

	private folderUri(): URI | undefined { return this.workspaceContextService.getWorkspace().folders[0]?.uri; }
	private papersDir(): URI | undefined { const f = this.folderUri(); return f ? joinPath(f, '.qoka', 'manuscript', 'draft') : undefined; }
	private reviewsDir(): URI | undefined { const f = this.folderUri(); return f ? joinPath(f, '.qoka', 'manuscript', 'review') : undefined; }

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		const seq = ++this.refreshSeq;

		const isEmpty = this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;

		// Load ALL async data up front (papers, reviews, and their export file lists)
		// so the DOM build below has no awaits. An await between clearNode and the
		// appends is what let two overlapping refreshes interleave and duplicate a
		// section; precomputing removes that window, and the seq check drops any run
		// a newer refresh has superseded.
		const papers = isEmpty ? [] : await this.loadPapers();
		const reviews = isEmpty ? [] : await this.loadReviews();
		const reviewsDir = this.reviewsDir();
		const paperExports = await Promise.all(papers.map(p => this.loadExports(joinPath(p.folder, 'export'))));
		const reviewExports = await Promise.all(reviews.map(r => reviewsDir ? this.loadExports(joinPath(reviewsDir, r.execId, 'export')) : Promise.resolve([])));

		if (seq !== this.refreshSeq) { return; } // a newer refresh superseded this one

		clearNode(root);

		// Full-width one-line summary at the top of the sidebar.
		renderAriaTabSummary(root, 'manuscript');

		if (isEmpty) {
			this.empty(root, localize('aria.manuscript.noFolder', "Open a project folder to write and review papers."));
			return;
		}

		// The "+" chooser: start a new paper or a new review.
		const newBtn = append(root, $('button')) as HTMLButtonElement;
		newBtn.textContent = localize('aria.manuscript.new', "+ New");
		Object.assign(newBtn.style, { width: '100%', padding: '6px 10px', marginBottom: '10px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: 'none', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' });
		newBtn.onclick = () => void this.chooseNew();

		this.section(root, localize('aria.manuscript.writing', "Writing"));
		if (papers.length === 0) {
			this.empty(root, localize('aria.manuscript.noPapers', "No papers yet."));
		} else {
			papers.forEach((p, i) => {
				this.paperRow(root, p.folder, p.title);
				this.renderExports(root, paperExports[i]);
			});
		}

		this.section(root, localize('aria.manuscript.reviews', "Reviews"));
		if (reviews.length === 0) {
			this.empty(root, localize('aria.manuscript.noReviews', "No reviews yet."));
		} else {
			reviews.forEach((r, i) => {
				this.reviewRow(root, r);
				this.renderExports(root, reviewExports[i]);
			});
		}

	}

	/** Read a row's export/ folder file list (sorted). [] when there is no folder. */
	private async loadExports(dir: URI): Promise<{ name: string; resource: URI }[]> {
		try {
			const stat = await this.fileService.resolve(dir);
			const files = (stat.children ?? []).filter(c => !c.isDirectory).map(c => ({ name: c.name, resource: c.resource }));
			files.sort((a, b) => a.name.localeCompare(b.name));
			return files;
		} catch { return []; }
	}

	/** Render a row's exported files indented beneath it; clicking one opens it in
	 *  the editor. Synchronous (files are pre-loaded) so it can't interleave. */
	private renderExports(root: HTMLElement, files: { name: string; resource: URI }[]): void {
		for (const f of files) {
			const row = append(root, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 3px 28px', borderRadius: '4px', cursor: 'pointer' });
			row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };
			row.onclick = () => { void this.editorService.openEditor({ resource: f.resource, options: { pinned: true } }); };
			// Leftmost format tag (md / docx / latex) so long title-based filenames
			// stay distinguishable at a glance.
			const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
			const tag = append(row, $('span'));
			tag.textContent = ext === 'tex' ? 'latex' : ext;
			Object.assign(tag.style, { flexShrink: '0', fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.03em', opacity: '0.75', minWidth: '38px', textAlign: 'center', padding: '1px 5px', borderRadius: '4px', background: 'var(--vscode-badge-background, rgba(127,127,127,0.25))', color: 'var(--vscode-badge-foreground, var(--vscode-foreground))' });
			const label = append(row, $('span'));
			label.textContent = f.name;
			Object.assign(label.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', opacity: '0.85' });
			// "Save As" download button at the right end: opens the OS save dialog so
			// the user can copy the export anywhere. A down-arrow-into-tray glyph (inline
			// SVG - no exact codicon matches), no hover label.
			const dl = append(row, $('div'));
			Object.assign(dl.style, { display: 'flex', alignItems: 'center', flexShrink: '0', opacity: '0.6', cursor: 'pointer' });
			dl.appendChild(this.downloadGlyph());
			dl.addEventListener('mouseenter', () => { dl.style.opacity = '1'; });
			dl.addEventListener('mouseleave', () => { dl.style.opacity = '0.6'; });
			dl.onclick = (e) => { e.stopPropagation(); void this.saveAs(f.resource, f.name); };
		}
	}

	/** Down-arrow-into-open-tray "download" glyph as an inline SVG. */
	private downloadGlyph(): SVGSVGElement {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.5');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const arrow = document.createElementNS(ns, 'path');
		arrow.setAttribute('d', 'M8 2.5V8.8M5.1 6 8 9 10.9 6'); // shaft + downward head
		const tray = document.createElementNS(ns, 'path');
		tray.setAttribute('d', 'M3.5 10.5V13H12.5V10.5'); // open-top tray
		svg.appendChild(arrow);
		svg.appendChild(tray);
		return svg;
	}

	/** Copy an exported file somewhere the user picks via the OS save dialog. */
	private async saveAs(source: URI, name: string): Promise<void> {
		const defaultUri = joinPath(await this.fileDialogService.defaultFilePath(), name);
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('aria.manuscript.saveAsTitle', "Save exported file as"),
			defaultUri,
		});
		if (!target) { return; }
		try {
			await this.fileService.copy(source, target, true);
		} catch (e) {
			// Fallback: read + write (e.g. cross-provider copies the copy API rejects).
			try {
				const content = await this.fileService.readFile(source);
				await this.fileService.writeFile(target, content.value);
			} catch { /* surfaced by the dialog staying; nothing else to do */ }
		}
	}

	// --- chooser -----------------------------------------------------------

	/** A small centered modal: write a new paper, or run a new review. */
	private chooseNew(): void {
		const doc = this.viewBody?.ownerDocument ?? document;
		const backdrop = doc.createElement('div');
		Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '2000', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' });
		const card = doc.createElement('div');
		Object.assign(card.style, {
			minWidth: '320px', background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
			border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
			boxShadow: '0 6px 24px rgba(0,0,0,0.4)', padding: '14px', color: 'var(--vscode-foreground)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '13px',
		});
		const title = append(card, $('div'));
		title.textContent = localize('aria.manuscript.newTitle', "New");
		Object.assign(title.style, { fontWeight: '600', marginBottom: '10px' });

		const finish = (run?: () => void) => { doc.removeEventListener('keydown', onKey, true); backdrop.remove(); run?.(); };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(); } };
		const option = (icon: string, label: string, desc: string, command: string) => {
			const row = append(card, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '6px', cursor: 'pointer' });
			row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; });
			row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
			const ic = append(row, $(`span.codicon.${icon}`)) as HTMLElement;
			Object.assign(ic.style, { fontSize: '16px', opacity: '0.8' });
			const text = append(row, $('div'));
			const l = append(text, $('div')); l.textContent = label; l.style.fontWeight = '600';
			const d = append(text, $('div')); d.textContent = desc; Object.assign(d.style, { fontSize: '11px', opacity: '0.7' });
			row.onclick = () => finish(() => void this.commandService.executeCommand(command));
		};
		option('codicon-edit', localize('aria.manuscript.optWriting', "Paper writing"), localize('aria.manuscript.optWritingHint', "Draft a paper step by step with the AI"), 'aria.paperWriter.new');
		option('codicon-checklist', localize('aria.manuscript.optReview', "Paper review"), localize('aria.manuscript.optReviewHint', "Get AI reviewers to critique a paper"), 'aria.peerReview.new');

		backdrop.onclick = (e) => { if (e.target === backdrop) { finish(); } };
		backdrop.appendChild(card);
		doc.body.appendChild(backdrop);
		doc.addEventListener('keydown', onKey, true);
	}

	// --- rows --------------------------------------------------------------

	private paperRow(root: HTMLElement, folder: URI, title: string): void {
		const row = this.baseRow(root);
		row.onclick = () => void this.commandService.executeCommand('aria.paperWriter.open', folder);
		const icon = append(row, $('span.codicon.codicon-output')) as HTMLElement;
		icon.style.flexShrink = '0'; icon.style.opacity = '0.7';
		const label = append(row, $('span'));
		label.textContent = title;
		Object.assign(label.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' });
		const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
		del.title = localize('aria.manuscript.deletePaper', "Delete paper");
		Object.assign(del.style, { flexShrink: '0', opacity: '0.6', cursor: 'pointer' });
		del.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.paperWriter.delete', folder); };
	}

	private reviewRow(root: HTMLElement, e: ReviewEntry): void {
		const row = this.baseRow(root);
		row.onclick = () => void this.commandService.executeCommand('aria.peerReview.open', e.execId);
		const icon = append(row, $('span.codicon.codicon-checklist')) as HTMLElement;
		icon.style.flexShrink = '0'; icon.style.opacity = '0.7';
		const col = append(row, $('div'));
		Object.assign(col.style, { flex: '1', overflow: 'hidden' });
		const title = append(col, $('div')); title.textContent = e.title;
		Object.assign(title.style, { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		const when = append(col, $('div'));
		const base = e.whenStr ? `${e.whenStr} · ${e.execId}` : e.execId;
		when.textContent = e.draft ? localize('aria.manuscript.reviewNotStarted', "Not started · {0}", e.execId) : base;
		Object.assign(when.style, { fontSize: '11px', opacity: '0.55', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
		del.title = localize('aria.manuscript.deleteReview', "Delete review");
		Object.assign(del.style, { flexShrink: '0', opacity: '0.6', cursor: 'pointer' });
		del.onclick = (ev) => { ev.stopPropagation(); void this.commandService.executeCommand('aria.peerReview.delete', e.execId); };
	}

	private baseRow(root: HTMLElement): HTMLElement {
		const row = append(root, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', borderRadius: '4px', cursor: 'pointer' });
		row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
		row.onmouseleave = () => { row.style.background = 'transparent'; };
		return row;
	}

	// --- data --------------------------------------------------------------

	private async loadPapers(): Promise<{ folder: URI; title: string }[]> {
		const dir = this.papersDir();
		if (!dir) { return []; }
		let folders: URI[] = [];
		try {
			const stat = await this.fileService.resolve(dir);
			folders = (stat.children ?? []).filter(c => c.isDirectory).map(c => c.resource);
		} catch { return []; }
		const out: { folder: URI; title: string }[] = [];
		for (const folder of folders) { out.push({ folder, title: await this.readPaperTitle(folder) }); }
		return out;
	}

	private async readPaperTitle(folder: URI): Promise<string> {
		try {
			const parsed = JSON.parse((await this.fileService.readFile(joinPath(folder, 'meta.json'))).value.toString());
			if (typeof parsed.title === 'string' && parsed.title.trim()) { return parsed.title.trim(); }
		} catch { /* fall through */ }
		return basename(folder);
	}

	private async loadReviews(): Promise<ReviewEntry[]> {
		const dir = this.reviewsDir();
		if (!dir) { return []; }
		const entries: ReviewEntry[] = [];
		try {
			const stat = await this.fileService.resolve(dir);
			for (const c of (stat.children ?? []).filter(x => x.isDirectory)) {
				const meta = await this.readReviewMeta(c.resource);
				const when = meta?.createdAt ? Date.parse(meta.createdAt) : 0;
				entries.push({ execId: basename(c.resource), title: meta?.title || basename(c.resource), when, whenStr: meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : '', draft: meta?.draft === true });
			}
		} catch { return []; }
		entries.sort((a, b) => b.when - a.when);
		return entries;
	}

	private async readReviewMeta(folder: URI): Promise<{ title?: string; createdAt?: string; draft?: boolean } | undefined> {
		try { return JSON.parse((await this.fileService.readFile(joinPath(folder, 'meta.json'))).value.toString()); } catch { return undefined; }
	}

	// --- helpers -----------------------------------------------------------

	private section(root: HTMLElement, text: string): void {
		const h = append(root, $('div'));
		h.textContent = text;
		Object.assign(h.style, { fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: '0.6', margin: '10px 4px 4px' });
	}

	private empty(root: HTMLElement, text: string): void {
		const p = append(root, $('p'));
		Object.assign(p.style, { opacity: '0.7', fontSize: '12.5px', margin: '2px 6px' });
		p.textContent = text;
	}
}
