/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Per-project paper storage for the aria-paper MCP. Each manuscript lives in
 * `<workspace>/.qoka/manuscript/draft/<id>/`:
 *   - meta.json          { id, title, format, outline, createdAt, updatedAt }
 *   - manuscript.md      Markdown source of truth (citations as [@citekey])
 *   - citations.csl.json CSL-JSON array of the citeable references
 *   - export/            generated MD / DOCX / LaTeX outputs
 *
 * Markdown is the single source of truth; LaTeX / DOCX / (later) PDF are
 * derived at export time via pandoc + citeproc.
 */

export interface PaperFormat {
	/** e.g. 'research-article' | 'review' | 'case-report' | 'preprint' */
	paperType: string;
	targetWords: number;
	/** CSL style key - maps to a bundled .csl file (ieee, apa, nature, vancouver, chicago). */
	citationStyle: string;
	/** Output language (BCP-47), e.g. 'en'. */
	language: string;
	venue?: string;
}

export interface OutlineSection {
	title: string;
	wordCount?: number;
	keyPoints?: string[];
	/** citekeys from citations.csl.json linked to this section */
	citations?: string[];
}

export interface PaperMeta {
	id: string;
	title: string;
	format: PaperFormat;
	/** Research focus (SPWA "focus" step) - bullet-point statement of problem,
	 *  objectives, gap/contribution. Set by the user or by Claude via set_focus. */
	focus: string;
	outline: OutlineSection[];
	/** Wizard step the user last had open (0=Format … 4=Write). */
	step: number;
	/** True while the agent is generating the first draft (set when it advances to
	 *  the Write step, cleared once the manuscript is written). Drives the "Writing
	 *  your paper…" spinner on the Write step. */
	drafting?: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PaperInfo {
	id: string;
	title: string;
	/** Wizard step the paper last sat on (0=Format … 4=Write). */
	step: number;
	/** True once a manuscript draft has been written (Write step reached and saved).
	 *  Lets the chat list only papers NOT yet finished when asking which to work on. */
	written: boolean;
}

/** A user-provided figure (image) or supplementary source file. Stored under
 *  .qoka/manuscript/draft/<id>/figures|sources/; `summary` is the AI description generated once
 *  on add (so writing prompts use the summary, not the raw file). */
export interface PaperAsset {
	id: string;
	/** Path relative to the paper dir, e.g. "figures/fig1.png". */
	file: string;
	name: string;
	summary?: string;
	/** Optional user-set caption (figures only). */
	caption?: string;
}

export interface PaperAssets {
	figures: PaperAsset[];
	sources: PaperAsset[];
}

export const DEFAULT_FORMAT: PaperFormat = {
	paperType: 'research-article',
	targetWords: 4000,
	citationStyle: 'ieee',
	language: 'en',
};

export function papersDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	// Manuscripts you write live under .qoka/ (kept out of the project's top-level
	// analysis files): <workspace>/.qoka/manuscript/draft/<id>/.
	return folder ? path.join(folder.uri.fsPath, '.qoka', 'manuscript', 'draft') : undefined;
}

/** Hidden store for generated figures (BioRender etc.): <workspace>/.qoka/figures/.
 *  Kept out of the analysis/ tree; surfaced only in the Manuscript tab's Figures
 *  section. */
export function generatedFiguresDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, '.qoka', 'figures') : undefined;
}

function extForImageType(contentType: string): string {
	const t = contentType.toLowerCase();
	if (t.includes('png')) { return '.png'; }
	if (t.includes('jpeg') || t.includes('jpg')) { return '.jpg'; }
	if (t.includes('svg')) { return '.svg'; }
	if (t.includes('webp')) { return '.webp'; }
	if (t.includes('gif')) { return '.gif'; }
	if (t.includes('bmp')) { return '.bmp'; }
	return '';
}

/** Save a generated figure into .qoka/figures/ from an http(s) URL, a data: URL,
 *  or a local file path. Returns the saved absolute path. De-dupes the name. */
