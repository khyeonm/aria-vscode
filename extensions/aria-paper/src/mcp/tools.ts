/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	addCitations, createPaper, getAssets, getCitations, getManuscript, getMeta,
	getProposal, hasUnsavedEdits, listPapers, OutlineSection, PaperFormat,
	resolvePaper, saveGeneratedFigure, setAssetSummary, setFocus, setFormat, setOutline, setProposal,
	setStep, setTitle, syncManuscriptTitle, writeManuscript,
} from '../papers';
import { ExportFormat, exportPaper } from '../exporter';
import { WRITING_GUIDE } from '../guide';

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asNumber(v: unknown): number | undefined { return typeof v === 'number' && isFinite(v) ? v : undefined; }

/** Only English and Korean are supported for now. Returns 'en' | 'ko' | undefined. */
function normalizeLanguage(v: string): 'en' | 'ko' | undefined {
	const s = v.trim().toLowerCase();
	if (s === 'en' || s === 'english' || s === '영어') { return 'en'; }
	if (s === 'ko' || s === 'kr' || s === 'korean' || s === '한국어' || s === '국문') { return 'ko'; }
	return undefined;
}

function resolveOrErr(arg: unknown): { id: string } | CallToolResult {
	const a = asString(arg);
	if (!a) { return err('`paper` (id or title) is required.'); }
	const meta = resolvePaper(a);
	if (!meta) { return err(`No paper matches "${a}". Use list_papers to see ids/titles.`); }
	return { id: meta.id };
}

