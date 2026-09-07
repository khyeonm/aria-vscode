/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAiProviders } from './detection/claudeCodeDetector';
import { QokaMcpServer } from './mcp/server';
import { ALL_TOOLS, AUTOPIPE_MCP_INSTRUCTIONS, ENVIRONMENT_TOOLS, ENVIRONMENT_MCP_INSTRUCTIONS, RUN_SERVER_TOOLS } from './mcp/tools';
import { RUN_MCP_INSTRUCTIONS } from './mcp/tools/run';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { ConfigService } from './config/configService';
import { SshService } from './ssh/sshService';
import { VMManager } from './vm/vmManager';
import { wslAvailable, listDistrosStrict, isWslServiceError, pickDistro, installWslEngine } from './vm/wsl';
import { QokaPdfEditorProvider } from './viewer/pdfEditor';
import { openResultsViewer, viewFileInViewer, QokaFileViewerProvider } from './viewer/viewerPanel';
import { HubApiClient, HubPlugin } from './hub/apiClient';
import { GitHubAuthService } from './github/oauthService';
import { setServices } from './common/services';
import { runScriptInEnv, readRunEnvFile } from './mcp/tools/run';
import { registerSetupCommands } from './commands/setupCommands';
import { PluginService, DEFAULT_PLUGIN_NAMES, resolveDefaultNames, NATIVE_VIEWER_NAMES } from './plugins/pluginService';
import { openHubPanel } from './panels/hubPanel';
import { openPluginsPanel } from './panels/pluginsPanel';
import { ensureBioRenderRegistered, loginBioRender, logoutBioRender, bioRenderStatus } from './registration/biorenderMcp';
import { ensureWorkspaceScaffold } from './common/workspaceSync';
import { NotebookKernel } from './notebook/controller';

let mcpServer: QokaMcpServer | undefined;
// Second MCP server ("qoka-run"): quick one-off code execution on the same
// built-in server. Started + registered alongside autopipe.
let runServer: QokaMcpServer | undefined;
// Third MCP server ("qoka-environment"): the run environment / active connection /
// resources (get_workspace_info, start_server, get/set_vm_resources). Started +
// registered alongside the others so code paths call it first without touching autopipe.
let envServer: QokaMcpServer | undefined;
interface ClientRegistration {
	ok: boolean;
	message: string;
	port: number | null;
}
let lastRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};
let lastRunRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};
let lastEnvRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};
// Set at activate(). refreshAiRegistrations needs globalState for the Codex
// reload prompt, and it runs outside activate()'s scope.
let extensionContext: vscode.ExtensionContext | undefined;

// BioRender MCP (built-in remote OAuth server). The server is registered
// headerless so it is present from the start; the actual auth is the AI CLI's
// own OAuth, driven from the Settings BioRender section via `claude mcp login`
// (a statically injected token header is ignored by the CLI for OAuth servers).

// globalState flag: the user pressed "Continue without the run environment" during
// first-run WSL/Ubuntu setup. While set, we don't auto-install or gate on launch -
// only auto-start when the environment is already ready. Cleared on explicit setup.
const WSL_SKIP_KEY = 'aria.autopipe.wslSetupSkipped';

/** Append a first-run WSL diagnostic line to ~/qoka-wsl-diag.log. Unlike a toast or the
 *  DevTools console, a file survives the sign-in flow's window reloads, so every launch
 *  attempt is preserved in order for the user to copy back. Best-effort; never throws. */
function wslDiag(message: string): void {
	try {
		fs.appendFileSync(path.join(os.homedir(), 'qoka-wsl-diag.log'), `${new Date().toISOString()} ${message}\n`);
	} catch { /* diagnostics must never break launch */ }
}

/**
 * First-run WSL setup phase, surfaced to the startup loader (via aria.autopipe.vm.status)
 * so "Preparing Qoka…" does NOT clear while the WSL engine is still being installed. The
 * built-in VM is not running during this whole phase (it only starts after a reboot once
 * the engine exists), so vm.status() alone would report 'stopped' and the loader would
 * drop into the workbench mid-setup. This flag keeps the loader up until setup resolves.
 *  - 'checking'   : probing whether the WSL engine is present (before the prompt shows)
 *  - 'prompting'  : the "Install WSL & Ubuntu" prompt is up, awaiting the user's choice
 *  - 'installing' : the elevated `wsl --install` is running
 *  - 'reboot'     : install finished; the user must restart the PC to continue
 *  - 'idle'       : not gating (engine present and starting, or the user opted out)
 */
type WslSetupPhase = 'idle' | 'checking' | 'prompting' | 'installing' | 'reboot';
let wslSetupPhase: WslSetupPhase = 'idle';

/** True once the Windows launch has DECIDED whether the WSL install prompt will show
 *  (so wslSetupPhase is meaningful). The sign-in overlay polls this + wslSetupPhase to
 *  hold sign-in until the WSL prompt is resolved, so the prompt appears BEFORE login. */
let wslLaunchDecided = false;

/** True from the moment we commit to running the built-in run-environment setup (WSL
 *  engine ready, project window) until it reaches 'ready' or the user opts out. The
 *  startup loader gates on this so it HOLDS until the Ubuntu account window appears and
 *  the account is created - state, not a fixed time grace. Never set for SSH targets or
 *  opted-out users, so their loader is never held waiting for a setup that won't run. */
