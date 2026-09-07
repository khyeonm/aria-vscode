/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AriaPeerReviewEditorPane } from './ariaPeerReviewEditorPane.js';
import { AriaPeerReviewInput } from './ariaPeerReviewInput.js';

// The Peer Review sidebar tab was merged into the consolidated "Manuscript" tab
// (see ariaManuscript.contribution). This file keeps registering the review editor
// pane, input and `aria.peerReview.*` commands - only the sidebar container/view
// moved - so the Manuscript list, the Paper Writing handoff and the MCP tools keep
// working.

// --- Editor pane ------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaPeerReviewEditorPane,
		AriaPeerReviewEditorPane.ID,
		localize2('aria.peerReview.editorPaneName', "Peer Review").value
	),
	[
		new SyncDescriptor(AriaPeerReviewInput)
	]
);

// --- Commands ---------------------------------------------------------------

// Create the review folder (a "draft" meta.json) up front so the new review shows
// in the Manuscript list immediately, not only after it starts. Reused by start.
async function createDraftReview(fileService: IFileService, workspaceContextService: IWorkspaceContextService, title: string, paperId: string | undefined): Promise<string | undefined> {
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return undefined; }
	const execId = 'rev-' + generateUuid().slice(0, 8);
	const dir = joinPath(folder.uri, '.qoka', 'manuscript', 'review', execId);
	await fileService.createFolder(dir);
	const meta = { execId, title, reviewers: [] as string[], createdAt: new Date().toISOString(), iteration: 1, draft: true, ...(paperId ? { paperId } : {}) };
	await fileService.writeFile(joinPath(dir, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
	return execId;
}

CommandsRegistry.registerCommand('aria.peerReview.new', async (accessor) => {
	const editorService = accessor.get(IEditorService);
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	// Reuse an existing UNSTARTED "New review" tab if one is open: focus it instead
	// of spawning a second empty tab. Otherwise a repeat open_new_review (or +New)
	// creates a fresh empty tab that becomes active and clobbers the source/files the
	// user already picked - so start_peer_review then sees "no draft".
	const folder = workspaceContextService.getWorkspace().folders[0];
	for (const input of editorService.editors.filter((i): i is AriaPeerReviewInput => i instanceof AriaPeerReviewInput)) {
		if (!input.execId || !folder) { continue; }
		try {
			const raw = await fileService.readFile(joinPath(folder.uri, '.qoka', 'manuscript', 'review', input.execId, 'meta.json'));
			if ((JSON.parse(raw.value.toString()) as { draft?: boolean }).draft === true) {
				await editorService.openEditor(input, { pinned: true });
				return;
			}
		} catch { /* meta unreadable; keep looking */ }
	}
	const execId = await createDraftReview(fileService, workspaceContextService, localize('aria.peerReview.newReviewTitle', "New review"), undefined);
	await editorService.openEditor(new AriaPeerReviewInput(execId), { pinned: true });
});

// Handoff from Paper Writing: open a NEW review with the given paper pre-selected as
// the source (the pane reads seedPaperId and switches to the "manuscript" source).
CommandsRegistry.registerCommand('aria.peerReview.newForPaper', async (accessor, paperId?: unknown) => {
	const seed = typeof paperId === 'string' && paperId ? paperId : undefined;
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	// Title the draft after the paper so the Manuscript list row is recognizable.
	let title = localize('aria.peerReview.newReviewTitle', "New review");
	if (seed) {
		const folder = workspaceContextService.getWorkspace().folders[0];
		if (folder) {
			try {
				const raw = await fileService.readFile(joinPath(folder.uri, '.qoka', 'manuscript', 'draft', seed, 'meta.json'));
				const t = (JSON.parse(raw.value.toString()) as { title?: unknown }).title;
				if (typeof t === 'string' && t.trim()) { title = t.trim(); }
			} catch { /* keep the default title */ }
		}
	}
	const execId = await createDraftReview(fileService, workspaceContextService, title, seed);
	await editorService.openEditor(new AriaPeerReviewInput(execId, seed), { pinned: true });
});

// List the Peer Review windows currently OPEN (started runs AND unstarted "new
// review" tabs), so the chat can reuse an open one instead of opening another.
CommandsRegistry.registerCommand('aria.peerReview.listOpen', async (accessor) => {
	const editorService = accessor.get(IEditorService);
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	const inputs = editorService.editors.filter((i): i is AriaPeerReviewInput => i instanceof AriaPeerReviewInput);
	const out: { execId: string | null; title: string; started: boolean }[] = [];
	for (const input of inputs) {
		// A draft (unstarted "New review") now has an execId + folder too, so read its
		// meta.draft to tell the chat whether it still needs start_peer_review.
		let started = false;
		if (input.execId && folder) {
			try {
				const raw = await fileService.readFile(joinPath(folder.uri, '.qoka', 'manuscript', 'review', input.execId, 'meta.json'));
				started = (JSON.parse(raw.value.toString()) as { draft?: boolean }).draft !== true;
			} catch { started = false; }
		}
		out.push({ execId: input.execId ?? null, title: input.getName(), started });
	}
	return out;
});

// Start the review from the CURRENTLY-open new-review form (source + reviewers the
// user picked). Triggered by the chat's start_peer_review tool - there is no button.
// Returns the execId so the tool can tell the AI which run to drive.
CommandsRegistry.registerCommand('aria.peerReview.runActive', async (accessor) => {
	const editorService = accessor.get(IEditorService);
	// Prefer the active editor; fall back to any VISIBLE review pane, so a review
	// started from the chat still finds the form even when the editor is not the
	// focused pane (the chat panel took focus).
	let pane: unknown = editorService.activeEditorPane;
	if (!(pane instanceof AriaPeerReviewEditorPane)) {
		pane = editorService.visibleEditorPanes.find(p => p instanceof AriaPeerReviewEditorPane);
	}
	if (pane instanceof AriaPeerReviewEditorPane) {
		return pane.runFromForm();
	}
	return undefined;
});

CommandsRegistry.registerCommand('aria.peerReview.open', async (accessor, execId?: unknown) => {
	if (typeof execId !== 'string' || !execId) { return; }
	await accessor.get(IEditorService).openEditor(new AriaPeerReviewInput(execId), { pinned: true });
});

CommandsRegistry.registerCommand('aria.peerReview.delete', async (accessor, execId?: unknown) => {
	if (typeof execId !== 'string' || !execId) { return; }
	const dialogService = accessor.get(IDialogService);
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return; }
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: localize('aria.peerReview.deleteConfirm', "Delete this review?"),
		detail: localize('aria.peerReview.deleteDetail', "This moves the review folder to the trash."),
		primaryButton: localize('aria.peerReview.deleteButton', "Delete"),
	});
	if (!confirmed) { return; }
	const dir = joinPath(folder.uri, '.qoka', 'manuscript', 'review', execId);
	try { await fileService.del(dir, { useTrash: true, recursive: true }); }
	catch { await fileService.del(dir, { useTrash: false, recursive: true }); }
	// Close its open tab so a deleted review doesn't leave a stale tab behind.
	for (const group of editorGroupsService.groups) {
		for (const editor of group.editors) {
			if (editor instanceof AriaPeerReviewInput && editor.execId === execId) { void group.closeEditor(editor); }
		}
	}
});
