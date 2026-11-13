import { getSettings, saveSettings, ext } from '../background/storage';
import { fileAccessHelp, hasFileAccess, requestFileAccess } from '../background/fileAccess';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ALL_SITES = '<all_urls>';

let siteAccessGranted = true;

/** Firefox never grants host permissions to a temporarily loaded add-on, and users can revoke them; show where things stand. */
async function showSiteAccess(): Promise<void> {
    const status = $('siteAccessStatus');
    try {
        const granted = await ext.permissions.contains({ origins: [ALL_SITES] });
        siteAccessGranted = granted;
        status.textContent = granted ? 'Granted.' : 'Not granted: model lists and cloud requests will fail until it is.';
        status.className = granted ? 'status ok' : 'status bad';
    } catch {
        status.textContent = '';
    }
}

async function grantSiteAccess(): Promise<void> {
    try { await ext.permissions.request({ origins: [ALL_SITES] }); } catch { /* reported by the status line */ }
    await showSiteAccess();
}

async function load(): Promise<void> {
    const s = await getSettings();
    await showSiteAccess();
    $<HTMLInputElement>('ollamaBaseUrl').value = s.ollamaBaseUrl;
    $<HTMLInputElement>('key-openai').value = s.keys.openai;
    $<HTMLInputElement>('key-gemini').value = s.keys.gemini;
    $<HTMLInputElement>('key-anthropic').value = s.keys.anthropic;
    $<HTMLInputElement>('key-blablador').value = s.keys.blablador;
    $<HTMLInputElement>('maxIterations').value = String(s.maxIterations);
    $<HTMLInputElement>('modelTimeoutMs').value = String(s.modelTimeoutMs);
    $<HTMLInputElement>('maxContextChars').value = String(s.maxContextChars);
    $<HTMLInputElement>('allowPrivateNetwork').checked = s.allowPrivateNetwork;
    $<HTMLInputElement>('allowLocalFiles').checked = s.allowLocalFiles;
    if (s.allowLocalFiles) { await showFileAccess(await hasFileAccess()); }
}

/** Report whether the browser lets the extension read file:// pages, with what to do if not. */
async function showFileAccess(granted: boolean): Promise<void> {
    const status = $('fileAccessStatus');
    status.textContent = granted ? 'Browser has granted file access.' : `Browser has not granted file access yet. ${fileAccessHelp()}`;
    status.className = granted ? 'status ok' : 'status bad';
}

/** A permission switch takes effect the moment it changes; waiting for Save would leave a window where it looks off but is on. */
async function flash(message: string): Promise<void> {
    const saved = $('saved');
    saved.textContent = message;
    saved.className = 'status ok';
    setTimeout(() => { if (saved.textContent === message) { saved.textContent = ''; } }, 3000);
}

async function onPrivateNetworkToggle(): Promise<void> {
    const on = $<HTMLInputElement>('allowPrivateNetwork').checked;
    await saveSettings({ allowPrivateNetwork: on });
    await flash(`Private-network access ${on ? 'enabled' : 'disabled'}.`);
}

/** Ticking the box asks the browser straight away (the request must come before any await), then saves. */
async function onLocalFilesToggle(): Promise<void> {
    const box = $<HTMLInputElement>('allowLocalFiles');
    const access = box.checked ? requestFileAccess() : Promise.resolve(false);
    await saveSettings({ allowLocalFiles: box.checked });
    await flash(`Local file reading ${box.checked ? 'enabled' : 'disabled'}.`);
    if (!box.checked) { $('fileAccessStatus').textContent = ''; return; }
    await showFileAccess(await access);
}

/** The button is the reliable gesture: a plain click with the request as its first act. */
async function onGrantFileAccess(): Promise<void> {
    const access = requestFileAccess();
    const box = $<HTMLInputElement>('allowLocalFiles');
    if (!box.checked) { box.checked = true; await saveSettings({ allowLocalFiles: true }); }
    await showFileAccess(await access);
}

/**
 * Every text and number field saves itself when it changes (on blur or Enter), so the page
 * never shows a state that is not in effect. Numbers fall back to the default when the field
 * is blank or not a number, and the field is updated to show what was actually stored.
 */
const DEFAULT_NUMBERS = { maxIterations: 60, modelTimeoutMs: 600000, maxContextChars: 60000 } as const;

