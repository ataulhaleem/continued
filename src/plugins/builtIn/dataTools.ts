/**
 * Built-in data tools: quick looks at CSV and JSON files without loading them
 * into the model whole.
 */

import * as fs from 'fs';
import { ITool } from '../types';
import { optionalNumber, requireString, resolveInside } from './common';

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string, delimiter = ','): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else { field += ch; }
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === delimiter) { row.push(field); field = ''; continue; }
        if (ch === '\r') { continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

function detectDelimiter(sample: string): string {
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestScore = -1;
    for (const d of candidates) {
        const counts = sample.split('\n').slice(0, 5).map(l => l.split(d).length - 1);
        const min = Math.min(...counts);
        const score = min > 0 && counts.every(c => c === counts[0]) ? min * 2 : min;
        if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
}

export const csvPreviewTool: ITool = {
    id: 'csv-preview',
    name: 'CSV Preview',
    version: '1.0.0',
    author: 'Continued',
    description: 'Inspect a CSV/TSV file: columns, row count, sample rows and min/max/mean for numeric columns. args: { filePath, rows (sample rows, default 10), delimiter (auto) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    readOnly: true,
    args: [
        { name: 'filePath', description: 'Workspace-relative CSV/TSV path', required: true },
        { name: 'rows', description: 'Sample rows to show', default: '10' },
        { name: 'delimiter', description: 'Column separator; auto-detected when empty' }
    ],
    async execute(args) {
        const rel = requireString(args, 'filePath');
        const abs = resolveInside(rel);
        if (!fs.existsSync(abs)) { throw new Error(`File not found: ${rel}`); }
        const stat = fs.statSync(abs);
        if (stat.size > 50 * 1024 * 1024) { throw new Error(`File too large for preview (${Math.round(stat.size / 1024 / 1024)} MB)`); }
        const text = fs.readFileSync(abs, 'utf-8');
        const delimiter = typeof args.delimiter === 'string' && args.delimiter ? (args.delimiter === '\\t' ? '\t' : args.delimiter) : detectDelimiter(text.slice(0, 5000));
        const rows = parseCsv(text, delimiter);
        if (rows.length === 0) { return `${rel} is empty`; }
        const header = rows[0];
        const data = rows.slice(1);
        const sample = Math.max(1, optionalNumber(args, 'rows', 10));

        const lines: string[] = [
            `file: ${rel}`,
            `delimiter: ${delimiter === '\t' ? 'TAB' : JSON.stringify(delimiter)}`,
            `columns (${header.length}): ${header.join(', ')}`,
            `data rows: ${data.length}`,
            ''
        ];

        // Column stats
        lines.push('column summary:');
        header.forEach((name, idx) => {
            const values = data.map(r => (r[idx] ?? '').trim());
            const nonEmpty = values.filter(v => v !== '');
            const numeric = nonEmpty.map(Number).filter(n => Number.isFinite(n));
            if (nonEmpty.length && numeric.length === nonEmpty.length) {
                const min = Math.min(...numeric), max = Math.max(...numeric);
                const mean = numeric.reduce((a, b) => a + b, 0) / numeric.length;
                lines.push(`  ${name}: numeric · min ${min} · max ${max} · mean ${mean.toFixed(3)} · empty ${values.length - nonEmpty.length}`);
            } else {
                const distinct = new Set(nonEmpty).size;
                lines.push(`  ${name}: text · distinct ${distinct} · empty ${values.length - nonEmpty.length}${distinct <= 6 ? ` · values ${[...new Set(nonEmpty)].slice(0, 6).join(' | ')}` : ''}`);
            }
        });

        lines.push('', `first ${Math.min(sample, data.length)} rows:`);
        lines.push(header.join(' | '));
        data.slice(0, sample).forEach(r => lines.push(r.map(v => v.length > 40 ? `${v.slice(0, 37)}…` : v).join(' | ')));
        return lines.join('\n');
    }
};

function getPath(value: unknown, dotted: string): unknown {
    if (!dotted.trim()) { return value; }
    let current: unknown = value;
    for (const part of dotted.split('.').filter(Boolean)) {
        if (current === null || typeof current !== 'object') { throw new Error(`Path "${dotted}" not found (stopped at "${part}")`); }
        const key = /^\d+$/.test(part) && Array.isArray(current) ? Number(part) : part;
        current = (current as Record<string | number, unknown>)[key as never];
        if (current === undefined) { throw new Error(`Path "${dotted}" not found (no "${part}")`); }
    }
    return current;
}

function describe(value: unknown, depth = 0): string {
    if (Array.isArray(value)) {
        return `array[${value.length}]${value.length ? ` of ${describe(value[0], depth + 1)}` : ''}`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value as object);
        if (depth >= 1) { return `object{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`; }
        return `object with ${keys.length} keys`;
    }
    return typeof value;
}

export const jsonQueryTool: ITool = {
    id: 'json-query',
    name: 'JSON Query',
    version: '1.0.0',
    author: 'Continued',
    description: 'Read part of a JSON file by dot path (e.g. "dependencies" or "items.0.name") or summarise its shape when path is empty. args: { filePath, path, maxChars (default 4000) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    readOnly: true,
    args: [
        { name: 'filePath', description: 'Workspace-relative JSON path', required: true },
        { name: 'path', description: 'Dot path inside the document; empty for an overview' },
        { name: 'maxChars', description: 'Output cap', default: '4000' }
    ],
    async execute(args) {
        const rel = requireString(args, 'filePath');
        const abs = resolveInside(rel);
        if (!fs.existsSync(abs)) { throw new Error(`File not found: ${rel}`); }
        let doc: unknown;
        try { doc = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch (e) { throw new Error(`${rel} is not valid JSON: ${(e as Error).message}`); }
        const dotted = typeof args.path === 'string' ? args.path : '';
        const maxChars = Math.max(200, optionalNumber(args, 'maxChars', 4000));
        const value = getPath(doc, dotted);
        if (!dotted.trim() && value && typeof value === 'object' && !Array.isArray(value)) {
            const lines = Object.entries(value as Record<string, unknown>).map(([k, v]) => `  ${k}: ${describe(v, 1)}`);
            return `${rel}: object with ${lines.length} keys\n${lines.slice(0, 80).join('\n')}${lines.length > 80 ? '\n  …' : ''}`;
        }
        const text = JSON.stringify(value, null, 2);
        return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated, ${text.length} chars total]` : text;
    }
};
