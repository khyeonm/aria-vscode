/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { renderMarkdown, IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { revealAiProviderChat } from '../../aria/browser/aiProviderChat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { tokenize, diffTokens, tokensToText } from './ariaManuscriptReviewEditorPane.js';
import { AriaPaperWriterInput } from './ariaPaperWriterInput.js';

interface PaperFormat { paperType: string; targetWords: number; citationStyle: string; language: string; venue?: string }
interface OutlineSection { title: string; wordCount?: number; keyPoints?: string[]; citations?: string[] }
interface PaperMeta { id: string; title: string; format: PaperFormat; focus?: string; outline: OutlineSection[]; step?: number; createdAt?: string; updatedAt?: string }
interface LibraryEntry { id: string; title: string; authors: string[]; year?: number; venue?: string; doi?: string; url?: string; tags?: string[] }
interface PaperAssetUI { id: string; file: string; name: string; summary?: string; caption?: string }

const LANGUAGES = [{ v: 'en', l: 'English' }, { v: 'ko', l: '한국어' }];
const STYLES = [
	{ v: 'ieee', l: 'IEEE' },
	{ v: 'apa', l: 'APA' },
	{ v: 'nature', l: 'Nature' },
	{ v: 'chicago', l: 'Chicago' },
	{ v: 'vancouver', l: 'Vancouver' },
	{ v: 'ama', l: 'AMA (American Medical Association)' },
	{ v: 'harvard', l: 'Harvard (Cite Them Right)' },
	{ v: 'mla', l: 'MLA' },
	{ v: 'cell', l: 'Cell' },
	{ v: 'science', l: 'Science' },
	{ v: 'pnas', l: 'PNAS' },
	{ v: 'plos', l: 'PLOS' },
	{ v: 'elife', l: 'eLife' },
	{ v: 'nar', l: 'Nucleic Acids Research' },
	{ v: 'bioinformatics', l: 'Bioinformatics (Oxford)' },
	{ v: 'lancet', l: 'The Lancet' },
	{ v: 'bmj', l: 'BMJ' },
	{ v: 'nejm', l: 'NEJM' },
];
/** MIME type for a data: URL, keyed off a file extension. */
function mimeForPath(p: string): string {
	switch (p.split('.').pop()?.toLowerCase()) {
		case 'png': return 'image/png';
		case 'jpg': case 'jpeg': return 'image/jpeg';
		case 'gif': return 'image/gif';
		case 'svg': return 'image/svg+xml';
		case 'webp': return 'image/webp';
		case 'bmp': return 'image/bmp';
		case 'tif': case 'tiff': return 'image/tiff';
		default: return 'application/octet-stream';
	}
}

const TYPES = ['research-article', 'review', 'case-report', 'preprint'];
const STEPS = ['Format', 'Sources', 'Focus', 'Outline', 'Write'];

/**
 * Editor pane for a paper project - a 5-step wizard mirroring SPWA:
 * Format → Sources → Focus → Outline → Write. Each "with AI" button
 * auto-sends a prompt to your AI chat; Claude writes back via the aria-paper
 * MCP (set_focus / set_outline / set_manuscript) and the form refreshes.
 */
export class AriaPaperWriterEditorPane extends EditorPane {

	static readonly ID = AriaPaperWriterInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private folder: URI | undefined;
	private meta: PaperMeta | undefined;
	private citations: Array<Record<string, unknown>> = [];
	private manuscript = '';
	private original = '';
	private assets: { figures: PaperAssetUI[]; sources: PaperAssetUI[] } = { figures: [], sources: [] };
	private library: LibraryEntry[] = [];
	private activeTag = '';
	private libraryPickerOpen = false;
	// Inline "Add from Figures" picker (generated figures in .qoka/figures).
	private figurePickerOpen = false;
	private generatedFigures: { name: string; path: string }[] = [];
	private focusEditing = false;
	private lastSelfWriteAt = 0;
	private proposalPending = false;
	private proposed = '';
	private importing = false;
	// Rendered (markdown -> HTML) vs Source (raw text / pending revision) view of the
	// finished draft. A staged revision (manuscript.proposed.md) is reviewed inline in
	// the Source view - accept/reject each change here, no separate tab.
	private draftMode: 'rendered' | 'source' = 'rendered';
	private lastRenderedDraft: IRenderedMarkdown | undefined;
	private outlineDragIndex: number | undefined;
	/** The step the AI just auto-advanced us to (via advance_paper_step / set_focus /
	 *  set_outline). On that step we hide the "send this to your AI chat" example - the
	 *  AI already did the work, so the nudge is redundant. Cleared on manual navigation. */
	private autoAdvancedStep: number | undefined;

	private readonly inputStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(AriaPaperWriterEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		applyAriaScrollbar(root);
		Object.assign(root.style, { width: '100%', height: '100%', overflow: 'auto', padding: '18px 22px', boxSizing: 'border-box', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', color: 'var(--vscode-foreground)' });
		parent.appendChild(root);
		this.root = root;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaPaperWriterInput)) {
			return;
		}
		this.inputStore.clear();
		this.folder = input.folderResource;
		this.forcedStep = undefined;
		this.autoAdvancedStep = undefined;
		await this.reload();
		this.library = await this.loadLibrary();
		if (token.isCancellationRequested) {
			return;
		}
		// Opening a finished paper (manuscript already written) should show the paper,
		// not restart the wizard: jump to the Write step, with the earlier steps shown
		// as completed. Cleared as soon as the user navigates a step.
		if (this.meta && this.manuscript.trim().length > 0) {
			this.forcedStep = STEPS.length - 1;
		}
		if (this.meta?.title) {
			input.setName(this.meta.title);
		}
		this.inputStore.add(this.fileService.onDidFilesChange(e => {
			const folder = this.folder;
			if (!folder || this.focusEditing || Date.now() - this.lastSelfWriteAt < 1500) {
				return;
			}
			if (e.affects(folder)) {
				const prevStep = this.step;
				void this.reload().then(() => {
					// The AI moved the wizard forward (advance_paper_step / set_focus /
					// set_outline): remember it so this step hides its chat-hint example.
					if (this.forcedStep === undefined && this.meta && (this.meta.step ?? 0) > prevStep) {
						this.autoAdvancedStep = this.meta.step;
					}
					this.render();
					this.maybeOpenReview();
				});
			}
		}));
		this.render();
		this.maybeOpenReview();
	}

	private async reload(): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.meta = await this.readJson<PaperMeta>(joinPath(folder, 'meta.json'));
		this.citations = (await this.readJson<Array<Record<string, unknown>>>(joinPath(folder, 'citations.csl.json'))) ?? [];
		this.manuscript = await this.readText(joinPath(folder, 'manuscript.md'));
		this.original = await this.readText(joinPath(folder, 'manuscript.original.md'));
		const a = await this.readJson<{ figures?: PaperAssetUI[]; sources?: PaperAssetUI[] }>(joinPath(folder, 'assets.json'));
		this.assets = { figures: a?.figures ?? [], sources: a?.sources ?? [] };
		const wasPending = this.proposalPending;
		this.proposed = await this.readText(joinPath(folder, 'manuscript.proposed.md'));
		this.proposalPending = this.proposed.trim().length > 0;
		// A fresh proposal: switch the draft view to Source, where the revision is
		// reviewed inline (accept/reject each change) - no separate tab opens.
		if (this.proposalPending && !wasPending) { this.draftMode = 'source'; }
	}

	/** When a revision is staged, surface it inline: make sure the Write step (with
	 *  the inline diff review) is the visible step. No separate review tab. */
	private maybeOpenReview(): void {
		if (!this.folder || !this.proposalPending) { return; }
		if (this.forcedStep !== STEPS.length - 1) { this.forcedStep = STEPS.length - 1; this.render(); }
	}

	private async loadLibrary(): Promise<LibraryEntry[]> {
		try {
			// The Paper Library is PER-PROJECT at <workspace>/.qoka/references/paper-library.json
			// (matches aria-paper-search's library.ts). Fall back to ~/.config/aria when
			// no project folder is known.
			const wsFolder = this.workspaceContextService.getWorkspace().folders[0];
			const libUri = wsFolder
				? joinPath(wsFolder.uri, '.qoka', 'references', 'paper-library.json')
				: joinPath(await this.pathService.userHome(), '.config', 'aria', 'paper-library.json');
			const lib = await this.readJson<{ papers?: LibraryEntry[] }>(libUri);
			return Array.isArray(lib?.papers) ? lib!.papers! : [];
		} catch {
			return [];
		}
	}

	private async readJson<T>(uri: URI): Promise<T | undefined> {
		try { return JSON.parse((await this.fileService.readFile(uri)).value.toString()) as T; } catch { return undefined; }
	}
	private async readText(uri: URI): Promise<string> {
		try { return (await this.fileService.readFile(uri)).value.toString(); } catch { return ''; }
	}
	private async write(name: string, content: string): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.lastSelfWriteAt = Date.now();
		await this.fileService.writeFile(joinPath(folder, name), VSBuffer.fromString(content));
		this.lastSelfWriteAt = Date.now();
	}
	private async saveMeta(): Promise<void> {
		if (!this.meta) { return; }
		this.meta.updatedAt = new Date().toISOString();
		await this.write('meta.json', JSON.stringify(this.meta, null, 2));
	}
	private async saveCitations(): Promise<void> { await this.write('citations.csl.json', JSON.stringify(this.citations, null, 2) + '\n'); }

	/** When a finished paper is opened, we jump straight to the Write step (the
	 *  result) without persisting that as the saved step; survives content reloads
	 *  and is cleared the moment the user navigates a step. */
	private forcedStep: number | undefined;

	private get step(): number {
		if (this.forcedStep !== undefined) { return this.forcedStep; }
		return Math.max(0, Math.min(STEPS.length - 1, this.meta?.step ?? 0));
	}
	private goStep(n: number): void {
		if (!this.meta) { return; }
		this.forcedStep = undefined;
		this.autoAdvancedStep = undefined; // manual navigation: show the chat hint again
		this.meta.step = Math.max(0, Math.min(STEPS.length - 1, n));
		void this.saveMeta();
		this.render();
	}

	private async sendToChat(query: string): Promise<void> {
		// Copy (reliable) + reveal whichever AI provider chat the user installed
		// (Claude / Codex / Gemini). Provider sidebars can't be injected with a
		// query, so the clipboard is the real delivery path - the user pastes it.
		await this.clipboardService.writeText(query);
		await revealAiProviderChat(this.commandService, this.configurationService);
		this.notificationService.info(localize('aria.paperWriter.promptSent', "Prompt copied - paste it into your AI chat (Ctrl/Cmd+V) and press Enter."));
	}

	// --- Rendering ----------------------------------------------------------

	private render(): void {
		const root = this.root;
		if (!root) { return; }
		clearNode(root);
		if (!this.meta) {
			append(root, $('p')).textContent = localize('aria.paperWriter.notFound', "This paper could not be loaded.");
			return;
		}
		this.renderTitle(root);
		this.renderStepRail(root);
		const screen = append(root, $('div'));
		screen.style.minHeight = '360px';
		switch (this.step) {
			case 0: this.renderFormatStep(screen); break;
			case 1: this.renderSourcesStep(screen); break;
			case 2: this.renderFocusStep(screen); break;
			case 3: this.renderOutlineStep(screen); break;
			default: this.renderWriteStep(screen); break;
		}
		this.renderNav(root);
	}

	private renderTitle(root: HTMLElement): void {
		const l = append(root, $('label'));
		l.textContent = localize('aria.paperWriter.titleLabel', "Paper title");
		Object.assign(l.style, { display: 'block', fontSize: '13px', opacity: '0.7', marginBottom: '4px' });
		const title = append(root, $('input')) as HTMLInputElement;
		title.value = this.meta!.title === 'Untitled paper' ? '' : this.meta!.title;
		title.placeholder = localize('aria.paperWriter.titlePlaceholder', "e.g. Tau aggregation drives neuronal loss in Alzheimer's disease");
		Object.assign(title.style, { width: '100%', fontSize: '18px', fontWeight: '600', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '5px', outline: 'none' });
		const commit = () => {
			const next = title.value.trim() || 'Untitled paper';
			if (next === this.meta!.title) { return; }
			this.meta!.title = next;
			if (this.input instanceof AriaPaperWriterInput) { this.input.setName(this.meta!.title); }
			void this.saveMeta().then(() =>
				// Keep the manuscript's leading H1 in sync (no-op if not drafted yet).
				this.commandService.executeCommand('aria.paper.syncTitle', this.meta!.id));
		};
		title.onchange = commit; title.onblur = commit;
		if (this.meta!.title === 'Untitled paper') { setTimeout(() => title.focus(), 0); }
	}

	private renderStepRail(root: HTMLElement): void {
		const rail = append(root, $('div'));
		// Full-width stepper: chips joined by flexible connector lines, with a
		// generous gap before the step content below.
		Object.assign(rail.style, { display: 'flex', alignItems: 'center', gap: '0', margin: '18px 0 26px' });
		STEPS.forEach((label, i) => {
			const active = i === this.step;
			// A step you have moved past is completed: fill it grey (with a check), the
			// current step stays blue, and steps still ahead are just an outline.
			const done = i < this.step;
			// active = blue (button), done = grey fill, upcoming = transparent outline.
			const background = active
				? 'var(--vscode-button-background)'
				: done ? 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.35))' : 'transparent';
			const color = active
				? 'var(--vscode-button-foreground)'
				: done ? 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))' : 'var(--vscode-foreground)';
			const chip = append(rail, $('span'));
			Object.assign(chip.style, { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13.5px', padding: '6px 14px', borderRadius: '15px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: '0', border: '1px solid rgba(127,127,127,0.4)', background, color, fontWeight: active ? '600' : '400', opacity: (!active && !done) ? '0.8' : '1' });
			if (done) {
				const check = append(chip, $('span.codicon.codicon-check')) as HTMLElement;
				Object.assign(check.style, { fontSize: '12px', opacity: '0.85' });
			}
			const txt = append(chip, $('span'));
			txt.textContent = `${i + 1}. ${label}`;
			chip.onclick = () => this.goStep(i);
			if (i < STEPS.length - 1) {
				const line = append(rail, $('div'));
				Object.assign(line.style, { flex: '1', height: '0', borderTop: '1px dashed rgba(127,127,127,0.5)', margin: '0 8px' });
			}
		});
	}

	private renderNav(root: HTMLElement): void {
		const bar = append(root, $('div'));
		Object.assign(bar.style, { display: 'flex', justifyContent: 'space-between', marginTop: '24px', paddingTop: '14px', borderTop: '1px solid rgba(127,127,127,0.2)' });
		const back = this.button(localize('aria.paperWriter.back', "← Back"), 'ghost', () => this.goStep(this.step - 1));
		back.style.visibility = this.step === 0 ? 'hidden' : 'visible';
		bar.appendChild(back);
		if (this.step < STEPS.length - 1) {
			bar.appendChild(this.button(localize('aria.paperWriter.next', "Next →"), 'primary', () => this.goStep(this.step + 1)));
		} else {
			bar.appendChild($('span'));
		}
	}

	// --- Step 1: Format -----------------------------------------------------

	private renderFormatStep(root: HTMLElement): void {
		this.header(root, localize('aria.paperWriter.formatHeader', "① Format"));
		const grid = append(root, $('div'));
		Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' });
		const f = this.meta!.format;
		this.field(grid, localize('aria.paperWriter.language', "Language"), this.select(LANGUAGES, f.language, v => { f.language = v; void this.saveMeta(); }));
		this.field(grid, localize('aria.paperWriter.type', "Paper type"), this.select(TYPES.map(t => ({ v: t, l: t })), f.paperType, v => { f.paperType = v; void this.saveMeta(); }));
		this.field(grid, localize('aria.paperWriter.length', "Target length (words)"), this.number(f.targetWords, v => { f.targetWords = v; void this.saveMeta(); }));
		this.field(grid, localize('aria.paperWriter.style', "Citation style"), this.searchableSelect(STYLES, f.citationStyle, v => { f.citationStyle = v; void this.saveMeta(); this.renderPreview(prevHost); }));
		const prevHost = append(root, $('div'));
		prevHost.style.marginTop = '14px';
		this.renderPreview(prevHost);
	}

	private renderPreview(host: HTMLElement): void {
		clearNode(host);
		const l = append(host, $('div'));
		l.textContent = localize('aria.paperWriter.preview', "Citation preview");
		Object.assign(l.style, { fontSize: '13px', opacity: '0.7', marginBottom: '4px' });
		const box = append(host, $('div'));
		Object.assign(box.style, { fontSize: '13px', lineHeight: '1.5', whiteSpace: 'pre-line', padding: '10px 12px', borderRadius: '6px', background: 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1))', opacity: '0.85' });
		void this.commandService.executeCommand<string>('aria.paper.previewCitation', this.meta!.format.citationStyle)
			.then(sample => { box.textContent = sample || localize('aria.paperWriter.previewNa', "Preview unavailable."); })
			.catch(() => { box.textContent = localize('aria.paperWriter.previewNa', "Preview unavailable."); });
	}

	// --- Step 2: Sources / Citations ---------------------------------------

	private renderSourcesStep(root: HTMLElement): void {
		this.header(root, localize('aria.paperWriter.citationsHeader', "② Sources / Citations"));

		// Selected citations - a bordered, scrollable box so they stand out.
		const label = append(root, $('div'));
		label.textContent = localize('aria.paperWriter.selectedCitations', "Citations in this paper ({0})", this.citations.length);
		Object.assign(label.style, { fontSize: '13px', opacity: '0.7', marginBottom: '4px' });
		const box = append(root, $('div'));
		applyAriaScrollbar(box);
		Object.assign(box.style, { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px', padding: '8px 10px', maxHeight: '200px', overflowY: 'auto' });
		if (this.citations.length === 0) {
			const e = append(box, $('div'));
			e.textContent = localize('aria.paperWriter.noCitations', "No citations yet - import a BibTeX file or pick from your Paper Library below.");
			Object.assign(e.style, { fontSize: '13px', opacity: '0.55' });
		} else {
			for (const c of this.citations) {
				const row = append(box, $('div'));
				Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '13px' });
				const key = append(row, $('span')); key.textContent = `[@${String(c.id ?? '')}]`;
				Object.assign(key.style, { opacity: '0.6', flexShrink: '0' });
				const title = append(row, $('span')); title.textContent = String(c.title ?? '(untitled)');
				Object.assign(title.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
				const rm = append(row, $('span.codicon.codicon-close')) as HTMLElement;
				Object.assign(rm.style, { cursor: 'pointer', opacity: '0.6', flexShrink: '0' });
				rm.onclick = () => { this.citations = this.citations.filter(x => x !== c); void this.saveCitations().then(() => this.render()); };
			}
		}

		// Buttons: import BibTeX (+ spinner while importing) + Paper Library toggle.
		const tools = append(root, $('div'));
		Object.assign(tools.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0' });
		tools.appendChild(this.button(localize('aria.paperWriter.importBibtex', "Import BibTeX (.bib)"), 'ghost', () => void this.importBibtex()));
		if (this.importing) {
			const spin = append(tools, $('span.codicon.codicon-loading.codicon-modifier-spin')) as HTMLElement;
			spin.title = localize('aria.paperWriter.importing', "Importing…");
			spin.style.opacity = '0.8';
		}
		tools.appendChild(this.button(
			this.libraryPickerOpen ? localize('aria.paperWriter.hideLibrary', "Close Paper Library") : localize('aria.paperWriter.pickLibrary', "Select from Paper Library"),
			'ghost', () => {
				this.libraryPickerOpen = !this.libraryPickerOpen;
				// Re-read the library each time the picker is opened: it is loaded once
				// at setInput, so papers saved to the Paper Library AFTER this tab opened
				// would otherwise show as an empty picker.
				if (this.libraryPickerOpen) {
					void this.loadLibrary().then(lib => { this.library = lib; this.render(); });
				} else {
					this.render();
				}
			}));

		if (this.libraryPickerOpen) {
			this.renderLibraryPicker(root);
		}

		this.renderAssetSection(root, 'figure');
		this.renderAssetSection(root, 'source');
	}

	/** Figures / supplementary-sources section: upload + list with summary state. */
	private renderAssetSection(root: HTMLElement, kind: 'figure' | 'source'): void {
		const items = kind === 'figure' ? this.assets.figures : this.assets.sources;
		const label = append(root, $('div'));
		label.textContent = kind === 'figure'
			? localize('aria.paperWriter.figures', "Figures ({0})", items.length)
			: localize('aria.paperWriter.sources', "Supplementary data / sources ({0})", items.length);
		Object.assign(label.style, { fontSize: '13px', opacity: '0.7', margin: '14px 0 4px' });

		const box = append(root, $('div'));
		applyAriaScrollbar(box);
		Object.assign(box.style, { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px', padding: '8px 10px', maxHeight: '160px', overflowY: 'auto' });
		if (items.length === 0) {
			const e = append(box, $('div'));
			e.textContent = kind === 'figure'
				? localize('aria.paperWriter.noFigures', "No figures yet - add images the AI should reference as (Figure N).")
				: localize('aria.paperWriter.noSources', "No supplementary files yet - add data, PDFs, or code the AI should draw facts from.");
			Object.assign(e.style, { fontSize: '13px', opacity: '0.55' });
		} else {
			for (const it of items) {
				const item = append(box, $('div'));
				Object.assign(item.style, { padding: '4px 0', borderBottom: '1px solid rgba(127,127,127,0.12)' });
				const row = append(item, $('div'));
				Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' });
				const name = append(row, $('span')); name.textContent = it.name;
				Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
				const state = append(row, $('span'));
				state.textContent = it.summary ? localize('aria.paperWriter.summarized', "✓ summarized") : localize('aria.paperWriter.pendingSummary', "summary pending…");
				Object.assign(state.style, { fontSize: '12px', opacity: '0.6', flexShrink: '0' });
				const rm = append(row, $('span.codicon.codicon-close')) as HTMLElement;
				Object.assign(rm.style, { cursor: 'pointer', opacity: '0.6', flexShrink: '0' });
				rm.onclick = () => void this.removeAsset(it.id);
				// Editable, expandable summary box (drag the corner to resize).
				if (it.summary) {
					const sb = append(item, $('textarea')) as HTMLTextAreaElement;
					sb.value = it.summary;
					this.styleTextarea(sb, '52px');
					sb.style.marginTop = '5px';
					sb.onchange = () => { if (this.meta) { void this.commandService.executeCommand('aria.paper.setAssetSummary', this.meta.id, it.id, sb.value); } };
				}
			}
		}

		const tools = append(root, $('div'));
		Object.assign(tools.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0 0' });
		if (kind === 'figure') {
			// Two ways to add a figure: upload from disk, or pick from the generated
			// store (.qoka/figures) that the Manuscript tab's Figures section shows -
			// the latter opens an inline checkbox box below (like Paper Library).
			tools.appendChild(this.button(localize('aria.paperWriter.uploadFigure', "Upload figure"), 'ghost', () => void this.addAssets('aria.paper.addFigures')));
			tools.appendChild(this.button(
				this.figurePickerOpen ? localize('aria.paperWriter.hideFigures', "Close Figures") : localize('aria.paperWriter.addFromFigures', "Add from Figures"),
				'ghost', () => void this.toggleFigurePicker()));
		} else {
			tools.appendChild(this.button(localize('aria.paperWriter.addSources', "Add files"), 'ghost', () => void this.addAssets('aria.paper.addSources')));
		}
		if (kind === 'figure' && this.figurePickerOpen) { this.renderFigurePicker(root); }
		const pending = items.filter(i => !i.summary).length;
		if (pending > 0) {
			// No prompt-copy: show an example to send to the AI chat (like the Focus
			// step). Sending it makes the AI read THESE files and write each summary
			// into this section via set_asset_summary. Figures and sources each get
			// their own line, since a user may have added only one of the two.
			this.sendChatHint(root, kind === 'figure'
				? "Read the figures I added and write a short summary of each."
				: "Read the supplementary files I added and write a short summary of each.", false);
		}
	}

	private async addAssets(cmd: string): Promise<void> {
		if (!this.meta) { return; }
		const added = await this.commandService.executeCommand<PaperAssetUI[]>(cmd, this.meta.id);
		if (added && added.length > 0) {
			await this.reload();
			// The re-render shows a "send this to your AI chat" example for the new,
			// unsummarized files (see renderAssetSection) - no prompt is copied.
			this.render();
		}
	}

	private async removeAsset(assetId: string): Promise<void> {
		if (!this.meta) { return; }
		await this.commandService.executeCommand('aria.paper.removeAsset', this.meta.id, assetId);
		await this.reload();
		this.render();
	}

	private renderLibraryPicker(root: HTMLElement): void {
		const panel = append(root, $('div'));
		Object.assign(panel.style, { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px', padding: '10px 12px', marginTop: '2px' });

		if (this.library.length === 0) {
			const e = append(panel, $('div'));
			e.textContent = localize('aria.paperWriter.libEmpty', "Your Paper Library is empty. Save papers from the Paper Library tab first.");
			Object.assign(e.style, { fontSize: '13px', opacity: '0.6' });
			return;
		}

		const existingDois = new Set(this.citations.map(c => String((c as { DOI?: unknown }).DOI ?? '').toLowerCase()).filter(Boolean));
		const candidates = this.library.filter(p => !(p.doi && existingDois.has(p.doi.toLowerCase())));
		const tags = Array.from(new Set(this.library.flatMap(p => p.tags ?? []))).sort();

		// Small hint at the top: the tag filter below only appears once papers carry
		// tags, so users who never tagged anything don't know the filter exists.
		const tagHint = append(panel, $('div'));
		tagHint.textContent = localize('aria.paperWriter.libTagHint', "Tip: tag papers in the Paper Library, then filter them by tag here.");
		Object.assign(tagHint.style, { fontSize: '11.5px', opacity: '0.6', marginBottom: '8px' });

		if (tags.length) {
			const chips = append(panel, $('div'));
			Object.assign(chips.style, { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' });
			const mkChip = (text: string, val: string) => {
				const chip = append(chips, $('span')) as HTMLElement;
				chip.textContent = text;
				const active = this.activeTag === val;
				Object.assign(chip.style, { fontSize: '11.5px', padding: '2px 9px', borderRadius: '10px', cursor: 'pointer', border: '1px solid rgba(127,127,127,0.4)', background: active ? 'var(--vscode-button-background)' : 'transparent', color: active ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' });
				chip.onclick = () => { this.activeTag = val; this.render(); };
			};
			mkChip(localize('aria.paperWriter.allTag', "All"), '');
			for (const t of tags) { mkChip(`#${t}`, t); }
		}

		const filtered = this.activeTag ? candidates.filter(p => (p.tags ?? []).includes(this.activeTag)) : candidates;
		const selected = new Set<LibraryEntry>();
		const rowCbs: HTMLInputElement[] = [];

		// "Select all" header row above the list: toggles every currently-shown
		// (filtered) row, so it doubles as a per-tag "select all" when a tag chip is
		// active (filtered is the active tag's papers). Individual toggles keep it in
		// sync (checked when all are on, indeterminate when only some are).
		let master: HTMLInputElement | undefined;
		if (filtered.length > 0) {
			const head = append(panel, $('label'));
			Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', fontWeight: '600', cursor: 'pointer', borderBottom: '1px solid rgba(127,127,127,0.2)', marginBottom: '2px' });
			master = append(head, $('input')) as HTMLInputElement;
			master.type = 'checkbox'; master.style.flexShrink = '0';
			const mlabel = append(head, $('span'));
			mlabel.textContent = localize('aria.paperWriter.selectAll', "Select all ({0})", filtered.length);
			master.onchange = () => {
				const on = master!.checked;
				selected.clear();
				for (const cb of rowCbs) { cb.checked = on; }
				if (on) { for (const p of filtered) { selected.add(p); } }
			};
		}

		const list = append(panel, $('div'));
		applyAriaScrollbar(list);
		Object.assign(list.style, { maxHeight: '220px', overflowY: 'auto' });
		if (filtered.length === 0) {
			const e = append(list, $('div'));
			e.textContent = localize('aria.paperWriter.allAdded', "Nothing to add here.");
			Object.assign(e.style, { fontSize: '13px', opacity: '0.55' });
		}
		for (const p of filtered) {
			const row = append(list, $('label'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '13px', cursor: 'pointer' });
			const cb = append(row, $('input')) as HTMLInputElement;
			cb.type = 'checkbox'; cb.style.flexShrink = '0';
			rowCbs.push(cb);
			cb.onchange = () => {
				if (cb.checked) { selected.add(p); } else { selected.delete(p); }
				if (master) {
					master.checked = rowCbs.every(c => c.checked);
					master.indeterminate = !master.checked && rowCbs.some(c => c.checked);
				}
			};
			const txt = append(row, $('span'));
			txt.textContent = `${p.authors?.[0] ?? ''}${p.year ? ` (${p.year})` : ''} - ${p.title}`;
			Object.assign(txt.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		}

		const addRow = append(panel, $('div'));
		Object.assign(addRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' });
		append(addRow, this.button(localize('aria.paperWriter.addSelected', "+ Add selected as citations"), 'primary', () => {
			if (selected.size === 0) { return; }
			for (const p of selected) { this.citations.push(this.toCsl(p)); }
			void this.saveCitations().then(() => this.render());
		}));
	}

	private async toggleFigurePicker(): Promise<void> {
		if (!this.meta) { return; }
		if (!this.figurePickerOpen) {
			this.generatedFigures = (await this.commandService.executeCommand<{ name: string; path: string }[]>('aria.paper.listGeneratedFigures', this.meta.id)) ?? [];
		}
		this.figurePickerOpen = !this.figurePickerOpen;
		this.render();
	}

	/** Inline picker for generated figures (.qoka/figures): checkbox multi-select
	 *  + a right-aligned "Add selected figures". Mirrors the Paper Library box. */
	private renderFigurePicker(root: HTMLElement): void {
		const panel = append(root, $('div'));
		Object.assign(panel.style, { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px', padding: '10px 12px', marginTop: '6px' });
		if (this.generatedFigures.length === 0) {
			const e = append(panel, $('div'));
			e.textContent = localize('aria.paperWriter.noGenFigures', "No figures yet. Ask the chat to create one; it appears in the Manuscript tab's Figures section.");
			Object.assign(e.style, { fontSize: '13px', opacity: '0.6' });
			return;
		}
		const selected = new Set<string>();
		const list = append(panel, $('div'));
		applyAriaScrollbar(list);
		Object.assign(list.style, { maxHeight: '220px', overflowY: 'auto' });
		for (const f of this.generatedFigures) {
			const row = append(list, $('label'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '13px', cursor: 'pointer' });
			const cb = append(row, $('input')) as HTMLInputElement;
			cb.type = 'checkbox'; cb.style.flexShrink = '0';
			cb.onchange = () => { if (cb.checked) { selected.add(f.path); } else { selected.delete(f.path); } };
			const txt = append(row, $('span')); txt.textContent = f.name;
			Object.assign(txt.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		}
		const addRow = append(panel, $('div'));
		Object.assign(addRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' });
		append(addRow, this.button(localize('aria.paperWriter.addSelectedFigures', "+ Add selected figures"), 'primary', () => {
			if (selected.size === 0 || !this.meta) { return; }
			void this.commandService.executeCommand('aria.paper.addFiguresByPath', this.meta.id, Array.from(selected)).then(async () => {
				this.figurePickerOpen = false;
				await this.reload();
				this.render();
			});
		}));
	}

	private async importBibtex(): Promise<void> {
		if (!this.meta) { return; }
		this.importing = true;
		this.render();
		try {
			const added = await this.commandService.executeCommand<number>('aria.paper.importBibtex', this.meta.id);
			if (typeof added === 'number') {
				this.notificationService.info(localize('aria.paperWriter.bibImported', "Imported {0} reference(s) from BibTeX.", added));
				await this.reload();
			}
		} catch (e) {
			this.notificationService.error(localize('aria.paperWriter.bibFailed', "BibTeX import failed: {0}", (e as Error).message));
		} finally {
			this.importing = false;
			this.render();
		}
	}

	private toCsl(p: LibraryEntry): Record<string, unknown> {
		const first = (p.authors?.[0] ?? '').trim();
		const famWord = first.split(/\s+/).pop() ?? 'ref';
		const base = `${famWord.toLowerCase().replace(/[^a-z0-9]/g, '')}${p.year ?? ''}` || 'ref';
		const used = new Set(this.citations.map(c => String(c.id)));
		let key = base, i = 1;
		while (used.has(key)) { key = base + String.fromCharCode(96 + (++i)); }
		return {
			id: key, type: 'article-journal', title: p.title,
			author: (p.authors ?? []).map(name => {
				const parts = name.trim().split(/\s+/);
				const family = parts.pop() ?? name;
				return parts.length ? { family, given: parts.join(' ') } : { literal: name };
			}),
			...(p.year ? { issued: { 'date-parts': [[p.year]] } } : {}),
			...(p.venue ? { 'container-title': p.venue } : {}),
			...(p.doi ? { DOI: p.doi } : {}),
			...(p.url ? { URL: p.url } : {}),
		};
	}

	/** A "Send this to your AI chat: <example>" hint that replaces the old
	 *  prompt-copy buttons. The entry step (Focus) pulses to draw the eye; later
	 *  steps show it as a plain one-line fallback (the AI usually advances those
	 *  automatically). */
	/** True when the AI auto-advanced us to the current step, so the "send this to
	 *  your AI chat" example should be hidden (the AI already did that step's work). */
	private hintSuppressed(): boolean {
		return this.autoAdvancedStep === this.step;
	}

	private sendChatHint(root: HTMLElement, example: string, pulse: boolean): void {
		if (this.hintSuppressed()) { return; }
		const box = append(root, $('div'));
		Object.assign(box.style, {
			border: '1px solid var(--vscode-focusBorder, #4488dd)', borderRadius: '6px',
			padding: '9px 12px', margin: '2px 0 10px',
		});
		const label = append(box, $('div'));
		label.textContent = localize('aria.paperWriter.sendToChat', "Send this to your AI chat, for example:");
		Object.assign(label.style, { fontSize: '12px', opacity: '0.7', marginBottom: '3px' });
		const ex = append(box, $('div'));
		ex.textContent = example;
		Object.assign(ex.style, { fontSize: '13px', fontWeight: '600', lineHeight: '1.45' });
		if (pulse) {
			box.animate(
				[{ boxShadow: '0 0 0 0 rgba(68,136,221,0.45)' }, { boxShadow: '0 0 0 7px rgba(68,136,221,0)' }],
				{ duration: 1700, iterations: Infinity });
		}
	}

	/** One "<bold question> Say this in your AI chat: <example>" line, appended into a
	 *  shared subtle box on the Write step (chat-driven re-write / revise, no buttons).
	 *  Deliberately low-key (no blue border) so it does not compete with the draft. */
	private askLine(box: HTMLElement, title: string, example: string): void {
		const wrap = append(box, $('div'));
		wrap.style.margin = '3px 0';
		const t = append(wrap, $('span'));
		t.textContent = title + ' ';
		t.style.fontWeight = '600';
		const ex = append(wrap, $('span'));
		ex.textContent = localize('aria.paperWriter.sayInChat', "Say this in your AI chat, for example: {0}", `"${example}"`);
		ex.style.opacity = '0.8';
	}

	// --- Step 3: Focus ------------------------------------------------------

	private renderFocusStep(root: HTMLElement): void {
		this.header(root, localize('aria.paperWriter.focusHeader', "③ Research focus"));
		const hint = append(root, $('div'));
		hint.textContent = localize('aria.paperWriter.focusHint', "Develop the focus with AI (it asks one question at a time), or write/paste it directly. Problem, objectives, gap, and contribution.");
		Object.assign(hint.style, { fontSize: '13px', opacity: '0.7', lineHeight: '1.55', marginBottom: '8px' });
		this.sendChatHint(root, "Let's write a paper, starting with the research focus.", true);
		const ta = append(root, $('textarea')) as HTMLTextAreaElement;
		ta.value = this.meta!.focus ?? '';
		ta.placeholder = localize('aria.paperWriter.focusPlaceholder', "- Problem: …\n- Objective: …\n- Gap / contribution: …");
		this.styleTextarea(ta, '160px');
		ta.style.marginTop = '8px';
		ta.onfocus = () => { this.focusEditing = true; };
		ta.onblur = () => { this.focusEditing = false; this.meta!.focus = ta.value; void this.saveMeta(); };
	}

	// --- Step 4: Outline ----------------------------------------------------

	private renderOutlineStep(root: HTMLElement): void {
		this.header(root, localize('aria.paperWriter.outlineHeader', "④ Outline"));
		const hint = append(root, $('div'));
		hint.textContent = localize('aria.paperWriter.outlineHint', "Let the AI propose sections + word budgets, or build them yourself. Add the key points each section should cover.");
		Object.assign(hint.style, { fontSize: '13px', opacity: '0.7', lineHeight: '1.55', marginBottom: '8px' });
		this.sendChatHint(root, "Propose an outline with sections and word budgets.", false);
		const btnRow = append(root, $('div'));
		Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
		btnRow.appendChild(this.button(localize('aria.paperWriter.resetOutline', "Reset to default sections"), 'ghost', () => {
			this.meta!.outline = this.defaultOutline();
			void this.saveMeta().then(() => this.render());
		}));

		// Default sections + word budget on first visit (user can edit/override).
		if (this.outlineIsBlank()) {
			this.meta!.outline = this.defaultOutline();
			void this.saveMeta();
		}
		const outline = this.meta!.outline;
		const total = outline.reduce((s, x) => s + (x.wordCount ?? 0), 0);
		const sum = append(root, $('div'));
		sum.textContent = localize('aria.paperWriter.wordSum', "Section words: {0} / target {1}", total, this.meta!.format.targetWords);
		Object.assign(sum.style, { fontSize: '11.5px', opacity: '0.6', margin: '10px 0 4px' });

		for (let i = 0; i < outline.length; i++) {
			const s = outline[i];
			const card = append(root, $('div'));
			Object.assign(card.style, { border: '1px solid rgba(127,127,127,0.25)', borderRadius: '6px', padding: '10px', margin: '6px 0' });
			// Drag-to-reorder: the card is only draggable while grabbing the handle,
			// so the inputs stay usable.
			card.ondragover = (e) => { e.preventDefault(); if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; } card.style.borderColor = 'var(--vscode-focusBorder, #4488dd)'; };
			card.ondragleave = () => { card.style.borderColor = 'rgba(127,127,127,0.25)'; };
			card.ondragend = () => { card.draggable = false; this.outlineDragIndex = undefined; };
			card.ondrop = (e) => {
				e.preventDefault();
				card.style.borderColor = 'rgba(127,127,127,0.25)';
				const from = this.outlineDragIndex;
				if (from === undefined || from === i) { return; }
				const [moved] = outline.splice(from, 1);
				outline.splice(i, 0, moved);
				void this.saveMeta().then(() => this.render());
			};
			const top = append(card, $('div'));
			Object.assign(top.style, { display: 'flex', gap: '6px', alignItems: 'center' });
			const handle = append(top, $('span.codicon.codicon-gripper')) as HTMLElement;
			handle.title = localize('aria.paperWriter.dragSection', "Drag to reorder");
			Object.assign(handle.style, { cursor: 'grab', opacity: '0.55', flexShrink: '0' });
			handle.onmousedown = () => { card.draggable = true; this.outlineDragIndex = i; };
			const t = append(top, $('input')) as HTMLInputElement;
			t.value = s.title; t.placeholder = localize('aria.paperWriter.sectionTitle', "Section");
			this.styleControl(t); t.style.flex = '1';
			t.onchange = () => { s.title = t.value; void this.saveMeta(); };
			const w = append(top, $('input')) as HTMLInputElement;
			w.type = 'number'; w.value = String(s.wordCount ?? ''); w.placeholder = 'words'; w.min = '0';
			this.styleControl(w); w.style.width = '90px';
			w.onchange = () => { s.wordCount = parseInt(w.value, 10) || undefined; void this.saveMeta(); this.render(); };
			const rm = append(top, $('span.codicon.codicon-trash')) as HTMLElement;
			Object.assign(rm.style, { cursor: 'pointer', opacity: '0.6', flexShrink: '0' });
			rm.onclick = () => { outline.splice(i, 1); void this.saveMeta().then(() => this.render()); };
			const kp = append(card, $('textarea')) as HTMLTextAreaElement;
			kp.value = (s.keyPoints ?? []).join('\n');
			kp.placeholder = localize('aria.paperWriter.keyPoints', "Key points (one per line)");
			this.styleTextarea(kp, '64px'); kp.style.marginTop = '6px';
			kp.onchange = () => { s.keyPoints = kp.value.split('\n').map(x => x.trim()).filter(Boolean); void this.saveMeta(); };
		}
		const add = append(root, this.button(localize('aria.paperWriter.addSection', "+ Add section"), 'ghost', () => {
			outline.push({ title: '' }); void this.saveMeta().then(() => this.render());
		})) as HTMLElement;
		add.style.marginTop = '6px';
	}

	/** Default sections (요약/서론/본론1/본론2/논의) with word counts split from
	 *  the target length. User-editable; shown automatically on first visit. */
	private defaultOutline(): OutlineSection[] {
		const ko = this.meta!.format.language === 'ko';
		const target = this.meta!.format.targetWords || 4000;
		const defs: Array<{ en: string; ko: string; p: number }> = [
			{ en: 'Abstract', ko: '요약', p: 0.07 },
			{ en: 'Introduction', ko: '서론', p: 0.20 },
			{ en: 'Body 1', ko: '본론 1', p: 0.25 },
			{ en: 'Body 2', ko: '본론 2', p: 0.25 },
			{ en: 'Discussion', ko: '논의', p: 0.23 },
		];
		const sections = defs.map(d => ({ title: ko ? d.ko : d.en, wordCount: Math.round(target * d.p), keyPoints: [] as string[], citations: [] as string[] }));
		const sum = sections.reduce((s, x) => s + (x.wordCount ?? 0), 0);
		if (sum !== target) { sections[2].wordCount = (sections[2].wordCount ?? 0) + (target - sum); }
		return sections;
	}

	/** True when the outline is empty or only blank placeholder sections. */
	private outlineIsBlank(): boolean {
		const cur = this.meta!.outline ?? [];
		return cur.length === 0 || cur.every(s => !(s.title && s.title.trim()) && !(s.keyPoints && s.keyPoints.length));
	}

	// --- Step 5: Write ------------------------------------------------------

	private renderWriteStep(root: HTMLElement): void {
		this.header(root, localize('aria.paperWriter.writeHeader', "⑤ Write"));

		const written = this.manuscript.trim().length > 0;
		const words = written ? this.manuscript.trim().split(/\s+/).filter(Boolean).length : 0;

		const hint = append(root, $('div'));
		hint.textContent = written
			? localize('aria.paperWriter.writeDone', "Drafted ({0} words). Review it, re-write if needed, then export.", words)
			: localize('aria.paperWriter.writeHint', "The AI combines your format, sources, focus, and outline to write the manuscript section by section.");
		Object.assign(hint.style, { fontSize: '13px', opacity: '0.7', lineHeight: '1.55', marginBottom: '12px' });

		// Not yet drafted. While the AI is generating the first draft (it set the
		// drafting flag when it advanced here), show a spinner; otherwise guide the
		// user to ask for it in chat.
		if (!written) {
			if (this.meta?.drafting) {
				const wait = append(root, $('div'));
				Object.assign(wait.style, { display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 12px', fontSize: '13px' });
				const spin = append(wait, $('span.codicon.codicon-loading.codicon-modifier-spin')) as HTMLElement;
				Object.assign(spin.style, { fontSize: '16px', flexShrink: '0' });
				const label = append(wait, $('span'));
				label.textContent = localize('aria.paperWriter.writing', "Writing your paper…");
			} else {
				this.sendChatHint(root, "Write the draft section by section.", false);
			}
		}

		if (written) {
			// Actions first: export buttons on the left, "Review this paper" pushed to
			// the right (hands the finished manuscript to a new peer review).
			const bar = append(root, $('div'));
			Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '14px' });
			bar.appendChild(this.button('Export MD', 'ghost', () => void this.export('markdown')));
			bar.appendChild(this.button('Export DOCX', 'ghost', () => void this.export('docx')));
			bar.appendChild(this.button('Export LaTeX', 'ghost', () => void this.export('latex')));
			const review = this.button(localize('aria.paperWriter.reviewThis', "Review this paper"), 'primary', () => {
				void this.commandService.executeCommand('aria.peerReview.newForPaper', this.meta!.id);
			});
			review.style.marginLeft = 'auto';
			bar.appendChild(review);

			// Re-write and revise are chat-driven (no buttons): both lines sit in ONE
			// low-key box (same tone as the notes box below), so they inform without
			// competing with the draft.
			const ask = append(root, $('div'));
			Object.assign(ask.style, { padding: '11px 14px', borderRadius: '6px', background: 'rgba(127,127,127,0.08)', fontSize: '12.5px', lineHeight: '1.6', marginBottom: '14px' });
			this.askLine(ask, localize('aria.paperWriter.askRewrite', "Want to re-write the whole draft?"), "Re-write the whole draft.");
			this.askLine(ask, localize('aria.paperWriter.askRevise', "Want to revise a part?"), "Revise the Introduction section: <what to change>.");

			// The written draft, scrollable, right below the prompts so the user can
			// read the result without opening the file. A Rendered / Source toggle sits
			// on top: Rendered = markdown -> HTML (headings, images, superscripts),
			// Source = the raw manuscript text.
			const draftHeader = append(root, $('div'));
			Object.assign(draftHeader.style, { display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' });
			draftHeader.appendChild(this.draftModeToggle());

			const draftBox = append(root, $('div'));
			applyAriaScrollbar(draftBox);
			Object.assign(draftBox.style, { border: '1px solid rgba(127,127,127,0.3)', borderRadius: '6px', padding: '12px 14px', maxHeight: '460px', overflowY: 'auto', wordBreak: 'break-word', fontSize: '13px', lineHeight: '1.6', marginBottom: '14px' });
			if (this.draftMode === 'rendered') {
				this.renderDraftRendered(draftBox);
			} else if (this.proposalPending) {
				// Source view with a staged revision: review it inline (accept/reject each
				// change) instead of showing the raw text or opening a separate tab.
				this.renderProposalReview(draftBox);
			} else {
				draftBox.style.whiteSpace = 'pre-wrap';
				draftBox.textContent = this.manuscript.trim();
			}

			const id = this.meta!.id;
			const note = append(root, $('div'));
			Object.assign(note.style, { marginTop: '14px', padding: '11px 14px', borderRadius: '6px', background: 'rgba(127,127,127,0.08)', fontSize: '12.5px', lineHeight: '1.65' });
			const bullet = (label: string, rest: string) => {
				const li = append(note, $('div'));
				Object.assign(li.style, { margin: '4px 0', opacity: '0.85' });
				const dot = append(li, $('span')); dot.textContent = '•  '; dot.style.opacity = '0.6';
				const b = append(li, $('span')); b.textContent = label; b.style.fontWeight = '600';
				const t = append(li, $('span')); t.textContent = rest;
			};
			bullet(
				localize('aria.paperWriter.noteDraftLabel', "Working draft"),
				localize('aria.paperWriter.noteDraft', " - .qoka/manuscript/draft/{0}/manuscript.md. Your current manuscript; the title and AI edits are saved here.", id));
			bullet(
				localize('aria.paperWriter.noteOriginalLabel', "Original draft"),
				localize('aria.paperWriter.noteOriginal', " - .qoka/manuscript/draft/{0}/manuscript.original.md. The first generated draft, kept unchanged even when you revise with AI.", id));
			bullet(
				localize('aria.paperWriter.noteExportLabel', "Exports"),
				localize('aria.paperWriter.noteExport', " - .qoka/manuscript/draft/{0}/export/ (named after the paper title, e.g. <title>.md / .docx / .tex). These are snapshots: they only change when you Export again, so re-export after any update.", id));
		}
	}

	/** Rendered / Source segmented toggle for the finished draft. */
	private draftModeToggle(): HTMLElement {
		const seg = $('div');
		Object.assign(seg.style, { display: 'flex', flexShrink: '0', border: '1px solid rgba(127,127,127,0.3)', borderRadius: '5px', overflow: 'hidden' });
		const mk = (mode: 'rendered' | 'source', label: string) => {
			const active = this.draftMode === mode;
			const b = append(seg, $('div'));
			b.textContent = label;
			Object.assign(b.style, { padding: '3px 10px', fontSize: '11.5px', cursor: 'pointer', userSelect: 'none', background: active ? 'var(--vscode-button-background)' : 'transparent', color: active ? 'var(--vscode-button-foreground)' : 'inherit', opacity: active ? '1' : '0.75' });
			b.onclick = () => { if (this.draftMode !== mode) { this.draftMode = mode; this.render(); } };
		};
		mk('rendered', localize('aria.paperWriter.rendered', "Rendered"));
		mk('source', localize('aria.paperWriter.source', "Source"));
		return seg;
	}

	/** Rendered markdown view of the draft. Images are inlined as data: URLs BEFORE
	 *  rendering (async), so display never depends on how the renderer/sanitizer
	 *  treats a relative or file src (it can strip it, leaving an empty box). */
	private renderDraftRendered(box: HTMLElement): void {
		const text = this.manuscript.trim();
		if (!text) { box.textContent = localize('aria.paperWriter.noBody', "(No draft yet.)"); return; }
		box.textContent = localize('aria.paperWriter.rendering', "Rendering...");
		const md = text
			.replace(/(!\[[^\]]*\]\([^)]*\))\s*\{[^}]*\}/g, '$1')
			.replace(/\^([^\s^]{1,32})\^/g, '<sup>$1</sup>');
		void this.renderDraftInlined(box, md, this.folder);
	}

	private async renderDraftInlined(box: HTMLElement, md: string, dir: URI | undefined): Promise<void> {
		const value = await this.inlineImages(md, dir);
		this.lastRenderedDraft?.dispose();
		const rendered = renderMarkdown({ value, isTrusted: true, supportHtml: true }, { sanitizerConfig: { remoteImageIsAllowed: () => true } });
		this.lastRenderedDraft = rendered;
		Object.assign(rendered.element.style, { wordBreak: 'break-word' });
		for (const img of Array.from(rendered.element.querySelectorAll('img'))) { Object.assign(img.style, { maxWidth: '100%', height: 'auto' }); }
		clearNode(box);
		box.appendChild(rendered.element);
	}

	/** Replace each local image reference (markdown ![alt](path) or <img src>) with a
	 *  data: URL read from disk. A path readable nowhere becomes a visible
	 *  "[figure not found: <path>]" marker. Figures live in the draft's figures/ dir
	 *  (uploaded) or the generated store .qoka/figures (BioRender / AI). */
	private async inlineImages(text: string, dir: URI | undefined): Promise<string> {
		const re = /(!\[[^\]]*\]\(\s*<?)([^)>\s"']+)((?:>?\s*(?:"[^"]*")?\s*)\))|(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi;
		const paths = new Set<string>();
		for (let m = re.exec(text); m; m = re.exec(text)) { const p = m[2] ?? m[5]; if (p) { paths.add(p); } }
		if (paths.size === 0) { return text; }
		const map = new Map<string, string | null>();
		await Promise.all([...paths].map(async p => { map.set(p, await this.readImageData(p, dir)); }));
		re.lastIndex = 0;
		return text.replace(re, (whole, mdOpen, mdPath, mdClose, htmlOpen, htmlPath, htmlClose) => {
			const p = mdPath ?? htmlPath;
			if (p && /^(https?|data):/i.test(p)) { return whole; }
			const data = p ? map.get(p) : null;
			if (data) { return mdPath !== undefined ? `${mdOpen}${data}${mdClose}` : `${htmlOpen}${data}${htmlClose}`; }
			return `\n\n\`[figure not found: ${p}]\`\n\n`;
		});
	}

	/** Read one image path into a data: URL, trying the draft dir, its figures/ dir,
	 *  and the workspace .qoka/figures store (by basename). */
	private async readImageData(src: string, dir: URI | undefined): Promise<string | null> {
		if (/^(https?|data):/i.test(src)) { return null; }
		const candidates: URI[] = [];
		try {
			if (src.startsWith('file:')) { candidates.push(URI.parse(src)); }
			else if (src.startsWith('/')) { candidates.push(URI.file(src)); }
			else if (dir && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) { candidates.push(joinPath(dir, src.replace(/^\.?\//, ''))); }
		} catch { /* fall through */ }
		const base = src.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '';
		const wsFolder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (base) {
			if (dir) { candidates.push(joinPath(dir, 'figures', base), joinPath(dir, base)); }
			if (wsFolder) { candidates.push(joinPath(wsFolder, '.qoka', 'figures', base)); }
		}
		for (const uri of candidates) {
			try { const data = await this.fileService.readFile(uri); return `data:${mimeForPath(uri.path)};base64,${encodeBase64(data.value)}`; } catch { /* next */ }
		}
		return null;
	}

	// --- Inline revision review (manuscript.proposed.md) --------------------
	// A staged revision is reviewed HERE, in the Source view, not in a separate tab:
	// sentence-level diff of manuscript.md vs manuscript.proposed.md, each change with
	// Accept (writes it into manuscript.md) / Reject (drops it from the proposal). The
	// diff helpers are shared with the standalone manuscript-review pane.

	private diffSegments(): ReturnType<typeof diffTokens> {
		return diffTokens(tokenize(this.manuscript), tokenize(this.proposed));
	}

	/** Reassemble the manuscript, taking for each change either the proposed
	 *  ('added') or the current ('removed') side. */
	private assembleManuscript(choose: (changeIndex: number) => 'added' | 'removed'): string {
		const toks: Parameters<typeof tokensToText>[0] = [];
		for (const s of this.diffSegments()) {
			if (s.type === 'equal') { toks.push(...s.tokens); }
			else { toks.push(...(choose(s.index) === 'added' ? s.added : s.removed)); }
		}
		return tokensToText(toks) + '\n';
	}

	private async writeDraftFile(name: string, content: string): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.lastSelfWriteAt = Date.now();
		await this.fileService.writeFile(joinPath(folder, name), VSBuffer.fromString(content));
		this.lastSelfWriteAt = Date.now();
	}

	private async clearProposal(): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.lastSelfWriteAt = Date.now();
		try { await this.fileService.del(joinPath(folder, 'manuscript.proposed.md')); } catch { /* already gone */ }
		this.lastSelfWriteAt = Date.now();
	}

	private async reloadAndRender(): Promise<void> {
		await this.reload();
		this.render();
	}

	private async acceptChange(i: number): Promise<void> {
		await this.writeDraftFile('manuscript.md', this.assembleManuscript(k => (k === i ? 'added' : 'removed')));
		await this.reloadAndRender();
	}
	private async rejectChange(i: number): Promise<void> {
		await this.writeDraftFile('manuscript.proposed.md', this.assembleManuscript(k => (k === i ? 'removed' : 'added')));
		await this.reloadAndRender();
	}
	private async acceptAllChanges(): Promise<void> {
		await this.writeDraftFile('manuscript.md', this.proposed.trimEnd() + '\n');
		await this.clearProposal();
		await this.reloadAndRender();
	}
	private async rejectAllChanges(): Promise<void> {
		await this.clearProposal();
		await this.reloadAndRender();
	}

	/** Render the staged revision inline: bulk actions + each change block with its
	 *  own Accept / Reject (yellow = added, red = removed). */
	private renderProposalReview(box: HTMLElement): void {
		box.style.whiteSpace = 'normal';
		const segments = this.diffSegments();
		const changes = segments.filter((s): s is Extract<typeof s, { type: 'change' }> => s.type === 'change');
		if (changes.length === 0) {
			// Proposal matches the working copy - nothing to review; clean it up.
			void this.clearProposal().then(() => this.reloadAndRender());
			box.textContent = localize('aria.paperWriter.noChanges', "No changes to review.");
			return;
		}
		const sub = append(box, $('div'));
		sub.textContent = localize('aria.paperWriter.reviewSub', "{0} change(s). Yellow = added, red = removed. Accept or reject each - it applies immediately.", changes.length);
		Object.assign(sub.style, { fontSize: '12px', opacity: '0.7', marginBottom: '10px' });

		const bulk = append(box, $('div'));
		Object.assign(bulk.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' });
		bulk.appendChild(this.button(localize('aria.paperWriter.acceptAll', "Accept all"), 'ghost', () => void this.acceptAllChanges()));
		bulk.appendChild(this.button(localize('aria.paperWriter.rejectAll', "Reject all"), 'ghost', () => void this.rejectAllChanges()));

		const list = append(box, $('div'));
		Object.assign(list.style, { fontSize: '13px', lineHeight: '1.6' });
		for (const s of segments) {
			if (s.type === 'equal') { this.renderReviewContext(list, tokensToText(s.tokens)); }
			else { this.renderReviewChange(list, s); }
		}
	}

	private renderReviewContext(parent: HTMLElement, text: string): void {
		if (!text.trim()) { return; }
		const el = append(parent, $('div'));
		Object.assign(el.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: '0.6', margin: '4px 0' });
		el.textContent = text;
	}

	private renderReviewChange(parent: HTMLElement, seg: Extract<ReturnType<typeof diffTokens>[number], { type: 'change' }>): void {
		const wrap = append(parent, $('div'));
		Object.assign(wrap.style, { border: '1px solid rgba(127,127,127,0.3)', borderRadius: '6px', padding: '8px 10px', margin: '8px 0' });
		const removed = tokensToText(seg.removed);
		const added = tokensToText(seg.added);
		if (removed.trim()) { this.renderReviewBlock(wrap, removed, 'removed'); }
		if (added.trim()) { this.renderReviewBlock(wrap, added, 'added'); }
		const actions = append(wrap, $('div'));
		Object.assign(actions.style, { display: 'flex', gap: '6px', marginTop: '6px' });
		actions.appendChild(this.button(localize('aria.paperWriter.accept', "Accept"), 'primary', () => void this.acceptChange(seg.index)));
		actions.appendChild(this.button(localize('aria.paperWriter.reject', "Reject"), 'ghost', () => void this.rejectChange(seg.index)));
	}

	private renderReviewBlock(parent: HTMLElement, text: string, kind: 'added' | 'removed'): void {
		const el = append(parent, $('div'));
		const isHeading = /^#{1,6}\s/.test(text.trim());
		Object.assign(el.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '3px 6px', borderRadius: '3px', margin: '3px 0', fontWeight: isHeading ? '700' : '400' });
		if (kind === 'added') {
			el.style.background = 'rgba(240, 200, 0, 0.28)';
		} else {
			el.style.background = 'rgba(230, 70, 70, 0.22)';
			el.style.textDecoration = 'line-through';
			el.style.opacity = '0.8';
		}
		el.textContent = text;
	}

	private async export(format: 'markdown' | 'docx' | 'latex'): Promise<void> {
		if (!this.meta) { return; }
		try {
			const result = await this.commandService.executeCommand<string>('aria.paper.export', this.meta.id, format);
			this.notificationService.info(result ?? localize('aria.paperWriter.exported', "Exported {0}.", format));
		} catch (e) {
			this.notificationService.error(localize('aria.paperWriter.exportFailed', "Export failed: {0}", (e as Error).message));
		}
	}

	// --- Prompts (auto-sent to your AI chat) -----------------------------

	/** Human-readable name of the paper's configured writing language. */
	private langName(): string {
		return this.meta!.format.language === 'ko' ? 'Korean (한국어)' : 'English';
	}
	/** Reminder appended to every generation prompt so the SAVED content follows
	 *  the Format step's language, not whatever language we happen to chat in. */
	private langClause(): string {
		return ` Write and save the content in ${this.langName()} (the paper's configured language) regardless of the language we are chatting in.`;
	}

	private focusPrompt(): string {
		return `Using the Qoka paper writer, develop the research focus for the paper "${this.meta!.id}". First read get_writing_guide (Focus stage) and get_paper, then ask me ONE question at a time (grounded in the citations) to develop the focus; when ready, save it with set_focus.${this.langClause()}`;
	}
	private outlinePrompt(): string {
		return `Using the Qoka paper writer, generate the outline for the paper "${this.meta!.id}". Read get_writing_guide (Outline stage) and get_paper, then call set_outline with sections whose wordCounts sum to the target length, each with keyPoints and the citekeys that support them.${this.langClause()}`;
	}
	/** True when the working copy diverged from the frozen original (user edits
	 *  exist that a full re-write would discard). */
	private hasUnsavedEdits(): boolean {
		return !!this.original.trim() && this.manuscript.trim() !== this.original.trim();
	}

	/** Re-write entry point: warn (native dialog) before discarding edits. */
	private async onWrite(): Promise<void> {
		if (this.hasUnsavedEdits()) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('aria.paperWriter.rewriteConfirm', "Re-write the whole paper?"),
				detail: localize('aria.paperWriter.rewriteDetail', "This replaces your current edited manuscript with a fresh draft. The original first draft is always preserved."),
				primaryButton: localize('aria.paperWriter.rewriteOk', "Re-write"),
			});
			if (!confirmed) { return; }
			void this.sendToChat(this.draftPrompt(true));
			return;
		}
		void this.sendToChat(this.draftPrompt(false));
	}

	private draftPrompt(force: boolean): string {
		const forceClause = force ? ' I have confirmed replacing my edited version - call set_manuscript with force=true.' : '';
		return `Using the Qoka paper writer, write a COMPLETELY NEW full draft from scratch for the paper "${this.meta!.id}". Read get_writing_guide (Write stage) and get_paper for the focus, outline, citations, and my sources - but base the prose ONLY on those. Do NOT reuse the current manuscript text or any pendingRevision; this is a fresh re-write that fully replaces them. Write section by section and save with set_manuscript.${forceClause}${this.langClause()}`;
	}
	private revisePrompt(): string {
		return `Using the Qoka paper writer, I want to revise PART of the manuscript for the paper "${this.meta!.id}". Read get_writing_guide (Revise stage) and get_paper, ask me what to change, then make only those edits (keeping everything else verbatim) and call propose_manuscript_revision so I can review the highlighted changes before they apply.${this.langClause()}`;
	}

	// --- Small UI helpers ---------------------------------------------------

	private header(parent: HTMLElement, text: string): void {
		const h = append(parent, $('div'));
		h.textContent = text;
		Object.assign(h.style, { fontSize: '17px', fontWeight: '600', margin: '6px 0 14px' });
	}
	private field(parent: HTMLElement, label: string, control: HTMLElement): void {
		const wrap = append(parent, $('div'));
		const l = append(wrap, $('label')); l.textContent = label;
		Object.assign(l.style, { display: 'block', fontSize: '13px', opacity: '0.75', marginBottom: '5px' });
		wrap.appendChild(control);
	}
	private select(options: Array<{ v: string; l: string }>, value: string, onChange: (v: string) => void): HTMLElement {
		const sel = $('select') as HTMLSelectElement;
		for (const o of options) {
			const opt = append(sel, $('option')) as HTMLOptionElement;
			opt.value = o.v; opt.textContent = o.l;
			if (o.v === value) { opt.selected = true; }
		}
		this.styleControl(sel);
		sel.onchange = () => onChange(sel.value);
		return sel;
	}
	/** A searchable dropdown: type to filter, fixed-height scrollable list with
	 *  the VS Code scrollbar. Used for the long citation-style list. */
	private searchableSelect(options: Array<{ v: string; l: string }>, value: string, onChange: (v: string) => void): HTMLElement {
		const labelOf = (v: string) => options.find(o => o.v === v)?.l ?? v;
		const wrap = document.createElement('div');
		Object.assign(wrap.style, { position: 'relative', width: '100%' });
		const input = append(wrap, $('input')) as HTMLInputElement;
		this.styleControl(input);
		input.style.cursor = 'pointer';
		input.value = labelOf(value);
		const panel = append(wrap, $('div'));
		applyAriaScrollbar(panel);
		Object.assign(panel.style, { display: 'none', position: 'absolute', top: 'calc(100% + 2px)', left: '0', right: '0', zIndex: '50', maxHeight: '240px', overflowY: 'auto', background: 'var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526))', border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.4))', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.35)' });
		let open = false;
		const close = () => { open = false; panel.style.display = 'none'; input.value = labelOf(value); };
		const renderList = (filter: string) => {
			clearNode(panel);
			const f = filter.trim().toLowerCase();
			const matches = options.filter(o => !f || o.l.toLowerCase().includes(f) || o.v.toLowerCase().includes(f));
			if (matches.length === 0) {
				const e = append(panel, $('div')); e.textContent = localize('aria.paperWriter.noStyleMatch', "No matching styles");
				Object.assign(e.style, { padding: '7px 11px', opacity: '0.6', fontSize: '13px' });
				return;
			}
			for (const o of matches) {
				const row = append(panel, $('div'));
				row.textContent = o.l;
				const sel = o.v === value;
				Object.assign(row.style, { padding: '7px 11px', fontSize: '13.5px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', background: sel ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent', color: sel ? 'var(--vscode-list-activeSelectionForeground)' : 'inherit' });
				row.onmouseenter = () => { if (!sel) { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; } };
				row.onmouseleave = () => { if (!sel) { row.style.background = 'transparent'; } };
				// mousedown (not click) so it fires before the input blur closes the panel.
				row.onmousedown = (e) => { e.preventDefault(); value = o.v; input.value = o.l; close(); onChange(o.v); };
			}
		};
		const openPanel = () => { open = true; panel.style.display = 'block'; input.value = ''; input.placeholder = labelOf(value); renderList(''); };
		input.onfocus = () => openPanel();
		input.onclick = () => { if (!open) { openPanel(); } };
		input.oninput = () => renderList(input.value);
		input.onblur = () => setTimeout(() => { if (open) { close(); } }, 150);
		input.onkeydown = (e) => { if (e.key === 'Escape') { close(); input.blur(); } };
		return wrap;
	}

	private number(value: number, onChange: (v: number) => void): HTMLElement {
		const input = $('input') as HTMLInputElement;
		input.type = 'number'; input.value = String(value ?? 0); input.min = '0';
		this.styleControl(input);
		input.onchange = () => onChange(parseInt(input.value, 10) || 0);
		return input;
	}
	private styleControl(el: HTMLElement): void {
		Object.assign(el.style, { width: '100%', padding: '6px 9px', fontSize: '14px', boxSizing: 'border-box', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '4px' });
	}
	private styleTextarea(ta: HTMLTextAreaElement, minHeight: string): void {
		applyAriaScrollbar(ta);
		Object.assign(ta.style, { width: '100%', minHeight, boxSizing: 'border-box', fontSize: '13.5px', lineHeight: '1.6', padding: '10px 12px', borderRadius: '6px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', resize: 'vertical' });
	}
	private button(text: string, variant: 'primary' | 'ghost', onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		Object.assign(btn.style, { padding: '7px 15px', fontSize: '13.5px', borderRadius: '4px', cursor: 'pointer' });
		if (variant === 'primary') {
			Object.assign(btn.style, { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: '1px solid transparent' });
		} else {
			Object.assign(btn.style, { background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.4)' });
		}
		btn.onclick = onclick;
		return btn;
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.folder = undefined;
		this.meta = undefined;
		super.clearInput();
	}

	override layout(_dimension: Dimension): void { /* scrollable block */ }
}