export async function saveGeneratedFigure(source: string, name?: string): Promise<string> {
	const dir = generatedFiguresDir();
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	let bytes: Buffer;
	let ext = '';
	if (/^https?:\/\//i.test(source)) {
		const res = await fetch(source);
		if (!res.ok) { throw new Error(`download failed: ${res.status}`); }
		bytes = Buffer.from(await res.arrayBuffer());
		ext = extForImageType(res.headers.get('content-type') ?? '') || path.extname(new URL(source).pathname) || '.png';
	} else if (/^data:/i.test(source)) {
		const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(source);
		if (!m) { throw new Error('invalid data URL'); }
		bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
		ext = extForImageType(m[1] ?? '') || '.png';
	} else {
		bytes = fs.readFileSync(source);
		ext = path.extname(source) || '.png';
	}
	const raw = (name ?? 'figure').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'figure';
	const hasExt = /\.[A-Za-z0-9]+$/.test(raw);
	const baseNoExt = hasExt ? raw.replace(/\.[^.]+$/, '') : raw;
	const useExt = hasExt ? path.extname(raw) : ext;
	let fname = baseNoExt + useExt;
	for (let i = 2; fs.existsSync(path.join(dir, fname)); i++) { fname = `${baseNoExt}-${i}${useExt}`; }
	const dest = path.join(dir, fname);
	fs.writeFileSync(dest, bytes);
	return dest;
}

function paperDir(id: string): string | undefined {
	const dir = papersDir();
	return dir ? path.join(dir, id) : undefined;
}

function metaPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'meta.json') : undefined;
}

export function manuscriptPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'manuscript.md') : undefined;
}

export function citationsPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'citations.csl.json') : undefined;
}

export function exportDir(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'export') : undefined;
}

/** Sanitized base filename for a paper's exports, derived from its title so the
 *  output lands as "<title>.docx" rather than a generic "paper.docx". Strips the
 *  characters no filesystem allows; empty titles fall back to "paper". */
export function exportFileBase(title: string): string {
	const base = (title || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
	return base || 'paper';
}

/** Absolute path of a paper's export in one format, using the title-based name,
 *  falling back to ANY existing file with that extension (older "paper.<ext>"
 *  exports, or one saved under a previous title). Undefined when none exists. */
export function findExportFile(id: string, ext: 'md' | 'docx' | 'tex'): string | undefined {
	const dir = exportDir(id);
	if (!dir) { return undefined; }
	const meta = getMeta(id);
	const preferred = path.join(dir, `${exportFileBase(meta?.title ?? '')}.${ext}`);
	if (fs.existsSync(preferred)) { return preferred; }
	try {
		const hit = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.' + ext));
		return hit ? path.join(dir, hit) : undefined;
	} catch { return undefined; }
}

/** Staged revision the user reviews before it overwrites manuscript.md. */
export function proposalPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'manuscript.proposed.md') : undefined;
}

/** Frozen baseline = the latest clean draft from set_manuscript, before the
 *  user's review edits. Preserved so the user keeps both pre-edit and edited
 *  versions; only a re-generation (set_manuscript) refreshes it. */
export function originalPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'manuscript.original.md') : undefined;
}

export function listPapers(): PaperInfo[] {
	const dir = papersDir();
	if (!dir) { return []; }
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir).filter(e => {
			try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
		});
	} catch {
		return [];
	}
	const papers: PaperInfo[] = [];
	for (const id of entries) {
		const meta = getMeta(id);
		if (meta) { papers.push({ id: meta.id, title: meta.title, step: meta.step ?? 0, written: getManuscript(meta.id).trim().length > 0 }); }
	}
	return papers;
}

/** Resolve a paper by id (exact), then title (exact, then substring), case-insensitive. */
export function resolvePaper(arg: string): PaperMeta | undefined {
	const a = arg.trim().toLowerCase();
	const metas = listPapers().map(p => getMeta(p.id)).filter((m): m is PaperMeta => !!m);
	return metas.find(m => m.id.toLowerCase() === a)
		?? metas.find(m => m.title.toLowerCase() === a)
		?? metas.find(m => m.title.toLowerCase().includes(a));
}

