/**
 * Browser tools and resources. In the browser the "workspace" is the set of open
 * tabs; tools read pages, search them, follow links, and (with approval) click,
 * fill and navigate.
 *
 * Page-side functions are injected with `scripting.executeScript({ func })`, so they
 * must be self-contained: no closures over module scope.
 */

import { ext, getSettings } from './storage';
import { fileAccessHelp, hasFileAccess, isFirefox } from './fileAccess';
import { extractPdfText, isPdfBytes, isPdfUrl, PDF_MAX_BYTES } from './pdf';
import { PluginArgSpec } from '../../../core/harness/types';

export interface BrowserTool {
    id: string;
    name: string;
    description: string;
    args: PluginArgSpec[];
    /** Never prompts for approval. */
    readOnly?: boolean;
    /**
     * The tool sends data off the machine. `readOnly` means "does not change the page", which is
     * not the same as "safe to run unattended": a tool that can GET an arbitrary URL can carry
     * whatever the agent has read out with it. Egress tools always ask, whatever the mode.
     */
    egress?: boolean;
    /** Prompts even in Auto-Edit mode. */
    risky?: boolean;
    enabled: boolean;
    source: 'built-in';
    execute(args: Record<string, unknown>): Promise<string>;
}

export interface BrowserResource {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    source: 'built-in';
    fetch(): Promise<string>;
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[::1\]|.*\.local$)/i;

export async function checkUrl(raw: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
    let url: URL;
    try { url = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: `Invalid URL: ${raw}` }; }
    if (!/^https?:$/.test(url.protocol)) { return { ok: false, reason: `Only http(s) URLs are allowed, got ${url.protocol}` }; }
    if (PRIVATE_HOST.test(url.hostname)) {
        const settings = await getSettings();
        if (!settings.allowPrivateNetwork) {
            return { ok: false, reason: `${url.hostname} is a local/private address. Enable "allow private network" in the options to permit it.` };
        }
    }
    return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

export async function activeTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id === undefined) {
        const [any] = await ext.tabs.query({ active: true });
        if (!any || any.id === undefined) { throw new Error('No active tab.'); }
        return any;
    }
    return tab;
}

async function resolveTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
    const id = args.tabId !== undefined && args.tabId !== '' ? Number(args.tabId) : NaN;
    if (Number.isFinite(id)) {
        try { return await ext.tabs.get(id); } catch { throw new Error(`No tab with id ${id}. Use list-tabs to see ids.`); }
    }
    return activeTab();
}

/**
 * Why a tab may not be read, or null when it may. Browser-internal pages are always off limits.
 * A `file://` tab is readable only when the user enabled it in the options page and the
 * browser has granted file access; the agent still cannot open file URLs itself (checkUrl).
 */
async function restricted(tab: chrome.tabs.Tab): Promise<string | null> {
    const url = tab.url ?? '';
    if (/^file:/i.test(url)) {
        const settings = await getSettings();
        const granted = settings.allowLocalFiles ? await hasFileAccess() : false;
        auditLog(`local file ${settings.allowLocalFiles && granted ? 'ALLOWED' : 'DENIED'}: ${url} (setting ${settings.allowLocalFiles ? 'on' : 'off'}, browser grant ${granted ? 'yes' : settings.allowLocalFiles ? 'no' : 'not checked'})`);
        if (!settings.allowLocalFiles) {
            return `Cannot read ${url}: local files are off limits until "Read local files opened in the browser" is switched on in Enclave's options.`;
        }
        if (!granted) {
            return `Cannot read ${url}: the browser has not granted Enclave access to local files. ${fileAccessHelp()}`;
        }
        return null;
    }
    if (!url || /^(chrome|about|moz-extension|chrome-extension|edge|view-source):/i.test(url)) {
        return `Cannot read ${url || 'this tab'}: browser-internal pages are off limits. Open a normal web page.`;
    }
    return null;
}

