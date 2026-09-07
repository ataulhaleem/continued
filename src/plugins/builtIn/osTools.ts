/**
 * Built-in OS / developer tools: read-only git queries, an opt-in Python runner
 * and an opt-in HTTP fetch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ITool } from '../types';
import { optionalNumber, requireString, resolveInside, runCommand, workspaceRoot } from './common';

export const gitInfoTool: ITool = {
    id: 'git-info',
    name: 'Git Info',
    version: '1.0.0',
    author: 'Continued',
    description: 'Read-only git queries. args: { action: status|diff|log|branches|show, path (optional file to scope diff/log), count (log entries, default 10), ref (for show) }',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    readOnly: true,
    args: [
        { name: 'action', description: 'status | diff | log | branches | show', default: 'status' },
        { name: 'path', description: 'Limit diff/log to this file or folder' },
        { name: 'count', description: 'Number of log entries', default: '10' },
        { name: 'ref', description: 'Commit or ref for show (default HEAD)' }
    ],
    async execute(args) {
        const action = String(args.action || 'status').toLowerCase();
        const scope = typeof args.path === 'string' && args.path.trim() ? ` -- ${JSON.stringify(args.path.trim())}` : '';
        const count = Math.max(1, Math.min(100, optionalNumber(args, 'count', 10)));
        const ref = typeof args.ref === 'string' && /^[A-Za-z0-9._\/~^-]+$/.test(args.ref) ? args.ref : 'HEAD';
        let command: string;
        switch (action) {
            case 'status': command = 'git status --short --branch'; break;
            case 'diff': command = `git diff --stat && git diff${scope}`; break;
            case 'staged': command = `git diff --cached${scope}`; break;
            case 'log': command = `git log -${count} --date=short --pretty=format:"%h %ad %an  %s"${scope}`; break;
            case 'branches': command = 'git branch -a -vv'; break;
            case 'show': command = `git show --stat ${ref}`; break;
            default: throw new Error(`Unknown action "${action}". Use status, diff, staged, log, branches or show.`);
        }
        const result = await runCommand(command, 30000);
        if (result.code !== 0 && !result.stdout) {
            throw new Error(result.stderr.trim() || `git exited with code ${result.code}`);
        }
        const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
        return out.length > 20000 ? `${out.slice(0, 20000)}\n…[truncated]` : (out || '(clean)');
    }
};

export const pythonRunTool: ITool = {
    id: 'python-run',
    name: 'Run Python',
    version: '1.0.0',
    author: 'Continued',
    description: 'Run a Python snippet (or a script file) with the workspace as cwd and return stdout/stderr. Disabled by default; enable it in Plugin Manager. args: { code (snippet) or filePath (script), args (extra CLI args), timeoutMs (default 60000), python (interpreter, default python3) }',
    enabled: false,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'code', description: 'Python source to run', multiline: true },
        { name: 'filePath', description: 'Or: workspace-relative script to run' },
        { name: 'args', description: 'Extra command-line arguments' },
        { name: 'timeoutMs', description: 'Timeout', default: '60000' },
        { name: 'python', description: 'Interpreter', default: 'python3' }
    ],
    async execute(args) {
        const interpreter = typeof args.python === 'string' && /^[A-Za-z0-9_./\\-]+$/.test(args.python) ? args.python : 'python3';
        const timeout = Math.max(1000, optionalNumber(args, 'timeoutMs', 60000));
        const extra = typeof args.args === 'string' ? ` ${args.args}` : '';
        let scriptPath: string;
        let cleanup: (() => void) | null = null;
        if (typeof args.filePath === 'string' && args.filePath.trim()) {
            scriptPath = resolveInside(args.filePath);
            if (!fs.existsSync(scriptPath)) { throw new Error(`Script not found: ${args.filePath}`); }
        } else {
            const code = requireString(args, 'code');
            const tmp = path.join(os.tmpdir(), `continued-${process.pid}-${Date.now()}.py`);
            fs.writeFileSync(tmp, code, 'utf-8');
            scriptPath = tmp;
            cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
        }
        try {
            const result = await runCommand(`${interpreter} ${JSON.stringify(scriptPath)}${extra}`, timeout, workspaceRoot());
            const parts = [result.stdout.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ''].filter(Boolean);
            const body = parts.join('\n') || '(no output)';
            const capped = body.length > 20000 ? `${body.slice(0, 20000)}\n…[truncated]` : body;
            if (result.code !== 0) { throw new Error(`Python exited with code ${result.code}${result.code === 124 ? ' (timeout)' : ''}\n${capped}`); }
            return capped;
        } finally {
            cleanup?.();
        }
    }
};

export const httpFetchTool: ITool = {
    id: 'http-fetch',
    name: 'HTTP Fetch',
    version: '1.0.0',
    author: 'Continued',
    description: 'GET a public URL and return the body as text (HTML is reduced to text). Disabled by default; enable it in Plugin Manager. args: { url, maxChars (default 8000), raw (keep HTML, default false) }',
    enabled: false,
    source: 'built-in',
    category: 'tool',
    args: [
        { name: 'url', description: 'http(s) URL', required: true },
        { name: 'maxChars', description: 'Output cap', default: '8000' },
        { name: 'raw', description: 'Return the raw body instead of extracted text', default: 'false' }
    ],
    async execute(args) {
        const url = requireString(args, 'url').trim();
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
        if (!/^https?:$/.test(parsed.protocol)) { throw new Error('Only http and https URLs are allowed'); }
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/.test(parsed.hostname)) {
            throw new Error('Requests to local or private network addresses are not allowed');
        }
        const maxChars = Math.max(500, optionalNumber(args, 'maxChars', 8000));
        const raw = /^(true|1|yes)$/i.test(String(args.raw ?? 'false'));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Continued-VSCode/1.0 (+https://github.com/ataulhaleem/continued)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, redirect: 'follow' });
            const type = response.headers.get('content-type') ?? '';
            if (!response.ok) { throw new Error(`HTTP ${response.status} ${response.statusText}`); }
            let body = await response.text();
            if (!raw && /html/i.test(type)) {
                body = body
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
                    .trim();
            }
            const header = `${response.status} ${type.split(';')[0]} · ${body.length} chars\n\n`;
            return header + (body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated]` : body);
        } catch (error) {
            if ((error as Error).name === 'AbortError') { throw new Error('Request timed out after 30s'); }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
};
