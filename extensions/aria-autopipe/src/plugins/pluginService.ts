/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { HubPlugin } from '../hub/apiClient';

/** Server-side pagination contract from the plugin manifest. The viewer's
 *  fake `/data/{filename}` endpoint executes these shell commands against
 *  the SSH host to feed the plugin. Shape mirrors autopipe-app's `DataSource`. */
export interface DataSourceCommands {
	type: 'text' | 'docker';
	image?: string;
	row_count?: string;
	metadata?: string;
	rows?: string;
	col_headers?: string[];
	meta_parse?: string;
	allow_nonzero_exit?: boolean;
	fallback?: DataSourceCommands[];
}

/** When a plugin viewer claims a whole pipeline result DIRECTORY (rather than
 *  a single file extension). A `results/<run>/` folder carries a
 *  `.qoka-pipeline.json` marker naming the pipeline that produced it; a
 *  pipeline-type plugin claims the folder when ANY of its rules match (the
 *  marker name is in a rule's `names`, OR all of a rule's `required_files` are
 *  present). Mirrors autopipe's `pipeline_match`. The current plugins use the
 *  `rules[]` shape; `names`/`required_files` at the top level is the legacy
 *  single-rule form, still accepted. */
export interface PipelineMatchRule {
	names?: string[];
	required_files?: string[];
}
export interface PipelineMatch {
	rules?: PipelineMatchRule[];
	names?: string[];
	required_files?: string[];
}

export interface PluginManifest {
	name: string;
	version: string;
	description?: string;
	extensions: string[];
	entry: string;
	style?: string | null;
	data_source?: DataSourceCommands;
	/** 'file' (default) matches by extension; 'pipeline' claims a whole
	 *  result directory via `pipeline_match`. */
	plugin_type?: 'file' | 'pipeline';
	pipeline_match?: PipelineMatch;
}

export interface InstalledPlugin {
	manifest: PluginManifest;
	dir: string;
}

/** The default plugins Qoka installs on first run. Fetched from Hub so the user
 *  has every common file type covered out of the box. Names match the Hub
 *  registry entries verbatim. The first 12 are file-extension viewers; the last
 *  is a pipeline dashboard (plugin_type 'pipeline') that claims an aptaselect
 *  result directory (matched via its pipeline_match rules). PDF is intentionally
 *  absent: it is served by the built-in qoka.pdfViewer, not a plugin (see
 *  NATIVE_VIEWER_NAMES). */
export const DEFAULT_PLUGIN_NAMES = [
	'bam-viewer', 'bcf-viewer', 'bed-viewer', 'cram-viewer', 'csv-viewer',
	'fasta-viewer', 'fastq-viewer', 'gff-viewer', 'hdf5-viewer', 'image-viewer',
	'text-viewer', 'vcf-viewer',
	'aptaselect-viewer',
];

/** Viewers Qoka serves natively (built-in custom editors), so they are NOT
 *  managed as installable plugins: their files always open in the built-in
 *  editor regardless of any Hub plugin, and installing / removing the matching
 *  Hub plugin does nothing. PDF -> qoka.pdfViewer. Kept out of the default set
 *  and the Result Viewers list so the UI never offers a no-op install/remove. */
export const NATIVE_VIEWER_NAMES = new Set<string>(['pdf-viewer', 'image-viewer']);

/** Display info + served extensions for each bundled native viewer, so the Result
 *  Viewers panel can list them (and toggle them on/off) even though they are not
 *  Hub plugins. `custom` maps to the Qoka custom-editor viewType. */