/**
 * Paper-writing tools. Reads/structure/citations/export operate on the
 * per-project paper store; the actual prose is written by the agent following
 * get_writing_guide. (HITL propose/accept editing arrives in a later phase -
 * for now set_manuscript writes directly.)
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'get_writing_guide',
			description: 'Read the manuscript-writing methodology Qoka expects you to follow (structure, source-exclusivity, citation keys, prose rules). Call this before drafting. CRITICAL - picking WHICH paper: when the user asks to write a paper or work on a step (focus/outline/draft) WITHOUT naming which paper, you MUST NOT guess or auto-pick. First call list_papers, then LIST to the user the papers that are not yet finished (written=false, i.e. no full draft) with their titles and how far each got (step), and ASK the user which one - e.g. "Which paper? 1) <title> (focus done) 2) <title> (outline done)". Only proceed after they answer. If EXACTLY ONE unfinished paper exists, still CONFIRM it explicitly ("Work on this paper: <title>?") before doing anything. If NONE exist, offer create_paper. Never call set_focus/set_outline/set_manuscript/advance_paper_step until the user has confirmed the specific paper.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(WRITING_GUIDE),
		},
		{
			name: 'create_paper',
			description: 'Create a new, empty paper project and return its id. Writes <project>/.qoka/manuscript/draft/<id>/ with a default format.',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string', description: 'Working title for the paper.' } },
				required: ['title'],
				additionalProperties: false,
			},
			handler: async (a) => {
				try {
					const meta = createPaper(asString(a.title) ?? 'Untitled');
					// Best-effort: move to the Manuscript tab and open the new paper
					// so the user lands in the wizard (folder URI is
					// <workspace>/.qoka/manuscript/draft/<id>). UI failures must not fail the tool.
					try {
						const folder = vscode.workspace.workspaceFolders?.[0];
						if (folder) {
							const paperUri = vscode.Uri.joinPath(folder.uri, '.qoka', 'manuscript', 'draft', meta.id);
							await vscode.commands.executeCommand('workbench.view.ariaManuscript');
							await vscode.commands.executeCommand('aria.paperWriter.open', paperUri);
						}
					} catch { /* opening the writing window is best-effort */ }
					return ok(`Created paper "${meta.title}" (id: ${meta.id}). Opened the writing window in the Manuscript tab - tell the user you moved to the Manuscript tab and opened the writing window.`);
				} catch (e) { return err(`create_paper failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'list_papers',
			description: 'List paper projects in this workspace. Each entry is { id, title, step (0 Format … 4 Write), written (true once a full draft exists) }. Use `written`/`step` to show the user which papers are unfinished when asking which one to work on.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(listPapers())),
		},
		{
			name: 'get_paper',
			description: 'Get a paper: its format settings, outline, and the current manuscript Markdown. `paper` is the id or title.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const meta = getMeta(r.id)!;
				const pending = getProposal(r.id);
				const assets = getAssets(r.id);
				return ok(JSON.stringify({
					id: meta.id,
					title: meta.title,
					format: meta.format,
					focus: meta.focus,
					outline: meta.outline,
					manuscript: getManuscript(r.id),
					// User-provided figures/sources (paths are relative to the paper
					// dir). Each has a `summary`; summarize any with an empty summary
					// (read the file, call set_asset_summary) before writing.
					figures: assets.figures,
					sources: assets.sources,
					// If a revision is awaiting the user's review, build your next
					// edit ON TOP OF this (not the saved manuscript) so multiple
					// pending edits accumulate for review.
					pendingRevision: pending ? pending : undefined,
				}, null, 2));
			},
		},
		{
			name: 'set_format',
			description: 'Set the paper\'s format: paperType, targetWords, citationStyle (ieee|apa|nature|vancouver|chicago), language (BCP-47), venue. Only the fields you pass are changed.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					paperType: { type: 'string' },
					targetWords: { type: 'number' },
					citationStyle: { type: 'string', description: 'ieee | apa | nature | chicago | vancouver | ama | harvard | mla | cell | science | pnas | plos | elife | nar | bioinformatics | lancet | bmj | nejm' },
					language: { type: 'string', enum: ['en', 'ko'], description: 'Writing language: en (English) or ko (Korean).' },
					venue: { type: 'string' },
				},
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const partial: Partial<PaperFormat> = {};
				if (asString(a.paperType) !== undefined) { partial.paperType = asString(a.paperType); }
				if (asNumber(a.targetWords) !== undefined) { partial.targetWords = asNumber(a.targetWords); }
				if (asString(a.citationStyle) !== undefined) { partial.citationStyle = asString(a.citationStyle); }
				if (asString(a.language) !== undefined) {
					const lang = normalizeLanguage(asString(a.language)!);
					if (!lang) { return err('language must be "en" (English) or "ko" (Korean).'); }
					partial.language = lang;
				}
				if (asString(a.venue) !== undefined) { partial.venue = asString(a.venue); }
				try {
					const meta = setFormat(r.id, partial);
					return ok(`Updated format: ${JSON.stringify(meta.format)}`);
				} catch (e) { return err(`set_format failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_title',
			description: 'Set the paper title. Updates the title shown in the Manuscript tab (list + editor) AND the manuscript\'s top-level heading (and the frozen original). Propose a title to the user and get their confirmation BEFORE calling this.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					title: { type: 'string', description: 'The new paper title.' },
				},
				required: ['paper', 'title'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const title = asString(a.title);
				if (title === undefined || !title.trim()) { return err('`title` is required.'); }
				try {
					const meta = setTitle(r.id, title);
					syncManuscriptTitle(r.id); // refresh the manuscript H1 to match
					return ok(`Set title to "${meta.title}".`);
				} catch (e) { return err(`set_title failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_focus',
			description: 'Set the research focus - a bullet-point statement of the problem, objectives, gap/contribution, and (if figures exist) where each figure belongs. Develop it with the user one question at a time, then record it here. See get_writing_guide → Focus. After saving, ASK the user whether to continue to the outline; if they agree, call advance_paper_step (step 3) and build it with set_outline.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					focus: { type: 'string', description: 'The research-focus statement (bullet points).' },
				},
				required: ['paper', 'focus'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const focus = asString(a.focus);
				if (focus === undefined) { return err('`focus` is required.'); }
				try {
					setFocus(r.id, focus);
					setStep(r.id, 2); // keep/move the window on the Focus step
					return ok('Saved research focus. When the user agrees to continue, write the outline with set_outline - the window moves to the Outline step automatically.');
				} catch (e) { return err(`set_focus failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_outline',
			description: 'Set the paper outline: an ordered list of sections, each { title, wordCount?, keyPoints?, citations? } where citations are citekeys from list_citations. Per-section wordCount should sum to targetWords. After saving, ASK the user whether to continue to the draft; if they agree, call advance_paper_step (step 4) and write it with set_manuscript.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					sections: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								wordCount: { type: 'number' },
								keyPoints: { type: 'array', items: { type: 'string' } },
								citations: { type: 'array', items: { type: 'string' } },
							},
							required: ['title'],
							additionalProperties: false,
						},
					},
				},
				required: ['paper', 'sections'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				if (!Array.isArray(a.sections)) { return err('`sections` must be an array.'); }
				try {
					const meta = setOutline(r.id, a.sections as OutlineSection[]);
					setStep(r.id, 3); // move the window to the Outline step so the UI follows
					return ok(`Set outline (${meta.outline.length} sections). When the user agrees to continue, call advance_paper_step (step 4) to show the writing spinner, then write the draft with set_manuscript.`);
				} catch (e) { return err(`set_outline failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'advance_paper_step',
			description: 'Move the writing window to a wizard step so the user is carried through the flow. Steps (0-based): 0 Format, 1 Sources, 2 Focus, 3 Outline, 4 Write. After you finish a step AND the user agrees to continue, call this to advance the UI (e.g. step 3 after the focus), then do that next step. The window follows automatically.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					step: { type: 'number', description: 'Target step: 2 Focus, 3 Outline, 4 Write (0 Format, 1 Sources).' },
				},
				required: ['paper', 'step'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const step = asNumber(a.step);
				if (step === undefined) { return err('`step` is required.'); }
				try {
					const meta = setStep(r.id, step);
					const names = ['Format', 'Sources', 'Focus', 'Outline', 'Write'];
					return ok(`Moved the writing window to the ${names[meta.step]} step.`);
				} catch (e) { return err(`advance_paper_step failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_manuscript',
			description: 'Write a FULL draft (initial draft or full re-generation). This RESETS both the working copy and the frozen original baseline to this text and clears any pending review. Use this ONLY for a fresh/whole draft - for editing an existing manuscript use propose_manuscript_revision instead. Use [@citekey] for in-text citations; the chosen style is applied at export. Follow get_writing_guide.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					markdown: { type: 'string', description: 'Full manuscript Markdown.' },
					force: { type: 'boolean', description: 'Set true only after the user confirms discarding their edited version. Required when the working copy has edits not in the original.' },
				},
				required: ['paper', 'markdown'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const md = asString(a.markdown);
				if (md === undefined) { return err('`markdown` is required.'); }
				// Guard: a re-generation discards the user's accepted edits. Make
				// the agent confirm with the user first (the UI re-write button
				// passes force after its own confirm dialog).
				if (a.force !== true && hasUnsavedEdits(r.id)) {
					return ok('This paper has user edits (the working copy differs from the original draft) that a full re-write would discard. Ask the user to confirm they want to replace their edited version; if they agree, call set_manuscript again with force=true. (The frozen original is always kept either way.)');
				}
				try {
					writeManuscript(r.id, md);
					return ok(`Saved new draft (${md.length} chars). Reset the working copy and the original baseline.`);
				} catch (e) { return err(`set_manuscript failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'propose_manuscript_revision',
			description: 'Propose a revised manuscript for the user to REVIEW before it is applied. Pass the FULL revised Markdown (keep unchanged sections/paragraphs verbatim so only your actual edits are highlighted). This does NOT overwrite manuscript.md - it stages the change; Qoka opens a review tab where the user accepts/rejects each changed section or paragraph (added = yellow, removed = red). Use this for partial edits/revisions; use set_manuscript only for the initial full draft. After the user reviews, run export_paper and tell them the output path.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					markdown: { type: 'string', description: 'Full revised manuscript Markdown (unchanged parts kept verbatim).' },
				},
				required: ['paper', 'markdown'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const md = asString(a.markdown);
				if (md === undefined) { return err('`markdown` is required.'); }
				try {
					setProposal(r.id, md);
					// Open (or focus) the review tab even if the paper writer tab was
					// closed - otherwise the staged revision is invisible. Best-effort.
					try {
						const folder = vscode.workspace.workspaceFolders?.[0];
						if (folder) {
							const paperUri = vscode.Uri.joinPath(folder.uri, '.qoka', 'manuscript', 'draft', r.id);
							await vscode.commands.executeCommand('aria.paperWriter.openReview', paperUri);
						}
					} catch { /* opening the review tab is best-effort */ }
					return ok(`Staged a proposed revision and opened the review tab in Qoka (the manuscript-review tab where the user accepts/rejects each change). Tell the user you opened the review tab. Wait for them to review; once they accept, run export_paper and tell them the output path.`);
				} catch (e) { return err(`propose_manuscript_revision failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'list_assets',
			description: 'List the paper\'s figures and supplementary source files (id, file path relative to the paper dir, and AI summary). Read this to know what visuals/data the user provided.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				return ok(JSON.stringify(getAssets(r.id), null, 2));
			},
		},
		{
			name: 'set_asset_summary',
			description: 'Save a concise summary for a figure or source file (the figures/sources writing prompts use the summary, not the raw file). Read the actual file first (view images, read data files), then describe what it shows and the concept it illustrates in 3-4 sentences.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					assetId: { type: 'string', description: 'The asset id from get_paper/list_assets.' },
					summary: { type: 'string', description: 'Concise description of the figure/source.' },
				},
				required: ['paper', 'assetId', 'summary'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const assetId = asString(a.assetId);
				const summary = asString(a.summary);
				if (!assetId || summary === undefined) { return err('`assetId` and `summary` are required.'); }
				const hit = setAssetSummary(r.id, assetId, summary);
				if (!hit) { return err(`No asset "${assetId}" in this paper.`); }
				return ok(`Saved summary for ${hit.name}.`);
			},
		},
		{
			name: 'save_figure',
			description: 'Save a generated figure image into the project so it appears in the Manuscript tab\'s Figures section. `source` = an http(s) image URL (e.g. a BioRender custom-figure imageUrl), a data: URL, or a local file path. Optional `name`. Stored in the hidden .qoka/figures store - do NOT write figures into analysis/ or a top-level figures/ folder. Call this right after generating a figure so the user can see and insert it.',
			inputSchema: {
				type: 'object',
				properties: {
					source: { type: 'string', description: 'Image http(s) URL, data: URL, or local file path.' },
					name: { type: 'string', description: 'Optional file name for the saved figure.' },
				},
				required: ['source'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const source = asString(a.source);
				if (!source) { return err('`source` is required (an image URL, data URL, or local path).'); }
				try {
					const saved = await saveGeneratedFigure(source, asString(a.name));
					return ok(`Saved figure to ${saved}. It now appears in the Manuscript tab's Figures section.`);
				} catch (e) {
					return err(`Could not save figure: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'list_citations',
			description: 'List the citeable references for this paper (CSL-JSON). Only these citekeys may be cited in the manuscript.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const items = getCitations(r.id).map(c => {
					const x = c as Record<string, unknown>;
					return { id: x.id, title: x.title, issued: x.issued };
				});
				return ok(JSON.stringify(items, null, 2));
			},
		},
		{
			name: 'add_citation',
			description: 'Add citeable references as CSL-JSON. Pass MANY at once via `items` (an array) - do NOT call this once per reference; a batch is written in a single pass. Each item needs a `type` and ideally `id`, `title`, `author`, `issued`. (`csl`, a single object, is still accepted for one reference.) Returns the citekeys to use as [@citekey].',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					items: { type: 'array', items: { type: 'object' }, description: 'CSL-JSON reference items to add in one batch. Preferred over `csl` whenever adding more than one.' },
					csl: { type: 'object', description: 'A single CSL-JSON reference item (use `items` for several).' },
				},
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const batch: Record<string, unknown>[] = [];
				if (Array.isArray(a.items)) {
					for (const it of a.items) {
						if (typeof it !== 'object' || it === null) { return err('every entry in `items` must be a CSL-JSON object.'); }
						batch.push(it as Record<string, unknown>);
					}
				}
				if (typeof a.csl === 'object' && a.csl !== null) { batch.push(a.csl as Record<string, unknown>); }
				if (batch.length === 0) { return err('Pass `items` (an array of CSL-JSON objects) or a single `csl` object.'); }
				try {
					const keys = addCitations(r.id, batch);
					return ok(`Added ${keys.length} citation(s): ${keys.map(k => `[@${k}]`).join(' ')}.`);
				} catch (e) { return err(`add_citation failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'export_paper',
			description: 'Convert / export the manuscript to a file via the BUNDLED pandoc + citeproc. format = markdown | docx | latex. THIS tool is the ONLY correct way to produce a .docx / .tex / .md of the paper - do NOT convert it yourself and NEVER run pandoc (or any converter) in your own terminal/shell: the user has no pandoc installed, Qoka bundles its own, and a terminal attempt silently fails. This works for docx exactly as it does for markdown/latex - the bundled pandoc converts the manuscript Markdown to any of the three. By default it converts the SAVED manuscript.md; to convert text that is NOT saved yet, pass it as `markdown` and it is used directly (and saved as the manuscript if none exists) - so docx export never requires you to save first. In-text citations and the bibliography are rendered in the paper\'s citation style. (PDF is added later.) Returns the output path.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					format: { type: 'string', description: 'markdown | docx | latex' },
					markdown: { type: 'string', description: 'Optional. The manuscript Markdown to convert. Provide this to export/convert (e.g. to docx) even when the manuscript has NOT been saved yet: it is used as the conversion source, and saved as the manuscript when none exists. Omit to convert the already-saved manuscript.' },
				},
				required: ['paper', 'format'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const fmt = asString(a.format) as ExportFormat | undefined;
				if (fmt !== 'markdown' && fmt !== 'docx' && fmt !== 'latex') {
					return err('`format` must be markdown, docx, or latex.');
				}
				try {
					const res = await exportPaper(r.id, fmt, asString(a.markdown));
					return ok(`Exported ${fmt} -> ${res.outputPath} (style: ${res.style}).`);
				} catch (e) { return err(`export_paper failed: ${(e as Error).message}`); }
			},
		},
	];
}
