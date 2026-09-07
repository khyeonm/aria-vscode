/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isEqual } from '../../../../base/common/resources.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AriaPaperWriterEditorPane } from './ariaPaperWriterEditorPane.js';
import { AriaPaperWriterInput } from './ariaPaperWriterInput.js';
import { AriaManuscriptReviewEditorPane } from './ariaManuscriptReviewEditorPane.js';
import { AriaManuscriptReviewInput } from './ariaManuscriptReviewInput.js';

// The Paper Writing sidebar tab was merged into the consolidated "Manuscript" tab
// (see ariaManuscript.contribution). This file keeps registering the paper-writing
// editor panes, inputs and `aria.paperWriter.*` commands - only the sidebar
// container/view moved - so the Manuscript list and the MCP tools keep working.

// --- Editor pane (paper setup form) -----------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaPaperWriterEditorPane,
		AriaPaperWriterEditorPane.ID,
		localize2('aria.paperWriter.editorPaneName', "Paper Writing").value
	),
	[
		new SyncDescriptor(AriaPaperWriterInput)
	]
);

// --- Editor pane (manuscript revision review) -------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaManuscriptReviewEditorPane,
		AriaManuscriptReviewEditorPane.ID,
		localize2('aria.manuscriptReview.editorPaneName', "Manuscript Review").value
	),
	[
		new SyncDescriptor(AriaManuscriptReviewInput)
	]
);

// A staged revision is now reviewed INLINE in the Paper Writer tab (Write step,
// Source view), not in a separate Manuscript Review tab. Open/focus the Paper
// Writer for this paper so the inline review shows.
CommandsRegistry.registerCommand('aria.paperWriter.openReview', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	await accessor.get(IEditorService).openEditor(new AriaPaperWriterInput(uri), { pinned: true });
});

// --- Commands ---------------------------------------------------------------

function reviveUri(resource: unknown): URI | undefined {
	if (!resource) { return undefined; }
	return URI.isUri(resource) ? resource : URI.revive(resource as never);
}

CommandsRegistry.registerCommand('aria.paperWriter.new', async (accessor) => {
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return; }
	const id = 'paper-' + generateUuid().slice(0, 8);
	const dir = joinPath(folder.uri, '.qoka', 'manuscript', 'draft', id);
	await fileService.createFolder(dir);
	const now = new Date().toISOString();
	const meta = {
		id,
		title: 'Untitled paper',
		format: { paperType: 'research-article', targetWords: 4000, citationStyle: 'ieee', language: 'en' },
		outline: [] as unknown[],
		createdAt: now,
		updatedAt: now,
	};
	await fileService.writeFile(joinPath(dir, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
	await fileService.writeFile(joinPath(dir, 'manuscript.md'), VSBuffer.fromString(''));
	await fileService.writeFile(joinPath(dir, 'citations.csl.json'), VSBuffer.fromString('[]\n'));
	await editorService.openEditor(new AriaPaperWriterInput(dir), { pinned: true });
});

CommandsRegistry.registerCommand('aria.paperWriter.open', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	await accessor.get(IEditorService).openEditor(new AriaPaperWriterInput(uri), { pinned: true });
});

CommandsRegistry.registerCommand('aria.paperWriter.delete', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	// Capture services BEFORE the await - the accessor is only valid synchronously.
	const dialogService = accessor.get(IDialogService);
	const fileService = accessor.get(IFileService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: localize('aria.paperWriter.deleteConfirm', "Delete this paper?"),
		detail: localize('aria.paperWriter.deleteDetail', "This moves the paper folder to the trash."),
		primaryButton: localize('aria.paperWriter.deleteButton', "Delete"),
	});
	if (!confirmed) { return; }
	try {
		await fileService.del(uri, { useTrash: true, recursive: true });
	} catch {
		await fileService.del(uri, { useTrash: false, recursive: true });
	}
	// Close its open tabs (the writer AND any manuscript-review tab for it), so a
	// deleted paper doesn't leave a stale "Untitled paper" tab behind.
	for (const group of editorGroupsService.groups) {
		for (const editor of group.editors) {
			const folder = (editor instanceof AriaPaperWriterInput || editor instanceof AriaManuscriptReviewInput) ? editor.folderResource : undefined;
			if (folder && isEqual(folder, uri)) { void group.closeEditor(editor); }
		}
	}
});
