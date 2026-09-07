/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPandoc } from './exporter';
import { findExportFile, getManuscript, resolvePaper } from './papers';
import { CallToolResult, ToolDefinition } from './mcp/tools';

const execFileAsync = promisify(execFile);

/**
 * Per-project AI Peer Review storage. Each review run lives in
 * `<workspace>/.qoka/manuscript/review/<execId>/`:
 *   - meta.json      { execId, title, reviewers[], paperId?, manuscriptFile?, supplementaryFiles[], createdAt, iteration }
 *   - files/         attached originals (manuscript + supplementary) for file-based reviews
 *   - concerns.json  { iteration, reviewers: { <reviewer>: { concerns: Concern[], recordedAt } } }
 *   - revisions/     (Phase 2) staged defensive revisions
 *
 * execId is unique per run, so two reviews of a same-titled paper stay distinct.
 * The Qoka Manuscript tab reads meta/concerns directly; these MCP tools are for
 * the reviewer agent (extract text on read, record structured concerns).
 */

export interface Concern {
	severity: 'major' | 'minor';
	title: string;
	detail: string;
}

export interface ReviewMeta {
	execId: string;
	title: string;
	reviewers: string[];
	/** Set when reviewing an in-project Paper Writer manuscript. */
	paperId?: string;
	/**
	 * Which stored format of that manuscript to review: 'markdown' → the live
	 * manuscript.md, 'docx' → export/paper.docx, 'latex' → export/paper.tex.
	 * Defaults to markdown. docx/latex are extracted to text via pandoc.
	 */
	paperFormat?: 'markdown' | 'docx' | 'latex';
	/** The MAIN manuscript file (relative to the review dir) - the text reviewed,
	 *  previewed, and revised. Set for attached-file reviews. */
	draftFile?: string;
	/** Figure files (relative) - passed to the reviewer by name only. */
	figureFiles?: string[];
	/** Supplementary/data files (relative) - extracted to text as extra context. */
	supplementaryFiles?: string[];
	createdAt: string;
	iteration: number;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }

export function reviewsDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	// Reviews live under .qoka/: <workspace>/.qoka/manuscript/review/<execId>/.
	return folder ? path.join(folder.uri.fsPath, '.qoka', 'manuscript', 'review') : undefined;
}

function reviewDir(execId: string): string | undefined {
	const dir = reviewsDir();
	return dir ? path.join(dir, execId) : undefined;
}

export function getReviewMeta(execId: string): ReviewMeta | undefined {
	const dir = reviewDir(execId);
	if (!dir) { return undefined; }
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as ReviewMeta;
	} catch {
		return undefined;
	}
}

/** Extract plain text / markdown from an attached document (any common format).
 *  `mediaDir`: when given (the review's docs/ dir), embedded images are extracted
 *  there via pandoc `--extract-media`, so the markdown's `media/xxx.png` references
 *  resolve to real files. Without it, those references point at nothing. */