async function runInTab<T, A extends unknown[]>(tab: chrome.tabs.Tab, func: (...args: A) => T, args: A, world: 'ISOLATED' | 'MAIN' = 'ISOLATED'): Promise<T> {
    const blocked = await restricted(tab);
    if (blocked) { throw new Error(blocked); }
    const results = await ext.scripting.executeScript({ target: { tabId: tab.id! }, func, args, world } as chrome.scripting.ScriptInjection<A, T>);
    const first = results?.[0];
    if (!first) { throw new Error('The page did not respond (it may be still loading).'); }
    return first.result as T;
}

// ---------------------------------------------------------------------------
// PDF tabs
// ---------------------------------------------------------------------------

/**
 * Read the first kilobyte of the URL the tab shows and say whether it is a PDF. Uses the tab's
 * own cookies (same origin, `credentials: include`) and cancels the body after the first chunk,
 * so a large HTML page is not downloaded just to be sniffed.
 */
async function sniffPdf(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(url, { signal: controller.signal, credentials: 'include', redirect: 'follow', headers: { Range: 'bytes=0-1023' } });
        if (!res.ok && res.status !== 206) { return false; }
        if (/application\/pdf/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel(); return true; }
        const reader = res.body?.getReader();
        if (!reader) { return false; }
        const { value } = await reader.read();
        await reader.cancel();
        return !!value && isPdfBytes(value);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
        const res = await fetch(url, { signal: controller.signal, credentials: 'include', redirect: 'follow' });
        if (!res.ok) { throw new Error(`HTTP ${res.status} ${res.statusText} while fetching the PDF`); }
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > PDF_MAX_BYTES) { throw new Error(`The PDF is ${(declared / 1048576).toFixed(0)} MB; the limit is ${PDF_MAX_BYTES / 1048576} MB.`); }
        const data = await res.arrayBuffer();
        if (data.byteLength > PDF_MAX_BYTES) { throw new Error(`The PDF is larger than ${PDF_MAX_BYTES / 1048576} MB.`); }
        if (!isPdfBytes(new Uint8Array(data, 0, Math.min(1024, data.byteLength)))) { throw new Error('The response is not a PDF (no %PDF header). If the page needs a login, sign in on the tab first.'); }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs inside a tab: fetch the document's own URL and return its bytes as base64. The page's
 * origin is the file itself, so this can succeed where an extension-page fetch is refused.
 * Everything it needs is in scope here, because it is serialised and sent into the tab.
 */
async function readOwnDocumentAsBase64(): Promise<string> {
    const res = await fetch(location.href);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) { binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
    return btoa(binary);
}

/**
 * Runs in the page's main world of Firefox's PDF viewer: pdf.js exposes the open document as
 * `PDFViewerApplication`, whose `getData()` yields the file's bytes. Chrome's viewer has no such
 * object, so there this simply reports that it is not pdf.js.
 */
async function readViewerDocumentAsBase64(): Promise<string> {
    const app = (globalThis as unknown as { PDFViewerApplication?: { initializedPromise?: Promise<void>; pdfDocument?: { getData(): Promise<Uint8Array> } } }).PDFViewerApplication;
    if (!app) { throw new Error('this tab is not the pdf.js viewer'); }
    await app.initializedPromise;
    for (let waited = 0; !app.pdfDocument && waited < 10000; waited += 250) { await new Promise(r => setTimeout(r, 250)); }
    if (!app.pdfDocument) { throw new Error('the viewer has no document loaded'); }
    const bytes = await app.pdfDocument.getData();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) { binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
    return btoa(binary);
}

