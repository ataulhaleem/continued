/**
 * Side-panel shim: lets the unchanged VS Code sidebar UI run inside a browser
 * extension page.
 *
 * - `acquireVsCodeApi()` returns an object whose `postMessage` forwards to the
 *   background over a runtime port.
 * - Messages from the background are re-dispatched as `window` message events, which
 *   is what the UI listens for.
 * - Inline `onclick` handlers are blocked by the extension CSP, so copy buttons get
 *   a delegated listener here.
 * - A ping every 20 s keeps the background service worker alive during long runs.
 */

const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

let port: chrome.runtime.Port | null = null;
const queue: unknown[] = [];
let everConnected = false;
let runInProgress = false;

function connect(): void {
    port = ext.runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener((message: { type?: string }) => {
        if (message?.type === 'agentDone') { runInProgress = false; }
        window.postMessage(message, '*');
    });
    port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(() => {
            connect();
            queue.splice(0).forEach(m => port?.postMessage(m));
            // Chrome restarts the background service worker; whatever was running is gone.
            if (runInProgress) {
                window.postMessage({ type: 'assistantResponse', content: '⚠️ The background worker was restarted by the browser and the run was interrupted. Please send the request again.' }, '*');
                window.postMessage({ type: 'agentDone' }, '*');
                runInProgress = false;
            }
            if (everConnected) { port?.postMessage({ type: 'getModels' }); }
        }, 400);
    });
    everConnected = true;
}
connect();

function send(message: unknown): void {
    if (!port) { queue.push(message); return; }
    try { port.postMessage(message); } catch { queue.push(message); }
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: { type?: string; id?: string }) => {
        if (message?.type === 'harnessDelete' && !window.confirm(`Delete harness "${message.id}"?`)) { return; }
        if (message?.type === 'sendPrompt' || message?.type === 'executePlan' || message?.type === 'harnessRun') { runInProgress = true; }
        if (message?.type === 'cancelAgent' || message?.type === 'harnessStop') { runInProgress = false; }
        send(message);
    },
    getState: () => undefined,
    setState: () => undefined
});

setInterval(() => send({ type: 'ping' }), 20000);

document.addEventListener('click', event => {
    const btn = (event.target as HTMLElement | null)?.closest('.md-copy-btn') as HTMLElement | null;
    if (!btn) { return; }
    const code = btn.closest('.md-code-block')?.querySelector('code');
    if (!code) { return; }
    navigator.clipboard.writeText(code.textContent ?? '').then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 1500);
    }).catch(() => undefined);
});
