/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { SettingsSection } from './settingsSection.js';

interface BioRenderStatus { connected?: boolean; account?: string }

/**
 * BioRender section: connect the user's own BioRender account so the chat can
 * search icons/templates and generate figures as that account. The BioRender MCP
 * is a built-in Qoka server; only the login lives here. Connect runs the AI CLI's
 * own OAuth (aria.biorender.login -> `claude mcp login`), which opens the browser
 * once. The status dot + button update IN PLACE (the row is not torn down and
 * rebuilt), and the status loads asynchronously so opening Settings is instant.
 */
export class BioRenderSection extends SettingsSection {

	private dot: HTMLElement | undefined;
	private label: HTMLElement | undefined;
	private button: HTMLButtonElement | undefined;
	private errEl: HTMLElement | undefined;
	private busy = false;

	async refresh(): Promise<void> {
		clearNode(this.body);
		this.busy = false;

		const note = append(this.body, $('div'));
		note.textContent = 'Connect your BioRender account to search icons and templates and generate figures from chat. Connect opens BioRender in your browser once; Qoka never sees your password.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px', lineHeight: '1.5' });

		// Build the row ONCE; connect/disconnect update it in place (no teardown).
		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '3px 0' });
		const dot = append(row, $('span'));
		Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0' });
		this.dot = dot;
		const label = append(row, $('span'));
		Object.assign(label.style, { flex: '1', minWidth: '0' });
		this.label = label;
		const button = append(row, $('button')) as HTMLButtonElement;
		this.button = button;
		this.errEl = append(this.body, $('div'));
		Object.assign(this.errEl.style, { fontSize: '11px', color: 'var(--vscode-errorForeground)', marginTop: '6px' });
		this.errEl.hidden = true;

		// Show a "checking" state instantly, then update once the (slow) CLI status returns.
		this.apply({ connected: false }, true);
		void this.loadAndApply();
	}

	private async loadAndApply(): Promise<void> {
		let status: BioRenderStatus = { connected: false };
		try { status = (await this.commandService.executeCommand<BioRenderStatus>('aria.biorender.getStatus')) ?? { connected: false }; } catch { /* offline */ }
		this.apply(status, false);
	}

	/** Update the dot colour, label, and button in place. `checking` shows a
	 *  transient "checking…" state while the first status call is in flight. */
	private apply(status: BioRenderStatus, checking: boolean): void {
		const dot = this.dot, label = this.label, button = this.button;
		if (!dot || !label || !button) { return; }
		if (checking) {
			dot.style.background = 'var(--vscode-charts-yellow, #e6c200)';
			label.textContent = 'BioRender: checking...';
			button.textContent = 'Connect to BioRender';
			this.primaryButton(button);
			button.disabled = true;
			return;
		}
		if (status.connected) {
			dot.style.background = 'var(--vscode-charts-green, #4caf50)';
			label.textContent = status.account ? `BioRender: connected as ${status.account}` : 'BioRender: connected';
			button.textContent = 'Disconnect';
			this.secondaryButton(button);
			button.disabled = false;
			button.onclick = () => void this.run('disconnect');
		} else {
			dot.style.background = 'var(--vscode-charts-yellow, #e6c200)';
			label.textContent = 'BioRender: not connected';
			button.textContent = 'Connect to BioRender';
			this.primaryButton(button);
			button.disabled = false;
			button.onclick = () => void this.run('connect');
		}
	}

	private async run(kind: 'connect' | 'disconnect'): Promise<void> {
		const button = this.button;
		if (!button || this.busy) { return; }
		this.busy = true;
		if (this.errEl) { this.errEl.hidden = true; }
		button.disabled = true;
		button.textContent = kind === 'connect' ? 'Connecting...' : 'Disconnecting...';
		try {
			if (kind === 'connect') {
				const r = await this.commandService.executeCommand<{ ok?: boolean; message?: string }>('aria.biorender.login');
				if (r && r.ok === false && this.errEl) { this.errEl.textContent = r.message ?? 'BioRender login failed.'; this.errEl.hidden = false; }
			} else {
				await this.commandService.executeCommand('aria.biorender.logout');
			}
		} catch { /* handled by status refresh */ }
		this.busy = false;
		// Re-read status and update in place - this also re-enables the button, so a
		// cancelled login can simply be retried by clicking Connect again.
		await this.loadAndApply();
	}

	private primaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		});
	}
	private secondaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
			color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
		});
	}
}
