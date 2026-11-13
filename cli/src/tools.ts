/**
 * The CLI host's tools: the read-only built-ins the editor ships, reimplemented for Node with
 * the same output conventions as the CWL runner, plus `run-command`. Everything stays inside
 * the workspace: paths are resolved through realpath and rejected when they escape it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';

export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.venv', '__pycache__', '.continued']);

export function inside(root: string, rel: string): string {
    const target = path.resolve(root, rel);
    const realRoot = fs.realpathSync(root);
    let real = target;
    try { real = fs.realpathSync(target); } catch { real = path.resolve(realRoot, path.relative(root, target)); }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new Error(`Access denied: '${rel}' is outside the workspace`);
    }
    return target;
}

/** Glob → RegExp over `/`-separated relative paths. `**` spans directories; `*` does not. */
export function globToRegExp(pattern: string): RegExp {
    let p = pattern.replace(/^\.\//, '');
    if (!p.includes('/') && !p.startsWith('**')) { p = `**/${p}`; }
    let out = '^';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') {
                i++;
                if (p[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
            } else { out += '[^/]*'; }
        } else if (c === '?') { out += '[^/]'; }
        else if (c === '{') {
            const end = p.indexOf('}', i);
            if (end === -1) { out += '\\{'; continue; }
            out += '(?:' + p.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
            i = end;
        } else if ('.+^$()|[]\\'.includes(c)) { out += '\\' + c; }
        else { out += c; }
    }
    return new RegExp(out + '$');
}

export function walk(root: string, pattern = '**/*', max = 5000): string[] {
    const re = globToRegExp(pattern);
    const found: string[] = [];
    const visit = (dir: string, rel: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (found.length >= max) { return; }
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { visit(path.join(dir, e.name), r); } }
            else if (e.isFile() && re.test(r)) { found.push(r); }
        }
    };
    visit(root, '');
    return found.sort();
}

export function shell(root: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; text: string; code: number | null }> {
    return new Promise(resolve => {
        const child = spawn(command, { shell: true, cwd: root, env: process.env });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        const onAbort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { err += String(d); });
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            const text = (out + (err ? `\n${err}` : '')).trim();
            resolve({ ok: code === 0, text, code });
        });
        child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: e.message, code: null }); });
    });
}

function git(root: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
        execFile('git', args, { cwd: root, timeout: 30000 }, (error, stdout, stderr) => {
            resolve(error ? `FAILED: ${(stderr || error.message).trim()}` : stdout.trimEnd());
        });
    });
}

const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

export interface CliTool {
    id: string;
    readOnly: boolean;
    description: string;
    execute(root: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<string>;
}

export const tools: CliTool[] = [
    {
        id: 'run-command', readOnly: false,
        description: 'Run a shell command in the workspace.',
        async execute(root, args, timeoutMs, signal) {
            const command = str(args.command).trim();
            if (!command) { throw new Error('run-command: no command given'); }
            const r = await shell(root, command, timeoutMs, signal);
            if (!r.ok) { throw new Error(`Command exited with code ${r.code ?? 'unknown'}:\n${r.text}`.trim()); }
            return r.text;
        }
    },
    {
        id: 'read-file', readOnly: true, description: 'Read a workspace file.',
        async execute(root, args) {
            const rel = str(args.filePath || args.path);
            if (!rel) { throw new Error('read-file: no file path was given. If this step uses {{activeFile}}, pass --file.'); }
            return fs.readFileSync(inside(root, rel), 'utf8');
        }
    },
    {
        id: 'grep-search', readOnly: true, description: 'Regex search across files.',
        async execute(root, args) {
            const re = new RegExp(str(args.query || args.pattern));
            const hits: string[] = [];
            for (const rel of walk(root, str(args.filePattern, '**/*'))) {
                let text: string;
                try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && hits.length < 500; i++) {
                    if (re.test(lines[i])) { hits.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`); }
                }
                if (hits.length >= 500) { break; }
            }
            return hits.length ? `Found ${hits.length} matches:\n${hits.join('\n')}` : 'No matches found.';
        }
    },
    {
        id: 'semantic-search', readOnly: true, description: 'Find files by glob.',
        async execute(root, args) {
            const paths = walk(root, str(args.pattern || args.query, '**/*'));
            return paths.length ? `Found ${paths.length} files:\n${paths.join('\n')}` : 'No files found.';
        }
    },
    {
        id: 'list-directory', readOnly: true, description: 'List a directory.',
        async execute(root, args) {
            const dir = inside(root, str(args.path, '.'));
            return fs.readdirSync(dir).sort().join('\n');
        }
    },
    {
        id: 'file-info', readOnly: true, description: 'Size and modification time of a file.',
        async execute(root, args) {
            const rel = str(args.filePath || args.path);
            const st = fs.statSync(inside(root, rel));
            return JSON.stringify({ path: rel, bytes: st.size, modified: st.mtime.toISOString() }, null, 2);
        }
    },
    {
        id: 'git-info', readOnly: true, description: 'git status and recent log.',
        async execute(root) {
            return `${await git(root, ['status', '--short', '--branch'])}\n\n${await git(root, ['log', '-8', '--oneline'])}`;
        }
    },
    {
        id: 'csv-preview', readOnly: true, description: 'First rows of a CSV file.',
        async execute(root, args) {
            const rows = Number(args.rows) || 20;
            return fs.readFileSync(inside(root, str(args.filePath || args.path)), 'utf8').split('\n').slice(0, rows).join('\n');
        }
    },
    {
        id: 'json-query', readOnly: true, description: 'Dot-path lookup in a JSON file.',
        async execute(root, args) {
            let value: unknown = JSON.parse(fs.readFileSync(inside(root, str(args.filePath || args.path)), 'utf8'));
            for (const part of str(args.query).split('.').filter(Boolean)) {
                value = Array.isArray(value) ? value[Number(part)] : (value as Record<string, unknown>)[part];
            }
            return JSON.stringify(value, null, 2);
        }
    }
];

export interface CliResource { id: string; description: string; fetch(root: string): Promise<string>; }

export const resources: CliResource[] = [
    {
        id: 'workspace-files', description: 'File inventory of the workspace.',
        async fetch(root) { const paths = walk(root); return paths.length ? `Found ${paths.length} files:\n${paths.join('\n')}` : 'No files found.'; }
    },
    {
        id: 'git-summary', description: 'Branch, status and recent commits.',
        async fetch(root) { return `${await git(root, ['status', '--short', '--branch'])}\n\n${await git(root, ['log', '-8', '--oneline'])}`; }
    }
];