let wslSetupPending = false;

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-autopipe] activate()');
	extensionContext = context;

	// On every activation (idempotent, best-effort): migrate any old autopipe/ +
	// mixed layout to the unified data/analysis/results tree AND make sure those
	// three dirs + the README exist, so a freshly opened project always shows
	// them - even for remote-only users who never start the built-in VM.
	try { ensureWorkspaceScaffold(); } catch { /* best-effort */ }

	// In-app PDF viewer (pdf.js) as the default editor for .pdf, so downloaded papers
	// (Paper Library) and pipeline result PDFs render inside Qoka as an editor tab
	// instead of an external app.
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(
		QokaPdfEditorProvider.viewType,
		new QokaPdfEditorProvider(),
		{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
	));

	// Open a pipeline results/<run> FOLDER in the autopipe viewer (plugins render each
	// result file from the LOCAL results/ folder). Invoked by the "Open in viewer"
	// button on results/ folders in the Analysis tab. Opening a folder marks it as a
	// tree scope; clicking a file inside routes to aria.autopipe.viewFileInViewer.
	context.subscriptions.push(vscode.commands.registerCommand('aria.autopipe.openResultsViewer', async (arg: unknown) => {
		const local = typeof arg === 'string' ? arg : (arg && (arg as vscode.Uri).fsPath) || '';
		if (!local) { return; }
		try {
			await openResultsViewer(String(local));
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not open the pipeline viewer: ${(e as Error).message}`);
		}
	}));

	// Render a single result file in the viewer tab whose scope contains it.
	// Called by the core explorer when a file inside an open viewer scope is clicked.
	context.subscriptions.push(vscode.commands.registerCommand('aria.autopipe.viewFileInViewer', async (arg: unknown) => {
		const local = typeof arg === 'string' ? arg : (arg && (arg as vscode.Uri).fsPath) || '';
		if (!local) { return; }
		try {
			await viewFileInViewer(String(local));
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not open the file in the viewer: ${(e as Error).message}`);
		}
	}));

	// Per-extension result viewer: clicking a plugin-backed result file (h5ad,
	// bam, ...) in the Analysis tab opens it in its own editor tab via this
	// custom editor, instead of needing the eye-icon viewer scope.
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(
		'qoka.autopipe.fileViewer',
		new QokaFileViewerProvider(),
		{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
	));

	// Wire up the shared service container so MCP tool handlers can reach
	// config / ssh / hub / github without each of them tracking the
	// dependency graph individually.
	const config = new ConfigService(context);

	// Built-in server ("Qoka built-in" Run environment): a WSL2 distro (Windows)
	// or bundled QEMU/vfkit guest (Mac/Linux), exposed to the rest of autopipe as
	// a synthetic SSH profile. Created before the shared container so tool handlers
	// (including qoka-run's run_code) can boot it on demand via `services().vm`.
	const vm = new VMManager(context, config);
	context.subscriptions.push({ dispose: () => vm.dispose() });

	const services = {
		config,
		ssh: new SshService(),
		hub: new HubApiClient(config.get().registry_url),
		github: new GitHubAuthService(),
		plugins: new PluginService(),
		vm,
	};
	setServices(services);

	// Native Jupyter kernel "Qoka Run Environment": opening a .ipynb and picking
	// this kernel runs each cell in the ACTIVE run environment (WSL/vfkit/SSH) via
	// a persistent SSH channel + in-VM relay - not on a local Python. Constructed
	// AFTER setServices(): its constructor reads the active connection via services().
	try { new NotebookKernel(context, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath); } catch (e) { console.error('[aria-autopipe] notebook kernel init failed', e); }

	// First run: default the built-in VM as the active target so the user has a
	// working environment without configuring a server. Only on Mac/Win, or on
	// Linux when a dev stand-in is set (Linux users otherwise run locally). Never
	// overrides an existing choice.
	const boot = config.get();
	const hasStandin = !!(process.env.ARIA_AUTOPIPE_VM_STANDIN
		|| vscode.workspace.getConfiguration('aria.autopipe').get<string>('vmStandin'));
	if (!boot.active_ssh_profile_id && boot.ssh_profiles.length === 0 && (process.platform !== 'linux' || hasStandin)) {
		void config.activateLocalVm();
	}
	// Bring the VM up if it's the active target (dev: eager start; production
	// lazy-start-on-first-pipeline lands in M4). Fire-and-forget.
	const bootNow = config.get();
	const launchDiag = `platform=${process.platform} activeProfile=${JSON.stringify(bootNow.active_ssh_profile_id)} sshProfiles=${bootNow.ssh_profiles.length} isLocalVmActive=${config.isLocalVmActive()} skipFlag=${!!context.globalState.get<boolean>(WSL_SKIP_KEY)}`;
	console.log(`[aria-autopipe] launch: ${launchDiag}`);
	if (process.platform === 'win32') { wslDiag(`launch: ${launchDiag}`); }
	if (config.isLocalVmActive()) {
		if (process.platform === 'win32') {
			// handleWindowsBuiltinLaunch flips wslLaunchDecided once it knows if the prompt
			// shows; the sign-in overlay waits on that so the prompt appears before login.
			void handleWindowsBuiltinLaunch(context, vm);
		} else {
			wslLaunchDecided = true; // no WSL prompt on Mac/Linux
			startBuiltinVmTracked(vm);
		}
	} else {
		// The built-in WSL environment is NOT the active target (e.g. a saved SSH profile
		// from earlier testing is active). No WSL prompt - let sign-in proceed immediately.
		wslLaunchDecided = true;
		if (process.platform === 'win32') {
			wslDiag('launch: built-in VM NOT active -> no WSL prompt (active target is an SSH profile).');
		}
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.vm.setActive', () => config.activateLocalVm()),
		// Run a raw script in the ACTIVE run environment (SSH/WSL/vfkit) and return
		// { stdout, stderr, exitCode }. Lean: no result folders or workspace sync. Used by the
		// qoka-loop engine to run a locked evaluator in the SAME place run_code executes - including
		// the per-project bubblewrap sandbox on WSL - so the evaluator sees the sub-agent's files
		// and installed packages. The wrapping lives in runScriptInEnv (next to run_code's own).
		vscode.commands.registerCommand('aria.qokarun.runInEnv', (arg: { code?: string; language?: string; cwdRel?: string }) =>
			runScriptInEnv(typeof arg?.code === 'string' ? arg.code : '', arg?.language, typeof arg?.cwdRel === 'string' ? arg.cwdRel : undefined)),
		// Lightweight read of a run's live stdout.log from inside the active run env (used by the loop
		// engine to tail [QOKA_STEP] progress markers on a REMOTE SSH host, where the local results/ dir
		// is still empty until the run finishes). Mounted local envs read the local file directly.
		vscode.commands.registerCommand('aria.qokarun.readRunEnvFile', (arg: { relPath?: string }) =>
			readRunEnvFile(typeof arg?.relPath === 'string' ? arg.relPath : '')),
		vscode.commands.registerCommand('aria.autopipe.vm.start', () => vm.start()),
		vscode.commands.registerCommand('aria.autopipe.vm.stop', () => vm.stop()),
		// Enable the WSL engine (+ Ubuntu) with a self-elevated `wsl --install`. Invoked
		// by the first-run WSL prompt's "Install WSL & Ubuntu" button. Rejects if the
		// user declines the UAC prompt, so the prompt can re-enable and let them retry.
		vscode.commands.registerCommand('aria.autopipe.vm.installEngine', async () => {
			wslSetupPhase = 'installing';
			wslDiag('installEngine: starting elevated wsl --install');
			try {
				await installWslEngine();
				// Installed: the engine now exists but only takes effect after a restart, so
				// keep gating the loader until the user reboots (the prompt shows the notice).
				wslDiag('installEngine: completed OK (awaiting reboot)');
				wslSetupPhase = 'reboot';
				return true;
			} catch (err) {
				// UAC declined / install could not start: back to the prompt so the loader
				// stays up and the user can retry.
				wslDiag(`installEngine: FAILED: ${err instanceof Error ? err.message : String(err)}`);
				wslSetupPhase = 'prompting';
				throw err;
			}
		}),
		// The user pressed "Continue without the run environment": remember it so we
		// stop auto-installing/gating on every launch. On-demand setup (vm.setup) or an
		// already-ready environment clears it again.
		vscode.commands.registerCommand('aria.autopipe.vm.skipSetup', () => {
			// Opted out: stop gating so the loader clears and the workbench becomes usable.
			wslDiag('skipSetup: user chose Continue without the run environment');
			wslSetupPhase = 'idle';
			wslSetupPending = false;
			void context.globalState.update(WSL_SKIP_KEY, true);
			void vm.stop();
			// Release the startup loader that was held for the WSL prompt (see the early reserve in
			// handleWindowsBuiltinLaunch) so the workbench becomes usable now that the user opted out.
			void vscode.commands.executeCommand('aria.startup.markComplete', 'aria-wsl-setup', '', false);
		}),
		vscode.commands.registerCommand('aria.autopipe.vm.status', () => ({ status: vm.status(), error: vm.lastError(), progress: vm.progress(), wslPhase: wslSetupPhase, wslLaunchDecided, wslSetupPending })),
		// Distinguish "WSL/Ubuntu not installed" from "installed but not connected" for
		// the Connections section. On non-Windows these probes harmlessly return false/[].
		vscode.commands.registerCommand('aria.autopipe.vm.wslProbe', async () => {
			const wsl = await wslAvailable();
			if (!wsl) { return { wsl: false, ubuntu: false }; }
			// STRICT list: a wedged WSL service must report serviceError (needs a reset /
			// PC restart), NOT be misread as "Ubuntu not installed" (an errored list is
			// not an empty one). Keeps the Connections message honest.
			try {
				const ubuntu = pickDistro(await listDistrosStrict()) !== undefined;
				return { wsl: true, ubuntu };
			} catch (e) {
				if (isWslServiceError(e)) { return { wsl: true, ubuntu: false, serviceError: true }; }
				return { wsl: true, ubuntu: false };
			}
		}),
		// "Set up now": make the built-in VM active and provision+boot it.
		vscode.commands.registerCommand('aria.autopipe.vm.setup', async () => {
			// User explicitly asked to set up - undo any earlier "continue without" opt-out.
			await context.globalState.update(WSL_SKIP_KEY, false);
			await config.activateLocalVm();
			// Fire-and-forget: vm.start() blocks up to 3 min waiting for SSH. The
			// panel polls vm.status() for progress, so don't await it here or the
			// row click that triggers setup appears frozen.
			void vm.start().catch(err => console.error('[aria-autopipe] built-in VM start failed:', err));
		}),
		// Reset recreates the throwaway overlay (data on the shared workspace is
		// kept). Confirm because it interrupts any running VM.
		vscode.commands.registerCommand('aria.autopipe.vm.reset', async () => {
			const ok = await vscode.window.showWarningMessage(
				'Reset the built-in run environment? Your pipelines and data are kept (they live in the shared workspace); only the VM itself is rebuilt.',
				{ modal: true }, 'Reset');
			if (ok !== 'Reset') { return; }
			await vm.reset();
			await vm.start();
		}),
		// Resource overrides (RAM/CPU) - applied on next VM start.
		vscode.commands.registerCommand('aria.autopipe.vm.setResources', (patch: unknown) =>
			config.setLocalVmResources((patch ?? {}) as { memoryMB?: number; cpus?: number })),
		// Interactive editor invoked by the panel's gear button: simple RAM/CPU
		// inputs, then offer to restart the VM so the change takes effect.
		vscode.commands.registerCommand('aria.autopipe.vm.editResources', async () => {
			const cur = config.get().local_vm;
			// Bound the inputs by THIS computer's real limits (the VM runs locally,
			// so a value above the host crashes it - e.g. vfkit rejects a memory
			// size over VZ's maximum). Show the ceiling so the user knows it, and
			// pre-fill with the current value already clamped to that ceiling.
			const lim = vm.hostLimits();
			const maxGB = Math.max(1, Math.floor(lim.maxMemoryMB / 1024));
			const maxCpus = lim.maxCpus;
			const memGB = await vscode.window.showInputBox({
				title: `Built-in server - Memory in GB (max ${maxGB} on this computer)`,
				value: String(Math.min(maxGB, Math.max(1, Math.round(cur.memoryMB / 1024)))),
				validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v <= maxGB ? undefined : `Whole number of GB (1-${maxGB})`,
			});
			if (memGB === undefined) { return; }
			const cpus = await vscode.window.showInputBox({
				title: `Built-in server - CPU cores (max ${maxCpus} on this computer)`,
				value: String(Math.min(maxCpus, Math.max(1, cur.cpus))),
				validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v <= maxCpus ? undefined : `Whole number of cores (1-${maxCpus})`,
			});
			if (cpus === undefined) { return; }
			await config.setLocalVmResources({ memoryMB: Number(memGB) * 1024, cpus: Number(cpus) });
			if (config.isLocalVmActive()) {
				const restart = await vscode.window.showInformationMessage(
					'Built-in server settings saved. Restart it now to apply?', 'Restart now', 'Later');
				if (restart === 'Restart now') {
					await vm.stop();
					// Fire-and-forget: vm.start() blocks up to 3 min waiting for SSH.
					// Don't await it here or the command appears frozen - the panel
					// polls vm.status() and shows the booting/progress state instead.
					void vm.start().catch(err => console.error('[aria-autopipe] VM restart failed:', err));
				}
			}
		}),
	);

	// Register the SSH/GitHub/Repo/Registry setup commands the panel calls.
	registerSetupCommands(context);

	// First-run plugin bootstrap. Fires non-blocking so the rest of activate
	// can proceed; the user sees a progress toast while it runs. Once it settles,
	// bind each installed viewer's file extensions to the Qoka Result Viewer.
	void bootstrapDefaultPlugins(services.plugins, services.hub)
		.finally(() => { void syncViewerAssociations(services.plugins); });

	// Result Viewer management (the Settings "Result Viewer" section calls these):
	// list installed + Hub viewers, install / remove one, and re-sync associations.
	context.subscriptions.push(vscode.commands.registerCommand('aria.resultViewer.list', () => {
		return listResultViewers(services.plugins, services.hub);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aria.resultViewer.install', async (name: string) => {
		const hp = await services.hub.getPluginByName(name);
		if (!hp) { throw new Error(`Viewer "${name}" was not found on the Hub.`); }
		await services.plugins.install(hp);
		services.plugins.unmarkRemoved(name);
		await syncViewerAssociations(services.plugins);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aria.resultViewer.remove', async (name: string) => {
		services.plugins.uninstall(name);
		services.plugins.markRemoved(name);
		await syncViewerAssociations(services.plugins);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aria.resultViewer.refresh', async () => {
		await syncViewerAssociations(services.plugins);
	}));

	// True when a results/<run> folder has a `.qoka-pipeline.json` marker whose
	// pipeline is claimed by an installed pipeline-type viewer (with its required
	// files present). The Analysis tree uses this to show the "Open in viewer"
	// eye icon ONLY on runs that actually have a dedicated dashboard.
	context.subscriptions.push(vscode.commands.registerCommand('aria.autopipe.matchesPipelineViewer', (folderPath: unknown): boolean => {
		try {
			const dir = String(folderPath ?? '');
			if (!dir) { return false; }
			const markerFile = path.join(dir, '.qoka-pipeline.json');
			if (!fs.existsSync(markerFile)) { return false; }
			const raw = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
			const pipeline = typeof raw?.pipeline === 'string' ? raw.pipeline.trim() : '';
			if (!pipeline) { return false; }
			const files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
			return !!services.plugins.findForPipeline(pipeline, files);
		} catch {
			return false;
		}
	}));

	// BioRender MCP: login/logout/status for the Settings "BioRender" section.
	// Login runs the AI CLI's OWN OAuth (`claude mcp login biorender`, which opens
	// the browser and stores the token in the CLI) - a Qoka-injected header is
	// ignored by the CLI for OAuth servers, so this is what actually authenticates.
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.biorender.getStatus', () => bioRenderStatus()),
		vscode.commands.registerCommand('aria.biorender.login', () => loginBioRender()),
		vscode.commands.registerCommand('aria.biorender.logout', () => logoutBioRender()),
	);
	// Register the built-in BioRender MCP now (headerless) so it is present from
	// the start; the user authenticates it later from the Settings BioRender
	// section. Fire-and-forget.
	void ensureBioRenderRegistered();

	// Keep the Hub client's base URL in sync with config changes (the user
	// can switch registries by editing config, even though we don't yet
	// expose a UI for it).
	context.subscriptions.push(
		config.onDidChange((cfg) => {
			services.hub = new HubApiClient(cfg.registry_url);
			setServices(services);
		}),
	);

	mcpServer = new QokaMcpServer({ name: 'qoka-autopipe', tools: ALL_TOOLS, defaultPort: 3748, instructions: AUTOPIPE_MCP_INSTRUCTIONS });
	// Second MCP: "qoka-run" - quick one-off code execution (run_code) on the SAME
	// built-in server (shared via VMManager). Registered under its own name/port so
	// the AI lists it as a separate server. Port range starts at 3760 to stay clear
	// of autopipe's 3748 fallback band.
	// Distinct base port from qoka-paper-search (which moved off the old shared
	// 3760). Bases must be unique per server so the first window gets clean,
	// predictable numbers; a second window falls straight to an OS-assigned port.
	runServer = new QokaMcpServer({ name: 'qoka-run', tools: RUN_SERVER_TOOLS, defaultPort: 3752, instructions: RUN_MCP_INSTRUCTIONS });
	context.subscriptions.push({ dispose: () => { void runServer?.stop(); } });
	// Third MCP: "qoka-environment" - the run environment / connection / resources.
	// Its own name/port (3810, clear of every other server's base) so the AI lists it
	// separately and code paths call get_workspace_info here without reaching autopipe.
	envServer = new QokaMcpServer({ name: 'qoka-environment', tools: ENVIRONMENT_TOOLS, defaultPort: 3810, instructions: ENVIRONMENT_MCP_INSTRUCTIONS });
	context.subscriptions.push({ dispose: () => { void envServer?.stop(); } });

	// Boot the MCP server only. Registration with the AI clients is NOT done
	// here: `claude mcp add` is a read-modify-write of ~/.claude.json with no
	// locking, so every Qoka extension registering itself at activate() raced the
	// others and a random subset of the servers survived. The workbench
	// chat-open coordinator now drives registration for all of them, one at a
	// time, through aria.autopipe.reregisterMcp below.
	//
	// We still join the workbench startup overlay's tracking so the overlay holds
	// until the server is listening.
	//
	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	// Start the qoka-run server too. Its registration happens inside
	// refreshAiRegistrations (keyed off runServer.currentPort), same as autopipe.
	const runStartPromise = runServer.start();
	runStartPromise.catch((err) => console.error('[aria-autopipe] qoka-run MCP start failed:', err));

	// Start the qoka-environment server too (same lifecycle as qoka-run).
	const envStartPromise = envServer.start();
	envStartPromise.catch((err) => console.error('[aria-autopipe] qoka-environment MCP start failed:', err));

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-autopipe-mcp');
		let summary = 'Autopipe MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-autopipe] MCP up on ${port}`);
			summary = `Autopipe MCP up on ${port}`;
		} catch (err) {
			console.error('[aria-autopipe] startup failed', err);
			summary = `Autopipe MCP startup failed: ${(err as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand(
				'aria.startup.markComplete',
				'aria-autopipe-mcp',
				summary,
				changed,
			);
		}
	})();

	// Sole registration entry point: the chat-open coordinator (workbench) calls
	// this when an AI chat opens, serialized across every Qoka MCP, so a provider
	// whose CLI was installed after startup gets registered right when the user
	// goes to use it. Returns true if it newly registered something, so the
	// coordinator can show one "open a new chat" prompt across all Qoka MCPs.
	// Awaits the server start because the coordinator may call before the port
	// is known.
	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (see aria.mcp.applyConfig).
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.mcpInfo', async () => {
			try { await startPromise; } catch { return null; }
			const port = mcpServer?.currentPort;
			return typeof port === 'number' ? { name: 'qoka-autopipe', port } : null;
		}),
	);

	// qoka-run's { name, port } for the startup coordinator's batch config write.
	// Reported separately from autopipe because it is a SECOND server on its own
	// port (it shares this process + the VMManager, but registers independently).
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.qokarun.mcpInfo', async () => {
			try { await runStartPromise; } catch { return null; }
			const port = runServer?.currentPort;
			return typeof port === 'number' ? { name: 'qoka-run', port } : null;
		}),
	);

	// qoka-environment's { name, port } for the startup coordinator's batch config
	// write. Reported separately because it is a THIRD server on its own port.
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.qokaenv.mcpInfo', async () => {
			try { await envStartPromise; } catch { return null; }
			const port = envServer?.currentPort;
			return typeof port === 'number' ? { name: 'qoka-environment', port } : null;
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.reregisterMcp', async () => {
			// refreshAiRegistrations reads mcpServer.currentPort, which the server
			// itself sets once start() resolves - so awaiting start() here is enough.
			try { await startPromise; } catch { return { changed: false, registered: false }; }
			return refreshAiRegistrations();
		}),
	);

	context.subscriptions.push(
		// Live reachability of the ACTIVE run connection - the SINGLE source of truth
		// shared by the Connections view (green/red dot) and get_workspace_info, so
		// the UI, the actual connection, and what the chat reports always agree.
		vscode.commands.registerCommand('aria.autopipe.connection.probe', async () => {
			if (config.isLocalVmActive()) {
				const ep = config.localVmProfile();
				if (!ep) { return { kind: 'builtin' as const, connected: false }; }
				return { kind: 'builtin' as const, connected: await services.ssh.canConnect(ep, 4000) };
			}
			const p = config.activeProfile();
			if (!p) { return { kind: 'none' as const, connected: false }; }
			return { kind: 'ssh' as const, connected: await services.ssh.canConnect(p, 5000) };
		}),
		// Re-establish the ACTIVE connection: restart the built-in server, or (for an
		// SSH host we don't manage) just re-probe it. Returns the fresh reachability.
		vscode.commands.registerCommand('aria.autopipe.connection.restart', async () => {
			if (config.isLocalVmActive()) {
				try {
					await vm.stop();
					await vm.start();
					const ep = config.localVmProfile();
					return { kind: 'builtin' as const, connected: !!ep && await services.ssh.canConnect(ep, 4000) };
				} catch (e) {
					return { kind: 'builtin' as const, connected: false, error: e instanceof Error ? e.message : String(e) };
				}
			}
			const p = config.activeProfile();
			if (!p) { return { kind: 'none' as const, connected: false }; }
			return { kind: 'ssh' as const, connected: await services.ssh.canConnect(p, 5000) };
		}),
		vscode.commands.registerCommand('aria.autopipe.getStatus', async (silent?: boolean) => {
			const detection = await detectAiProviders();
			const cfg = config.get();
			const profile = config.activeProfile();
			const status = {
				providers: detection.providers,
				anyAiInstalled: detection.anyInstalled,
				claudeCliInstalled: detection.claudeCliInstalled,
				claudeCliVersion: detection.claudeCliVersion,
				mcpServer: {
					running: mcpServer?.listening ?? false,
					port: mcpServer?.currentPort ?? null,
				},
				registration: {
					claude_code: lastRegistration.claude,
					codex: lastRegistration.codex,
				},
				sshActiveProfile: profile ? `${profile.username}@${profile.host}` : null,
				sshActiveProfileId: cfg.active_ssh_profile_id,
				sshProfiles: cfg.ssh_profiles.map(p => ({
					id: p.id, name: p.name, host: p.host, username: p.username, port: p.port,
				})),
				githubConnected: !!cfg.github?.token,
				githubLogin: cfg.github?.login ?? null,
				uploadMode: cfg.per_pipeline_repo ? 'per-pipeline' as const : 'single' as const,
				uploadRepoName: cfg.github_repo,
			};
			if (!silent) {
				const ai = detection.providers.filter(p => p.installed)
					.map(p => `${p.displayName}${p.active ? '' : ' (inactive)'}`)
					.join(', ') || 'No AI assistant detected';
				const mcp = status.mcpServer.running
					? `MCP: 127.0.0.1:${status.mcpServer.port}`
					: 'MCP: not running';
				const ssh = status.sshActiveProfile ?? 'SSH: no active profile';
				const gh = status.githubConnected ? `GitHub: @${status.githubLogin}` : 'GitHub: not connected';
				vscode.window.showInformationMessage(`Autopipe - ${ai} · ${mcp} · ${ssh} · ${gh}`);
			}
			return status;
		}),
		vscode.commands.registerCommand('aria.autopipe.openHub', () => openHubPanel()),
		vscode.commands.registerCommand('aria.autopipe.openPlugins', () => openPluginsPanel()),
		vscode.commands.registerCommand('aria.autopipe.reregister', async (silent?: boolean) => {
			// Re-runs the auto-register flow for every detected client. The
			// `silent` flag is set when Save Settings calls us internally -
			// that flow already shows its own "Settings saved" toast, so we
			// suppress success notifications here to avoid back-to-back
			// messages. Errors still bubble up so the user knows the wiring
			// didn't land.
			if (!mcpServer || !mcpServer.currentPort) {
				if (!silent) {
					vscode.window.showErrorMessage('Qoka MCP server is not running yet.');
				}
				return;
			}
			const port = mcpServer.currentPort;
			const detection = await detectAiProviders();
			const wantClaude = detection.providers.some(p => p.kind === 'claude-code' && p.installed);
			const wantCodex = detection.providers.some(p => p.kind === 'codex' && p.installed);

			if (!wantClaude && !wantCodex) {
				if (!silent) {
					vscode.window.showWarningMessage('No supported AI extension detected. Install the Claude Code or Codex extension to use Autopipe.');
				}
				return;
			}

			const connected: string[] = [];
			const failed: string[] = [];
			if (wantClaude) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				(r.ok ? connected : failed).push(r.ok ? 'Claude Code' : `Claude Code (${r.message})`);
			}
			if (wantCodex) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				(r.ok ? connected : failed).push(r.ok ? 'Codex' : `Codex (${r.message})`);
			}

			if (failed.length === 0) {
				if (!silent) {
					vscode.window.showInformationMessage(`Autopipe MCP registered with ${connected.join(' + ')}.`);
				}
			} else {
				vscode.window.showErrorMessage(`MCP registration failed: ${failed.join('; ')}`);
			}
		}),
	);
}

/**
 * Start the built-in run environment and, on Windows, hold the first-run
 * "Setting up Qoka" overlay while it sets up - so the WSL/Ubuntu install +
 * account creation + provisioning run alongside the CLI/MCP setup instead of
 * behind a half-ready workbench. We announce ourselves as a startup tracker
 * (aria.startup.beginTracking), stream vm progress into the overlay subtitle,
 * and markComplete once the environment is ready (or setup ends), which lets the
 * overlay clear. Windows-only: Mac/Linux use vfkit/QEMU with no account step, so
 * they keep the plain fire-and-forget start.
 */
/**
 * Windows launch decision for the built-in run environment:
 *  - user opted out before -> only resume once WSL is FULLY set up (engine + Ubuntu +
 *    account); otherwise leave them alone (no prompt, no install).
 *  - WSL engine present -> start normally (installs Ubuntu if needed, opens the account
 *    OOBE, provisions), all behind the loader.
 *  - WSL engine missing -> show the first-run "Install WSL & Ubuntu" prompt.
 * wslAvailable() retries internally, so a cold-but-installed WSL is not mistaken for a
 * missing engine (which would have wrongly shown the install prompt).
 */
async function handleWindowsBuiltinLaunch(context: vscode.ExtensionContext, vm: VMManager): Promise<void> {
	// Only START the run environment (installs Ubuntu, opens the account OOBE terminal,
	// provisions) in a PROJECT window - never in the empty sign-in / picker window, so the
	// Ubuntu account terminal cannot pop up over login. The WSL install PROMPT still shows
	// in the empty window (it must come before login). When a project opens, this runs
	// again in that window and starts the VM there.
	const hasFolder = !!vscode.workspace.workspaceFolders?.length;
	// Reserve the startup-loader hold NOW - before the async wslAvailable() probe below - so the
	// loader cannot clear during that probe (the MCP trackers finish meanwhile, which used to race
	// the loader ahead of the Ubuntu OOBE window). Every path that does NOT go on to set up WSL
	// releases it again; startBuiltinVmTracked releases it at account creation ('booting').
	void vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-wsl-setup');
	const releaseLoader = () => void vscode.commands.executeCommand('aria.startup.markComplete', 'aria-wsl-setup', '', false);
	if (context.globalState.get<boolean>(WSL_SKIP_KEY)) {
		const ready = await vm.isWslReady();
		wslDiag(`handleWindowsBuiltinLaunch: skip flag set; wslReady=${ready}, hasFolder=${hasFolder}. No prompt.`);
		wslLaunchDecided = true; // opted out earlier -> no prompt, let sign-in proceed
		if (ready && hasFolder) {
			void context.globalState.update(WSL_SKIP_KEY, false);
			startBuiltinVmTracked(vm);
		} else {
			releaseLoader(); // no WSL setup this window -> let the loader finish
		}
		return;
	}
	// Probe for the engine. Keep the loader up ('checking') so it does not clear during
	// the wslAvailable() retries and briefly flash the workbench before the prompt shows.
	wslSetupPhase = 'checking';
	const engineReady = await wslAvailable();
	wslDiag(`handleWindowsBuiltinLaunch: wslAvailable=${engineReady}, hasFolder=${hasFolder}.`);
	if (engineReady) {
		// Engine is present (post-reboot, or already had WSL). Start ONLY in a project
		// window (installs Ubuntu / opens the account OOBE / provisions); in the empty
		// window just let sign-in proceed - the VM starts when a project opens.
		wslSetupPhase = 'idle';
		wslLaunchDecided = true; // no prompt -> sign-in can proceed
		if (hasFolder) {
			startBuiltinVmTracked(vm);
		} else {
			releaseLoader(); // empty window: VM starts later when a project opens
		}
		return;
	}
	// WSL engine is not installed and the user has not opted out: offer to install it.
	// Stay in a gating phase so the loader keeps showing until the user decides.
	// Set the phase FIRST, then mark decided, so the sign-in overlay that is waiting sees
	// the pending prompt (not a momentary 'idle') and holds login until it is resolved.
	wslSetupPhase = 'prompting';
	wslLaunchDecided = true;
	try {
		await vscode.commands.executeCommand('aria.wslPrompt.show', 'install');
		wslDiag('handleWindowsBuiltinLaunch: requested aria.wslPrompt.show OK (popup should be visible).');
	} catch (err) {
		wslDiag(`handleWindowsBuiltinLaunch: aria.wslPrompt.show FAILED: ${err instanceof Error ? err.message : String(err)}`);
		console.error('[aria-autopipe] could not show the WSL install prompt:', err);
	}
}

function startBuiltinVmTracked(vm: VMManager): void {
	if (process.platform !== 'win32') {
		void vm.start().catch(err => console.error('[aria-autopipe] built-in VM start failed:', err));
		return;
	}
	const TRACKER = 'aria-wsl-setup';
	// The built-in run-env setup is now actually running (WSL engine ready, project window).
	// beginTracking holds the startup loader through the (minutes-long) Ubuntu install + the
	// account OOBE window - the loader must never clear before the user has created the account.
	wslSetupPending = true;
	void vscode.commands.executeCommand('aria.startup.beginTracking', TRACKER);
	const progSub = vm.onProgress(p => {
		if (p?.message) {
			void vscode.commands.executeCommand('aria.firstRun.updateOverlay', p.message);
		}
	});
	// Release the STARTUP LOADER as soon as the Ubuntu ACCOUNT is created (status -> 'booting'):
	// the interactive OOBE is done, so Qoka finishes loading while the REST (booting -> ready,
	// provisioning, CLI/MCP wiring) continues in the BACKGROUND. markComplete is idempotent, so a
	// later start() settle / failure is a harmless no-op. wslSetupPending stays true until start()
	// fully settles so the CHAT still waits for a usable run environment (a separate, quieter gate).
	let released = false;
	const release = (summary: string, changed: boolean) => {
		if (released) { return; }
		released = true;
		void vscode.commands.executeCommand('aria.startup.markComplete', TRACKER, summary, changed);
	};
	const statusSub = vm.onDidChangeStatus(s => {
		if (s === 'booting' || s === 'ready') { release('Run environment ready', true); }
	});
	void vm.start()
		.then(
			() => release('Run environment ready', true),
			err => {
				console.error('[aria-autopipe] built-in VM start failed:', err);
				// Release even on failure so the loader never hangs; the error surfaces in the
				// connections panel and the user can retry "Set up now".
				release('', false);
			},
		)
		.finally(() => { wslSetupPending = false; progSub.dispose(); statusSub.dispose(); });
}

/** The custom-editor viewType that hosts every installed file viewer. */
const RESULT_VIEWER_VIEW_TYPE = 'qoka.autopipe.fileViewer';

/** One row in the Settings "Result Viewer" list. */
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
 * Bind `workbench.editorAssociations` to the currently installed FILE viewers:
 * every extension an installed viewer declares maps to the Qoka Result Viewer,
 * so clicking such a file opens it there. Uninstalling a viewer drops its
 * associations, so the file falls back to the default (text / media) or a
 * user-installed extension's editor. PDF is left to the dedicated qoka.pdfViewer.
 * User associations for other viewTypes are preserved.
 */
async function syncViewerAssociations(plugins: PluginService): Promise<void> {
	const exts = new Set<string>();
	for (const p of plugins.listInstalled()) {
		if (p.manifest.plugin_type === 'pipeline') { continue; }
		for (const e of p.manifest.extensions) {
			const clean = String(e).toLowerCase().replace(/^\./, '').trim();
			if (clean && clean !== 'pdf') { exts.add(clean); }
		}
	}
	const cfg = vscode.workspace.getConfiguration();
	const current = { ...(cfg.get<Record<string, string>>('workbench.editorAssociations') ?? {}) };
	// Drop every glob we previously pointed at our viewer, then re-add the live set.
	for (const key of Object.keys(current)) {
		if (current[key] === RESULT_VIEWER_VIEW_TYPE) { delete current[key]; }
	}
	for (const ext of exts) { current[`*.${ext}`] = RESULT_VIEWER_VIEW_TYPE; }
	try {
		await cfg.update('workbench.editorAssociations', current, vscode.ConfigurationTarget.Global);
	} catch { /* best effort - a read-only settings store shouldn't break activation */ }
}

/** Merge the Hub catalog with locally installed viewers into a display list. */
async function listResultViewers(plugins: PluginService, hub: HubApiClient): Promise<ResultViewerRow[]> {
	let hubPlugins: HubPlugin[] = [];
	try { hubPlugins = await hub.listPlugins(); } catch { /* offline: show installed only */ }
	const removed = plugins.getRemovedDefaults();
	const defaultSet = resolveDefaultNames(hubPlugins);
	const byName = new Map<string, ResultViewerRow>();
	for (const h of hubPlugins) {
		if (NATIVE_VIEWER_NAMES.has(h.name)) { continue; } // PDF etc. are built-in, not managed here.
		byName.set(h.name, {
			name: h.name, description: h.description ?? '', extensions: h.extensions ?? [], author: h.author ?? '',
			hubVersion: h.version ?? null, installedVersion: plugins.installedVersion(h.name),
			isDefault: defaultSet.has(h.name), isPipeline: false,
			installed: plugins.isInstalled(h.name), removed: removed.has(h.name),
		});
	}
	for (const p of plugins.listInstalled()) {
		const n = p.manifest.name;
		if (NATIVE_VIEWER_NAMES.has(n)) { continue; } // PDF etc. are built-in, not managed here.
		const row = byName.get(n);
		if (row) {
			row.installed = true;
			row.installedVersion = p.manifest.version;
			row.isPipeline = p.manifest.plugin_type === 'pipeline';
			if (!row.extensions.length) { row.extensions = p.manifest.extensions; }
		} else {
			byName.set(n, {
				name: n, description: p.manifest.description ?? '', extensions: p.manifest.extensions, author: '',
				hubVersion: null, installedVersion: p.manifest.version,
				isDefault: defaultSet.has(n), isPipeline: p.manifest.plugin_type === 'pipeline',
				installed: true, removed: removed.has(n),
			});
		}
	}
	return [...byName.values()].sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || a.name.localeCompare(b.name));
}

/**
 * Make sure the default 13 plugins are installed. Skips silently when they
 * already match the latest Hub version; otherwise downloads in the
 * background with a progress notification. Failures are reported but
 * non-fatal: the panel still works, the user can retry from the Plugins
 * tab once it ships, and Qoka's other features don't depend on plugins.
 *
 * The reference list (`DEFAULT_PLUGIN_NAMES`) is the canonical 13 viewer
 * plugins the autopipe team ships with - every common bioinformatics
 * file type Qoka knows how to render at install time.
 */
async function bootstrapDefaultPlugins(plugins: PluginService, hub: HubApiClient): Promise<void> {
	console.log('[aria-autopipe] bootstrapDefaultPlugins() starting');
	// Snapshot of what's already installed so we can decide between "first
	// run", "incremental update", and "everything good". If every default
	// is installed *and* at the right version we don't even show a toast.
	const installedCount = DEFAULT_PLUGIN_NAMES.filter(n => plugins.isInstalled(n)).length;
	const removed = plugins.getRemovedDefaults();
	const isFirstRun = installedCount === 0 && removed.size === 0;
	console.log(`[aria-autopipe] bootstrap: installed=${installedCount}/${DEFAULT_PLUGIN_NAMES.length}, isFirstRun=${isFirstRun}`);

	// Only the very first run auto-installs the default viewers, so result files
	// open out of the box. After that we NEVER auto-install a newly-added default
	// or auto-update an existing one - those are surfaced in the Result Viewers
	// panel (Settings -> Result Viewer -> Manage Result Viewers) with Install /
	// Update buttons, so the user applies them only when they choose to.
	if (!isFirstRun) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: isFirstRun ? 'Autopipe - installing default viewer plugins' : 'Autopipe - checking for plugin updates',
			cancellable: false,
		},
		async (progress) => {
			let lastFraction = 0;
			try {
				const result = await plugins.ensureDefaults(
					() => hub.listPlugins(),
					(msg, fraction) => {
						const increment = Math.max(0, (fraction - lastFraction) * 100);
						lastFraction = fraction;
						progress.report({ message: msg, increment });
					},
				);
				const summaryParts: string[] = [];
				if (result.installed.length) {
					summaryParts.push(`Installed ${result.installed.length}`);
				}
				if (result.updated.length) {
					summaryParts.push(`Updated ${result.updated.length}`);
				}
				if (result.failed.length) {
					summaryParts.push(`${result.failed.length} failed`);
				}
				if (summaryParts.length === 0) {
					// Quiet success - everything was already up to date.
					console.log('[aria-autopipe] default plugins up to date');
					return;
				}
				const msg = `Autopipe plugins - ${summaryParts.join(', ')}.`;
				if (result.failed.length > 0) {
					vscode.window.showWarningMessage(`${msg} See Settings tab → Plugins to retry: ${result.failed.map(f => f.name).join(', ')}`);
				} else {
					vscode.window.showInformationMessage(msg);
				}
			} catch (err) {
				console.error('[aria-autopipe] bootstrap failed:', err);
				vscode.window.showWarningMessage(
					`Autopipe plugin setup deferred: ${(err as Error).message}. You can install plugins manually from the Plugins tab once the issue is resolved.`,
				);
			}
		},
	);
}

/**
 * Re-run MCP registration when an AI extension is installed/removed after
 * Qoka booted. Only acts on transitions - Claude/Codex newly available
 * gets registered; previously-registered client now uninstalled gets
 * cleaned up. Idempotent because the underlying register/unregister
 * functions remove any prior entry before adding.
 */
// Returns true if a provider was NEWLY registered (so the caller can prompt the
// user to open a fresh chat). The self-notification is gone: the chat-open
// coordinator shows a single toast across all Qoka MCPs instead.
/**
 * Codex caches its MCP servers at extension-activation time (not per-chat), so
 * if the Codex extension activated before our `codex mcp add` landed, the user
 * has to reload the window for Codex to see autopipe. Only ask when Codex is
 * actually up and we didn't just reload for this very reason. Deliberately not
 * folded into the unified startup summary: it needs a button to be useful.
 */
const PENDING_CODEX_RELOAD_KEY = 'aria.autopipe.pendingCodexReload';
async function maybeOfferCodexReload(): Promise<void> {
	const context = extensionContext;
	if (!context) {
		return;
	}
	const justReloaded = context.globalState.get<boolean>(PENDING_CODEX_RELOAD_KEY, false);
	if (justReloaded) {
		await context.globalState.update(PENDING_CODEX_RELOAD_KEY, false);
		return;
	}
	const detection = await detectAiProviders();
	const codexActive = detection.providers.some(p => p.kind === 'codex' && p.installed && p.active);
	if (!codexActive) {
		return;
	}
	void vscode.window.showInformationMessage(
		'Autopipe needs Codex to reload to pick up the new MCP. Reload now?',
		'Reload Window',
	).then(async (choice) => {
		if (choice === 'Reload Window') {
			await context.globalState.update(PENDING_CODEX_RELOAD_KEY, true);
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

let refreshInFlight: Promise<{ changed: boolean; registered: boolean }> | null = null;
async function refreshAiRegistrations(): Promise<{ changed: boolean; registered: boolean }> {
	// Coalesce rapid-fire onDidChange events (extension installs often
	// fire several in quick succession) so we don't spam registration
	// calls.
	if (refreshInFlight) {
		return refreshInFlight;
	}
	refreshInFlight = (async () => {
		try {
			if (!mcpServer || !mcpServer.currentPort) {
				return { changed: false, registered: false };
			}
			const port = mcpServer.currentPort;

			const newlyConnected: string[] = [];

			// Register on CLI presence, NOT on the provider EXTENSION being installed.
			// The registration helpers resolve the CLI themselves and no-op (ok=false)
			// when it's absent - exactly like every other Qoka MCP. Gating on the
			// extension used to make autopipe the one server that stayed unregistered
			// through onboarding (the CLI is installed at AI-pick time; the extension
			// only later), so it registered a pass behind the other seven.
			if (!lastRegistration.claude.ok) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Claude Code');
				}
			}

			if (!lastRegistration.codex.ok) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Codex');
					if (r.changed) {
						await maybeOfferCodexReload();
					}
				}
			}

			// qoka-run: the second MCP (quick code execution). Register it under its
			// own name/port so the AI lists it separately from autopipe. Only once it
			// has a live port (it starts concurrently with autopipe at activate()).
			const runPort = runServer?.currentPort;
			if (runPort) {
				if (!lastRunRegistration.claude.ok) {
					const r = await registerWithClaudeCode(runPort, 'qoka-run');
					lastRunRegistration.claude = { ...r, port: runPort };
					if (r.ok) { newlyConnected.push('Claude Code (qoka-run)'); }
				}
				if (!lastRunRegistration.codex.ok) {
					const r = await registerWithCodex(runPort, 'qoka-run');
					lastRunRegistration.codex = { ...r, port: runPort };
					if (r.ok) { newlyConnected.push('Codex (qoka-run)'); }
				}
			}

			// qoka-environment: the third MCP (run environment / connection / resources).
			const envPort = envServer?.currentPort;
			if (envPort) {
				if (!lastEnvRegistration.claude.ok) {
					const r = await registerWithClaudeCode(envPort, 'qoka-environment');
					lastEnvRegistration.claude = { ...r, port: envPort };
					if (r.ok) { newlyConnected.push('Claude Code (qoka-environment)'); }
				}
				if (!lastEnvRegistration.codex.ok) {
					const r = await registerWithCodex(envPort, 'qoka-environment');
					lastEnvRegistration.codex = { ...r, port: envPort };
					if (r.ok) { newlyConnected.push('Codex (qoka-environment)'); }
				}
			}

			// Keep the built-in BioRender MCP registered too (idempotent: skips when
			// the CLI already has it, so this is cheap on repeat coordinator runs).
			void ensureBioRenderRegistered();

			return {
				changed: newlyConnected.length > 0,
				registered: lastRegistration.claude.ok || lastRegistration.codex.ok,
			};
		} catch (err) {
			console.error('[aria-autopipe] refreshAiRegistrations failed:', err);
			return { changed: false, registered: false };
		}
	})();
	try {
		return await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
}

export async function deactivate(): Promise<void> {
	// Intentionally leave the client registrations in place on shutdown.
	// The next Qoka launch validates them by comparing the registered port to
	// the live MCP port and only rewrites when stale - so persisting the entry
	// lets that fast path skip a redundant remove+add (and the "start a new
	// chat" toast) on every restart. A stale entry (port changed while Qoka was
	// closed) is self-healed on the next launch; the only lingering case is a
	// full Qoka uninstall, which the user can clear with `claude/codex mcp
	// remove autopipe`. (unregisterFromClaudeCode/Codex are still used by
	// refreshAiRegistrations when the Claude/Codex extension itself is removed.)
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