export function getMeta(id: string): PaperMeta | undefined {
	const p = metaPath(id);
	if (!p) { return undefined; }
	try {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<PaperMeta>;
		if (!parsed || typeof parsed.id !== 'string') { return undefined; }
		return {
			id: parsed.id,
			title: typeof parsed.title === 'string' ? parsed.title : 'Untitled',
			format: { ...DEFAULT_FORMAT, ...(parsed.format ?? {}) },
			focus: typeof parsed.focus === 'string' ? parsed.focus : '',
			outline: Array.isArray(parsed.outline) ? parsed.outline : [],
			step: typeof parsed.step === 'number' ? parsed.step : 0,
			drafting: parsed.drafting === true,
			createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
			updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
		};
	} catch {
		return undefined;
	}
}

function writeMeta(meta: PaperMeta): void {
	const p = metaPath(meta.id);
	if (!p) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(path.dirname(p), { recursive: true });
	meta.updatedAt = new Date().toISOString();
	fs.writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8');
}

export function createPaper(title: string): PaperMeta {
	const dir = papersDir();
	if (!dir) { throw new Error('No workspace folder is open.'); }
	const id = 'paper-' + crypto.randomBytes(4).toString('hex');
	const now = new Date().toISOString();
	const meta: PaperMeta = {
		id,
		title: title.trim() || 'Untitled',
		format: { ...DEFAULT_FORMAT },
		focus: '',
		outline: [],
		step: 0,
		createdAt: now,
		updatedAt: now,
	};
	fs.mkdirSync(path.join(dir, id), { recursive: true });
	writeMeta(meta);
	fs.writeFileSync(manuscriptPath(id)!, '', 'utf8');
	fs.writeFileSync(citationsPath(id)!, '[]\n', 'utf8');
	return meta;
}

export function setFormat(id: string, partial: Partial<PaperFormat>): PaperMeta {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	meta.format = { ...meta.format, ...partial };
	writeMeta(meta);
	return meta;
}

export function setFocus(id: string, focus: string): PaperMeta {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	meta.focus = focus;
	writeMeta(meta);
	return meta;
}

export function setOutline(id: string, outline: OutlineSection[]): PaperMeta {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	meta.outline = outline;
	writeMeta(meta);
	return meta;
}

export function setTitle(id: string, title: string): PaperMeta {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	meta.title = title.trim() || meta.title;
	writeMeta(meta);
	return meta;
}

/** Set the wizard step the writing window shows (0=Format … 4=Write). Lets the
 *  agent advance the UI to the next step after finishing one, so the user is
 *  carried through focus -> outline -> draft. */
export function setStep(id: string, step: number): PaperMeta {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	meta.step = Math.max(0, Math.min(4, Math.round(step)));
	// Advancing to Write means the agent is about to draft: show the spinner.
	// set_manuscript clears it once the draft lands.
	meta.drafting = meta.step === 4;
	writeMeta(meta);
	return meta;
}

