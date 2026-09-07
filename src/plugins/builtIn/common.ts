/**
 * Shared helpers for built-in plugins.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);

export function workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder is open');
    }
    return folders[0].uri.fsPath;
}

/** Resolve a path against the workspace root and refuse anything outside it. */
export function resolveInside(relativePath: string): string {
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
        throw new Error('A workspace-relative path is required');
    }
    const root = workspaceRoot();
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Access denied: "${relativePath}" is outside the workspace`);
    }
    return absolute;
}

export function toRelative(absolute: string): string {
    return path.relative(workspaceRoot(), absolute).replace(/\\/g, '/');
}

export function requireString(args: Record<string, any>, name: string): string {
    const value = args?.[name];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Missing required argument: ${name} (string)`);
    }
    return value;
}

export function optionalNumber(args: Record<string, any>, name: string, fallback: number): number {
    const value = args?.[name];
    if (value === undefined || value === null || value === '') { return fallback; }
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isFinite(n) ? n : fallback;
}

export function optionalBool(args: Record<string, any>, name: string, fallback: boolean): boolean {
    const value = args?.[name];
    if (value === undefined || value === null || value === '') { return fallback; }
    if (typeof value === 'boolean') { return value; }
    return /^(true|1|yes)$/i.test(String(value));
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    if (bytes < 1024 * 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', 'venv', '.venv', '.cache', '__pycache__', '.idea', '.vscode-test']);

/** Walk the workspace (bounded) and return absolute file paths. */
export function walkFiles(startAbsolute: string, maxFiles = 5000): string[] {
    const result: string[] = [];
    const stack = [startAbsolute];
    while (stack.length && result.length < maxFiles) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) { stack.push(path.join(dir, entry.name)); }
            } else if (entry.isFile()) {
                result.push(path.join(dir, entry.name));
                if (result.length >= maxFiles) { break; }
            }
        }
    }
    return result;
}

export function guessLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.js': 'JavaScript', '.jsx': 'JavaScript (React)', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
        '.py': 'Python', '.ipynb': 'Jupyter notebook', '.r': 'R', '.jl': 'Julia', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
        '.c': 'C', '.h': 'C header', '.cpp': 'C++', '.hpp': 'C++ header', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
        '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL', '.md': 'Markdown', '.tex': 'LaTeX', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
        '.toml': 'TOML', '.xml': 'XML', '.html': 'HTML', '.css': 'CSS', '.csv': 'CSV', '.tsv': 'TSV', '.txt': 'Plain text', '.dockerfile': 'Dockerfile'
    };
    if (path.basename(filePath).toLowerCase() === 'dockerfile') { return 'Dockerfile'; }
    return map[ext] ?? (ext ? ext.slice(1).toUpperCase() : 'unknown');
}

export async function runCommand(command: string, timeoutMs = 30000, cwd = workspaceRoot()): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat' } });
        return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 };
    } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
        return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? ''), code: err.killed ? 124 : (typeof err.code === 'number' ? err.code : 1) };
    }
}