export const NATIVE_VIEWER_INFO: Record<string, { description: string; extensions: string[]; custom: string }> = {
	'pdf-viewer': { description: 'Built-in PDF viewer (Qoka)', extensions: ['pdf'], custom: 'qoka.pdfViewer' },
	'image-viewer': { description: 'Built-in image viewer (Qoka)', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'], custom: 'qoka.imageViewer' },
};

/** Hub tag (in user_plugins.tags) that marks a viewer as a Qoka default.
 *  Adding / removing this tag on the Hub changes the default set WITHOUT an app
 *  update. Plugin FILES still download from the Hub; this only decides WHICH
 *  viewers are defaults, and it rides along with the plugin list we already fetch. */
export const DEFAULT_TAG = 'qoka-default';

/** Default viewer names for this Hub snapshot: every plugin carrying DEFAULT_TAG,
 *  or - until any plugin is tagged on the Hub - the built-in fallback list. */
export function resolveDefaultNames(hubPlugins: HubPlugin[]): Set<string> {
	const tagged = hubPlugins.filter(p => (p.tags ?? []).includes(DEFAULT_TAG)).map(p => p.name);
	const names = tagged.length ? tagged : DEFAULT_PLUGIN_NAMES;
	// Never treat a natively-served viewer (e.g. PDF) as an installable default.
	return new Set(names.filter(n => !NATIVE_VIEWER_NAMES.has(n)));
}

/**
 * Local plugin manager. Plugins live under the user's home in
 * `~/.qoka/autopipe-plugins/<name>/` so a single install can serve every
 * SSH host the user connects to. `PluginService` handles:
 *
 *   - reading installed manifests
 *   - matching a file extension to a plugin
 *   - downloading a plugin from its Hub GitHub tarball
 *   - the first-run bootstrap that installs the default plugins
 *
 * No npm dependencies: extraction uses the system `tar` command. Linux
 * and macOS ship it; Windows 10+ ships it too.
 */
/** One-time move of the pre-rename plugin dir (~/.aria-autopipe-plugins) to its
 *  new home (~/.qoka/autopipe-plugins), so updating keeps installed plugins
 *  instead of re-downloading the defaults and orphaning user-installed ones. */
function migrateLegacyPluginsDir(newDir: string): void {
	try {
		const legacy = path.join(os.homedir(), '.aria-autopipe-plugins');
		if (fs.existsSync(legacy) && !fs.existsSync(newDir)) {
			fs.mkdirSync(path.dirname(newDir), { recursive: true });
			fs.renameSync(legacy, newDir);
		}
	} catch { /* best-effort - ensureDir + Hub re-download recover if this fails */ }
}

export class PluginService {

	private readonly userPluginsDir: string;

	constructor() {
		this.userPluginsDir = path.join(os.homedir(), '.qoka', 'autopipe-plugins');
		migrateLegacyPluginsDir(this.userPluginsDir);
		console.log(`[aria-autopipe] PluginService: userPluginsDir = ${this.userPluginsDir}`);
		this.ensureDir(this.userPluginsDir);
		console.log(`[aria-autopipe] PluginService: directory ${fs.existsSync(this.userPluginsDir) ? 'exists' : 'does NOT exist'}`);
	}

	pluginsDirectory(): string {
		return this.userPluginsDir;
	}

	/** List every plugin currently installed under the user's plugin
	 *  directory, in install-time order. Bad manifests are skipped with a
	 *  console warning rather than killing the listing. */
	listInstalled(): InstalledPlugin[] {
		const out: InstalledPlugin[] = [];
		if (!fs.existsSync(this.userPluginsDir)) {
			return out;
		}
		for (const entry of fs.readdirSync(this.userPluginsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = path.join(this.userPluginsDir, entry.name);
			const manifest = this.readManifest(dir);
			if (manifest) {
				out.push({ manifest, dir });
			}
		}
		return out;
	}

	isInstalled(name: string): boolean {
		return fs.existsSync(path.join(this.userPluginsDir, name, 'manifest.json'));
	}

	installedVersion(name: string): string | null {
		const m = this.readManifest(path.join(this.userPluginsDir, name));
		return m?.version ?? null;
	}

	/** Delete an installed plugin's directory. No-op if it isn't there. */
	uninstall(name: string): void {
		const dir = path.join(this.userPluginsDir, name);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	/** JSON file (a name array) recording default viewers the user has
	 *  explicitly removed, so ensureDefaults never re-installs them. */
	private removedRecordPath(): string {
		return path.join(path.dirname(this.userPluginsDir), 'autopipe-plugins-removed.json');
	}

	getRemovedDefaults(): Set<string> {
		try {
			const raw = JSON.parse(fs.readFileSync(this.removedRecordPath(), 'utf8'));
			return new Set(Array.isArray(raw) ? raw.map((n: unknown) => String(n)) : []);
		} catch {
			return new Set();
		}
	}

	private writeRemoved(set: Set<string>): void {
		try {
			fs.writeFileSync(this.removedRecordPath(), JSON.stringify([...set]), 'utf8');
		} catch { /* best effort */ }
	}

	/** Record `name` as user-removed (survives restarts; blocks re-install). */
	markRemoved(name: string): void {
		const s = this.getRemovedDefaults();
		s.add(name);
		this.writeRemoved(s);
	}

	/** Clear the user-removed flag so `name` can be a default / installed again. */
	unmarkRemoved(name: string): void {
		const s = this.getRemovedDefaults();
		s.delete(name);
		this.writeRemoved(s);
	}

	// --- Native viewers (qoka.pdfViewer / qoka.imageViewer) enable/disable ------
	// Bundled native viewers can be "removed" (disabled) from the Result Viewers
	// panel just like a plugin. Disabling is a persisted flag; the routing then
	// points those file types at VS Code's default editor instead of the native one.

	private nativeDisabledPath(): string {
		return path.join(path.dirname(this.userPluginsDir), 'autopipe-native-disabled.json');
	}

	getDisabledNativeViewers(): Set<string> {
		try {
			const raw = JSON.parse(fs.readFileSync(this.nativeDisabledPath(), 'utf8'));
			return new Set(Array.isArray(raw) ? raw.map((n: unknown) => String(n)) : []);
		} catch {
			return new Set();
		}
	}

	setNativeViewerEnabled(name: string, enabled: boolean): void {
		const s = this.getDisabledNativeViewers();
		if (enabled) { s.delete(name); } else { s.add(name); }
		try { fs.writeFileSync(this.nativeDisabledPath(), JSON.stringify([...s]), 'utf8'); } catch { /* best effort */ }
	}

	/**
	 * Find the plugin that should render a file with the given extension.
	 * Extensions are compared case-insensitively and stripped of a leading
	 * dot. Returns null when nothing matches.
	 */
	findForExtension(ext: string): InstalledPlugin | null {
		const wanted = ext.toLowerCase().replace(/^\./, '');
		for (const p of this.listInstalled()) {
			// A pipeline-type plugin claims directories, not file extensions -
			// don't let it shadow a real file viewer.
			if (p.manifest.plugin_type === 'pipeline') {
				continue;
			}
			if (p.manifest.extensions.some(e => e.toLowerCase() === wanted)) {
				return p;
			}
		}
		return null;
	}

	/**
	 * Find a pipeline-type plugin that claims a whole result directory. Mirrors
	 * the autopipe app's matcher: collect the plugin's rules (the `rules[]`
	 * shape plus a legacy top-level names/required_files as one rule), and the
	 * folder matches when ANY rule matches - either the folder's marker
	 * `pipelineName` is in the rule's `names`, OR all of the rule's
	 * `required_files` are present in `dirFiles`. So one viewer can claim a
	 * folder by name even when its outputs vary, or by output files even when
	 * the marker name is missing/renamed. Returns null when nothing matches -
	 * the caller then falls back to the per-file viewer.
	 */
	findForPipeline(pipelineName: string, dirFiles: string[]): InstalledPlugin | null {
		const marker = pipelineName.trim().toLowerCase();
		// The marker records the Docker image name, which Qoka builds as
		// `autopipe-<pipeline>`, but a plugin's `names` list the bare pipeline
		// name (e.g. "aptaselect"). Match on both so the image-name marker still
		// resolves to the pipeline viewer.
		const markerCandidates = new Set([marker, marker.replace(/^autopipe-/, '')].filter(Boolean));
		const present = new Set(dirFiles.map(f => f.toLowerCase()));
		for (const p of this.listInstalled()) {
			if (p.manifest.plugin_type !== 'pipeline') {
				continue;
			}
			const match = p.manifest.pipeline_match;
			if (!match) {
				continue;
			}
			const rules: PipelineMatchRule[] = Array.isArray(match.rules) ? [...match.rules] : [];
			// Legacy single-rule form: top-level names / required_files.
			if ((match.names && match.names.length) || (match.required_files && match.required_files.length)) {
				rules.push({ names: match.names, required_files: match.required_files });
			}
			for (const r of rules) {
				const names = Array.isArray(r.names) ? r.names : [];
				if (names.some(n => markerCandidates.has(String(n).trim().toLowerCase()))) {
					return p;
				}
				const required = Array.isArray(r.required_files) ? r.required_files : [];
				if (required.length && required.every(f => present.has(String(f).trim().toLowerCase()))) {
					return p;
				}
			}
		}
		return null;
	}

	/**
	 * Download a plugin from Hub and install it under the user dir. Uses
	 * GitHub's archive endpoint to pull a tarball, then `tar -xz` to
	 * extract; `--strip-components=1` removes GitHub's wrapper directory
	 * (e.g. `pdf-viewer-1.1.1/`).
	 */
	async install(plugin: HubPlugin, onProgress?: (msg: string) => void): Promise<void> {
		const tarUrl = githubTarballUrl(plugin.github_url);
		const tmpFile = path.join(os.tmpdir(), `aria-${plugin.name}-${Date.now()}.tar.gz`);
		try {
			onProgress?.(`Downloading ${plugin.name}…`);
			await downloadToFile(tarUrl, tmpFile);

			const targetDir = path.join(this.userPluginsDir, plugin.name);
			// Wipe a pre-existing install so we don't end up with a mix of
			// old and new files (e.g. a removed JS dependency from v1).
			if (fs.existsSync(targetDir)) {
				fs.rmSync(targetDir, { recursive: true, force: true });
			}
			fs.mkdirSync(targetDir, { recursive: true });

			onProgress?.(`Extracting ${plugin.name}…`);
			await runTar(tmpFile, targetDir);
		} finally {
			try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
		}
	}

	/**
	 * Make sure the default plugins are installed. Skips ones that
	 * already match the Hub version; downloads everything else. Returns
	 * the actions taken so callers can build a summary notification.
	 */
	async ensureDefaults(
		fetchHubList: () => Promise<HubPlugin[]>,
		onProgress?: (msg: string, fraction: number) => void,
	): Promise<{ installed: string[]; updated: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }> {
		const installed: string[] = [];
		const updated: string[] = [];
		const skipped: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		let hubPlugins: HubPlugin[];
		try {
			hubPlugins = await fetchHubList();
		} catch (err) {
			throw new Error(`Couldn't reach Autopipe Hub: ${(err as Error).message}`);
		}

		// Defaults the user has explicitly removed stay removed - never re-install them.
		// The default set comes from the Hub's DEFAULT_TAG (fallback: the built-in list).
		const removed = this.getRemovedDefaults();
		const wantedNames = resolveDefaultNames(hubPlugins);
		const defaults = hubPlugins.filter(p => wantedNames.has(p.name) && !removed.has(p.name));

		for (let i = 0; i < defaults.length; i++) {
			const plugin = defaults[i];
			const fraction = i / defaults.length;
			const currentVersion = this.installedVersion(plugin.name);
			if (currentVersion === plugin.version) {
				skipped.push(plugin.name);
				onProgress?.(`${plugin.name} (already up to date)`, fraction);
				continue;
			}
			try {
				onProgress?.(`${plugin.name} ${currentVersion ? `${currentVersion} → ${plugin.version}` : plugin.version}`, fraction);
				await this.install(plugin);
				if (currentVersion) {
					updated.push(plugin.name);
				} else {
					installed.push(plugin.name);
				}
			} catch (err) {
				failed.push({ name: plugin.name, error: (err as Error).message });
			}
		}
		onProgress?.('Done', 1);
		return { installed, updated, skipped, failed };
	}

	private readManifest(dir: string): PluginManifest | null {
		const file = path.join(dir, 'manifest.json');
		if (!fs.existsSync(file)) {
			return null;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (typeof raw?.name === 'string' && typeof raw?.version === 'string' && Array.isArray(raw?.extensions) && typeof raw?.entry === 'string') {
				return {
					name: raw.name,
					version: raw.version,
					description: typeof raw.description === 'string' ? raw.description : undefined,
					extensions: raw.extensions.map((e: unknown) => String(e)),
					entry: raw.entry,
					style: typeof raw.style === 'string' ? raw.style : null,
					// Pass through the data_source block verbatim; the
					// viewer's pagination handler inspects it directly.
					data_source: raw.data_source as DataSourceCommands | undefined,
					plugin_type: raw.plugin_type === 'pipeline' ? 'pipeline' : 'file',
					pipeline_match: raw.pipeline_match as PipelineMatch | undefined,
				};
			}
		} catch (err) {
			console.warn(`[aria-autopipe] bad manifest at ${file}`, err);
		}
		return null;
	}

	private ensureDir(dir: string): void {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (err) {
			// Surface mkdir failures right away - without this log we
			// silently end up with an empty plugin set and no obvious
			// reason. Permission and "exists as file" both land here.
			console.error(`[aria-autopipe] mkdirSync(${dir}) failed:`, err);
		}
	}
}

/**
 * Convert a GitHub `tree/<tag>` URL (as stored in Hub) into the matching
 * tarball download URL. The Hub stores e.g.
 *   https://github.com/khyeonm/pdf-viewer/tree/v1.1.1
 * GitHub's archive endpoint at
 *   https://codeload.github.com/khyeonm/pdf-viewer/tar.gz/refs/tags/v1.1.1
 * is the tarball.
 */
function githubTarballUrl(treeUrl: string): string {
	// Accept both /tree/<ref> and /<ref> forms.
	const m = treeUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree)?\/([^/?#]+)/);
	if (!m) {
		throw new Error(`Unrecognized GitHub URL: ${treeUrl}`);
	}
	const [, owner, repo, ref] = m;
	// `refs/tags/<tag>` works for tag refs; for branch refs we'd want
	// `refs/heads/<branch>`. Qoka's plugins use semver tags exclusively,
	// so we hard-code the tags variant.
	return `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${ref}`;
}

function downloadToFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		const onError = (err: Error) => {
			file.close();
			try { fs.unlinkSync(dest); } catch { /* ignore */ }
			reject(err);
		};
		const fetch = (u: string, redirectsLeft: number) => {
			https.get(u, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (redirectsLeft <= 0) {
						onError(new Error(`Too many redirects (${url})`));
						return;
					}
					const next = res.headers.location.startsWith('http')
						? res.headers.location
						: new URL(res.headers.location, u).toString();
					fetch(next, redirectsLeft - 1);
					return;
				}
				if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
					onError(new Error(`HTTP ${res.statusCode} for ${u}`));
					return;
				}
				res.pipe(file);
				file.on('finish', () => file.close(() => resolve()));
			}).on('error', onError);
		};
		fetch(url, 10);
	});
}

function runTar(tarball: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// --strip-components=1 drops the `<repo>-<tag>/` wrapper GitHub puts
		// around the tarball contents so the plugin files land directly in
		// destDir.
		const child = spawn('tar', ['-xzf', tarball, '-C', destDir, '--strip-components=1']);
		let stderr = '';
		child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
			}
		});
	});
}