async function extractText(absFile: string, mediaDir?: string): Promise<string> {
	const ext = path.extname(absFile).toLowerCase();
	if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
		return fs.readFileSync(absFile, 'utf8');
	}
	if (ext === '.docx' || ext === '.tex' || ext === '.html' || ext === '.htm' || ext === '.odt' || ext === '.rtf') {
		const from = ext === '.tex' ? 'latex'
			: (ext === '.html' || ext === '.htm') ? 'html'
				: ext === '.odt' ? 'odt'
					: ext === '.rtf' ? 'rtf'
						: 'docx';
		try {
			const pandoc = await getPandoc();
			const args = [absFile, '-f', from, '-t', 'markdown', '--wrap=none'];
			const opts: { timeout: number; maxBuffer: number; cwd?: string } = { timeout: 60000, maxBuffer: 32 * 1024 * 1024 };
			if (mediaDir) {
				// Extract images into <mediaDir>/media/ and keep the references relative
				// (`media/xxx.png`) by running from mediaDir; the review pane resolves
				// them against the docs/ dir where the extracted markdown lives.
				try { fs.mkdirSync(mediaDir, { recursive: true }); } catch { /* best-effort */ }
				args.push('--extract-media=.');
				opts.cwd = mediaDir;
			}
			const { stdout } = await execFileAsync(pandoc, args, opts);
			return stdout;
		} catch (e) {
			return `[Could not extract ${ext} (pandoc): ${(e as Error).message.slice(0, 200)}. Provide the paper as .md if this persists.]`;
		}
	}
	if (ext === '.pdf') {
		try {
			const { stdout } = await execFileAsync('pdftotext', ['-layout', absFile, '-'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
			return stdout;
		} catch {
			return `[Could not extract PDF text - 'pdftotext' is not available. Convert the paper to .md or .docx and attach that. File: ${path.basename(absFile)}]`;
		}
	}
	// Unknown extension: best-effort as UTF-8 text.
	try { return fs.readFileSync(absFile, 'utf8'); } catch { return `[Unreadable file: ${path.basename(absFile)}]`; }
}

/** Record a reviewer's concerns for a review run. */
function recordConcerns(execId: string, reviewer: string, concerns: Concern[]): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'concerns.json');
	let data: { iteration: number; reviewers: Record<string, { concerns: Concern[]; recordedAt: string }> };
	try {
		data = JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		const meta = getReviewMeta(execId);
		data = { iteration: meta?.iteration ?? 1, reviewers: {} };
	}
	data.reviewers[reviewer] = { concerns, recordedAt: new Date().toISOString() };
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/** Flatten a run's recorded concerns to a list the assistant can address by id
 *  (`<reviewer>#<index>`, matching the review tab). [] when none recorded yet. */
function readConcernsList(execId: string): { id: string; reviewer: string; severity: 'major' | 'minor'; title: string; detail: string }[] {
	const dir = reviewDir(execId);
	if (!dir) { return []; }
	let data: { reviewers?: Record<string, { concerns?: Concern[] }> };
	try { data = JSON.parse(fs.readFileSync(path.join(dir, 'concerns.json'), 'utf8')); } catch { return []; }
	const out: { id: string; reviewer: string; severity: 'major' | 'minor'; title: string; detail: string }[] = [];
	for (const [reviewer, rec] of Object.entries(data.reviewers ?? {})) {
		(rec?.concerns ?? []).forEach((c, i) => out.push({ id: `${reviewer}#${i}`, reviewer, severity: c.severity, title: c.title, detail: c.detail }));
	}
	return out;
}

/** Mark a concern resolved (or unresolved) in the run's state.json - the review
 *  tab watches this file and dims/checks the concern card. Idempotent. */
function setConcernResolved(execId: string, concernId: string, resolved: boolean): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'state.json');
	let data: { resolved?: string[] } = {};
	try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
	const set = new Set(data.resolved ?? []);
	if (resolved) { set.add(concernId); } else { set.delete(concernId); }
	fs.writeFileSync(p, JSON.stringify({ resolved: [...set] }, null, 2), 'utf8');
}

/** Reset a run for a fresh review iteration on the (possibly revised) paper:
 *  clear concerns/revisions/resolved and bump the iteration. */
function resetForRerun(execId: string): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	for (const f of ['concerns.json', 'revisions.json', 'state.json']) {
		try { fs.unlinkSync(path.join(dir, f)); } catch { /* may not exist */ }
	}
	const meta = getReviewMeta(execId);
	if (meta) {
		meta.iteration = (meta.iteration ?? 1) + 1;
		try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8'); } catch { /* non-fatal */ }
	}
}

/** One candidate edit (an "Argument / Edit footprint / Risk" strategy). */
export interface RevisionProposal { original: string; replacement: string; explanation: string }
/** Up to 3 alternative proposals that resolve one concern, for one document. */
export interface Revision { documentKey: string; proposals: RevisionProposal[]; recordedAt: string }

/** Extracted-snapshot + working-copy paths for a document, all under `docs/`.
 *  `main` is the draft; `suppl-<i>` are supplementary documents. */
function docPaths(dir: string, docKey: string): { extracted: string; working: string } {
	const base = path.join(dir, 'docs');
	return { extracted: path.join(base, `${docKey}.extracted.md`), working: path.join(base, `${docKey}.working.md`) };
}

function recordRevisionEntry(execId: string, concernId: string, documentKey: string, proposals: RevisionProposal[]): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'revisions.json');
	let data: Record<string, Revision> = {};
	try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
	data[concernId] = { documentKey, proposals, recordedAt: new Date().toISOString() };
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/** The current editable text for one document of a review: its working copy if
 *  any revisions were accepted, else its extracted snapshot. Defaults to `main`. */