/** Text of the PDF a tab shows, with the same header shape `read-page` produces. */
async function readPdfTab(tab: chrome.tabs.Tab, maxChars: number, pages: string): Promise<string> {
    const url = tab.url ?? '';
    const blocked = await restricted(tab);
    if (blocked) { throw new Error(blocked); }
    const isLocal = /^file:/i.test(url);
    const fileName = isLocal ? decodeURIComponent(url.split('/').pop() ?? '') : '';
    let data: ArrayBuffer;
    if (isLocal) {
        // A local PDF sits in the browser's own viewer, so its bytes have to be fetched rather
        // than read from a DOM. Two routes, tried in turn: the side panel page (an extension
        // page; works in Chrome once file access is on, refused by Firefox, which blocks every
        // extension fetch of file://), then a script injected into the PDF tab itself, which
        // runs with the file's own origin (Firefox 153+ allows the injection once local-file
        // access is granted). Where both fail, attaching the file in the chat is the way in.
        // Firefox refuses every route (it blocks file:// fetches from extension pages and shields
        // its PDF viewer from injected scripts, even with local-file access granted), so say so
        // at once rather than report three failures.
        if (isFirefox) {
            throw new Error(`Firefox does not let any extension read a PDF it displays from your disk. Ask the user to attach "${fileName}" in the chat with the 📎 button; an attached PDF is read page by page. Do not search for the file elsewhere.`);
        }
        const attempts: string[] = [];
        let bytes: ArrayBuffer | null = null;
        try {
            if (!localFileReader) { throw new Error('no side panel is open'); }
            bytes = await localFileReader(url);
            auditLog(`local PDF ${fileName}: read via the side panel`);
        } catch (error) {
            attempts.push(`panel: ${(error as Error).message}`);
        }
        if (!bytes) {
            try {
                const base64 = await runInTab(tab, readOwnDocumentAsBase64, []);
                if (!base64) { throw new Error('the tab returned nothing'); }
                const binary = atob(base64);
                const out = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) { out[i] = binary.charCodeAt(i); }
                bytes = out.buffer;
                auditLog(`local PDF ${fileName}: read from inside the tab`);
            } catch (error) {
                attempts.push(`tab: ${(error as Error).message}`);
            }
        }
        if (!bytes) {
            // Firefox's own viewer (pdf.js) holds the open document in a page-world object; the
            // bytes come from there without any fetch. Needs the page's main world.
            try {
                const base64 = await runInTab(tab, readViewerDocumentAsBase64, [], 'MAIN');
                if (!base64) { throw new Error('the viewer returned nothing'); }
                const binary = atob(base64);
                const out = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) { out[i] = binary.charCodeAt(i); }
                bytes = out.buffer;
                auditLog(`local PDF ${fileName}: read from the browser's PDF viewer`);
            } catch (error) {
                attempts.push(`viewer: ${(error as Error).message}`);
            }
        }
        if (!bytes) {
            throw new Error(`Could not read the local PDF "${fileName}" (${attempts.join('; ')}). Ask the user to attach "${fileName}" in the chat with the 📎 button instead; an attached PDF is read page by page.`);
        }
        if (bytes.byteLength > PDF_MAX_BYTES) { throw new Error(`The local PDF "${fileName}" is larger than ${PDF_MAX_BYTES / 1048576} MB.`); }
        if (!isPdfBytes(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)))) { throw new Error(`The local file "${fileName}" is not a PDF (no %PDF header).`); }
        data = bytes;
    } else {
        data = await fetchPdfBytes(url);
    }
    const pdf = await extractPdfText(data, { maxChars, pages });
    const title = pdf.title || (tab.title ?? '').replace(/\.pdf$/i, '') || url;
    const head = `title: ${title}\nurl: ${url}\nformat: PDF, ${pdf.numPages} page(s); read pages ${pdf.pages.length === pdf.numPages ? 'all' : pdf.pages.join(',')}${pages ? ` (asked: ${pages})` : ''}\nchars: ${pdf.text.length}\n\n`;
    return head + pdf.text + (pdf.truncated ? `\n…[truncated at ${maxChars} chars; ask for specific pages with the pages argument]` : '');
}

