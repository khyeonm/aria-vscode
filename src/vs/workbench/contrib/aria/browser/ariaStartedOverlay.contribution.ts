/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import { isWindows } from '../../../../base/common/platform.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkspacesService, IRecentlyOpened, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceContextService, WorkbenchState, isSingleFolderWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAuthenticationService, AuthenticationSession } from '../../../services/authentication/common/authentication.js';
import { ARIA_MARK } from './ariaLogo.js';
import { ROADMAP_SCHEME } from '../../ariaRoadmapWizard/browser/ariaRoadmapWizardCommon.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ARIA_MODE_SETTING, ARIA_AI_PROVIDER_SETTING, AriaMode } from '../common/ariaConfiguration.js';
import { ARIA_SET_MODE_COMMAND, ARIA_REMEMBER_MODE_COMMAND } from './ariaModeManager.js';
import { ConcreteProvider, PROVIDER_EXTENSION_ID, PROVIDER_LABEL, hasPickedAiProvider, markPickedAiProvider, clearPickedAiProvider, providerSettingFor, setPendingInstall } from './ariaAiProviderChoice.js';

// Pre-paint workbench hide. Installing the stylesheet at module-load
// - before any contribution constructor runs - guarantees the bare
// workbench can't flash even momentarily between the workbench's own
// paint and our overlay's appendChild. The contribution constructor
// removes this style if it ever decides NOT to show the overlay
// (e.g. one-shot just-picked path), so the workbench becomes
// visible again immediately in that case.
(function installEarlyHide(): void {
	if (typeof document === 'undefined') {
		return;
	}
	if (document.getElementById('aria-started-hide-workbench')) {
		return;
	}
	const installNow = () => {
		if (document.getElementById('aria-started-hide-workbench')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'aria-started-hide-workbench';
		style.textContent = `
			body > *:not(#aria-started-overlay):not(#aria-login-gate-overlay):not(.aria-wsl-overlay):not(style):not(script):not(link) {
				visibility: hidden !important;
			}
		`;
		(document.head || document.documentElement).appendChild(style);
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', installNow, { once: true });
	} else {
		installNow();
	}
})();

/** Qoka authentication provider id (see the aria-authentication extension). */
const AUTH_ID = 'aria';

/** Friendly, generic lines cycled under the spinner while a sign-in step runs,
 *  so the wait doesn't feel dead. Not real status - just reassurance. */
const LOADING_MESSAGES: readonly string[] = [
	'Getting Qoka ready…',
	'One moment…',
	'Almost there…',
];
/** Shown only while an active sign-in is in progress (authLoading). These mention
 *  the browser / authorization, which would be misleading during a plain reload
 *  such as switching projects while already signed in. */
const SIGNIN_MESSAGES: readonly string[] = [
	'Preparing sign-in…',
	'Opening your browser…',
	'Waiting for authorization…',
	'Almost there…',
];

/** One-shot sessionStorage flag set right before vscode.openFolder
 *  reloads the workbench, and consumed on the next constructor run
 *  (cleared on first read). Because it self-clears, it can never go
 *  stale and silently skip Started on a future launch - even if the
 *  storage backend persists across the electron app close, the first
 *  load consumes the flag and every subsequent load sees nothing. */
const JUST_PICKED_FLAG = 'aria.started.justPicked';

/** One-shot localStorage flag set by "Change project" (see ariaAccountStatus).
 *  When the user explicitly asks to change projects we must land on the PICKER,
 *  not silently auto-reopen the project they just left. localStorage (not
 *  sessionStorage) so it survives the closeFolder reload; consumed on first read. */
const WANT_PICKER_FLAG = 'aria.started.wantPicker';

/** APPLICATION-scoped storage of the last-active PROJECT folder URI. A project
 *  window records it on focus; a COLD app launch (no other window open) reopens
 *  it - more accurate than "most recently opened" when several windows were open
 *  and closed together. */
const LAST_ACTIVE_PROJECT_KEY = 'aria.started.lastActiveProject';
/** Set (localStorage, value = '1') when the user chooses "Continue without signing
 *  in" on the login screen. Makes sign-in optional: once skipped, later launches go
 *  straight to the picker/project instead of the login gate. Cleared when the user
 *  actually signs in. The user can still sign in anytime from Settings. */
const LOGIN_SKIPPED_FLAG = 'aria.login.skipped';
/** Set (localStorage) by the "Sign in" action when it closes a project to send the
 *  user back to the login screen. Value = the project's folder URI. After a
 *  successful login the overlay consumes it and reopens that project. */
const SIGNIN_RETURN_TO = 'aria.signin.returnTo';
/** Set (localStorage) when the user explicitly clicks a Mode card. Until then the
 *  picker shows NEITHER mode selected (rather than the config default). */
const MODE_CHOSEN_FLAG = 'aria.mode.chosen';

/** Per-window-session guard so an auto-reopen that somehow lands back on an EMPTY
 *  workbench (e.g. the recent folder was deleted) can't spin in a reopen loop.
 *  sessionStorage resets on a genuine relaunch, which is exactly when we want to
 *  try again. */
const AUTO_REOPEN_TRIED_FLAG = 'aria.started.autoReopenTried';

/** One-shot localStorage flag telling the folder-window login gate to skip its
 *  session poll. Set by pickAndDismiss (the overlay just validated a session
 *  before opening the folder); consumed by ariaLoginGate. Mirrors the literal in
 *  ariaLoginGate.contribution.ts. */
const LOGIN_GATE_SKIP_FLAG = 'aria.loginGate.skipOnce';

/** Legacy key from a previous attempt; cleared on startup so old
 *  installations don't keep a stale timestamp around. */
const RECENT_PICK_KEY = 'aria.started.recentPickAt';

/** README dropped into a new project folder to explain the default layout.
 *  Plain, non-developer-friendly wording; no emojis. */
const PROJECT_TEMPLATE_README = `# Qoka project

This folder was created by Qoka. Here is what each folder is for:

- data/        Input data. Put your datasets here. Per-run input summaries
               (for data kept on a server) go under data/<run-name>/.
- analysis/    The CODE: code you asked to keep and notebooks (.ipynb), plus
               autopipe pipeline code (one folder per pipeline). Quick throwaway
               checks are not kept; low-value scratch code goes to .qoka/analysis/.
- results/     The OUTPUTS: each run's result files and logs, in results/<run-name>/.
- .qoka/       Qoka's own files - edit these through the app, not by hand:
    manuscript/draft/   Papers you write in the Manuscript tab.
    manuscript/review/  Results from the Manuscript tab's reviews.
    references/         Papers you save to your Paper Library.
    notebook/           Overview, roadmaps and research notes.

You can rename or delete any folder you do not need.
`;

/** Persistent (localStorage) breadcrumb trail for the New Project / picker
 *  flow. openWindow reloads (or recreates) the window, wiping the DevTools
 *  console, so the moment a bounce happens is unobservable in the live console.
 *  We append milestones here - localStorage survives a reload AND a full window
 *  recreation (unlike sessionStorage) - and dump+clear them on the next overlay
 *  construction, so the post-bounce console prints exactly what happened before
 *  the reload. Capped so it can never grow without bound. */
const TRAIL_KEY = 'aria.started.trail';
function pushTrail(msg: string): void {
	try {
		const raw = localStorage.getItem(TRAIL_KEY);
		const arr: string[] = raw ? JSON.parse(raw) : [];
		arr.push(`${new Date().toISOString()} ${msg}`);
		// Keep the last 40 entries only.
		localStorage.setItem(TRAIL_KEY, JSON.stringify(arr.slice(-40)));
	} catch { /* storage unavailable - diagnostics are best-effort */ }
}
function dumpTrail(): void {
	try {
		const raw = localStorage.getItem(TRAIL_KEY);
		if (!raw) { return; }
		const arr: string[] = JSON.parse(raw);
		if (arr.length) {
			console.log(`[aria][trail] --- New Project / picker breadcrumb from before this load (${arr.length} entries) ---`);
			for (const line of arr) { console.log(`[aria][trail] ${line}`); }
			console.log('[aria][trail] --- end ---');
		}
		localStorage.removeItem(TRAIL_KEY);
	} catch { /* ignore */ }
}

/**
 * Qoka's "Started" overlay - a full-viewport surface that locks the
 * workbench until the user picks a project. Replaces the previous
 * editor-pane approach so the sidebar, menu bar, terminal, and editor
 * tabs underneath are all blocked from interaction.
 *
 * Behaviour summary
 *  - Shows on workbench restore ONLY when no folder is loaded (EMPTY
 *    workspace). If a project is already open (restored from a previous
 *    session or launched from a CLI), the workbench is shown directly.
 *  - Setup (MCP registration, skill install, etc.) runs in the
 *    background while the overlay is up. The "Setting up Qoka" loading
 *    overlay (firstRunOverlay) is intentionally skipped here - the
 *    Started overlay is the user-facing surface during setup.
 *  - When the user picks Open Project / a recent project, VS Code
 *    reloads the window with the new folder. In the new window:
 *      • Started overlay does not show (a folder is loaded now).
 *      • firstRunOverlay shows if setup is still tracking, and fades
 *        out when tracking completes.
 *  - New Project is a placeholder for the upcoming chat-driven flow;
 *    it surfaces an info notification and hides the overlay so the
 *    user is not trapped.
 */
class AriaStartedOverlayContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.startedOverlay';

	private overlay: HTMLDivElement | undefined;
	private hideWorkbenchStyle: HTMLStyleElement | undefined;
	/** True while the overlay is stood down because the roadmap wizard editor
	 *  is open. We only auto-return the picker when WE hid it for that reason. */
	private suppressedForRoadmap = false;

	// Auth state - the overlay is also the sign-in gate. Until the first check
	// resolves we show the loading spinner; then login (no session) or the
	// signed-in banner + picker (session present).
	private ariaSession: AuthenticationSession | undefined;
	private ariaProvider: string | undefined;
	private authChecked = true; // login removed: never wait on an auth check
	private authLoading = false;
	// True once the user chose "Continue without signing in" (this window), OR the
	// persisted LOGIN_SKIPPED_FLAG is set. Lets the overlay skip the login screen and
	// go to the picker/project without a session. Sign-in stays available in Settings.
	private guestMode = false;
	private cycleTimer: ReturnType<typeof setInterval> | undefined;

	// AI-provider picker step (shown after sign-in, before the mode/project
	// picker, on first run only). `aiInstalled` is filled asynchronously from
	// IExtensionService; `aiChecked` is the user's multi-select state.
	private aiInstalled: Record<ConcreteProvider, boolean> | undefined;
	private aiChecked: Record<ConcreteProvider, boolean> = { claude: false, codex: false };
	private aiCheckedInit = false;
	private aiFetching = false;
	// True while, right after the user clicks Continue on the AI picker, we install
	// the chosen provider's CLI and register the MCP servers. The overlay shows a
	// loading page during this so the user can't proceed until the tools are ready.
	private setupInProgress = false;
	/** Windows only: while true, the overlay shows a neutral "Preparing Qoka" cover (not
	 *  the sign-in view) so the WSL install prompt can be resolved FIRST, before login. */
	private wslGateWaiting = false;
	/** Set when the user explicitly asked for the project picker (the "Change project"
	 *  button). Sign-in is optional, so an explicit picker request shows the picker even
	 *  when signed out - it must not be bounced to the login screen. */
	private explicitPicker = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// Print (and clear) any breadcrumb the pre-reload window left behind, then
		// record where THIS load landed - so a New Project bounce shows up as
		// "createNewProject ... openWindow" followed by "constructor: state=EMPTY".
		dumpTrail();
		try {
			const state = this.contextService.getWorkbenchState();
			const stateName = state === WorkbenchState.EMPTY ? 'EMPTY' : state === WorkbenchState.FOLDER ? 'FOLDER' : 'WORKSPACE';
			const justPicked = (() => { try { return sessionStorage.getItem(JUST_PICKED_FLAG); } catch { return '?'; } })();
			pushTrail(`constructor: workbenchState=${stateName}, justPickedFlag=${justPicked}`);
			console.log(`[aria][trail] constructor: workbenchState=${stateName}, justPickedFlag=${justPicked}`);
		} catch { /* ignore */ }

		// Re-check which provider extensions are installed when the set changes
		// (e.g. the user installs one from the picker), so the step updates.
		this._register(this.extensionService.onDidChangeExtensions(() => {
			if (this.overlay && !hasPickedAiProvider()) {
				void this.refreshAiInstalled();
			}
		}));

		// The New Project wizard opens as a real editor. When it appears we
		// step the picker aside so the wizard + Claude Code's aux-bar chat own
		// the window; when it closes we bring the picker back (unless a project
		// was just picked and a reload is imminent).
		this._register(this.editorService.onDidEditorsChange(() => this.syncRoadmapEditor()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING) && this.overlay) {
				this.rerender();
			}
		}));

		// Wipe legacy / stale skip markers so this build can never be
		// silently skipped because of state left over from an earlier
		// build's storage backend.
		try { sessionStorage.removeItem('aria.started.picked'); } catch { /* ignore */ }
		try { localStorage.removeItem(RECENT_PICK_KEY); } catch { /* ignore */ }

		// Remember the last-active PROJECT so a cold app launch reopens where the
		// user was actually working. Store now (this window shows a project) and
		// again whenever it regains focus; the empty-window auto-reopen reads it.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			const projectUri = this.contextService.getWorkspace().folders[0]?.uri;
			if (projectUri) {
				const remember = () => {
					try { this.storageService.store(LAST_ACTIVE_PROJECT_KEY, projectUri.toString(), StorageScope.APPLICATION, StorageTarget.MACHINE); } catch { /* ignore */ }
				};
				remember();
				this._register(this.hostService.onDidChangeFocus(focused => { if (focused) { remember(); } }));
			}
		}

		// This overlay (sign-in + picker) is only for an EMPTY workbench. A folder
		// window - a just-picked reload or a restored project - shows the workbench
		// directly; the login guard (ariaLoginGate) handles sign-in there.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			pushTrail('startup: workbenchState != EMPTY (folder attached) -> showing workbench, overlay suppressed (GOOD - no bounce)');
			try { sessionStorage.removeItem(JUST_PICKED_FLAG); } catch { /* ignore */ }
			this.removeEarlyHideStyleByID();
			return;
		}

		// During the openFolder reload, the very next workbench load
		// must NOT re-show Started. We hand that off to a sessionStorage
		// flag that's set just before reload and cleared on first read
		// - so it's a one-shot, can't go stale, doesn't leak across
		// genuine app restarts (sessionStorage is per-window-session).
		try {
			if (sessionStorage.getItem(JUST_PICKED_FLAG) === '1') {
				pushTrail('startup: workbenchState EMPTY but justPicked flag SET -> suppressing overlay for the reload (folder did not attach yet)');
				sessionStorage.removeItem(JUST_PICKED_FLAG);
				// Module-load installed an early hide stylesheet to
				// prevent the workbench flash; on the skip path we
				// must take it down or the user stares at a blank
				// page while setup runs.
				this.removeEarlyHideStyleByID();
				return;
			}
		} catch { /* ignore */ }

		// EMPTY workbench, not a just-picked reload. Hide the workbench shell right
		// away (avoids a flash) while we decide asynchronously whether to auto-reopen
		// the last project or bring up the sign-in / picker overlay.
		this.installHideWorkbenchStyle();
		void this.decideEmptyWorkbench();
	}

	/**
	 * Reached on an EMPTY workbench that isn't a just-picked reload - i.e. a plain
	 * app launch (Cmd+Q relaunch) or a Dock reactivation into a fresh empty window.
	 * Intent-based routing:
	 *   - "Change project" was clicked  → show the PICKER (WANT_PICKER_FLAG).
	 *   - Signed out (no session)        → show SIGN-IN.
	 *   - Otherwise (signed in, past onboarding, a recent project exists)
	 *                                    → AUTO-REOPEN the most recent project.
	 * Only an explicit action lands on the picker/sign-in; everything else returns
	 * the user straight to where they were working.
	 */
	/** Hold the sign-in / picker until the Windows WSL install prompt (if any) is resolved,
	 *  so the prompt appears BEFORE login. While waiting, the overlay shows a neutral
	 *  loading cover (wslGateWaiting) so the workbench is never blank. aria-autopipe reports
	 *  whether the prompt shows via aria.autopipe.vm.status (wslLaunchDecided + wslPhase):
	 *  wait for the decision, then while a prompt phase is active hold; 'idle' (no prompt /
	 *  resolved) lets login proceed. Bounded so a stuck / absent extension never blocks
	 *  login. No-op off Windows. */
	private async _awaitWslPromptResolved(): Promise<void> {
		if (!isWindows) { return; }
		const start = Date.now();
		const DECISION_GRACE = 15000;          // extension never decided -> stop waiting, run login
		const HARD_DEADLINE = 20 * 60 * 1000;  // an active prompt is a legit gate, but never forever
		while (Date.now() - start < HARD_DEADLINE) {
			let st: { wslPhase?: string; wslLaunchDecided?: boolean } | undefined;
			try {
				st = await this.commandService.executeCommand('aria.autopipe.vm.status');
			} catch {
				st = undefined; // aria-autopipe not activated yet (or no such command)
			}
			if (!st || !st.wslLaunchDecided) {
				if (Date.now() - start >= DECISION_GRACE) { return; }
				await timeout(400);
				continue;
			}
			const phase = st.wslPhase;
			if (phase === 'checking' || phase === 'prompting' || phase === 'installing' || phase === 'reboot') {
				await timeout(500); // WSL prompt is up - keep the cover, hold sign-in behind it
				continue;
			}
			return; // 'idle'/undefined after a decision -> no prompt or already resolved
		}
	}

	private async decideEmptyWorkbench(): Promise<void> {
		// Windows first-run: bring up the overlay as a neutral loading cover and hold until
		// the WSL install prompt (if WSL is missing) is resolved, so it appears BEFORE
		// sign-in. No-op off Windows / when WSL is present (returns almost immediately).
		if (isWindows) {
			this.wslGateWaiting = true;
			this.show(); // overlay shows the loading cover (render sees wslGateWaiting)
			await this._awaitWslPromptResolved();
			this.wslGateWaiting = false;
			// Fall through to the normal decision below; the overlay is already up, so the
			// sign-in path just re-renders it and the auto-reopen path hides it + reloads.
		}

		// Explicit "Change project" always wins - consume the one-shot flag and show
		// the picker.
		let wantPicker = false;
		try { wantPicker = localStorage.getItem(WANT_PICKER_FLAG) === '1'; } catch { /* ignore */ }
		if (wantPicker) {
			try { localStorage.removeItem(WANT_PICKER_FLAG); } catch { /* ignore */ }
			// Show the picker directly - even when signed out. "Change project" is an
			// explicit in-app action and sign-in is optional, so it must NOT bounce to login.
			this.explicitPicker = true;
			pushTrail('decideEmptyWorkbench: WANT_PICKER flag set -> showing picker (login not forced)');
			this.showOverlayAndWireAuth();
			return;
		}

		// ADDITIONAL window: another Qoka project window is already open, so the user
		// opened this new window to pick a (probably different) project. Always show
		// the picker - never auto-reopen the most-recent project here. Only a COLD
		// launch (this is the only window) returns the user to where they left off.
		if (await this.anotherProjectWindowOpen()) {
			pushTrail('decideEmptyWorkbench: another project window is open -> showing picker (additional window)');
			this.showOverlayAndWireAuth();
			return;
		}

		// Loop guard: if we already tried to auto-reopen in THIS window session and
		// still landed empty, the target was unopenable - fall back to the picker.
		let alreadyTried = false;
		try { alreadyTried = sessionStorage.getItem(AUTO_REOPEN_TRIED_FLAG) === '1'; } catch { /* ignore */ }
		if (alreadyTried) {
			pushTrail('decideEmptyWorkbench: auto-reopen already tried this session -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		// Need a signed-in session AND a completed onboarding (AI provider chosen) to
		// auto-reopen; otherwise the first-run sign-in / AI-picker flow must run.
		// Login removed: there is no session concept. Auto-reopen is gated only on
		// whether an AI provider was chosen (pickedAi), below.
		const hasSession = false;
		// "Onboarding done" = the localStorage picked flag OR an explicit
		// aria.aiProvider setting (claude/codex). The setting persists reliably even
		// if the localStorage flag was lost, so a returning user isn't wrongly sent
		// back through the AI picker.
		const providerSetting = this.configurationService.getValue<string>('aria.aiProvider');
		const pickedAi = hasPickedAiProvider() || providerSetting === 'claude' || providerSetting === 'codex';
		// Sign-in is optional: a guest who already skipped login (and picked an AI)
		// is treated like a signed-in user for auto-reopen, so they aren't sent back
		// to the login screen every launch.
		const mayProceed = true; // login removed: never gate the picker / auto-reopen on a session
		if (!mayProceed || !pickedAi) {
			pushTrail(`decideEmptyWorkbench: hasSession=${hasSession}, loginSkipped=${this.loginSkipped()}, pickedAi=${pickedAi} -> showing sign-in/picker`);
			this.showOverlayAndWireAuth();
			return;
		}

		// Find the most recent project folder that still exists on disk.
		const recentUri = await this.mostRecentExistingProject();
		if (!recentUri) {
			pushTrail('decideEmptyWorkbench: no reopenable recent project -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		// If that most-recent project is already open in another Qoka window,
		// reopening it here would only dedup-focus that window and strand THIS one
		// blank. Skip the reopen and show the picker so the user opens something in
		// this window instead (this is a fresh empty window, so don't close it).
		const nativeHost = this.nativeHost();
		if (nativeHost && await this.findWindowWithFolder(nativeHost, recentUri) !== undefined) {
			pushTrail('decideEmptyWorkbench: most-recent project already open in another window -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		try { sessionStorage.setItem(AUTO_REOPEN_TRIED_FLAG, '1'); } catch { /* ignore */ }
		pushTrail(`decideEmptyWorkbench: auto-reopening most recent project ${recentUri.fsPath}`);
		// Reuse the just-picked machinery so the reloaded window suppresses the
		// overlay and lands directly on the project.
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri: recentUri }], { forceReuseWindow: true });
		});
		// MULTI-WINDOW SAFETY: openWindow reuses a window to open the folder, BUT if
		// that project is already open in another Qoka window, the app focuses THAT
		// window instead of reusing this empty one - leaving this window with its
		// shell hidden and no folder (a permanent blank window, the "second window
		// shows nothing" bug). When the reuse DID reload this window, this renderer is
		// replaced and the timer below never fires. If we're still here after a beat,
		// the reuse went elsewhere: reveal the picker so the user can open a (possibly
		// different) project in THIS window rather than staring at a blank shell.
		setTimeout(() => {
			pushTrail('decideEmptyWorkbench: still empty after auto-reopen (project already open elsewhere) -> showing picker');
			this.showOverlayAndWireAuth();
		}, 2500);
	}

	/** The most recent recently-opened folder whose directory still exists, or
	 *  undefined when there is none to reopen. */
	private async mostRecentExistingProject(): Promise<URI | undefined> {
		// Prefer the LAST-ACTIVE project (the folder window the user last worked in /
		// that was last closed) so a cold launch reopens where they left off, even
		// when several windows were open and closed at once.
		try {
			const raw = this.storageService.get(LAST_ACTIVE_PROJECT_KEY, StorageScope.APPLICATION);
			if (raw) {
				const uri = URI.parse(raw);
				if (await this.fileService.exists(uri)) {
					return uri;
				}
			}
		} catch { /* fall back to the recents list */ }

		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			return undefined;
		}
		for (const item of recents.workspaces) {
			const uri: URI | undefined = isRecentFolder(item)
				? item.folderUri
				: isRecentWorkspace(item)
					? item.workspace.configPath
					: undefined;
			if (!uri) {
				continue;
			}
			try {
				if (await this.fileService.exists(uri)) {
					return uri;
				}
			} catch {
				// Unreadable - skip and try the next most recent.
			}
		}
		return undefined;
	}

	/** Bring up the sign-in / picker overlay and keep it in sync with the session.
	 *  Split out of the constructor so decideEmptyWorkbench can defer to it on every
	 *  non-auto-reopen path. */
	private showOverlayAndWireAuth(): void {
		// Login removed: just show the overlay (goes straight to the AI/mode/project
		// picker). No auth session wiring, no sign-in. rerender() AFTER show() so a
		// re-entry - e.g. the Windows WSL gate already created the overlay as a loading
		// cover - repaints it as the picker instead of staying stuck on "loading".
		this.show();
		this.rerender();
	}

	/** Read the current Qoka session and re-render the overlay to match. */
	private async refreshAuth(): Promise<void> {
		try {
			// activateImmediate=true wakes the aria-authentication extension so its
			// provider is registered before we read sessions.
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			this.ariaSession = sessions.length > 0 ? sessions[0] : undefined;
		} catch {
			this.ariaSession = undefined;
		}
		// The session has no provider (scopes are []); the extension exposes it.
		try {
			const info = await this.commandService.executeCommand<{ provider?: string } | undefined>('aria.auth.getSession');
			this.ariaProvider = info?.provider;
		} catch {
			this.ariaProvider = undefined;
		}
		this.authChecked = true;
		this.authLoading = false;
		this.rerender();
	}

	private async signIn(provider: 'orcid' | 'google'): Promise<void> {
		// Going through the login screen normally re-arms the AI picker. But a
		// RE-sign-in from within a project ("Sign in" in the status bar / Settings,
		// which sets SIGNIN_RETURN_TO) must KEEP the existing AI-provider choice - the
		// user already onboarded - so we reopen straight into the project and its setup
		// gate still runs. Only clear (re-arm the picker) for a first-run login.
		let reSignIn = false;
		try { reSignIn = !!localStorage.getItem(SIGNIN_RETURN_TO); } catch { /* ignore */ }
		if (!reSignIn) {
			clearPickedAiProvider();
		}
		this.authLoading = true;
		this.rerender();
		try {
			console.log(`[aria] sign-in started via ${provider}`);
			// The provider hint is passed as the scope; the aria-authentication
			// extension reads it to skip its own provider QuickPick.
			await this.authService.createSession(AUTH_ID, [provider]);
			// Actually signed in now: drop any "skipped sign-in" guest state so the
			// signed-in experience takes over.
			try { localStorage.removeItem(LOGIN_SKIPPED_FLAG); } catch { /* ignore */ }
			this.guestMode = false;
			// Success fires onDidChangeSessions → refreshAuth → banner + picker.
			console.log(`[aria] sign-in via ${provider} succeeded`);
		} catch (e) {
			// Cancelled (user closed the browser / clicked Cancel) or failed:
			// drop the loading state and re-render the sign-in screen.
			console.log(`[aria] sign-in via ${provider} cancelled/failed, returning to sign-in screen:`, (e as Error)?.message);
			this.authLoading = false;
			void this.refreshAuth();
		}
	}

	private async signOut(): Promise<void> {
		if (!this.ariaSession) {
			return;
		}
		try {
			await this.authService.removeSession(AUTH_ID, this.ariaSession.id);
		} catch { /* ignore */ }
		// onDidChangeSessions → refreshAuth → login view. Already in the picker
		// (empty workspace), so no folder needs closing here.
		void this.refreshAuth();
	}


	private installHideWorkbenchStyle(): void {
		// Module-load already installed the stylesheet. We just take a
		// reference so removeHideWorkbenchStyle() has something to
		// clean up when the overlay is dismissed.
		if (this.hideWorkbenchStyle) {
			return;
		}
		const existing = document.getElementById('aria-started-hide-workbench');
		if (existing instanceof HTMLStyleElement) {
			this.hideWorkbenchStyle = existing;
			return;
		}
		// Fallback if early install somehow didn't run (e.g. document
		// wasn't yet ready). Install now.
		const style = document.createElement('style');
		style.id = 'aria-started-hide-workbench';
		style.textContent = `
			body > *:not(#aria-started-overlay):not(#aria-login-gate-overlay):not(.aria-wsl-overlay):not(style):not(script):not(link) {
				visibility: hidden !important;
			}
		`;
		document.head.appendChild(style);
		this.hideWorkbenchStyle = style;
	}

	private removeHideWorkbenchStyle(): void {
		if (this.hideWorkbenchStyle) {
			this.hideWorkbenchStyle.remove();
			this.hideWorkbenchStyle = undefined;
		}
	}

	private removeEarlyHideStyleByID(): void {
		const existing = document.getElementById('aria-started-hide-workbench');
		if (existing) {
			existing.remove();
		}
		this.hideWorkbenchStyle = undefined;
	}

	/** Set the one-shot just-picked flag so the next workbench load
	 *  (the one triggered by vscode.openFolder) skips Started. The
	 *  flag is consumed-and-cleared on first read in the constructor
	 *  of that next load, so it cannot leak across genuine restarts. */
	private pickAndDismiss(action: () => void): void {
		try {
			sessionStorage.setItem(JUST_PICKED_FLAG, '1');
			// The overlay only reaches a folder-opening action when the user is
			// signed in (the picker sits behind the auth gate). Tell the folder
			// window's login gate to TRUST that and skip its own session poll -
			// otherwise, while a fresh window is busy (e.g. installing the CLI), the
			// gate's getSessions can race the auth restore, wrongly conclude "signed
			// out", and closeFolder - the New Project bounce. We store a TIMESTAMP
			// (not just '1'): the gate honours it only if fresh (seconds old), so a
			// flag that somehow lingers can never suppress the gate on a later,
			// genuinely-signed-out folder window. localStorage survives the reload.
			localStorage.setItem(LOGIN_GATE_SKIP_FLAG, String(Date.now()));
			pushTrail('pickAndDismiss: set justPicked + loginGateSkip flags, hiding overlay, running action');
		} catch {
			// Storage can throw in restricted contexts; the overlay
			// still hides and the action still runs.
			pushTrail('pickAndDismiss: storage.setItem THREW - flags NOT set');
		}
		this.hide();
		action();
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		// Never show the sign-in / mode-and-project picker once a project folder
		// is open. The picker is for the empty-workbench start only; a folder
		// window must stay on the project - even if a provider extension failed
		// to load or wasn't detected - instead of bouncing back to the picker.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			return;
		}

		const overlay = document.createElement('div');
		overlay.id = 'aria-started-overlay';
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		overlay.style.color = 'var(--vscode-foreground, #cccccc)';
		// Higher than firstRunOverlay (999999) so loading never leaks through.
		overlay.style.zIndex = '1000000';
		overlay.style.overflow = 'auto';
		// Center the content box on screen. `display:flex` + `margin:auto` on the
		// content (see render) centers it both axes and still scrolls when the
		// content is taller than the viewport.
		overlay.style.display = 'flex';
		overlay.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';
		// Allow dragging the window by the overlay background (covered title bar);
		// the content box (render()) opts back out so its controls stay clickable.
		overlay.style.setProperty('-webkit-app-region', 'drag');

		this.installFocusTrap(overlay);

		document.body.appendChild(overlay);
		this.overlay = overlay;

		this.render();
	}

	private hide(): void {
		if (!this.overlay) {
			return;
		}
		this.stopMessageCycle();
		this.overlay.remove();
		this.overlay = undefined;
		this.removeHideWorkbenchStyle();
	}

	/** React to the roadmap wizard editor opening / closing. */
	private syncRoadmapEditor(): void {
		const wizardOpen = this.editorService.editors.some(e => e.resource?.scheme === ROADMAP_SCHEME);
		if (wizardOpen) {
			// Editor is up - stand the picker down (only if we currently show it).
			if (this.overlay) {
				this.hide();
				this.suppressedForRoadmap = true;
			}
			return;
		}
		// Editor gone - bring the picker back, but only if we were the ones who
		// hid it and no project pick is mid-flight (Save triggers a reload).
		if (this.suppressedForRoadmap) {
			this.suppressedForRoadmap = false;
			let justPicked = false;
			try { justPicked = sessionStorage.getItem(JUST_PICKED_FLAG) === '1'; } catch { /* ignore */ }
			if (!justPicked && !this.overlay) {
				this.installHideWorkbenchStyle();
				this.show();
			}
		}
	}

	// --- AI-assistant picker step ------------------------------------------

	/** A small themed button used by the AI picker step. Secondary buttons use
	 *  `inherit` so they read correctly on both the easy (white) and advanced
	 *  (dark) overlay backgrounds. */
	private makeButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = label;
		btn.style.padding = '9px 20px';
		btn.style.fontSize = '13.5px';
		btn.style.borderRadius = '5px';
		btn.style.cursor = 'pointer';
		btn.style.font = 'inherit';
		if (primary) {
			btn.style.background = 'var(--vscode-button-background, #0e639c)';
			btn.style.color = 'var(--vscode-button-foreground, #ffffff)';
			btn.style.border = '1px solid transparent';
		} else {
			btn.style.background = 'transparent';
			btn.style.color = 'inherit';
			btn.style.border = '1px solid rgba(127,127,127,0.5)';
		}
		btn.onclick = onClick;
		return btn;
	}

	/** Async-check which provider extensions are installed, then re-render. On
	 *  the first fill, pre-check the installed ones so a ready user can just
	 *  click Continue. */
	private async refreshAiInstalled(): Promise<void> {
		if (this.aiFetching) {
			return;
		}
		this.aiFetching = true;
		try {
			const check = async (p: ConcreteProvider) => !!(await this.extensionService.getExtension(PROVIDER_EXTENSION_ID[p]));
			const [claude, codex] = await Promise.all([check('claude'), check('codex')]);
			this.aiInstalled = { claude, codex };
			if (!this.aiCheckedInit) {
				this.aiChecked = { claude, codex };
				this.aiCheckedInit = true;
			}
		} finally {
			this.aiFetching = false;
		}
		if (this.overlay && !hasPickedAiProvider()) {
			this.rerender();
		}
	}

	private renderAiProviderSection(parent: HTMLElement): void {
		const title = document.createElement('h1');
		title.textContent = 'Choose your AI assistant';
		title.style.fontSize = '32px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 8px 0';
		parent.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.textContent = 'Qoka works with Claude Code or OpenAI Codex (ChatGPT). Pick the one(s) you\'ll use - you can select both. You can change this later in Settings.';
		subtitle.style.fontSize = '14px';
		subtitle.style.opacity = '0.7';
		subtitle.style.margin = '0 0 28px 0';
		subtitle.style.maxWidth = '520px';
		parent.appendChild(subtitle);

		// Installed-state not known yet → fetch it and show a spinner meanwhile.
		if (!this.aiInstalled) {
			void this.refreshAiInstalled();
			this.renderLoadingSection(parent);
			return;
		}

		const list = document.createElement('div');
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '12px';
		list.style.maxWidth = '520px';
		parent.appendChild(list);
		(['claude', 'codex'] as ConcreteProvider[]).forEach(p => list.appendChild(this.renderProviderRow(p)));

		// Continue is enabled whenever at least one provider is checked. What it
		// does depends on install state (see chooseAiProviders): all checked ones
		// installed → proceed; any missing → open the Marketplace page(s) so the
		// user can install, then reload.
		const anyChecked = (['claude', 'codex'] as ConcreteProvider[]).some(p => this.aiChecked[p]);
		const cont = this.makeButton('Continue', true, () => { if (anyChecked) { void this.chooseAiProviders(); } });
		cont.style.marginTop = '26px';
		if (!anyChecked) {
			cont.style.opacity = '0.5';
			cont.style.cursor = 'not-allowed';
		}
		parent.appendChild(cont);

		const hint = document.createElement('div');
		hint.textContent = 'Check the assistant(s) you want. If a checked one isn\'t installed yet, you\'ll be taken to install it after you pick a project.';
		hint.style.marginTop = '12px';
		hint.style.fontSize = '12px';
		hint.style.opacity = '0.6';
		hint.style.maxWidth = '520px';
		parent.appendChild(hint);
	}

	private renderProviderRow(p: ConcreteProvider): HTMLElement {
		const installed = !!this.aiInstalled?.[p];
		const row = document.createElement('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '12px';
		row.style.padding = '14px 16px';
		row.style.border = '1px solid rgba(127,127,127,0.35)';
		row.style.borderRadius = '8px';

		// Checkbox is ALWAYS selectable - the user may want an assistant that
		// isn't installed yet; Continue routes such choices to the Marketplace.
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = this.aiChecked[p];
		cb.style.width = '17px';
		cb.style.height = '17px';
		cb.style.cursor = 'pointer';
		cb.onchange = () => { this.aiChecked[p] = cb.checked; this.rerender(); };
		row.appendChild(cb);

		const name = document.createElement('div');
		name.textContent = PROVIDER_LABEL[p];
		name.style.flex = '1';
		name.style.fontSize = '15px';
		name.style.fontWeight = '600';
		row.appendChild(name);

		// Installed → an active Uninstall button (click removes it). Not installed
		// → a red "Uninstalled" label. The checkbox stays selectable in both cases.
		if (installed) {
			const uninstall = this.makeButton('Uninstall', false, () => void this.uninstallProvider(p));
			uninstall.style.padding = '5px 12px';
			uninstall.style.fontSize = '12.5px';
			row.appendChild(uninstall);
		} else {
			const label = document.createElement('span');
			label.textContent = 'Uninstalled';
			label.style.fontSize = '12.5px';
			label.style.fontWeight = '600';
			label.style.color = 'var(--vscode-errorForeground, #e51400)';
			row.appendChild(label);
		}
		return row;
	}

	private async uninstallProvider(p: ConcreteProvider): Promise<void> {
		try {
			await this.commandService.executeCommand('workbench.extensions.uninstallExtension', PROVIDER_EXTENSION_ID[p]);
			this.aiChecked[p] = false;
			this.notificationService.info(`${PROVIDER_LABEL[p]} uninstalled. Reload Qoka to fully remove it.`);
		} catch (e) {
			this.notificationService.error(`Could not uninstall ${PROVIDER_LABEL[p]}: ${(e as Error).message}`);
		}
		void this.refreshAiInstalled();
	}

	/**
	 * Continue from the AI picker:
	 *  - if every CHECKED provider is installed → record the choice in
	 *    `aria.aiProvider` and advance to the mode/project picker;
	 *  - if any CHECKED provider is NOT installed → dismiss the overlay and open
	 *    the Marketplace page for each missing one (both, if both were checked)
	 *    so the user can install; we do NOT mark the choice, so the picker
	 *    returns on the next reload where the now-installed provider proceeds.
	 */
	private async chooseAiProviders(): Promise<void> {
		const providers: ConcreteProvider[] = ['claude', 'codex'];
		const checked = providers.filter(p => this.aiChecked[p]);
		if (checked.length === 0) {
			return;
		}
		// Any checked provider that isn't installed yet is DEFERRED: record it and
		// advance to the project picker. Its Marketplace page opens later - after
		// the user picks a project - in that project window (see ariaStartupChat),
		// not here in the empty picker.
		const missing = checked.filter(p => !this.aiInstalled?.[p]);
		setPendingInstall(missing);

		const setting = providerSettingFor(this.aiChecked.claude, this.aiChecked.codex);
		markPickedAiProvider();
		try {
			// handleDirtyFile:'save' + donotNotifyError so writing the setting never
			// pops the settings.json editor / a save dialog over the overlay.
			await this.configurationService.updateValue(ARIA_AI_PROVIDER_SETTING, setting, {}, ConfigurationTarget.APPLICATION, { handleDirtyFile: 'save', donotNotifyError: true });
		} catch { /* proceed even if persisting fails; 'auto' resolution covers it */ }

		// Install the chosen provider(s)' CLI NOW, behind a loading page, so the
		// binary is ready before the user reaches the chat. MCP servers are NOT
		// registered here: picking a project reloads into a new window where every
		// Qoka MCP server gets a FRESH port, so any registration now would be stale
		// at once. The project window is where MCP registration happens (its own
		// loader holds until every server is registered). Idempotent, so a later
		// relaunch (CLI already installed) is fast and never shows this. Failsafe
		// timeout so a stuck install can't trap the user here.
		this.setupInProgress = true;
		this.rerender();
		try {
			await Promise.race([
				this.commandService.executeCommand('aria.setup.prepareProviders', checked),
				timeout(90000),
			]);
		} catch { /* proceed regardless - the project window's setup gate retries */ }
		this.setupInProgress = false;
		this.rerender(); // → mode + project picker
	}

	private rerender(): void {
		if (!this.overlay) {
			return;
		}
		while (this.overlay.firstChild) {
			this.overlay.removeChild(this.overlay.firstChild);
		}
		this.render();
	}

	/**
	 * The launch overlay follows the mode: white in easy (matching the forced
	 * light theme), the current dark editor background in advanced. Re-applied on
	 * every render, so clicking the Easy / Advanced card recolors it immediately.
	 */
	private applyModeColors(): void {
		if (!this.overlay) {
			return;
		}
		const easy = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) === 'easy';
		this.overlay.style.background = easy ? '#ffffff' : 'var(--vscode-editor-background, #1e1e1e)';
		this.overlay.style.color = easy ? '#1f1f1f' : 'var(--vscode-foreground, #cccccc)';
	}

	private render(): void {
		if (!this.overlay) {
			return;
		}

		this.applyModeColors();

		const content = document.createElement('div');
		content.style.maxWidth = '900px';
		content.style.width = '100%';
		// `margin: auto` inside the flex overlay centers this box on both axes
		// (and overrides flex stretch), while still allowing scroll when tall.
		content.style.margin = 'auto';
		content.style.padding = '40px';
		content.style.boxSizing = 'border-box';
		// The overlay background is a window-drag region (see show()); the content
		// box opts out so its buttons / menus stay clickable.
		content.style.setProperty('-webkit-app-region', 'no-drag');
		this.overlay.appendChild(content);

		// A prior render's loading-message cycle points at a now-removed node.
		this.stopMessageCycle();

		// Windows first-run gate: while the WSL install prompt is being resolved, show a
		// neutral loading cover (never the sign-in view, and never a blank workbench) so
		// the WSL prompt comes up FIRST, before login. Cleared once WSL is resolved.
		if (this.wslGateWaiting) {
			this.renderLoadingSection(content);
			return;
		}

		// Sign-in gate: until authenticated, this overlay shows login (or the
		// loading spinner mid sign-in), NOT the project picker.
		if (!this.authChecked || this.authLoading) {
			// During an ACTIVE sign-in offer a way back: closing the external
			// browser fires no event, so createSession never rejects and the
			// spinner would otherwise hang on "Preparing sign-in…" forever.
			this.renderLoadingSection(content, this.authLoading);
			return;
		}
		// Login removed: the overlay never shows a sign-in screen - it goes straight
		// to the AI-provider / mode / project picker.

		// Right after Continue on the AI picker: installing the CLI + registering
		// MCP. Blocks the picker until the tools are ready. (hasPickedAiProvider is
		// already true here, so this must be checked before that branch.)
		if (this.setupInProgress) {
			this.renderSetupLoading(content);
			return;
		}

		// First-run AI-assistant step: signed in but hasn't chosen an AI yet.
		// Blocks the mode/project picker until a provider is chosen (and at
		// least one chosen provider is installed).
		// Post sign-in return: a "Sign in" action (status bar / Settings) closed the
		// project and sent us to the login screen. Now that we are authenticated,
		// reopen the project we left - straight to it, skipping the AI re-picker (an
		// already-onboarded user is the only one who can reach this).
		if (this.ariaSession) {
			let signinReturnTo: string | null = null;
			try { signinReturnTo = localStorage.getItem(SIGNIN_RETURN_TO); } catch { /* ignore */ }
			if (signinReturnTo) {
				try { localStorage.removeItem(SIGNIN_RETURN_TO); } catch { /* ignore */ }
				pushTrail(`render: sign-in return -> reopening ${signinReturnTo}`);
				const uri = URI.parse(signinReturnTo);
				this.pickAndDismiss(() => {
					void this.hostService.openWindow([{ folderUri: uri }], { forceReuseWindow: true });
				});
				return;
			}
		}

		if (!hasPickedAiProvider()) {
			this.renderAiProviderSection(content);
			return;
		}

		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';

		// Header: the Qoka face mark at the far left (its left edge aligns with the
		// mode/start sections below), title + subtitle stacked to its right. The mark's
		// height spans from the title down through the subtitle.
		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '18px';
		header.style.margin = '0 0 32px 0';

		const markWrap = document.createElement('div');
		markWrap.style.display = 'flex';
		markWrap.style.alignItems = 'center';
		markWrap.style.flex = '0 0 auto';
		const mark = document.createElement('img');
		mark.src = ARIA_MARK;
		mark.alt = '';
		mark.setAttribute('aria-hidden', 'true');
		mark.style.height = '88px';
		mark.style.width = 'auto';
		mark.style.objectFit = 'contain';
		markWrap.appendChild(mark);

		const textCol = document.createElement('div');
		textCol.style.display = 'flex';
		textCol.style.flexDirection = 'column';
		textCol.style.justifyContent = 'center';

		const title = document.createElement('h1');
		title.textContent = mode === 'easy'
			? 'Qoka - Easy Mode'
			: mode === 'advanced'
				? 'Qoka - Advanced Mode'
				: 'Welcome to Qoka';
		title.style.fontSize = '32px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 8px 0';
		textCol.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.textContent = mode === ''
			? 'Choose a mode below, then pick or create a project to begin.'
			: 'Pick or create a project to begin.';
		subtitle.style.fontSize = '14px';
		subtitle.style.opacity = '0.7';
		subtitle.style.margin = '0';
		textCol.appendChild(subtitle);

		header.appendChild(markWrap);
		header.appendChild(textCol);
		content.appendChild(header);

		// Signed-in banner intentionally not rendered (login is being retired; the
		// picker no longer shows account info at the top).
		this.renderModeSection(content, mode);
		this.renderStartSection(content);
		void this.renderRecentProjects(content);
	}

	// --- sign-in views (merged into the picker overlay) --------------------

	private startMessageCycle(target: HTMLElement): void {
		this.stopMessageCycle();
		// Sign-in-specific wording only during an actual sign-in; a plain reload
		// (e.g. switching projects while already signed in) gets neutral messages.
		const messages = this.authLoading ? SIGNIN_MESSAGES : LOADING_MESSAGES;
		let i = 0;
		target.textContent = messages[0];
		this.cycleTimer = setInterval(() => {
			i = (i + 1) % messages.length;
			target.style.opacity = '0';
			setTimeout(() => {
				target.textContent = messages[i];
				target.style.opacity = '0.7';
			}, 300);
		}, 1900);
	}

	private stopMessageCycle(): void {
		if (this.cycleTimer !== undefined) {
			clearInterval(this.cycleTimer);
			this.cycleTimer = undefined;
		}
	}

	private renderLoadingSection(parent: HTMLElement, cancellable = false): void {
		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.alignItems = 'center';
		box.style.justifyContent = 'center';
		box.style.gap = '22px';
		box.style.minHeight = '220px';
		parent.appendChild(box);

		const spinner = document.createElement('div');
		spinner.style.width = '42px';
		spinner.style.height = '42px';
		spinner.style.borderRadius = '50%';
		spinner.style.border = '3px solid rgba(127, 127, 127, 0.25)';
		spinner.style.borderTopColor = 'var(--vscode-foreground, #fff)';
		spinner.style.animation = 'aria-started-spin 1.05s linear infinite';
		this.ensureSpinnerKeyframes();
		box.appendChild(spinner);

		const msg = document.createElement('div');
		msg.style.fontSize = '13.5px';
		msg.style.opacity = '0.7';
		msg.style.minHeight = '1.4em';
		msg.style.transition = 'opacity 0.3s ease';
		box.appendChild(msg);
		this.startMessageCycle(msg);

		if (cancellable) {
			// The underlying createSession stays pending (the loopback server times
			// out on its own); this just drops the overlay's waiting state and
			// returns the user to the sign-in buttons so they aren't stuck.
			const back = document.createElement('button');
			back.textContent = 'Back to sign-in';
			back.style.marginTop = '4px';
			back.style.padding = '6px 16px';
			back.style.fontSize = '12.5px';
			back.style.fontFamily = 'inherit';
			back.style.color = 'var(--vscode-foreground, #cccccc)';
			back.style.background = 'transparent';
			back.style.border = '1px solid rgba(127, 127, 127, 0.4)';
			back.style.borderRadius = '5px';
			back.style.cursor = 'pointer';
			back.onclick = () => {
				console.log('[aria] sign-in cancelled by user (Back to sign-in), returning to sign-in screen');
				// Actually ABORT the in-flight browser login: closing the browser fires
				// no event, so the loopback server + its withProgress linger and would
				// block a following sign-in with a different provider (the new login's
				// browser never opens). This command closes that server and rejects the
				// pending createSession.
				void this.commandService.executeCommand('aria.auth.cancelSignIn');
				// Render the sign-in screen SYNCHRONOUSLY. We must NOT call refreshAuth
				// here: its getSessions() call can queue behind the pending createSession,
				// so awaiting it would hang and the view would never update. The user was
				// mid sign-in, so there is no session - go straight to the login buttons.
				this.authLoading = false;
				this.authChecked = true;
				this.ariaSession = undefined;
				this.stopMessageCycle();
				this.rerender();
			};
			box.appendChild(back);
		}
	}

	private ensureSpinnerKeyframes(): void {
		if (document.getElementById('aria-started-spin-kf')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'aria-started-spin-kf';
		style.textContent = '@keyframes aria-started-spin { to { transform: rotate(360deg); } }';
		document.head.appendChild(style);
	}

	/** Loading page shown right after the AI picker's Continue, while the chosen
	 *  provider's CLI installs and the MCP servers register. A fixed message (not
	 *  the cycling sign-in copy) since this is a one-time first-run download. */
	private renderSetupLoading(parent: HTMLElement): void {
		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.alignItems = 'center';
		box.style.justifyContent = 'center';
		box.style.gap = '20px';
		box.style.minHeight = '240px';
		box.style.textAlign = 'center';
		parent.appendChild(box);

		const spinner = document.createElement('div');
		spinner.style.width = '42px';
		spinner.style.height = '42px';
		spinner.style.borderRadius = '50%';
		spinner.style.border = '3px solid rgba(127, 127, 127, 0.25)';
		spinner.style.borderTopColor = 'var(--vscode-foreground, #fff)';
		spinner.style.animation = 'aria-started-spin 1.05s linear infinite';
		this.ensureSpinnerKeyframes();
		box.appendChild(spinner);

		const title = document.createElement('div');
		title.textContent = 'Setting up your AI assistant';
		title.style.fontSize = '16px';
		title.style.fontWeight = '600';
		box.appendChild(title);

		const sub = document.createElement('div');
		sub.textContent = 'Downloading the tools it needs. This can take a minute the first time.';
		sub.style.fontSize = '13px';
		sub.style.opacity = '0.7';
		sub.style.maxWidth = '420px';
		sub.style.lineHeight = '1.5';
		box.appendChild(sub);
	}

	private renderLoginSection(parent: HTMLElement): void {
		console.log('[aria] showing sign-in screen (no active session)');
		// The picker content is left-aligned and wide; the sign-in column is short,
		// so center it (vertically too) for a balanced, intentional login screen.
		parent.style.display = 'flex';
		parent.style.flexDirection = 'column';
		parent.style.alignItems = 'center';
		parent.style.textAlign = 'center';
		parent.style.justifyContent = 'center';
		parent.style.minHeight = '70vh';

		const title = document.createElement('h1');
		title.textContent = 'Sign in to make Qoka yours';
		title.style.fontSize = '30px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 12px 0';
		parent.appendChild(title);

		const sub = document.createElement('p');
		sub.textContent = 'When you sign in, Qoka remembers your preferences and research across all projects to help you better. You can do it later in Settings.';
		sub.style.fontSize = '14px';
		sub.style.opacity = '0.7';
		sub.style.margin = '0 0 28px 0';
		sub.style.maxWidth = '440px';
		sub.style.lineHeight = '1.5';
		parent.appendChild(sub);

		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.gap = '10px';
		box.style.width = '300px';
		parent.appendChild(box);

		box.appendChild(this.makeLoginButton('Sign in with ORCID', () => void this.signIn('orcid')));
		box.appendChild(this.makeLoginButton('Sign in with Google', () => void this.signIn('google')));

		// Sign-in is optional: continue as a guest. Rendered as a quiet text link
		// below the buttons so it doesn't compete with signing in.
		const skip = document.createElement('button');
		skip.textContent = 'Continue without signing in';
		skip.style.marginTop = '18px';
		skip.style.background = 'transparent';
		skip.style.border = 'none';
		skip.style.cursor = 'pointer';
		skip.style.fontSize = '13px';
		skip.style.opacity = '0.65';
		skip.style.color = 'var(--vscode-foreground, #cccccc)';
		skip.style.fontFamily = 'inherit';
		skip.style.textDecoration = 'underline';
		skip.onmouseenter = () => { skip.style.opacity = '0.95'; };
		skip.onmouseleave = () => { skip.style.opacity = '0.65'; };
		skip.onclick = (e) => { e.stopPropagation(); this.continueWithoutSignIn(); };
		parent.appendChild(skip);
	}

	/** Persisted "the user opted to skip sign-in" flag. Read defensively so a
	 *  storage failure just means "not skipped". */
	private loginSkipped(): boolean {
		try { return localStorage.getItem(LOGIN_SKIPPED_FLAG) === '1'; } catch { return false; }
	}

	/** Whether the user has explicitly picked a Mode (vs. the config default). */
	private modeExplicitlyChosen(): boolean {
		try { return localStorage.getItem(MODE_CHOSEN_FLAG) === '1'; } catch { return false; }
	}

	/** "Continue without signing in": remember the choice and re-render so the
	 *  overlay proceeds to the AI/mode/project picker without a session. */
	private continueWithoutSignIn(): void {
		try { localStorage.setItem(LOGIN_SKIPPED_FLAG, '1'); } catch { /* ignore */ }
		this.guestMode = true;
		this.rerender();
	}

	private makeLoginButton(text: string, onClick: () => void): HTMLButtonElement {
		// Neutral, matching the Mode / Start cards - no brand accent colors.
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.style.width = '100%';
		btn.style.padding = '13px 16px';
		btn.style.fontSize = '14px';
		btn.style.fontWeight = '600';
		btn.style.cursor = 'pointer';
		btn.style.border = '1px solid rgba(127, 127, 127, 0.2)';
		btn.style.borderRadius = '6px';
		btn.style.background = 'rgba(127, 127, 127, 0.06)';
		btn.style.color = 'var(--vscode-foreground, #cccccc)';
		btn.style.fontFamily = 'inherit';
		btn.onmouseenter = () => { btn.style.background = 'rgba(127, 127, 127, 0.14)'; };
		btn.onmouseleave = () => { btn.style.background = 'rgba(127, 127, 127, 0.06)'; };
		btn.onclick = (e) => { e.stopPropagation(); onClick(); };
		return btn;
	}

	private renderSignedInBanner(parent: HTMLElement): void {
		const s = this.ariaSession;
		if (!s) {
			// Guest (chose "Continue without signing in"): a quiet banner that offers
			// to sign in, which returns to the login screen.
			const guest = document.createElement('div');
			guest.style.display = 'flex';
			guest.style.alignItems = 'center';
			guest.style.gap = '12px';
			guest.style.padding = '14px 18px';
			guest.style.marginBottom = '28px';
			guest.style.border = '1px solid rgba(127, 127, 127, 0.2)';
			guest.style.borderRadius = '6px';
			guest.style.background = 'rgba(127, 127, 127, 0.06)';

			const label = document.createElement('div');
			label.textContent = 'Using Qoka without signing in';
			label.style.fontSize = '13px';
			label.style.opacity = '0.7';
			guest.appendChild(label);

			const signIn = document.createElement('button');
			signIn.textContent = 'Sign in';
			signIn.style.marginLeft = 'auto';
			signIn.style.fontSize = '12.5px';
			signIn.style.padding = '6px 12px';
			signIn.style.cursor = 'pointer';
			signIn.style.borderRadius = '7px';
			signIn.style.border = '1px solid rgba(127, 127, 127, 0.35)';
			signIn.style.background = 'transparent';
			signIn.style.color = 'var(--vscode-foreground, #cccccc)';
			signIn.style.fontFamily = 'inherit';
			signIn.onclick = (e) => {
				e.stopPropagation();
				// Leave guest mode and forget the skip so the login screen shows.
				try { localStorage.removeItem(LOGIN_SKIPPED_FLAG); } catch { /* ignore */ }
				this.guestMode = false;
				this.rerender();
			};
			guest.appendChild(signIn);

			parent.appendChild(guest);
			return;
		}
		// Show the provider (google / orcid) after the name - the session itself has
		// no provider (scopes are []), so it comes from the extension via command.
		const name = (s.account?.label || 'Qoka user') + (this.ariaProvider ? ` (${this.ariaProvider})` : '');

		const banner = document.createElement('div');
		banner.style.display = 'flex';
		banner.style.alignItems = 'center';
		banner.style.gap = '12px';
		banner.style.padding = '14px 18px';
		banner.style.marginBottom = '28px';
		banner.style.border = '1px solid rgba(127, 127, 127, 0.2)';
		banner.style.borderRadius = '6px';
		banner.style.background = 'rgba(127, 127, 127, 0.06)';
		parent.appendChild(banner);

		const who = document.createElement('div');
		who.style.display = 'flex';
		who.style.flexDirection = 'column';
		who.style.gap = '2px';

		const nameEl = document.createElement('div');
		nameEl.style.fontSize = '14px';
		nameEl.style.fontWeight = '600';
		nameEl.textContent = name;
		who.appendChild(nameEl);

		const status = document.createElement('div');
		status.textContent = 'Signed in';
		status.style.fontSize = '12px';
		status.style.opacity = '0.6';
		who.appendChild(status);
		banner.appendChild(who);

		const out = document.createElement('button');
		out.textContent = 'Sign out';
		out.style.marginLeft = 'auto';
		out.style.fontSize = '12.5px';
		out.style.padding = '6px 12px';
		out.style.cursor = 'pointer';
		out.style.borderRadius = '7px';
		out.style.border = '1px solid rgba(127, 127, 127, 0.35)';
		out.style.background = 'transparent';
		out.style.color = 'var(--vscode-foreground, #cccccc)';
		out.style.fontFamily = 'inherit';
		out.onclick = (e) => { e.stopPropagation(); void this.signOut(); };
		banner.appendChild(out);
	}

	/** Whether the user clicked a mode card in THIS overlay session. Drives the card
	 *  highlight: nothing is selected on appear, but a clicked card stays highlighted
	 *  (survives the overlay's re-render on mode change). Resets with the window. */
	private _modePickedInPicker = false;

	private renderModeSection(parent: HTMLElement, currentMode: AriaMode): void {
		const heading = document.createElement('h2');
		heading.textContent = 'Mode';
		heading.style.fontSize = '16px';
		heading.style.fontWeight = '600';
		heading.style.margin = '0 0 12px 0';
		heading.style.opacity = '0.85';
		parent.appendChild(heading);

		const grid = document.createElement('div');
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = '1fr 1fr';
		grid.style.gap = '12px';
		grid.style.marginBottom = '12px';
		parent.appendChild(grid);

		const cards: { mode: 'easy' | 'advanced'; card: HTMLButtonElement }[] = [];
		// Paint one card as picked (blue) and the other neutral. NOTHING is painted
		// until the user picks in THIS overlay session (no pre-selection), but once
		// they click a card it highlights immediately for clear feedback.
		const paintSelection = (picked: 'easy' | 'advanced' | null): void => {
			for (const entry of cards) {
				const on = entry.mode === picked;
				entry.card.style.background = on
					? 'var(--vscode-button-background, rgba(0, 122, 204, 0.9))'
					: 'rgba(127, 127, 127, 0.06)';
				entry.card.style.color = on
					? 'var(--vscode-button-foreground, #fff)'
					: 'var(--vscode-foreground, #cccccc)';
			}
		};

		const makeCard = (mode: 'easy' | 'advanced', label: string, detail: string): void => {
			const card = document.createElement('button');
			card.style.display = 'flex';
			card.style.flexDirection = 'column';
			card.style.gap = '8px';
			card.style.padding = '16px 18px';
			card.style.border = '1px solid rgba(127, 127, 127, 0.2)';
			card.style.borderRadius = '6px';
			card.style.background = 'rgba(127, 127, 127, 0.06)';
			card.style.color = 'var(--vscode-foreground, #cccccc)';
			card.style.cursor = 'pointer';
			card.style.fontFamily = 'inherit';
			card.style.textAlign = 'left';
			card.style.transition = 'background 80ms ease, color 80ms ease';

			const titleEl = document.createElement('div');
			titleEl.textContent = label;
			titleEl.style.fontSize = '16px';
			titleEl.style.fontWeight = '600';
			card.appendChild(titleEl);

			const detailEl = document.createElement('span');
			detailEl.textContent = detail;
			detailEl.style.fontSize = '13px';
			detailEl.style.opacity = '0.85';
			card.appendChild(detailEl);

			card.onclick = (e) => {
				e.stopPropagation();
				// Highlight the clicked card at once (the reload into the project is
				// what actually applies the mode; this is immediate visual feedback).
				this._modePickedInPicker = true;
				paintSelection(mode);
				try { localStorage.setItem(MODE_CHOSEN_FLAG, '1'); } catch { /* ignore */ }
				void this.commandService.executeCommand(ARIA_SET_MODE_COMMAND, mode);
			};

			cards.push({ mode, card });
			grid.appendChild(card);
		};

		makeCard('easy', 'Easy', 'Simplified UI focused on chat and the research side panels.');
		makeCard('advanced', 'Advanced', 'Full IDE layout with drag-and-resize panels and every VS Code feature.');
		// Keep the picked highlight across the overlay's re-render (it re-renders when
		// the mode config changes); before any pick this session, both stay neutral.
		if (this._modePickedInPicker && (currentMode === 'easy' || currentMode === 'advanced')) {
			paintSelection(currentMode);
		}
	}

	private renderStartSection(parent: HTMLElement): void {
		const heading = document.createElement('h2');
		heading.textContent = 'Start';
		heading.style.fontSize = '16px';
		heading.style.fontWeight = '600';
		heading.style.margin = '32px 0 12px 0';
		heading.style.opacity = '0.85';
		parent.appendChild(heading);

		const row = document.createElement('div');
		row.style.display = 'grid';
		row.style.gridTemplateColumns = '1fr 1fr';
		row.style.gap = '12px';
		row.style.marginBottom = '24px';
		parent.appendChild(row);

		const makeCard = (label: string, detail: string, onclick: () => void): void => {
			const card = document.createElement('button');
			card.style.display = 'flex';
			card.style.flexDirection = 'column';
			card.style.gap = '6px';
			card.style.padding = '16px 18px';
			card.style.border = '1px solid rgba(127, 127, 127, 0.2)';
			card.style.borderRadius = '6px';
			card.style.background = 'rgba(127, 127, 127, 0.06)';
			card.style.color = 'var(--vscode-foreground, #cccccc)';
			card.style.cursor = 'pointer';
			card.style.fontFamily = 'inherit';
			card.style.textAlign = 'left';

			const titleEl = document.createElement('span');
			titleEl.textContent = label;
			titleEl.style.fontSize = '15px';
			titleEl.style.fontWeight = '600';
			card.appendChild(titleEl);

			const detailEl = document.createElement('span');
			detailEl.textContent = detail;
			detailEl.style.fontSize = '12.5px';
			detailEl.style.opacity = '0.75';
			card.appendChild(detailEl);

			card.onclick = (e) => {
				e.stopPropagation();
				onclick();
			};
			row.appendChild(card);
		};

		makeCard(
			'New Project',
			'Pick a location and name, then draft the roadmap in the new project.',
			() => {
				// New Project first creates+opens the project folder, then the
				// roadmap canvas auto-opens inside that window (see createNewProject).
				void this.createNewProject();
			},
		);

		makeCard(
			'Open Project...',
			'Browse for a folder on your machine.',
			() => {
				// Use the file dialog service directly so the user always
				// sees the OS folder picker, not the recent-folder quick
				// pick that the `workbench.action.files.openFolder`
				// command opens in some VS Code variants.
				void this.openFolderPicker();
			},
		);
	}

	/**
	 * Open an EXISTING project folder chosen from the picker (Open Project... or a
	 * recent entry). VS Code identifies a folder with exactly one window: opening a
	 * folder that is already open elsewhere focuses THAT window and leaves the
	 * window that triggered the open behind. Because this overlay only ever runs in
	 * an EMPTY window, that leftover is a blank shell with no folder and no chat
	 * (the "second window shows nothing" report). So when the folder is already
	 * open in another Qoka window, focus that window and close this redundant empty
	 * one - matching VS Code's native "reuse the existing window" behaviour. When
	 * the folder is not open anywhere, reuse THIS window as before.
	 */
	private async openExistingProject(folderUri: URI): Promise<void> {
		const nativeHost = this.nativeHost();
		const existingWindowId = nativeHost ? await this.findWindowWithFolder(nativeHost, folderUri) : undefined;
		if (nativeHost && existingWindowId !== undefined) {
			pushTrail(`openExistingProject: ${folderUri.fsPath} already open in window ${existingWindowId} -> focus it, close this empty window`);
			this.notificationService.notify({
				severity: Severity.Info,
				message: 'That project is already open in another window. Switched to it.',
			});
			try {
				await nativeHost.focusWindow({ targetWindowId: existingWindowId });
			} catch {
				// Best-effort focus; still close this redundant window below.
			}
			void this.hostService.close();
			return;
		}
		this.rememberPickedModeForFolder(folderUri);
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri }], { forceReuseWindow: true });
		});
	}

	/** Carry the mode the user picked in this (empty) overlay to the project we're
	 *  about to open. The picker window has no folder key of its own, so without this
	 *  the reload into the project would drop the choice and reopen in the project's
	 *  last-remembered / default mode. Saved under the target folder's key so
	 *  restoreFolderMode re-applies it. No-op when no explicit mode was picked. */
	private rememberPickedModeForFolder(folderUri: URI): void {
		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
		if (mode === 'easy' || mode === 'advanced') {
			void this.commandService.executeCommand(ARIA_REMEMBER_MODE_COMMAND, folderUri.toString(), mode);
		}
	}

	/** The desktop native-host service, or undefined on a build where it isn't
	 *  registered (e.g. web). Looked up lazily so this common-layer contribution
	 *  never hard-depends on a desktop-only service. */
	private nativeHost(): INativeHostService | undefined {
		return this.instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(INativeHostService);
			} catch {
				return undefined;
			}
		});
	}

	/** True when ANOTHER main window already has a project (folder / workspace) open.
	 *  An empty window appearing while such a window exists is an ADDITIONAL window
	 *  the user opened to pick something, so it shows the picker instead of auto-
	 *  reopening the most-recent project. */
	private async anotherProjectWindowOpen(): Promise<boolean> {
		const nativeHost = this.nativeHost();
		if (!nativeHost) { return false; }
		let windows: Array<{ readonly id: number; readonly workspace?: unknown }>;
		try {
			windows = await nativeHost.getWindows({ includeAuxiliaryWindows: false });
		} catch {
			return false;
		}
		const selfId = nativeHost.windowId;
		return windows.some(w => w.id !== selfId && !!w.workspace);
	}

	/** The id of another main window that already has `folderUri` open as its
	 *  single-folder workspace, or undefined when none does. */
	private async findWindowWithFolder(nativeHost: INativeHostService, folderUri: URI): Promise<number | undefined> {
		let windows: Array<{ readonly id: number; readonly workspace?: unknown }>;
		try {
			windows = await nativeHost.getWindows({ includeAuxiliaryWindows: false });
		} catch {
			return undefined;
		}
		const selfId = nativeHost.windowId;
		for (const w of windows) {
			if (w.id === selfId) {
				continue;
			}
			const ws = w.workspace;
			if (ws && isSingleFolderWorkspaceIdentifier(ws) && isEqual(ws.uri, folderUri)) {
				return w.id;
			}
		}
		return undefined;
	}

	private async openFolderPicker(): Promise<void> {
		const result = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Open Project',
			openLabel: 'Open',
		});
		if (!result || result.length === 0) {
			// User cancelled - keep the overlay up.
			return;
		}
		const folderUri = result[0];
		await this.openExistingProject(folderUri);
	}

	/** Where the New Project dialog should start: the user's Documents folder when
	 *  it exists, else their home directory. Never creates anything - it only picks a
	 *  neutral starting location so a new project is not nested in the open one. */
	private async newProjectDefaultDir(): Promise<URI> {
		const home = this.pathService.userHome({ preferLocal: true });
		const docs = URI.joinPath(home, 'Documents');
		try {
			const stat = await this.fileService.resolve(docs);
			if (stat.isDirectory) { return docs; }
		} catch { /* no Documents folder (e.g. minimal Linux) - fall back to home */ }
		return home;
	}

	/**
	 * New Project: let the user choose a location + folder name (one save
	 * dialog), create that folder with an empty `.aria/roadmap.json`, then open
	 * it. A one-shot flag makes the roadmap canvas auto-open in the new window,
	 * where the user drafts the roadmap with Claude Code.
	 */
	private async createNewProject(): Promise<void> {
		// Folder picker - the same dialog as Open Project. The native folder dialog
		// carries a built-in "New folder" button (showOpenDialog always adds the
		// 'createDirectory' property), so the user creates a fresh project folder
		// there and selects it. New vs Open differ by title, confirm label, and
		// what happens after: New scaffolds + seeds a roadmap, Open just opens.
		const result = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'New project - choose or create a folder',
			openLabel: 'Create project',
			// Start in the user's Documents folder (fallback: home) instead of the last
			// location, which was usually the currently open project - users then made a
			// project INSIDE another project. Nothing is created here: if Documents does
			// not exist (e.g. a minimal Linux install), we simply start at home.
			defaultUri: await this.newProjectDefaultDir(),
		});
		if (!result || result.length === 0) {
			// User cancelled - keep the overlay up.
			return;
		}
		// Plain file:// folder URI - the same shape openWindow gets for
		// recent / Open Project (which work).
		const folderUri = URI.file(result[0].fsPath);
		pushTrail(`createNewProject: target=${folderUri.fsPath}`);
		// Create the project FOLDER via the file service (main process): immediate
		// and reliable. Routing this through the aria-roadmap command instead meant
		// that on a FIRST launch the folder was created only AFTER that extension
		// finished ACTIVATING - a delay of seconds during which openWindow already
		// reloaded into an empty window and Started bounced back to the picker.
		// (After a sign-out the extension is already active, so it worked then.)
		try {
			// The folder already exists (picked, or made via the dialog's New
			// folder button); createFolder throws on an existing directory, so
			// only create it when it is somehow missing.
			if (!(await this.fileService.exists(folderUri))) {
				await this.fileService.createFolder(folderUri);
			}
			pushTrail('createNewProject: folder ready OK');
		} catch (e) {
			pushTrail(`createNewProject: createFolder FAILED - ${(e as Error).message}`);
			this.notificationService.notify({
				severity: Severity.Error,
				message: `Could not create the project: ${(e as Error).message}`,
			});
			return;
		}
		// Scaffold a friendly default folder layout so non-developer users have
		// an obvious place for each kind of file from the start. Best-effort:
		// never let this block the project from opening.
		await this.scaffoldProjectTemplate(folderUri);
		// Best-effort: seed a fresh empty roadmap so the new project starts blank.
		// Don't block the reload on it - the folder is all openWindow needs, and
		// aria-roadmap writes this when it activates in the new project window.
		void this.commandService.executeCommand('aria.roadmap.createEmptyAt', folderUri.fsPath);
		try {
			// Onboarding starts on the PROJECT OVERVIEW tab (name + description), which
			// then hands off to the Roadmap. So pulse the Overview icon on this New
			// Project reload - NOT the roadmap (the AI opens the roadmap later, via the
			// aria-overview `open_roadmap` tool). One-shot; a normal restore won't pulse.
			sessionStorage.setItem('aria.overview.pulseOnLoad', '1');
		} catch {
			// Storage unavailable - the user can still open the tabs from the sidebar.
		}
		pushTrail(`createNewProject: calling openWindow(forceReuseWindow) for ${folderUri.fsPath}`);
		this.rememberPickedModeForFolder(folderUri);
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri }], { forceReuseWindow: true });
		});
	}

	/**
	 * Create the default project folder layout inside a freshly created New
	 * Project folder. The top level holds only the user-facing files
	 * (data/, analysis/, results/); everything Qoka manages for you
	 * - the manuscripts you write, their reviews, the papers you save, and the
	 * notebook - lives under `.qoka/` so it never clutters the analysis view.
	 * Those `.qoka/` subfolders (manuscript/draft, manuscript/review,
	 * references, notebook) are created lazily by their features, so they are
	 * not pre-created here. All writes are best-effort and idempotent - a
	 * failure here must never prevent the project from opening.
	 */
	private async scaffoldProjectTemplate(folderUri: URI): Promise<void> {
		// The unified layout: data/ (inputs), analysis/ (code + pipeline code),
		// results/ (outputs). Scaffolded up front so the folders are there before the
		// first run. Keep this list and PROJECT_TEMPLATE_README in step with
		// aria-autopipe's ensureWorkspaceScaffold (both create the same three dirs).
		// 'notes' is intentionally NOT scaffolded: research notes now live inside the
		// Notebook tab at .qoka/notebook/notes, so a top-level notes/ folder would be
		// a confusing empty duplicate.
		const dirs = ['data', 'analysis', 'results', '.qoka'];
		for (const dir of dirs) {
			try {
				await this.fileService.createFolder(URI.joinPath(folderUri, dir));
			} catch { /* best-effort */ }
		}
		try {
			const readme = URI.joinPath(folderUri, 'README.md');
			if (!(await this.fileService.exists(readme))) {
				await this.fileService.writeFile(readme, VSBuffer.fromString(PROJECT_TEMPLATE_README));
			}
		} catch { /* best-effort */ }
		try {
			const marker = URI.joinPath(folderUri, '.qoka', 'project.json');
			if (!(await this.fileService.exists(marker))) {
				const body = JSON.stringify({ createdBy: 'qoka', template: 'default', version: 1 }, null, 2) + '\n';
				await this.fileService.writeFile(marker, VSBuffer.fromString(body));
			}
		} catch { /* best-effort */ }
	}

	private async renderRecentProjects(parent: HTMLElement): Promise<void> {
		const heading = document.createElement('h3');
		heading.textContent = 'Recent projects';
		heading.style.fontSize = '14px';
		heading.style.fontWeight = '600';
		heading.style.margin = '0 0 8px 0';
		heading.style.opacity = '0.8';
		parent.appendChild(heading);

		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			return;
		}

		// Drop recents whose folder/workspace no longer exists on disk (deleted
		// locally). VS Code keeps these around on purpose, but here we prune
		// them so the picker never offers a project that can't open. Runs on
		// every render, so it stays current as the overlay is reopened. Only
		// `file` paths are checked - remote/unmounted schemes are left as-is to
		// avoid false positives when a drive is temporarily unavailable.
		const withUris = recents.workspaces
			.map(item => ({
				item,
				uri: isRecentFolder(item)
					? item.folderUri
					: isRecentWorkspace(item)
						? item.workspace.configPath
						: undefined,
			}))
			.filter((x): x is { item: typeof x.item; uri: URI } => !!x.uri);

		const exists = await Promise.all(withUris.map(async x => {
			if (x.uri.scheme !== 'file') {
				return true;
			}
			try {
				return await this.fileService.exists(x.uri);
			} catch {
				return true; // on a check error, keep the entry rather than lose it
			}
		}));

		const missing = withUris.filter((_, i) => !exists[i]).map(x => x.uri);
		if (missing.length) {
			void this.workspacesService.removeRecentlyOpened(missing);
		}

		const all = withUris.filter((_, i) => exists[i]).map(x => x.item);
		if (all.length === 0) {
			const empty = document.createElement('p');
			empty.textContent = 'No recent projects yet.';
			empty.style.opacity = '0.5';
			empty.style.fontSize = '13px';
			empty.style.padding = '6px 12px';
			parent.appendChild(empty);
			return;
		}

		const VISIBLE_LIMIT = 5;
		const items = all.slice(0, VISIBLE_LIMIT);

		const list = document.createElement('div');
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '2px';
		parent.appendChild(list);

		for (const item of items) {
			const uri: URI | undefined = isRecentFolder(item)
				? item.folderUri
				: isRecentWorkspace(item)
					? item.workspace.configPath
					: undefined;
			if (!uri) {
				continue;
			}
			const name = basename(uri) || uri.fsPath;
			const path = uri.fsPath;

			const btn = document.createElement('button');
			btn.style.display = 'flex';
			btn.style.alignItems = 'center';
			btn.style.gap = '10px';
			btn.style.padding = '8px 12px';
			btn.style.background = 'transparent';
			btn.style.border = 'none';
			btn.style.color = 'var(--vscode-foreground, #cccccc)';
			btn.style.cursor = 'pointer';
			btn.style.fontFamily = 'inherit';
			btn.style.fontSize = '13px';
			btn.style.textAlign = 'left';
			btn.style.borderRadius = '4px';

			const nameEl = document.createElement('span');
			nameEl.textContent = name;
			nameEl.style.fontWeight = '500';
			btn.appendChild(nameEl);

			const pathEl = document.createElement('span');
			pathEl.textContent = path;
			pathEl.style.opacity = '0.55';
			pathEl.style.fontSize = '12px';
			pathEl.style.marginLeft = '6px';
			pathEl.style.overflow = 'hidden';
			pathEl.style.textOverflow = 'ellipsis';
			pathEl.style.whiteSpace = 'nowrap';
			btn.appendChild(pathEl);

			btn.title = path;
			btn.onclick = (e) => {
				e.stopPropagation();
				void this.openExistingProject(uri);
			};

			list.appendChild(btn);
		}
	}

	private installFocusTrap(overlay: HTMLDivElement): void {
		const swallow = (e: Event) => {
			// Inside the overlay → normal click/key handling.
			if (overlay.contains(e.target as Node)) {
				return;
			}
			// Block anything that leaks past the overlay.
			e.stopPropagation();
			e.preventDefault();
		};
		overlay.addEventListener('keydown', swallow, true);
		overlay.addEventListener('click', swallow, true);
	}
}

// Register at `Restored` - the same phase firstRunOverlay uses and
// is known to fully resolve every service we inject. Earlier phases
// (`Starting`, `Ready`) silently dropped the contribution because
// IWorkspacesService / IFileDialogService were not yet instantiated.
// The flash that previously made Restored unusable is now prevented
// by the early hide-workbench stylesheet installed at module-load
// time above - so we get late-but-reliable construction without the
// bare-workbench flicker.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaStartedOverlayContribution, LifecyclePhase.Restored);
