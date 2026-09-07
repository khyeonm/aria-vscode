/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { localize2 } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaManuscriptView } from './ariaManuscriptView.js';
import { AriaFiguresView } from './ariaFiguresView.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';

// The consolidated "Manuscript" tab merges the old Paper Writing and Peer Review
// tabs: one sidebar list where the "+" chooses whether to start writing a paper or
// to run a peer review, and a paper you have written can flow straight into review.
// The editor panes, inputs and `aria.paperWriter.*` / `aria.peerReview.*` commands
// still live in their original contributions (which keep them registered); only the
// two sidebar tabs are replaced by this single one.

const MANUSCRIPT_CONTAINER_ID = 'workbench.view.ariaManuscript';

// A small stack of manuscript pages: the front page (drawn last) is a clean sheet
// with a folded top-right corner (dog-ear); two more pages peek out to the lower
// left. The back pages are drawn as partial outlines that stop where the front page
// covers them, so no lines cross through it - it reads as the top sheet sitting on
// top (an opaque "white" page) even though the activity bar masks the glyph to a
// single theme colour. Inlined as a data: URI, so there is no media file.
const MANUSCRIPT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(11.75 12) scale(1.22) translate(-11.75 -12)"><path d="M6 8 H5 Q3.5 8 3.5 9.5 V19.5 Q3.5 21 5 21 H13.5 Q15 21 15 19.5 V18.5"/><path d="M8.5 5.5 H7.5 Q6 5.5 6 7 V17 Q6 18.5 7.5 18.5 H16 Q17.5 18.5 17.5 17 V16"/><path d="M8.5 4.5 Q8.5 3 10 3 H17 L20 6 V14.5 Q20 16 18.5 16 H10 Q8.5 16 8.5 14.5 V4.5 Z"/><path d="M17 3 V6 H20"/></g></svg>';
const manuscriptContainerIcon = URI.parse(`data:image/svg+xml,${encodeURIComponent(MANUSCRIPT_ICON_SVG)}`);

const manuscriptContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: MANUSCRIPT_CONTAINER_ID,
		title: localize2('aria.manuscript.containerTitle', "Manuscript"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MANUSCRIPT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: manuscriptContainerIcon,
		// Takes the slot the old Paper Writing tab used, keeping the Qoka group order.
		order: 16,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const manuscriptView: IViewDescriptor = {
	id: AriaManuscriptView.ID,
	name: localize2('aria.manuscript.viewName', "Manuscript"),
	containerIcon: manuscriptContainerIcon,
	ctorDescriptor: new SyncDescriptor(AriaManuscriptView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

// Figures: a SEPARATE collapsible view under Manuscript (like the Analysis tab's
// Changes/Snapshots), showing the generated figures kept in .qoka/figures.
const figuresView: IViewDescriptor = {
	id: AriaFiguresView.ID,
	name: localize2('aria.figures.viewName', "Figures"),
	ctorDescriptor: new SyncDescriptor(AriaFiguresView),
	canToggleVisibility: true,
	canMoveView: false,
	order: 2,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([manuscriptView, figuresView], manuscriptContainer);

// "How to use?" link in the view's title bar.
registerAriaTabHelpTitleAction(AriaManuscriptView.ID, 'manuscript');

/**
 * One-time move of the old top-level storage into `.qoka/` so existing projects keep
 * their papers, reviews and saved references after the layout change:
 *   paper/      -> .qoka/manuscript/draft/
 *   reviews/    -> .qoka/manuscript/review/
 *   references/ -> .qoka/references/
 * Idempotent (skips when the source is gone or the target already exists) and
 * best-effort: a failure must never block the project from opening.
 */
class AriaManuscriptLayoutMigration extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.manuscriptLayoutMigration';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		void this.run();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.run()));
	}

	private async run(): Promise<void> {
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			await this.migrate(folder.uri);
		}
	}

	private async migrate(root: URI): Promise<void> {
		const qoka = joinPath(root, '.qoka');
		await this.consolidate(joinPath(root, 'paper'), joinPath(qoka, 'manuscript', 'draft'));
		await this.consolidate(joinPath(root, 'reviews'), joinPath(qoka, 'manuscript', 'review'));
		await this.consolidate(joinPath(root, 'references'), joinPath(qoka, 'references'));
	}

	/**
	 * Move `from` into `to`. If `to` does not exist, move the whole folder in one
	 * shot. If it does (a feature auto-created an empty one, e.g. the library file
	 * before this ran), move each missing child in, keep the non-empty library, and
	 * drop the now-empty source - so an existing project ends with a single copy
	 * under `.qoka/` and the old top-level folder disappears.
	 */
	private async consolidate(from: URI, to: URI): Promise<void> {
		try {
			if (!(await this.fileService.exists(from))) { return; }
			if (!(await this.fileService.exists(to))) {
				await this.fileService.createFolder(dirname(to));
				await this.fileService.move(from, to, false);
				return;
			}
			const stat = await this.fileService.resolve(from);
			for (const child of stat.children ?? []) {
				const dest = joinPath(to, child.name);
				if (await this.fileService.exists(dest)) {
					// The one file both sides can legitimately have: keep the real one.
					if (child.name === 'paper-library.json') {
						await this.mergeLibrary(child.resource, dest);
						try { await this.fileService.del(child.resource, { useTrash: false }); } catch { /* leave it */ }
					}
					continue;
				}
				try { await this.fileService.move(child.resource, dest, false); } catch { /* skip a locked child */ }
			}
			// Remove the source once everything moved out, so the old top-level folder
			// no longer shows in the Explorer.
			try {
				const left = await this.fileService.resolve(from);
				if (!(left.children?.length)) { await this.fileService.del(from, { recursive: true, useTrash: false }); }
			} catch { /* leave leftovers rather than fail */ }
		} catch { /* best-effort: never block startup */ }
	}

	/** When both sides have a library, keep the source's papers only if the target's
	 *  is empty (the target was just auto-created). Never drops saved papers. */
	private async mergeLibrary(src: URI, dest: URI): Promise<void> {
		try {
			const read = async (u: URI): Promise<{ papers?: unknown[] } | undefined> => {
				try { return JSON.parse((await this.fileService.readFile(u)).value.toString()); } catch { return undefined; }
			};
			const s = await read(src);
			const d = await read(dest);
			const sPapers = Array.isArray(s?.papers) ? s!.papers! : [];
			const dPapers = Array.isArray(d?.papers) ? d!.papers! : [];
			if (dPapers.length === 0 && sPapers.length > 0) {
				await this.fileService.writeFile(dest, VSBuffer.fromString(JSON.stringify(s, null, 2) + '\n'));
			}
		} catch { /* best-effort */ }
	}
}

// NOTE: must be LifecyclePhase.Restored (or Eventually) - the deprecated
// registerWorkbenchContribution() maps the phase through toWorkbenchPhase(), which
// ONLY handles Restored/Eventually and returns undefined for Ready, so a Ready-phase
// contribution is registered but never instantiated (the migration would silently
// never run).
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaManuscriptLayoutMigration, LifecyclePhase.Restored);
