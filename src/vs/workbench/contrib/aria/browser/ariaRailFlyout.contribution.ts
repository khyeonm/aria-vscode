/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ARIA_MODE_SETTING } from '../common/ariaConfiguration.js';

/**
 * Easy-mode activity-bar hover flyout. At rest the rail stays the normal ~48px
 * icon strip; hovering it slides a labelled panel out to the right as a floating
 * OVERLAY (mounted on the workbench root) that covers the sidebar/editor beneath
 * without reflowing anything. Each row is an icon + the tab's name; clicking one
 * opens that tab and collapses the flyout. Only active in `aria.mode == easy`.
 */
export class AriaRailFlyoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.railFlyout';

	private readonly modeDisposables = this._register(new DisposableStore());
	private readonly openScheduler = this._register(new MutableDisposable());
	private readonly closeScheduler = this._register(new MutableDisposable());

	private overlay: HTMLElement | undefined;
	private rowsContainer: HTMLElement | undefined;
	private isOpen = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.applyMode();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.applyMode();
			}
		}));
	}

	private applyMode(): void {
		this.modeDisposables.clear();
		this.isOpen = false;
		this.overlay = undefined;
		this.rowsContainer = undefined;
		if (this.configurationService.getValue(ARIA_MODE_SETTING) === 'easy') {
			this.setup();
		}
	}

	private rail(): HTMLElement | undefined {
		return this.layoutService.getContainer(mainWindow, Parts.ACTIVITYBAR_PART);
	}

	private setup(): void {
		const rail = this.rail();
		if (!rail) {
			return;
		}

		const overlay = $('.aria-rail-flyout');
		Object.assign(overlay.style, {
			position: 'absolute', zIndex: '2500', width: '210px', boxSizing: 'border-box',
			overflowX: 'hidden', overflowY: 'auto',
			background: 'var(--vscode-activityBar-background, var(--vscode-sideBar-background))',
			boxShadow: '2px 0 14px rgba(0,0,0,0.30)',
			opacity: '0', pointerEvents: 'none', transform: 'translateX(-6px)',
			transition: 'opacity 120ms ease, transform 120ms ease',
		});
		this.rowsContainer = append(overlay, $('.aria-rail-flyout-rows'));
		// No padding: rows start at the rail's top edge so each icon lines up with
		// the real rail icon beneath it. Full height so Settings can sit at the bottom.
		Object.assign(this.rowsContainer.style, { display: 'flex', flexDirection: 'column', height: '100%' });

		this.layoutService.mainContainer.appendChild(overlay);
		this.overlay = overlay;
		this.modeDisposables.add({ dispose: () => overlay.remove() });

		this.position();

		// Hover intent: open on rail hover, keep open while over the overlay.
		this.modeDisposables.add(addDisposableListener(rail, EventType.MOUSE_ENTER, () => this.scheduleOpen()));
		this.modeDisposables.add(addDisposableListener(rail, EventType.MOUSE_LEAVE, () => this.scheduleClose()));
		this.modeDisposables.add(addDisposableListener(overlay, EventType.MOUSE_ENTER, () => this.closeScheduler.clear()));
		this.modeDisposables.add(addDisposableListener(overlay, EventType.MOUSE_LEAVE, () => this.scheduleClose()));

		// Collapse once a tab is chosen; keep aligned on layout changes.
		this.modeDisposables.add(this.paneCompositeService.onDidPaneCompositeOpen(() => this.close()));
		this.modeDisposables.add(this.layoutService.onDidLayoutMainContainer(() => this.position()));
	}

	private position(): void {
		const rail = this.rail();
		if (!this.overlay || !rail) {
			return;
		}
		const railRect = rail.getBoundingClientRect();
		const rootRect = this.layoutService.mainContainer.getBoundingClientRect();
		Object.assign(this.overlay.style, {
			top: `${railRect.top - rootRect.top}px`,
			left: `${railRect.left - rootRect.left}px`,
			height: `${railRect.height}px`,
		});
	}

	private scheduleOpen(): void {
		this.closeScheduler.clear();
		this.openScheduler.value = disposableTimeout(() => this.open(), 90);
	}

	private scheduleClose(): void {
		this.openScheduler.clear();
		this.closeScheduler.value = disposableTimeout(() => this.close(), 150);
	}

	private open(): void {
		if (!this.overlay || this.isOpen) {
			return;
		}
		this.buildRows();
		this.position();
		this.isOpen = true;
		Object.assign(this.overlay.style, { opacity: '1', pointerEvents: 'auto', transform: 'translateX(0)' });
	}

	private close(): void {
		if (!this.overlay || !this.isOpen) {
			return;
		}
		this.isOpen = false;
		Object.assign(this.overlay.style, { opacity: '0', pointerEvents: 'none', transform: 'translateX(-6px)' });
	}

	private buildRows(): void {
		const container = this.rowsContainer;
		if (!container) {
			return;
		}
		clearNode(container);

		const ids = this.paneCompositeService.getVisiblePaneCompositeIds(ViewContainerLocation.Sidebar);
		const activeId = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();

		for (const id of ids) {
			// Global full-text Search is hidden from the activity bar in easy mode
			// (developer chrome), so it must not appear in the hover flyout either.
			if (id === 'workbench.view.search') { continue; }
			// The Claude Code extension's left-sidebar icon is hidden in easy mode (the
			// chat lives in the right Secondary Side Bar), so it must not resurface in
			// the hover flyout. Matches its containers (workbench.view.extension.claude-*).
			if (id.toLowerCase().includes('claude')) { continue; }
			const viewContainer = this.viewDescriptorService.getViewContainerById(id);
			const model = viewContainer ? this.viewDescriptorService.getViewContainerModel(viewContainer) : undefined;
			this.addRow(container, model?.title ?? id, model?.icon, id === activeId, () => {
				// Toggle: clicking the row for the tab that is ALREADY open (sidebar
				// visible + this container active) hides the sidebar, matching the real
				// activity bar's default click behaviour. Otherwise open/focus it.
				const sidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
				const isActive = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === id;
				if (sidebarVisible && isActive) {
					this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
				} else {
					void this.paneCompositeService.openPaneComposite(id, ViewContainerLocation.Sidebar, true);
				}
				this.close();
			});
		}
		// The Settings row was removed: Settings stays reachable from the activity-bar
		// gear and the standard keybinding, so the flyout only lists the project tabs.
	}

	/**
	 * Append one flyout row sized to match the activity-bar rail: a fixed icon
	 * column the width of the rail (so the icon sits exactly over the real rail
	 * icon) and a row height equal to the rail's action height, then the label.
	 */
	private addRow(container: HTMLElement, name: string, icon: URI | ThemeIcon | undefined, isActive: boolean, onClick: () => void): void {
		const row = append(container, $('.aria-rail-flyout-row'));
		Object.assign(row.style, {
			display: 'flex', alignItems: 'center', flex: '0 0 auto',
			height: 'var(--activity-bar-action-height, 48px)',
			cursor: 'pointer', color: 'var(--vscode-foreground)', whiteSpace: 'nowrap',
		});
		if (isActive) {
			row.style.background = 'var(--vscode-list-activeSelectionBackground, rgba(127,127,127,0.22))';
		}
		row.onmouseenter = () => { if (!isActive) { row.style.background = 'var(--vscode-list-hoverBackground)'; } };
		row.onmouseleave = () => { if (!isActive) { row.style.background = ''; } };

		const iconEl = append(row, $('span.aria-rail-flyout-icon'));
		Object.assign(iconEl.style, {
			width: 'var(--activity-bar-width, 48px)', flex: '0 0 auto',
			height: '100%', fontSize: 'var(--activity-bar-icon-size, 24px)',
			display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
		});
		if (ThemeIcon.isThemeIcon(icon)) {
			iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
		} else if (URI.isUri(icon)) {
			const cssUrl = asCSSUrl(icon);
			const size = 'var(--activity-bar-icon-size, 24px)';
			iconEl.style.backgroundColor = 'currentColor';
			iconEl.style.setProperty('mask-image', cssUrl);
			iconEl.style.setProperty('-webkit-mask-image', cssUrl);
			iconEl.style.setProperty('mask-repeat', 'no-repeat');
			iconEl.style.setProperty('-webkit-mask-repeat', 'no-repeat');
			iconEl.style.setProperty('mask-position', 'center');
			iconEl.style.setProperty('-webkit-mask-position', 'center');
			iconEl.style.setProperty('mask-size', size);
			iconEl.style.setProperty('-webkit-mask-size', size);
		}

		const label = append(row, $('span.aria-rail-flyout-label'));
		label.textContent = name;
		Object.assign(label.style, { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '14px' });

		row.onclick = onClick;
	}
}