export function reviewWorkingText(execId: string, docKey = 'main'): string | undefined {
	const dir = reviewDir(execId);
	if (!dir) { return undefined; }
	const { extracted, working } = docPaths(dir, docKey);
	for (const p of [working, extracted]) {
		if (fs.existsSync(p)) { try { return fs.readFileSync(p, 'utf8'); } catch { /* next */ } }
	}
	return undefined;
}

/** Next free standalone-edit id (`edit-1`, `edit-2`, …) in a review's revisions. */
function nextEditId(execId: string): string {
	const dir = reviewDir(execId);
	let data: Record<string, unknown> = {};
	if (dir) { try { data = JSON.parse(fs.readFileSync(path.join(dir, 'revisions.json'), 'utf8')); } catch { /* fresh */ } }
	let n = 1;
	while (Object.prototype.hasOwnProperty.call(data, `edit-${n}`)) { n++; }
	return `edit-${n}`;
}

export type ReviewExportFormat = 'markdown' | 'docx' | 'latex';
const REVIEW_EXT: Record<ReviewExportFormat, string> = { markdown: 'md', docx: 'docx', latex: 'tex' };

/** Export one document of a review (working copy) to md/docx/latex inside the
 *  review's own directory. Markdown is a direct write; docx/latex go via pandoc. */
