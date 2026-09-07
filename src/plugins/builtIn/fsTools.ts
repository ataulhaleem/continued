/**
 * Built-in file-system tools beyond read/write/delete: listing, inspection,
 * targeted edits, append, move, copy and directory creation.
 *
 * Mutating tools declare `touches()` so the host can snapshot affected files and
 * offer a revert in the Agent Changes panel.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ITool } from '../types';
import { formatBytes, guessLanguage, optionalBool, optionalNumber, requireString, resolveInside, toRelative, IGNORED_DIRS } from './common';

export const listDirectoryTool: ITool = {
    id: 'list-directory',
    name: 'List Directory',
    version: '1.0.0',
    author: 'Continued',
    description: 'List the entries of a workspace directory with type and size. args: { path (default "."), depth (default 1, max 4), showHidden }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    readOnly: true,
    args: [
        { name: 'path', description: 'Workspace-relative directory', default: '.' },
        { name: 'depth', description: 'How many levels to descend (1–4)', default: '1' },
        { name: 'showHidden', description: 'Include dot-files (true/false)', default: 'false' }
    ],
    async execute(args) {
        const rel = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
        const root = resolveInside(rel);
        const depth = Math.min(4, Math.max(1, optionalNumber(args, 'depth', 1)));
        const showHidden = optionalBool(args, 'showHidden', false);
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            throw new Error(`Not a directory: ${rel}`);
        }
        const lines: string[] = [];
        let count = 0;
        const visit = (dir: string, level: number) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const entry of entries) {
                if (!showHidden && entry.name.startsWith('.')) { continue; }
                if (count++ >= 400) { lines.push(`${'  '.repeat(level)}… (truncated at 400 entries)`); return; }
                const full = path.join(dir, entry.name);
                const indent = '  '.repeat(level);
                if (entry.isDirectory()) {
                    const skipped = IGNORED_DIRS.has(entry.name);
                    lines.push(`${indent}${entry.name}/${skipped ? '  (not expanded)' : ''}`);
                    if (level + 1 < depth && !skipped) { visit(full, level + 1); }
                } else {
                    let size = '';
                    try { size = formatBytes(fs.statSync(full).size); } catch { /* ignore */ }
                    lines.push(`${indent}${entry.name}  ${size}`);
                }
            }
        };
        visit(root, 0);
        return lines.length ? `${rel}/\n${lines.join('\n')}` : `${rel}/ is empty`;
    }
};

