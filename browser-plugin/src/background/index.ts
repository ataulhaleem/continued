/**
 * Background entry: accepts side-panel connections, routes messages to the Backend,
 * keeps the active-tab indicator fresh, and opens the panel on toolbar click.
 */

import { Backend } from './backend';
import { ext } from './storage';

const ports = new Set<chrome.runtime.Port>();
const logLines: string[] = [];

function log(line: string): void {
    const entry = `[${new Date().toISOString()}] ${line}`;
    logLines.push(entry);
    if (logLines.length > 500) { logLines.shift(); }
    console.log(entry);
}

const backend = new Backend(message => {
    for (const port of ports) {
        try { port.postMessage(message); } catch { ports.delete(port); }
    }
}, log);

const ready = backend.init();

ext.runtime.onConnect.addListener(port => {
    if (port.name !== 'sidepanel') { return; }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(async (message: Record<string, unknown>) => {
        await ready;
        try {
            await backend.handle(message);
        } catch (error) {
            log(`handler error for ${String(message?.type)}: ${(error as Error).message}`);
            port.postMessage({ type: 'assistantResponse', content: `Error: ${(error as Error).message}` });
            port.postMessage({ type: 'agentDone' });
        }
    });
});

// Keep the "current page" indicator in sync with the active tab.
ext.tabs.onActivated.addListener(() => { void backend.postActiveTab(); });
ext.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete' && tab.active) { void backend.postActiveTab(); } });

// Toolbar button opens the side panel (Chrome) or the sidebar (Firefox).
const sidePanel = (ext as unknown as { sidePanel?: { setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void> } }).sidePanel;
if (sidePanel) {
    sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}
const sidebarAction = (ext as unknown as { sidebarAction?: { toggle(): Promise<void> } }).sidebarAction;
if (sidebarAction) {
    ext.action.onClicked.addListener(() => { sidebarAction.toggle().catch(() => undefined); });
}

// Expose the log for the options page ("Show log").
ext.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message?.type === 'getLog') { sendResponse({ log: logLines.join('\n') }); return true; }
    return false;
});
