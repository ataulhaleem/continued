/**
 * PDF text extraction with pdf.js (Mozilla's own PDF engine, from the `pdfjs-dist` package).
 *
 * A PDF open in a tab has no DOM the extension can read: Firefox's viewer is not scriptable
 * and Chrome's is a plugin. So the bytes are fetched (with the tab's cookies, from the URL the
 * user already has open) and the text is extracted here. The worker module is bundled and
 * registered on `globalThis`, which makes pdf.js run it in-process; that works both in
 * Firefox's event page and in Chrome's service worker, where `new Worker` is unavailable.
 *
 * No editor or browser API is used in this file, so it can be exercised under Node.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

/** Largest document read in full; beyond this the user is told to narrow the pages. */
export const PDF_MAX_BYTES = 60 * 1024 * 1024;

export interface PdfText {
    numPages: number;
    /** 1-based pages actually read, in order. */
    pages: number[];
    title: string;
    text: string;
    truncated: boolean;
}

/** `%PDF-` within the first kilobyte (some files carry a byte-order mark or junk before it). */
export function isPdfBytes(head: Uint8Array): boolean {
    const n = Math.min(head.length, 1024);
    for (let i = 0; i + 4 < n; i++) {
        if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) { return true; }
    }
    return false;
}

/** `.pdf` in the URL path — the cheap check; arXiv-style `/pdf/1234.5678` needs sniffing the bytes. */
export function isPdfUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return /\.pdf$/i.test(u.pathname) || /^\/pdf\//i.test(u.pathname);
    } catch { return false; }
}

/** "1-5, 8, 12-" → [1,2,3,4,5,8,12,…,numPages]. Empty or invalid → all pages. */
export function parsePageRange(spec: string, numPages: number): number[] {
    const wanted = new Set<number>();
    const clean = (spec ?? '').trim();
    if (!clean) { return Array.from({ length: numPages }, (_, i) => i + 1); }
    for (const part of clean.split(/[,\s]+/).filter(Boolean)) {
        const m = part.match(/^(\d+)?(?:-(\d+)?)?$/);
        if (!m || (m[1] === undefined && m[2] === undefined)) { continue; }
        const from = m[1] ? Number(m[1]) : 1;
        const to = part.includes('-') ? (m[2] ? Number(m[2]) : numPages) : from;
        for (let p = Math.max(1, from); p <= Math.min(numPages, to); p++) { wanted.add(p); }
    }
    return wanted.size ? Array.from(wanted).sort((a, b) => a - b) : Array.from({ length: numPages }, (_, i) => i + 1);
}

interface TextItemLike { str: string; hasEOL?: boolean; transform?: number[] }

/** Join a page's text items into lines: a new line when pdf.js says so or when the baseline moves. */
export function assemblePage(items: TextItemLike[]): string {
    let out = '';
    let lastY: number | null = null;
    for (const item of items) {
        if (typeof item.str !== 'string') { continue; }
        const y = item.transform ? item.transform[5] : null;
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) { out += '\n'; }
        out += item.str;
        if (item.hasEOL) { out += '\n'; }
        else if (item.str && !/\s$/.test(item.str)) { out += ' '; }
        if (y !== null) { lastY = y; }
    }
    return out
        .replace(/[ \t]+\n/g, '\n')
        .replace(/([a-z])-\n([a-z])/g, '$1$2')   // words hyphenated across lines
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Extract text from PDF bytes, page by page, with `[page N]` markers. */
export async function extractPdfText(data: ArrayBuffer | Uint8Array, options: { maxChars: number; pages?: string }): Promise<PdfText> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const task = pdfjs.getDocument({
        data: bytes,
        disableFontFace: true,         // no rendering here, so no need to load fonts into the page
        useSystemFonts: false,
        verbosity: 0
    });
    const doc = await task.promise;
    try {
        const numPages = doc.numPages;
        let title = '';
        try {
            const meta = await doc.getMetadata();
            const info = meta.info as { Title?: unknown } | undefined;
            title = typeof info?.Title === 'string' ? info.Title.trim() : '';
        } catch { /* metadata is optional */ }

        const pages = parsePageRange(options.pages ?? '', numPages);
        const parts: string[] = [];
        let total = 0;
        let truncated = false;
        const read: number[] = [];
        for (const p of pages) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            const text = assemblePage(content.items as TextItemLike[]);
            page.cleanup();
            const block = `[page ${p}]\n${text}`;
            if (total + block.length > options.maxChars) {
                const room = Math.max(0, options.maxChars - total);
                if (room > 200) { parts.push(block.slice(0, room)); read.push(p); }
                truncated = true;
                break;
            }
            parts.push(block);
            read.push(p);
            total += block.length + 2;
        }
        return { numPages, pages: read, title, text: parts.join('\n\n'), truncated };
    } finally {
        await task.destroy();
    }
}