export async function exportReviewPaper(execId: string, format: ReviewExportFormat, docKey = 'main'): Promise<string> {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	const text = reviewWorkingText(execId, docKey);
	if (text === undefined) { throw new Error('No paper text to export yet - run the review first.'); }
	const outDir = path.join(dir, 'export');
	fs.mkdirSync(outDir, { recursive: true });
	const base = docKey === 'main' ? 'paper' : docKey;
	const outPath = path.join(outDir, `${base}.${REVIEW_EXT[format]}`);
	if (format === 'markdown') {
		fs.writeFileSync(outPath, text, 'utf8');
		return outPath;
	}
	const tmp = path.join(outDir, '.export.src.md');
	fs.writeFileSync(tmp, text, 'utf8');
	try {
		const pandoc = await getPandoc();
		const args = [tmp, '-f', 'markdown', '-t', format === 'docx' ? 'docx' : 'latex'];
		if (format === 'latex') { args.push('--standalone'); }
		args.push('-o', outPath);
		await execFileAsync(pandoc, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
	}
	return outPath;
}

function parseConcerns(raw: unknown): Concern[] {
	if (!Array.isArray(raw)) { return []; }
	const out: Concern[] = [];
	for (const c of raw) {
		if (!c || typeof c !== 'object') { continue; }
		const o = c as Record<string, unknown>;
		const severity = o.severity === 'major' ? 'major' : 'minor';
		const title = typeof o.title === 'string' ? o.title : '';
		const detail = typeof o.detail === 'string' ? o.detail : '';
		if (title || detail) { out.push({ severity, title, detail }); }
	}
	return out;
}

/** MCP tools for the reviewer agent. Concatenated onto the paper tools. */
export function buildReviewTools(): ToolDefinition[] {
	return [
		{
			name: 'open_new_review',
			description: 'Open Qoka\'s Manuscript tab and start a NEW review window. When the user asks IN CHAT to peer-review a paper, call list_open_reviews FIRST - only call open_new_review when NO review window is already open (otherwise reuse the open one and start_peer_review). It only opens the UI (best-effort) - it does not start the review, and it does NOT pre-load any paper. After calling it, tell the user to pick ONE source in the new-review window: upload a file, OR click "A paper written in the Manuscript tab" and select the manuscript they wrote. They can add figures / supplementary files; when they say they are done, call start_peer_review to run it (it returns an execId for get_review).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				// Best-effort: reveal the Manuscript tab, then open the new-review
				// window. UI failures must not fail the tool.
				try { await vscode.commands.executeCommand('workbench.view.ariaManuscript'); } catch { /* tab optional */ }
				try { await vscode.commands.executeCommand('aria.peerReview.new'); } catch { /* window optional */ }
				return ok('Opened the Peer Review window. Tell the user to pick ONE source there - upload a file, or select "A paper written in the Manuscript tab" and choose their manuscript - and add any figures / supplementary files, then say when they are done. When they are, call start_peer_review to run it.');
			},
		},
		{
			name: 'list_open_reviews',
			description: 'List the Peer Review windows currently OPEN in Qoka. Returns [{ execId, title, started }]: started=false is an unstarted "New review" tab (its source/reviewers may already be filled in, e.g. from the paper writer\'s "Review this paper"); started=true is a review already running (use get_review on it, do NOT start it again). When the user asks to run/start a peer review WITHOUT naming which window, you MUST call this FIRST and MUST NOT guess or auto-pick. Then, considering only started=false windows: if SEVERAL, LIST them by title and ASK which one (have the user click that tab), then start_peer_review; if EXACTLY ONE, CONFIRM it ("Run this review: <title>?") then start_peer_review - do NOT tell the user to attach a paper if the window already has one; if NONE are open, call open_new_review. Never call start_peer_review until the user confirmed the specific window.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const list = await vscode.commands.executeCommand<{ execId: string | null; title: string }[]>('aria.peerReview.listOpen');
					return ok(JSON.stringify(list ?? []));
				} catch (e) { return err(`list_open_reviews failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'start_peer_review',
			description: 'Start the AI peer review from the review window the user CONFIRMED. Do NOT call this until you have called list_open_reviews and the user has told you (or confirmed) which review window to run - never pick one yourself. It runs whichever new-review window is active: they pick the source (a manuscript, or an uploaded file) and the reviewers there. Returns the review run id (execId). If it reports nothing is set up, tell the user to open the Peer Review tab and pick a source + reviewers, then call this again. After it returns an execId, call get_review(execId), run each reviewer independently, and record each reviewer\'s Major/Minor concerns with record_review - the results tab is already open with a spinner per reviewer.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const execId = await vscode.commands.executeCommand<string | undefined>('aria.peerReview.runActive');
					if (!execId) {
						return ok('No peer review is set up yet. Ask the user to open the Peer Review tab, pick a source (a manuscript or an uploaded file) and reviewers, then call start_peer_review again.');
					}
					return ok(`Started peer review run "${execId}". Now call get_review("${execId}"), run each selected reviewer independently, and record each reviewer's Major/Minor concerns with record_review. The results tab is already open with a spinner per reviewer.`);
				} catch (e) { return err(`start_peer_review failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'get_review',
			description: 'Load an AI Peer Review run started from Qoka\'s Manuscript tab. Returns the paper title, the MAIN manuscript text (the thing to review), any supplementary text, referenced figure names, and the reviewers to use. Call this first with the execId Qoka gave you, then run the reviewer sub-agents on the manuscript.',
			inputSchema: {
				type: 'object',
				properties: { execId: { type: 'string', description: 'The review run id Qoka passed in the prompt.' } },
				required: ['execId'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const meta = getReviewMeta(execId);
				if (!meta) { return err(`No review run "${execId}". It may not have been created yet.`); }
				const dir = reviewDir(execId)!;
				// The MAIN manuscript - the text to review, preview, and revise.
				let manuscript: { name: string; text: string } | undefined;
				if (meta.paperId) {
					const fmt = meta.paperFormat ?? 'markdown';
					if (fmt === 'markdown') {
						let text = getManuscript(meta.paperId) || '';
						if (!text.trim()) { const r = resolvePaper(meta.paperId); text = r ? getManuscript(r.id) : ''; }
						manuscript = { name: `${meta.title}.md`, text };
					} else {
						const abs = findExportFile(meta.paperId, fmt === 'docx' ? 'docx' : 'tex');
						manuscript = (abs && fs.existsSync(abs))
							? { name: path.basename(abs), text: await extractText(abs, path.join(dir, 'docs')) }
							: { name: `${meta.title}.md`, text: getManuscript(meta.paperId) || '' };
					}
				} else if (meta.draftFile) {
					manuscript = { name: path.basename(meta.draftFile), text: await extractText(path.join(dir, meta.draftFile), path.join(dir, 'docs')) };
				}
				if (!manuscript) { return err(`Review "${execId}" has no main manuscript file.`); }

				// Supplementary = extra text/data (also revisable); figures = names only.
				const supplementary: { key: string; name: string; text: string }[] = [];
				for (let i = 0; i < (meta.supplementaryFiles ?? []).length; i++) {
					const rel = meta.supplementaryFiles![i];
					supplementary.push({ key: `suppl-${i + 1}`, name: path.basename(rel), text: await extractText(path.join(dir, rel)) });
				}
				const figures = (meta.figureFiles ?? []).map(rel => path.basename(rel));

				// Snapshot each document's extracted text once (so accepted revisions in
				// *.working.md aren't shadowed), and return the working copy when present.
				const load = (docKey: string, name: string, text: string): { key: string; name: string; text: string } => {
					const { extracted, working } = docPaths(dir, docKey);
					if (!fs.existsSync(extracted)) { fs.mkdirSync(path.dirname(extracted), { recursive: true }); try { fs.writeFileSync(extracted, text, 'utf8'); } catch { /* non-fatal */ } }
					if (fs.existsSync(working)) { try { return { key: docKey, name, text: fs.readFileSync(working, 'utf8') }; } catch { /* fall through */ } }
					return { key: docKey, name, text };
				};
				const mainDoc = load('main', manuscript.name, manuscript.text);
				const supplDocs = supplementary.map(sd => load(sd.key, sd.name, sd.text));

				return ok(JSON.stringify({
					execId,
					title: meta.title,
					reviewers: meta.reviewers,
					iteration: meta.iteration,
					manuscript: { key: 'main', name: mainDoc.name, text: mainDoc.text },
					supplementary: supplDocs,
					figures,
					// Already-recorded concerns, each with an id (`<reviewer>#<index>`). When
					// the user asks to revise a specific one (e.g. "the first major concern"),
					// match it here and pass its id to record_revision.
					concerns: readConcernsList(execId),
					note: 'Review the MAIN manuscript (documentKey "main"). supplementary items (each has a key like "suppl-1") are extra data/context - check the manuscript claims against them, and if a fix belongs in a supplementary document target it via that key. figures are filenames only (you cannot see the images). When proposing a revision, pass the document key as documentKey.',
				}));
			},
		},
		{
			name: 'record_review',
			description: 'Record one reviewer\'s Major/Minor Concerns for a review run so Qoka\'s Manuscript tab can display them. Call once per reviewer after aggregating that reviewer\'s sub-agents. `concerns` is an array of { severity: "major"|"minor", title, detail }.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					reviewer: { type: 'string', description: 'Reviewer id, e.g. "claude".' },
					concerns: {
						type: 'array',
						description: 'Concerns. Each: { severity: "major"|"minor", title, detail }.',
						items: {
							type: 'object',
							properties: {
								severity: { type: 'string', enum: ['major', 'minor'] },
								title: { type: 'string' },
								detail: { type: 'string' },
							},
							required: ['severity', 'title'],
						},
					},
				},
				required: ['execId', 'reviewer', 'concerns'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const reviewer = typeof args.reviewer === 'string' ? args.reviewer : '';
				if (!execId || !reviewer) { return err('execId and reviewer are required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const concerns = parseConcerns(args.concerns);
				try {
					recordConcerns(execId, reviewer, concerns);
				} catch (e) {
					return err(`record_review failed: ${(e as Error).message}`);
				}
				// Auto-open the review results so the user sees them as soon as they land
				// (best-effort; idempotent - reopening the same run just focuses it).
				try {
					await vscode.commands.executeCommand('workbench.view.ariaManuscript');
					await vscode.commands.executeCommand('aria.peerReview.open', execId);
				} catch { /* UI reveal is best-effort */ }
				const major = concerns.filter(c => c.severity === 'major').length;
				return ok(`Recorded ${concerns.length} concern(s) for "${reviewer}" (${major} major). Qoka opened the review results in the Manuscript tab.`);
			},
		},
		{
			name: 'record_revision',
			description: 'Revise ONE concern from a review run: propose UP TO 3 alternative strategies. Call this when the user asks to fix/revise a concern (e.g. "revise the first major concern") - there is no button. First call get_review to read the CURRENT paper AND its `concerns` list, then match the concern the user named to its `id` there. Qoka shows the strategies in a "< N/3 >" carousel with an Accept button; the user accepts one, which replaces that span in the paper (Accept does NOT resolve the concern). Each proposal is a distinct strategy (different argument / edit footprint / risk) with the EXACT original span to replace (verbatim, long enough to be unique) and the full replacement. Only add reasoning/scoping/framing grounded in the existing paper - never invent data, numbers, procedures, or citations.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					concernId: { type: 'string', description: 'The concern id from get_review\'s `concerns` list (e.g. "claude#0"). Match it to the concern the user named ("the first major concern" = the first concerns entry with severity "major").' },
					documentKey: { type: 'string', description: 'Which document to edit: "main" for the manuscript (default), or a supplementary key like "suppl-1" from get_review.' },
					proposals: {
						type: 'array',
						minItems: 1,
						maxItems: 3,
						description: 'Up to 3 alternative strategies. Each: { original, replacement, explanation }. Different proposals may edit different spans.',
						items: {
							type: 'object',
							properties: {
								original: { type: 'string', description: 'Exact span to replace, copied verbatim from the current paper.' },
								replacement: { type: 'string', description: 'The full replacement text for that span.' },
								explanation: { type: 'string', description: 'The strategy: its argument and any risk, in one or two sentences.' },
							},
							required: ['original', 'replacement'],
						},
					},
				},
				required: ['execId', 'concernId', 'proposals'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const concernId = typeof args.concernId === 'string' ? args.concernId : '';
				const documentKey = typeof args.documentKey === 'string' && args.documentKey ? args.documentKey : 'main';
				if (!execId || !concernId) { return err('execId and concernId are required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const raw = Array.isArray(args.proposals) ? args.proposals : [];
				const proposals: RevisionProposal[] = [];
				for (const item of raw.slice(0, 3)) {
					if (!item || typeof item !== 'object') { continue; }
					const o = item as Record<string, unknown>;
					const original = typeof o.original === 'string' ? o.original : '';
					const replacement = typeof o.replacement === 'string' ? o.replacement : '';
					const explanation = typeof o.explanation === 'string' ? o.explanation : '';
					if (original) { proposals.push({ original, replacement, explanation }); }
				}
				if (!proposals.length) { return err('`proposals` must contain at least one strategy with an `original` span.'); }
				const current = reviewWorkingText(execId, documentKey) ?? '';
				const missing = proposals.filter(p => current && !current.includes(p.original));
				if (missing.length) {
					return err(`These proposal 'original' spans were not found verbatim in the current paper: ${missing.map(m => JSON.stringify(m.original.slice(0, 40))).join(', ')}. Call get_review again and copy exact text (punctuation/whitespace included).`);
				}
				try {
					recordRevisionEntry(execId, concernId, documentKey, proposals);
				} catch (e) {
					return err(`record_revision failed: ${(e as Error).message}`);
				}
				return ok(`Recorded ${proposals.length} revision strategy(ies) for concern ${concernId}. Qoka shows them in the paper in a "< N/${proposals.length} >" carousel with an Accept button - tell the user to review and Accept the one they prefer (that applies it to the paper). Accepting does NOT resolve the concern. AFTER that, ASK the user: "Mark this concern as resolved, or would you like to revise it differently?" - if resolved, call resolve_concern("${execId}", "${concernId}"); if they want a different revision, call record_revision again with new strategies.`);
			},
		},
		{
			name: 'resolve_concern',
			description: 'Mark a review concern resolved (dims/strikes it through in the Manuscript review tab). Call this ONLY after the user confirms they are done with that concern - typically after they accepted a revision and you asked "mark this concern as resolved?". Get the id from get_review\'s `concerns` list. Reversible: pass resolved=false to un-resolve.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					concernId: { type: 'string', description: 'The concern id from get_review (e.g. "claude#0").' },
					resolved: { type: 'boolean', description: 'true to mark resolved (default), false to un-resolve.' },
				},
				required: ['execId', 'concernId'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const concernId = typeof args.concernId === 'string' ? args.concernId : '';
				const resolved = args.resolved !== false;
				if (!execId || !concernId) { return err('execId and concernId are required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				try { setConcernResolved(execId, concernId, resolved); }
				catch (e) { return err(`resolve_concern failed: ${(e as Error).message}`); }
				return ok(resolved ? `Marked concern ${concernId} resolved.` : `Un-resolved concern ${concernId}.`);
			},
		},
		{
			name: 'rerun_review',
			description: 'Re-run the WHOLE peer review on the revised paper (a fresh iteration). Call this when the user asks to re-run after revising (e.g. "re-run the review on the revised paper"). It clears the previous concerns/revisions and bumps the iteration; the review tab then shows each reviewer as "reviewing" again. AFTER calling it, run each reviewer independently on the CURRENT paper and record their concerns with record_review, exactly like the first run.',
			inputSchema: {
				type: 'object',
				properties: { execId: { type: 'string', description: 'The review run id.' } },
				required: ['execId'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				if (!execId) { return err('execId is required.'); }
				const meta = getReviewMeta(execId);
				if (!meta) { return err(`No review run "${execId}".`); }
				try { resetForRerun(execId); }
				catch (e) { return err(`rerun_review failed: ${(e as Error).message}`); }
				const after = getReviewMeta(execId);
				return ok(`Reset review "${execId}" for iteration ${after?.iteration ?? '?'}. Now call get_review("${execId}"), run each reviewer (${meta.reviewers.join(', ')}) independently on the current paper, and record each reviewer's Major/Minor concerns with record_review. The review tab already shows a spinner per reviewer.`);
			},
		},
		{
			name: 'propose_document_edit',
			description: 'Propose an edit to ONE document of a review (the "main" manuscript or a supplementary doc like "suppl-1") that the USER directly asked for and is NOT tied to a review concern - e.g. "delete the title in the supplementary", "fix this typo". Qoka shows it inline in that document (auto-switching to its tab) with an Accept button; nothing changes until the user accepts. This is for the REVIEW\'s documents - do NOT use the paper-writing tools for these. (For fixing a specific review concern, use record_revision instead.) You may give up to 3 alternative `proposals`; the user browses "< N/3 >" and accepts one. Call get_review first and copy the exact text. Set `replacement` to "" to delete a span.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					documentKey: { type: 'string', description: 'Which document to edit: "main" (default) or a supplementary key like "suppl-1" from get_review.' },
					proposals: {
						type: 'array',
						minItems: 1,
						maxItems: 3,
						description: 'Up to 3 alternative ways to make the requested edit. Each: { original, replacement, explanation }.',
						items: {
							type: 'object',
							properties: {
								original: { type: 'string', description: 'Exact span to change, copied verbatim from the document.' },
								replacement: { type: 'string', description: 'Replacement text; use "" to delete the span.' },
								explanation: { type: 'string', description: 'One line on what this does.' },
							},
							required: ['original'],
						},
					},
				},
				required: ['execId', 'proposals'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const documentKey = typeof args.documentKey === 'string' && args.documentKey ? args.documentKey : 'main';
				if (!execId) { return err('execId is required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const raw = Array.isArray(args.proposals) ? args.proposals : [];
				const proposals: RevisionProposal[] = [];
				for (const item of raw.slice(0, 3)) {
					if (!item || typeof item !== 'object') { continue; }
					const o = item as Record<string, unknown>;
					const original = typeof o.original === 'string' ? o.original : '';
					const replacement = typeof o.replacement === 'string' ? o.replacement : '';
					const explanation = typeof o.explanation === 'string' ? o.explanation : '';
					if (original) { proposals.push({ original, replacement, explanation }); }
				}
				if (!proposals.length) { return err('`proposals` must contain at least one { original, replacement }.'); }
				const current = reviewWorkingText(execId, documentKey) ?? '';
				const missing = proposals.filter(p => current && !current.includes(p.original));
				if (missing.length) {
					return err(`These 'original' spans were not found verbatim in "${documentKey}": ${missing.map(m => JSON.stringify(m.original.slice(0, 40))).join(', ')}. Call get_review again and copy exact text.`);
				}
				try {
					recordRevisionEntry(execId, nextEditId(execId), documentKey, proposals);
				} catch (e) {
					return err(`propose_document_edit failed: ${(e as Error).message}`);
				}
				return ok(`Proposed ${proposals.length} edit option(s) for "${documentKey}". Qoka switched to that document and shows an Accept button - nothing is applied until the user accepts.`);
			},
		},
	];
}