async function saveField(id: string): Promise<void> {
    const el = $<HTMLInputElement>(id);
    const raw = el.value.trim();
    switch (id) {
        case 'ollamaBaseUrl': {
            const url = raw.replace(/\/+$/, '') || 'http://localhost:11434';
            el.value = url;
            await saveSettings({ ollamaBaseUrl: url });
            break;
        }
        case 'key-openai': case 'key-gemini': case 'key-anthropic': case 'key-blablador': {
            const name = id.slice(4) as 'openai' | 'gemini' | 'anthropic' | 'blablador';
            await saveSettings({ keys: { ...(await getSettings()).keys, [name]: raw } });
            break;
        }
        case 'maxIterations': case 'modelTimeoutMs': case 'maxContextChars': {
            const min = Number(el.min) || 1;
            const parsed = parseInt(raw, 10);
            const value = Number.isFinite(parsed) ? Math.max(min, parsed) : DEFAULT_NUMBERS[id];
            el.value = String(value);
            await saveSettings({ [id]: value });
            break;
        }
        default: return;
    }
    await flash(`Saved${id.startsWith('key-') ? ' (reopen the side panel to refresh the model list)' : ''}.`);
}

/**
 * Save everything on the page at once. The click is also a user gesture, so when the browser
 * has not granted site access yet the request goes out first (before any await), which is the
 * only way Firefox shows its prompt.
 */
async function saveAll(): Promise<void> {
    let request: Promise<unknown> | null = null;
    if (!siteAccessGranted) {
        try { request = ext.permissions.request({ origins: [ALL_SITES] }); } catch { request = null; }
    }
    const num = (id: 'maxIterations' | 'modelTimeoutMs' | 'maxContextChars') => {
        const el = $<HTMLInputElement>(id);
        const parsed = parseInt(el.value.trim(), 10);
        const value = Number.isFinite(parsed) ? Math.max(Number(el.min) || 1, parsed) : DEFAULT_NUMBERS[id];
        el.value = String(value);
        return value;
    };
    const url = $<HTMLInputElement>('ollamaBaseUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:11434';
    $<HTMLInputElement>('ollamaBaseUrl').value = url;
    await saveSettings({
        ollamaBaseUrl: url,
        keys: {
            openai: $<HTMLInputElement>('key-openai').value.trim(),
            gemini: $<HTMLInputElement>('key-gemini').value.trim(),
            anthropic: $<HTMLInputElement>('key-anthropic').value.trim(),
            blablador: $<HTMLInputElement>('key-blablador').value.trim()
        },
        maxIterations: num('maxIterations'),
        modelTimeoutMs: num('modelTimeoutMs'),
        maxContextChars: num('maxContextChars'),
        allowPrivateNetwork: $<HTMLInputElement>('allowPrivateNetwork').checked,
        allowLocalFiles: $<HTMLInputElement>('allowLocalFiles').checked
    });
    if (request) { await request.catch(() => undefined); }
    await showSiteAccess();
    await flash('Saved. Reopen the side panel to refresh the model list.');
}

function autosave(id: string): void {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('change', () => { void saveField(id); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { el.blur(); } });
}

async function testOllama(): Promise<void> {
    const status = $('ollamaStatus');
    const url = $<HTMLInputElement>('ollamaBaseUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:11434';
    status.textContent = 'Testing…';
    status.className = 'status';
    try {
        const res = await fetch(`${url}/api/tags`);
        const json = await res.json() as { models?: Array<{ name: string }> };
        const names = (json.models ?? []).map(m => m.name);
        status.textContent = names.length ? `OK — ${names.length} model(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` : 'Connected, but no models. Run `ollama pull qwen2.5-coder:7b`.';
        status.className = 'status ok';
    } catch (error) {
        status.textContent = `Could not reach ${url}: ${(error as Error).message}. Is Ollama running?`;
        status.className = 'status bad';
    }
}

async function showLog(): Promise<void> {
    const pre = $<HTMLPreElement>('log');
    try {
        const response = await ext.runtime.sendMessage({ type: 'getLog' }) as { log?: string } | undefined;
        pre.textContent = response?.log || '(log is empty — the background may have restarted)';
    } catch (error) {
        pre.textContent = `Could not read log: ${(error as Error).message}`;
    }
    pre.hidden = false;
}

$('testOllama').addEventListener('click', () => { void testOllama(); });
$('save').addEventListener('click', () => { void saveAll(); });
$('showLog').addEventListener('click', () => { void showLog(); });
for (const id of ['ollamaBaseUrl', 'key-openai', 'key-gemini', 'key-anthropic', 'key-blablador', 'maxIterations', 'modelTimeoutMs', 'maxContextChars']) { autosave(id); }
$('allowLocalFiles').addEventListener('change', () => { void onLocalFilesToggle(); });
$('allowPrivateNetwork').addEventListener('change', () => { void onPrivateNetworkToggle(); });
$('grantSiteAccess').addEventListener('click', () => { void grantSiteAccess(); });
$('grantFileAccess').addEventListener('click', () => { void onGrantFileAccess(); });
void load();