/** Length of the text after the `read-page` header, to tell an empty document from a real one. */
function bodyLength(pageResult: string): number {
    const i = pageResult.indexOf('\n\n');
    return i === -1 ? pageResult.length : pageResult.length - i - 2;
}

function tabLabel(tab: chrome.tabs.Tab): string {
    return `[tab ${tab.id}] ${tab.title ?? '(untitled)'} — ${tab.url ?? ''}`;
}

async function waitForLoad(tabId: number, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const tab = await ext.tabs.get(tabId);
        if (tab.status === 'complete') { return; }
        await new Promise(r => setTimeout(r, 250));
    }
}

// ---------------------------------------------------------------------------
// Page-side functions (self-contained)
// ---------------------------------------------------------------------------

function pageText(selector: string, maxChars: number): string {
    const root = selector ? document.querySelector(selector) : (document.querySelector('main, article, [role=main]') ?? document.body);
    if (!root) { return `ERROR: no element matches "${selector}"`; }
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg, iframe, nav, footer, header[role=banner], [aria-hidden=true]').forEach(n => n.remove());
    const text = (clone as HTMLElement).innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const head = `title: ${document.title}\nurl: ${location.href}\n${selector ? `selector: ${selector}\n` : ''}chars: ${text.length}\n\n`;
    return head + (text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated, ${text.length - maxChars} more chars]` : text);
}

function pageFind(query: string, useRegex: boolean, context: number, maxHits: number): string {
    const text = document.body.innerText;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let re: RegExp;
    try { re = new RegExp(useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { return `ERROR: invalid regex: ${(e as Error).message}`; }
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        if (!re.test(lines[i])) { continue; }
        const from = Math.max(0, i - context), to = Math.min(lines.length - 1, i + context);
        hits.push(`--- line ${i + 1} ---\n${lines.slice(from, to + 1).join('\n')}`);
    }
    return hits.length ? `${hits.length} hit(s) for "${query}" on ${document.title}\n\n${hits.join('\n\n')}` : `No matches for "${query}" on ${document.title}`;
}

function pageSelection(): string {
    const sel = window.getSelection()?.toString() ?? '';
    return sel.trim() ? `selection on ${document.title} (${sel.length} chars):\n${sel}` : '(nothing selected)';
}

function pageLinks(filter: string, max: number): string {
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const seen = new Set<string>();
    const out: string[] = [];
    let re: RegExp | null = null;
    if (filter) { try { re = new RegExp(filter, 'i'); } catch { re = null; } }
    for (const a of anchors) {
        const href = a.href;
        if (!href || !/^https?:/.test(href) || seen.has(href)) { continue; }
        const label = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (re && !re.test(href) && !re.test(label)) { continue; }
        seen.add(href);
        out.push(`${label || '(no text)'} → ${href}`);
        if (out.length >= max) { break; }
    }
    return out.length ? `${out.length} link(s)${filter ? ` matching /${filter}/` : ''} on ${document.title}:\n${out.join('\n')}` : 'No links found.';
}

function pageClick(selector: string, text: string): string {
    let el: HTMLElement | null = null;
    if (selector) { el = document.querySelector(selector) as HTMLElement | null; }
    if (!el && text) {
        const t = text.trim().toLowerCase();
        const candidates = Array.from(document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], summary, label')) as HTMLElement[];
        el = candidates.find(c => (c.innerText || (c as HTMLInputElement).value || '').trim().toLowerCase() === t)
            ?? candidates.find(c => (c.innerText || (c as HTMLInputElement).value || '').toLowerCase().includes(t))
            ?? null;
    }
    if (!el) { return `ERROR: nothing matches ${selector ? `selector "${selector}"` : `text "${text}"`}`; }
    el.scrollIntoView({ block: 'center' });
    el.click();
    return `Clicked <${el.tagName.toLowerCase()}> "${(el.innerText || (el as HTMLInputElement).value || selector).trim().slice(0, 60)}" on ${document.title}`;
}

function pageFill(selector: string, value: string, submit: boolean): string {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) { return `ERROR: no element matches "${selector}"`; }
    if ((el as HTMLInputElement).type === 'password') { return 'ERROR: refusing to fill password fields'; }
    if (el.isContentEditable) { el.textContent = value; }
    else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) { setter.call(el, value); } else { el.value = value; }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
        const form = el.closest('form');
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
        else { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    }
    return `Filled "${selector}" with ${value.length} chars${submit ? ' and submitted' : ''}`;
}

function pageScroll(direction: string, amount: number): string {
    if (direction === 'top') { window.scrollTo({ top: 0 }); }
    else if (direction === 'bottom') { window.scrollTo({ top: document.body.scrollHeight }); }
    else { window.scrollBy({ top: direction === 'up' ? -amount : amount }); }
    return `Scrolled ${direction}; now at ${Math.round(window.scrollY)} of ${Math.round(document.body.scrollHeight - window.innerHeight)} px`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== undefined ? n : fallback; };
const bool = (v: unknown): boolean => v === true || /^(true|1|yes)$/i.test(String(v ?? ''));

/**
 * Reads a file:// URL on behalf of the background. A Manifest V3 service worker cannot fetch
 * file:// at all; an extension page (the side panel) can where the browser has granted file
 * access, so the host installs a reader that relays the request there.
 */
/** Where access decisions are written; the host wires it to its log. */
let auditLog: (line: string) => void = () => undefined;
export function setAuditLog(log: (line: string) => void): void { auditLog = log; }

export type LocalFileReader = (url: string) => Promise<ArrayBuffer>;
let localFileReader: LocalFileReader | null = null;
export function setLocalFileReader(reader: LocalFileReader | null): void { localFileReader = reader; }

export const tools: BrowserTool[] = [
    {
        id: 'read-page', name: 'Read Page', source: 'built-in', enabled: true, readOnly: true,
        description: 'Read the text of the active tab (or a specific tab / CSS selector). A tab showing a PDF is read as text too, page by page. args: { tabId, selector, maxChars (default 12000), pages (PDF only, e.g. "1-5") }',
        args: [{ name: 'tabId', description: 'Tab id from list-tabs; empty = active tab' }, { name: 'selector', description: 'CSS selector to read only part of the page (HTML only)' }, { name: 'maxChars', default: '12000' }, { name: 'pages', description: 'PDF page range such as 1-5,8; empty = all' }],
        async execute(args) {
            const tab = await resolveTab(args);
            const maxChars = num(args.maxChars, 12000);
            if (isPdfUrl(tab.url ?? '')) { return readPdfTab(tab, maxChars, str(args.pages)); }
            // A PDF viewer tab has no readable DOM: injection fails (Firefox) or yields an empty
            // body (Chrome). Then, and only then, the URL is sniffed for a PDF (arXiv, DOI links).
            let html = '';
            let failure: Error | null = null;
            try { html = await runInTab(tab, pageText, [str(args.selector), maxChars]); } catch (error) { failure = error as Error; }
            if (!failure && bodyLength(html) >= 80) { return html; }
            if (!/^file:/i.test(tab.url ?? '') && !(await restricted(tab)) && await sniffPdf(tab.url ?? '')) { return readPdfTab(tab, maxChars, str(args.pages)); }
            if (failure) { throw failure; }
            return html;
        }
    },
    {
        id: 'read-pdf', name: 'Read PDF', source: 'built-in', enabled: true, readOnly: true,
        description: 'Read the text of the PDF shown in the active tab (or a specific tab), page by page with [page N] markers, using pdf.js. args: { tabId, pages (e.g. "1-5,8"; empty = all), maxChars (default 60000) }',
        args: [{ name: 'tabId', description: 'Tab id from list-tabs; empty = active tab' }, { name: 'pages', description: 'Page range such as 1-5,8; empty = all' }, { name: 'maxChars', default: '60000' }],
        async execute(args) {
            const tab = await resolveTab(args);
            return readPdfTab(tab, num(args.maxChars, 60000), str(args.pages));
        }
    },
    {
        id: 'find-in-page', name: 'Find in Page', source: 'built-in', enabled: true, readOnly: true,
        description: 'Search the active tab for text or a regex and return matching lines with context. args: { query*, regex (true/false), context (lines, default 1), tabId }',
        args: [{ name: 'query', required: true }, { name: 'regex', default: 'false' }, { name: 'context', default: '1' }, { name: 'tabId' }],
        async execute(args) {
            const query = str(args.query).trim();
            if (!query) { throw new Error('query is required'); }
            const tab = await resolveTab(args);
            return runInTab(tab, pageFind, [query, bool(args.regex), Math.min(5, num(args.context, 1)), 40]);
        }
    },
    {
        id: 'get-selection', name: 'Get Selection', source: 'built-in', enabled: true, readOnly: true,
        description: 'Return the text the user has selected on the active tab.',
        args: [],
        async execute() { return runInTab(await activeTab(), pageSelection, []); }
    },
    {
        id: 'extract-links', name: 'Extract Links', source: 'built-in', enabled: true, readOnly: true,
        description: 'List the links on the active tab, optionally filtered by a regex on URL or text. args: { filter, max (default 100), tabId }',
        args: [{ name: 'filter', description: 'Regex applied to URL and link text' }, { name: 'max', default: '100' }, { name: 'tabId' }],
        async execute(args) {
            const tab = await resolveTab(args);
            return runInTab(tab, pageLinks, [str(args.filter), Math.min(500, num(args.max, 100))]);
        }
    },
    {
        id: 'list-tabs', name: 'List Tabs', source: 'built-in', enabled: true, readOnly: true,
        description: 'List open tabs in the current window with ids, titles and URLs.',
        args: [],
        async execute() {
            const tabs = await ext.tabs.query({ lastFocusedWindow: true });
            return tabs.map(t => `${t.active ? '* ' : '  '}${tabLabel(t)}`).join('\n') || 'No tabs.';
        }
    },
    {
        id: 'open-tab', name: 'Open Tab', source: 'built-in', enabled: true, egress: true,
        description: 'Open a URL in a new tab and wait for it to load. args: { url*, background (true keeps the current tab focused) }',
        args: [{ name: 'url', required: true }, { name: 'background', default: 'false' }],
        async execute(args) {
            const check = await checkUrl(str(args.url));
            if (!check.ok) { throw new Error(check.reason); }
            const tab = await ext.tabs.create({ url: check.url.href, active: !bool(args.background) });
            if (tab.id !== undefined) { await waitForLoad(tab.id); }
            const fresh = tab.id !== undefined ? await ext.tabs.get(tab.id) : tab;
            return `Opened ${tabLabel(fresh)}`;
        }
    },
    {
        id: 'navigate', name: 'Navigate', source: 'built-in', enabled: true, egress: true,
        description: 'Navigate the active tab (or tabId) to a URL and wait for it to load. args: { url*, tabId }',
        args: [{ name: 'url', required: true }, { name: 'tabId' }],
        async execute(args) {
            const check = await checkUrl(str(args.url));
            if (!check.ok) { throw new Error(check.reason); }
            const tab = await resolveTab(args);
            await ext.tabs.update(tab.id!, { url: check.url.href });
            await waitForLoad(tab.id!);
            return `Navigated ${tabLabel(await ext.tabs.get(tab.id!))}`;
        }
    },
    {
        id: 'click', name: 'Click', source: 'built-in', enabled: true, risky: true,
        description: 'Click an element on the active tab by CSS selector or by its visible text. args: { selector, text, tabId }',
        args: [{ name: 'selector', description: 'CSS selector' }, { name: 'text', description: 'Visible text of a link/button' }, { name: 'tabId' }],
        async execute(args) {
            if (!str(args.selector) && !str(args.text)) { throw new Error('Provide selector or text'); }
            const tab = await resolveTab(args);
            const result = await runInTab(tab, pageClick, [str(args.selector), str(args.text)]);
            await new Promise(r => setTimeout(r, 600));
            return result;
        }
    },
    {
        id: 'fill', name: 'Fill Field', source: 'built-in', enabled: true, risky: true,
        description: 'Type into an input, textarea or editable element on the active tab. Never fills password fields. args: { selector*, value*, submit (true/false), tabId }',
        args: [{ name: 'selector', required: true }, { name: 'value', required: true, multiline: true }, { name: 'submit', default: 'false' }, { name: 'tabId' }],
        async execute(args) {
            const tab = await resolveTab(args);
            return runInTab(tab, pageFill, [str(args.selector), str(args.value), bool(args.submit)]);
        }
    },
    {
        id: 'scroll', name: 'Scroll', source: 'built-in', enabled: true, readOnly: true,
        description: 'Scroll the active tab. args: { direction: down|up|top|bottom (default down), amount (px, default 800) }',
        args: [{ name: 'direction', default: 'down' }, { name: 'amount', default: '800' }],
        async execute(args) { return runInTab(await activeTab(), pageScroll, [str(args.direction, 'down'), num(args.amount, 800)]); }
    },
    {
        // Marked egress, not readOnly: it does not touch the page, but it is a way for anything
        // the agent has read to leave the browser, so it is approved like any other such action.
        id: 'fetch-url', name: 'Fetch URL', source: 'built-in', enabled: true, egress: true,
        description: 'GET a URL without opening a tab and return its text (HTML reduced to text, JSON pretty-printed). args: { url*, maxChars (default 10000) }',
        args: [{ name: 'url', required: true }, { name: 'maxChars', default: '10000' }],
        async execute(args) {
            const check = await checkUrl(str(args.url));
            if (!check.ok) { throw new Error(check.reason); }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const res = await fetch(check.url.href, { signal: controller.signal, redirect: 'follow' });
                const type = res.headers.get('content-type') ?? '';
                if (!res.ok) { throw new Error(`HTTP ${res.status} ${res.statusText}`); }
                let body = await res.text();
                if (/json/i.test(type)) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep */ } }
                else if (/html/i.test(type)) {
                    body = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, '\n').replace(/<[^>]+>/g, '')
                        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                }
                const max = num(args.maxChars, 10000);
                return `${res.status} ${type.split(';')[0]} · ${body.length} chars\n\n${body.length > max ? `${body.slice(0, max)}\n…[truncated]` : body}`;
            } finally {
                clearTimeout(timer);
            }
        }
    },
    {
        id: 'wait', name: 'Wait', source: 'built-in', enabled: true, readOnly: true,
        description: 'Pause for a moment, e.g. after a click, before reading the page again. args: { ms (max 10000, default 1500) }',
        args: [{ name: 'ms', default: '1500' }],
        async execute(args) { const ms = Math.min(10000, Math.max(100, num(args.ms, 1500))); await new Promise(r => setTimeout(r, ms)); return `Waited ${ms} ms`; }
    }
];

export const resources: BrowserResource[] = [
    {
        id: 'current-page', name: 'Current Page', source: 'built-in', enabled: true,
        description: 'Title, URL and the main text of the active tab (first 6000 characters).',
        async fetch() { return runInTab(await activeTab(), pageText, ['', 6000]); }
    },
    {
        id: 'tabs', name: 'Open Tabs', source: 'built-in', enabled: true,
        description: 'Ids, titles and URLs of the tabs in the current window.',
        async fetch() { return tools.find(t => t.id === 'list-tabs')!.execute({}); }
    },
    {
        id: 'selection', name: 'Selection', source: 'built-in', enabled: true,
        description: 'Text currently selected on the active tab.',
        async fetch() { return runInTab(await activeTab(), pageSelection, []); }
    }
];