export function getManuscript(id: string): string {
	const p = manuscriptPath(id);
	if (!p) { return ''; }
	try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function getManuscriptOriginal(id: string): string {
	const p = originalPath(id);
	if (!p) { return ''; }
	try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** True when the working copy has diverged from the frozen baseline - i.e. the
 *  user accepted review edits that a re-generation would discard. */
export function hasUnsavedEdits(id: string): boolean {
	const orig = getManuscriptOriginal(id);
	if (!orig.trim()) { return false; } // no baseline yet → nothing to lose
	return getManuscript(id).trim() !== orig.trim();
}

/**
 * set_manuscript: generate / re-generate a full draft. Resets BOTH the working
 * copy and the frozen baseline to the new draft, and clears any pending review
 * (the old proposal is meaningless against new text). This is the only path
 * that overwrites manuscript.original.md.
 */
export function writeManuscript(id: string, markdown: string): void {
	const p = manuscriptPath(id);
	const op = originalPath(id);
	if (!p) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const meta = getMeta(id);
	// Keep the paper title as the leading H1 so it shows in manuscript.md and
	// every export, regardless of what the agent wrote.
	const out = meta ? withTitleHeading(markdown, meta.title) : markdown;
	fs.writeFileSync(p, out, 'utf8');
	if (op) { fs.writeFileSync(op, out, 'utf8'); } // refresh frozen baseline
	clearProposal(id); // any pending review is obsolete against the new draft
	// Draft landed: move the window to the Write step and stop the spinner, so the
	// UI follows the agent even if it wrote without advancing first.
	if (meta) { meta.drafting = false; meta.step = 4; writeMeta(meta); }
}

/** Stage a proposed revision (full revised manuscript) for the user to review;
 *  manuscript.md is NOT changed until the user accepts in the review tab. */
export function setProposal(id: string, markdown: string): void {
	const p = proposalPath(id);
	if (!p) { throw new Error('No workspace folder is open.'); }
	const meta = getMeta(id);
	const out = meta ? withTitleHeading(markdown, meta.title) : markdown;
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, out, 'utf8');
}

/** Read the staged revision, or '' if none is pending. */
export function getProposal(id: string): string {
	const p = proposalPath(id);
	if (!p) { return ''; }
	try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Discard any staged revision. */
export function clearProposal(id: string): void {
	const p = proposalPath(id);
	if (!p) { return; }
	try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/** Rewrite manuscript.md so its leading H1 matches the current title. Called
 *  when the title changes so the body stays in sync without a re-draft. */
export function syncManuscriptTitle(id: string): void {
	const meta = getMeta(id);
	if (!meta) { return; }
	// Title is metadata, not a content edit - apply the H1 to BOTH the working
	// copy and the frozen baseline so a title-only change doesn't read as an
	// "unsaved edit" (which would otherwise trigger the re-write warning).
	for (const p of [manuscriptPath(id), originalPath(id)]) {
		if (!p) { continue; }
		let cur = '';
		try { cur = fs.readFileSync(p, 'utf8'); } catch { continue; }
		// Don't materialize a title-only file before there's an actual draft.
		if (!cur.trim()) { continue; }
		fs.writeFileSync(p, withTitleHeading(cur, meta.title), 'utf8');
	}
}

export function getCitations(id: string): unknown[] {
	const p = citationsPath(id);
	if (!p) { return []; }
	try {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function setCitations(id: string, items: unknown[]): void {
	const p = citationsPath(id);
	if (!p) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

// --- Figures & supplementary sources ----------------------------------------

export function figuresDir(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'figures') : undefined;
}
export function sourcesDir(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'sources') : undefined;
}
function assetsPath(id: string): string | undefined {
	const dir = paperDir(id);
	return dir ? path.join(dir, 'assets.json') : undefined;
}

export function getAssets(id: string): PaperAssets {
	const p = assetsPath(id);
	if (!p) { return { figures: [], sources: [] }; }
	try {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
		return {
			figures: Array.isArray(parsed?.figures) ? parsed.figures : [],
			sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
		};
	} catch {
		return { figures: [], sources: [] };
	}
}

function writeAssets(id: string, assets: PaperAssets): void {
	const p = assetsPath(id);
	if (!p) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(assets, null, 2) + '\n', 'utf8');
}

/** Copy a picked file into the paper's figures/ or sources/ dir and register it
 *  (summary pending). Returns the new asset entry. */
export function addAsset(id: string, kind: 'figure' | 'source', srcAbsPath: string): PaperAsset {
	const dir = kind === 'figure' ? figuresDir(id) : sourcesDir(id);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const sub = kind === 'figure' ? 'figures' : 'sources';
	let name = path.basename(srcAbsPath);
	if (fs.existsSync(path.join(dir, name))) {
		const ext = path.extname(name);
		name = `${path.basename(name, ext)}-${crypto.randomBytes(2).toString('hex')}${ext}`;
	}
	fs.copyFileSync(srcAbsPath, path.join(dir, name));
	const entry: PaperAsset = { id: 'a-' + crypto.randomBytes(4).toString('hex'), file: `${sub}/${name}`, name };
	const assets = getAssets(id);
	assets[kind === 'figure' ? 'figures' : 'sources'].push(entry);
	writeAssets(id, assets);
	return entry;
}

export function setAssetSummary(id: string, assetId: string, summary: string): PaperAsset | undefined {
	const assets = getAssets(id);
	const hit = [...assets.figures, ...assets.sources].find(a => a.id === assetId);
	if (!hit) { return undefined; }
	hit.summary = summary;
	writeAssets(id, assets);
	return hit;
}

export function removeAsset(id: string, assetId: string): void {
	const dir = paperDir(id);
	const assets = getAssets(id);
	const hit = [...assets.figures, ...assets.sources].find(a => a.id === assetId);
	if (hit && dir) { try { fs.unlinkSync(path.join(dir, hit.file)); } catch { /* already gone */ } }
	assets.figures = assets.figures.filter(a => a.id !== assetId);
	assets.sources = assets.sources.filter(a => a.id !== assetId);
	writeAssets(id, assets);
}

/** Add (or replace by id) a single CSL-JSON citation item. Returns its citekey. */
export function addCitation(id: string, item: Record<string, unknown>): string {
	return addCitations(id, [item])[0];
}

/** Add MANY citations in ONE read/write of citations.csl.json (so a batch import
 *  does not rewrite the file once per item). Each item keeps its own `id` citekey,
 *  generating one when absent; later items win on a key clash within the batch, and
 *  the batch replaces any existing entry with the same key. Returns the citekeys in
 *  input order. */
export function addCitations(id: string, newItems: Record<string, unknown>[]): string[] {
	const keys: string[] = [];
	for (const item of newItems) {
		const key = typeof item.id === 'string' && item.id ? item.id : 'ref-' + crypto.randomBytes(3).toString('hex');
		item.id = key;
		keys.push(key);
	}
	const keySet = new Set(keys);
	const items = getCitations(id).filter(c => !keySet.has(String((c as { id?: unknown }).id ?? '')));
	items.push(...newItems);
	setCitations(id, items);
	return keys;
}

/**
 * Build a clean, citeproc-friendly citekey from a CSL item - `familyYear`
 * (e.g. "lu2026"). BibTeX exported by reference managers (RefWorks, EndNote)
 * carries opaque keys like `RefWorks:RefID:149-lu2026towards`; those work in
 * pandoc but are ugly and fragile, so on import we regenerate from author+year.
 */
export function citekeyFromCsl(item: Record<string, unknown>): string {
	const authors = Array.isArray(item.author) ? item.author as Array<Record<string, unknown>> : [];
	const first = authors[0];
	const famRaw = (first?.family ?? first?.literal ?? '') as string;
	const fam = (famRaw.toString().trim().split(/\s+/).pop() || 'ref').toLowerCase().replace(/[^a-z0-9]/g, '');
	const issued = item.issued as { 'date-parts'?: number[][] } | undefined;
	const year = issued?.['date-parts']?.[0]?.[0] ?? '';
	return `${fam || 'ref'}${year}`;
}

/** Add a citation under a freshly-generated clean citekey, de-duplicated against
 *  the paper's existing keys (familyYear, familyYearb, …). Returns the citekey. */
export function addCitationCleanKey(id: string, item: Record<string, unknown>): string {
	const used = new Set(getCitations(id).map(c => String((c as { id?: unknown }).id ?? '')));
	const base = citekeyFromCsl(item) || 'ref';
	let key = base, i = 1;
	while (used.has(key)) { key = base + String.fromCharCode(96 + (++i)); }
	item.id = key;
	return addCitation(id, item);
}

/**
 * Ensure the manuscript begins with a single `# {title}` H1 (the paper title),
 * replacing any existing leading H1 or inserting one. Section headers (`## …`)
 * are left untouched. Lets the title live in one place (meta.title) while still
 * appearing in manuscript.md and every export.
 */
export function withTitleHeading(markdown: string, title: string): string {
	const heading = `# ${title}`.trimEnd();
	const lines = markdown.split('\n');
	let i = 0;
	while (i < lines.length && lines[i].trim() === '') { i++; }
	if (i < lines.length && /^#\s+/.test(lines[i])) {
		lines[i] = heading;
		return lines.join('\n');
	}
	const body = markdown.replace(/^\s+/, '');
	return body ? `${heading}\n\n${body}` : `${heading}\n`;
}