export const fileInfoTool: ITool = {
    id: 'file-info',
    name: 'File Info',
    version: '1.0.0',
    author: 'Continued',
    description: 'Size, line/word count, language, modified time and the first lines of a file without reading all of it. args: { filePath, headLines (default 20) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    readOnly: true,
    args: [
        { name: 'filePath', description: 'Workspace-relative path', required: true },
        { name: 'headLines', description: 'How many leading lines to show', default: '20' }
    ],
    async execute(args) {
        const rel = requireString(args, 'filePath');
        const abs = resolveInside(rel);
        if (!fs.existsSync(abs)) { throw new Error(`File not found: ${rel}`); }
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) { throw new Error(`${rel} is a directory; use list-directory`); }
        const headLines = Math.max(0, optionalNumber(args, 'headLines', 20));
        const isBinary = stat.size > 0 && (() => {
            const fd = fs.openSync(abs, 'r');
            const buf = Buffer.alloc(Math.min(4096, stat.size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            return buf.includes(0);
        })();
        const lines = [
            `path: ${rel}`,
            `size: ${formatBytes(stat.size)} (${stat.size} bytes)`,
            `language: ${guessLanguage(abs)}${isBinary ? ' (binary)' : ''}`,
            `modified: ${stat.mtime.toISOString()}`
        ];
        if (!isBinary && stat.size <= 8 * 1024 * 1024) {
            const text = fs.readFileSync(abs, 'utf-8');
            const allLines = text.split('\n');
            const words = text.split(/\s+/).filter(Boolean).length;
            lines.push(`lines: ${allLines.length}`, `words: ${words}`);
            if (headLines > 0) {
                lines.push('', `--- first ${Math.min(headLines, allLines.length)} lines ---`, ...allLines.slice(0, headLines));
            }
        }
        return lines.join('\n');
    }
};

export const editFileTool: ITool = {
    id: 'edit-file',
    name: 'Edit File (find & replace)',
    version: '1.0.0',
    author: 'Continued',
    description: 'Replace text inside a file without rewriting the whole file. By default `find` must match exactly once. args: { filePath, find, replace, all (replace every match), regex (treat find as a regular expression) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'filePath', description: 'Workspace-relative path', required: true },
        { name: 'find', description: 'Text (or regex) to look for', required: true, multiline: true },
        { name: 'replace', description: 'Replacement text', required: true, multiline: true },
        { name: 'all', description: 'Replace all occurrences (true/false)', default: 'false' },
        { name: 'regex', description: 'Interpret find as a JavaScript regex (true/false)', default: 'false' }
    ],
    touches: (args) => [String(args.filePath ?? '')],
    async execute(args) {
        const rel = requireString(args, 'filePath');
        const find = requireString(args, 'find');
        const replace = typeof args.replace === 'string' ? args.replace : '';
        const all = optionalBool(args, 'all', false);
        const useRegex = optionalBool(args, 'regex', false);
        const abs = resolveInside(rel);
        if (!fs.existsSync(abs)) { throw new Error(`File not found: ${rel}`); }
        const original = fs.readFileSync(abs, 'utf-8');

        let updated: string;
        let count = 0;
        if (useRegex) {
            let re: RegExp;
            try { re = new RegExp(find, all ? 'g' : ''); } catch (e) { throw new Error(`Invalid regex: ${(e as Error).message}`); }
            updated = original.replace(re, () => { count++; return replace; });
        } else {
            const occurrences = original.split(find).length - 1;
            if (occurrences === 0) { throw new Error(`"${find.slice(0, 80)}" was not found in ${rel}`); }
            if (occurrences > 1 && !all) {
                throw new Error(`"${find.slice(0, 80)}" occurs ${occurrences} times in ${rel}; add more context to make it unique or set all=true`);
            }
            count = all ? occurrences : 1;
            updated = all ? original.split(find).join(replace) : original.replace(find, () => replace);
        }
        if (count === 0) { throw new Error(`Pattern did not match anything in ${rel}`); }
        fs.writeFileSync(abs, updated, 'utf-8');
        return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${rel} (${updated.split('\n').length} lines now)`;
    }
};

export const appendFileTool: ITool = {
    id: 'append-file',
    name: 'Append to File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Append text to the end of a file, creating it if needed. args: { filePath, content, newline (add a line break first, default true) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'filePath', description: 'Workspace-relative path', required: true },
        { name: 'content', description: 'Text to append', required: true, multiline: true },
        { name: 'newline', description: 'Ensure the file ends with a newline before appending', default: 'true' }
    ],
    touches: (args) => [String(args.filePath ?? '')],
    async execute(args) {
        const rel = requireString(args, 'filePath');
        const content = typeof args.content === 'string' ? args.content : '';
        const newline = optionalBool(args, 'newline', true);
        const abs = resolveInside(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        let prefix = '';
        if (newline && fs.existsSync(abs)) {
            const existing = fs.readFileSync(abs, 'utf-8');
            if (existing.length && !existing.endsWith('\n')) { prefix = '\n'; }
        }
        fs.appendFileSync(abs, prefix + content, 'utf-8');
        return `Appended ${content.length} characters to ${rel}`;
    }
};

export const moveFileTool: ITool = {
    id: 'move-file',
    name: 'Move / Rename File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Move or rename a file inside the workspace. args: { from, to, overwrite (default false) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'from', description: 'Current workspace-relative path', required: true },
        { name: 'to', description: 'New workspace-relative path', required: true },
        { name: 'overwrite', description: 'Replace the destination if it exists', default: 'false' }
    ],
    touches: (args) => [String(args.from ?? ''), String(args.to ?? '')],
    async execute(args) {
        const from = resolveInside(requireString(args, 'from'));
        const to = resolveInside(requireString(args, 'to'));
        if (!fs.existsSync(from)) { throw new Error(`Source not found: ${args.from}`); }
        if (fs.statSync(from).isDirectory()) { throw new Error('move-file only moves files, not directories'); }
        if (fs.existsSync(to) && !optionalBool(args, 'overwrite', false)) { throw new Error(`Destination exists: ${args.to} (set overwrite=true to replace)`); }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return `Moved ${toRelative(from)} → ${toRelative(to)}`;
    }
};

export const copyFileTool: ITool = {
    id: 'copy-file',
    name: 'Copy File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Copy a file inside the workspace. args: { from, to, overwrite (default false) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'from', description: 'Source workspace-relative path', required: true },
        { name: 'to', description: 'Destination workspace-relative path', required: true },
        { name: 'overwrite', description: 'Replace the destination if it exists', default: 'false' }
    ],
    touches: (args) => [String(args.to ?? '')],
    async execute(args) {
        const from = resolveInside(requireString(args, 'from'));
        const to = resolveInside(requireString(args, 'to'));
        if (!fs.existsSync(from)) { throw new Error(`Source not found: ${args.from}`); }
        if (fs.statSync(from).isDirectory()) { throw new Error('copy-file only copies files, not directories'); }
        if (fs.existsSync(to) && !optionalBool(args, 'overwrite', false)) { throw new Error(`Destination exists: ${args.to} (set overwrite=true to replace)`); }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        return `Copied ${toRelative(from)} → ${toRelative(to)} (${formatBytes(fs.statSync(to).size)})`;
    }
};

export const makeDirectoryTool: ITool = {
    id: 'make-directory',
    name: 'Make Directory',
    version: '1.0.0',
    author: 'Continued',
    description: 'Create a directory (and parents) inside the workspace. args: { path }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'path', description: 'Workspace-relative directory path', required: true }],
    async execute(args) {
        const rel = requireString(args, 'path');
        const abs = resolveInside(rel);
        if (fs.existsSync(abs)) { return `${rel} already exists`; }
        fs.mkdirSync(abs, { recursive: true });
        return `Created directory ${rel}`;
    }
};
