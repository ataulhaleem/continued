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
    port.onMessage.addListener((message: { type?: string; id?: string; url?: string }) => {
        if (message?.type === 'readLocalFile') { void readLocalFile(String(message.id), String(message.url)); return; }
        if (message?.type === 'permissionBar') { renderPermissionBar((message as { items?: PermissionItem[] }).items ?? []); return; }
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

/**
 * Read a file:// URL for the background, which (as a service worker) cannot fetch file:// itself.
 * This page can, when the browser has granted the extension file access. Bytes go back as
 * base64 because port messages are JSON.
 */
async function readLocalFile(id: string, url: string): Promise<void> {
    try {
        if (!/^file:/i.test(url)) { throw new Error('only file:// URLs are read this way'); }
        const res = await fetch(url);
        if (!res.ok && res.status !== 0) { throw new Error(`HTTP ${res.status}`); }
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) { binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
        send({ type: 'localFileData', id, base64: btoa(binary) });
    } catch (error) {
        send({ type: 'localFileData', id, error: (error as Error).message || String(error) });
    }
}

interface PermissionItem { id: string; label: string; origins: string[]; hint: string }

/**
 * A bar at the top of the panel with one button per grant the browser has not given. The
 * request is the first thing the click does: Firefox shows its prompt only inside the gesture,
 * and any await before it ends the gesture. Afterwards the model list is refreshed, which also
 * re-evaluates the bar.
 */
function renderPermissionBar(items: PermissionItem[]): void {
    let bar = document.getElementById('enclave-permission-bar');
    if (!items.length) { bar?.remove(); return; }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'enclave-permission-bar';
        Object.assign(bar.style, { padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-inputValidation-errorBackground)', font: 'var(--vscode-font-size) var(--vscode-font-family)', display: 'flex', flexDirection: 'column', gap: '6px' } as CSSStyleDeclaration);
        document.body.prepend(bar);
    }
    bar.replaceChildren();
    for (const item of items) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } as CSSStyleDeclaration);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.label;
        Object.assign(button.style, { padding: '4px 10px', cursor: 'pointer', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px' } as CSSStyleDeclaration);
        button.addEventListener('click', () => {
            let request: Promise<unknown>;
            try { request = ext.permissions.request({ origins: item.origins }); } catch (error) { request = Promise.reject(error); }
            button.disabled = true;
            request
                .catch(error => { hint.textContent = `The browser refused the request (${(error as Error).message}). ${item.hint}`; })
                .finally(() => { button.disabled = false; send({ type: 'getModels' }); });
        });
        const hint = document.createElement('span');
        hint.textContent = item.hint;
        hint.style.opacity = '0.85';
        row.append(button, hint);
        bar.appendChild(row);
    }
}

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

/**
 * Replace an element's children with parsed markup. The build rewrites the UI's
 * `el.innerHTML = …` assignments to this; DOMParser never executes scripts or
 * inline handlers, and the extension CSP blocks them anyway.
 */
(window as unknown as { __setHTML: (el: Element | null, html: unknown) => void }).__setHTML = (el, html) => {
    if (!el) { return; }
    const text = html === undefined || html === null ? '' : String(html);
    if (!text) { el.replaceChildren(); return; }
    const doc = new DOMParser().parseFromString(`<body>${text}</body>`, 'text/html');
    el.replaceChildren(...Array.from(doc.body.childNodes));
};

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
