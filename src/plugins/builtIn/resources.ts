/**
 * Built-in resources: context the agent (or a harness) can pull in on demand.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IResource } from '../types';
import { formatBytes, runCommand, walkFiles, workspaceRoot, toRelative } from './common';

export const systemInfoResource: IResource = {
    id: 'system-info',
    name: 'System Info',
    version: '1.0.0',
    author: 'Continued',
    description: 'Operating system, CPU, memory, shell, Node and VS Code versions, workspace path.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        const mem = os.totalmem();
        const free = os.freemem();
        let root = '(no workspace)';
        try { root = workspaceRoot(); } catch { /* keep placeholder */ }
        return [
            `os: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
            `hostname: ${os.hostname()}`,
            `cpus: ${os.cpus().length} × ${os.cpus()[0]?.model ?? 'unknown'}`,
            `memory: ${formatBytes(mem - free)} used of ${formatBytes(mem)}`,
            `uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
            `shell: ${process.env.SHELL ?? process.env.ComSpec ?? 'unknown'}`,
            `node: ${process.version} (extension host)`,
            `vscode: ${vscode.version}`,
            `user: ${os.userInfo().username}`,
            `workspace: ${root}`,
            `date: ${new Date().toISOString()}`
        ].join('\n');
    }
};

const TOOLCHAINS: Array<[string, string]> = [
    ['git', 'git --version'],
    ['node', 'node --version'],
    ['npm', 'npm --version'],
    ['pnpm', 'pnpm --version'],
    ['yarn', 'yarn --version'],
    ['python3', 'python3 --version'],
    ['python', 'python --version'],
    ['pip3', 'pip3 --version'],
    ['conda', 'conda --version'],
    ['uv', 'uv --version'],
    ['java', 'java -version'],
    ['go', 'go version'],
    ['rustc', 'rustc --version'],
    ['cargo', 'cargo --version'],
    ['docker', 'docker --version'],
    ['kubectl', 'kubectl version --client --short'],
    ['make', 'make --version'],
    ['cmake', 'cmake --version'],
    ['gcc', 'gcc --version'],
    ['R', 'R --version'],
    ['julia', 'julia --version'],
    ['ollama', 'ollama --version']
];

export const devEnvironmentResource: IResource = {
    id: 'dev-environment',
    name: 'Developer Environment',
    version: '1.0.0',
    author: 'Continued',
    description: 'Which toolchains are installed (git, node, python, conda, docker, go, rust, R, ollama, …) with versions.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        let cwd: string;
        try { cwd = workspaceRoot(); } catch { cwd = os.homedir(); }
        const results = await Promise.all(TOOLCHAINS.map(async ([name, command]) => {
            const r = await runCommand(command, 8000, cwd);
            const text = `${r.stdout}\n${r.stderr}`.trim().split('\n')[0]?.trim() ?? '';
            const ok = r.code === 0 || /version/i.test(text);
            return `${ok ? '✓' : '✗'} ${name}${ok && text ? `: ${text.slice(0, 80)}` : ''}`;
        }));
        return results.join('\n');
    }
};

export const openEditorsResource: IResource = {
    id: 'open-editors',
    name: 'Open Editors',
    version: '1.0.0',
    author: 'Continued',
    description: 'Files currently open in the editor, the active file, cursor position and the selected text.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        const active = vscode.window.activeTextEditor;
        const lines: string[] = [];
        const open = vscode.window.tabGroups.all.flatMap(g => g.tabs)
            .map(t => (t.input as { uri?: vscode.Uri })?.uri)
            .filter((u): u is vscode.Uri => !!u)
            .map(u => vscode.workspace.asRelativePath(u, false));
        lines.push(`open files (${open.length}):`, ...open.map(f => `  ${f}`));
        if (active) {
            const rel = vscode.workspace.asRelativePath(active.document.uri, false);
            const pos = active.selection.active;
            lines.push('', `active: ${rel} (${active.document.languageId}, ${active.document.lineCount} lines${active.document.isDirty ? ', unsaved changes' : ''})`);
            lines.push(`cursor: line ${pos.line + 1}, column ${pos.character + 1}`);
            if (!active.selection.isEmpty) {
                const text = active.document.getText(active.selection);
                lines.push(`selection (lines ${active.selection.start.line + 1}–${active.selection.end.line + 1}):`, text.length > 6000 ? `${text.slice(0, 6000)}\n…[truncated]` : text);
            }
        } else {
            lines.push('', 'active: (none)');
        }
        return lines.join('\n');
    }
};

export const gitSummaryResource: IResource = {
    id: 'git-summary',
    name: 'Git Summary',
    version: '1.0.0',
    author: 'Continued',
    description: 'Current branch, working-tree status, last commits and remotes in one block.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        const inside = await runCommand('git rev-parse --is-inside-work-tree', 8000);
        if (inside.code !== 0) { return 'Not a git repository.'; }
        const [branch, status, log, remotes] = await Promise.all([
            runCommand('git rev-parse --abbrev-ref HEAD', 8000),
            runCommand('git status --short', 15000),
            runCommand('git log -8 --date=short --pretty=format:"%h %ad %an  %s"', 15000),
            runCommand('git remote -v', 8000)
        ]);
        const changed = status.stdout.trim().split('\n').filter(Boolean);
        return [
            `branch: ${branch.stdout.trim() || '(detached)'}`,
            `working tree: ${changed.length ? `${changed.length} changed path(s)` : 'clean'}`,
            ...changed.slice(0, 40).map(l => `  ${l}`),
            changed.length > 40 ? `  … ${changed.length - 40} more` : '',
            '',
            'recent commits:',
            ...log.stdout.trim().split('\n').filter(Boolean).map(l => `  ${l}`),
            '',
            `remotes:\n${remotes.stdout.trim().split('\n').filter(Boolean).map(l => `  ${l}`).join('\n') || '  (none)'}`
        ].filter(l => l !== undefined).join('\n');
    }
};

export const diagnosticsResource: IResource = {
    id: 'diagnostics',
    name: 'Problems (Diagnostics)',
    version: '1.0.0',
    author: 'Continued',
    description: 'Errors and warnings VS Code currently reports (from language servers and linters), grouped by file.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        const all = vscode.languages.getDiagnostics();
        const sev = (s: vscode.DiagnosticSeverity) => s === 0 ? 'error' : s === 1 ? 'warning' : s === 2 ? 'info' : 'hint';
        let errors = 0, warnings = 0;
        const blocks: string[] = [];
        for (const [uri, diags] of all) {
            const relevant = diags.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
            if (!relevant.length) { continue; }
            const rel = vscode.workspace.asRelativePath(uri, false);
            blocks.push(`${rel}:`);
            for (const d of relevant.slice(0, 30)) {
                if (d.severity === 0) { errors++; } else { warnings++; }
                blocks.push(`  ${sev(d.severity)} L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.replace(/\s+/g, ' ').slice(0, 200)}${d.source ? ` [${d.source}]` : ''}`);
            }
            if (relevant.length > 30) { blocks.push(`  … ${relevant.length - 30} more`); }
        }
        if (!blocks.length) { return 'No errors or warnings reported.'; }
        return [`${errors} error(s), ${warnings} warning(s)`, '', ...blocks.slice(0, 400)].join('\n');
    }
};

interface Manifest { file: string; detail: string[] }

function readJson(p: string): Record<string, unknown> | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export const projectInfoResource: IResource = {
    id: 'project-info',
    name: 'Project Info',
    version: '1.0.0',
    author: 'Continued',
    description: 'Detected project type(s), package manager, scripts, dependencies, languages by file count and top-level layout.',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    async fetch() {
        const root = workspaceRoot();
        const manifests: Manifest[] = [];
        const exists = (f: string) => fs.existsSync(path.join(root, f));

        if (exists('package.json')) {
            const pkg = readJson(path.join(root, 'package.json')) ?? {};
            const scripts = Object.keys((pkg.scripts as object) ?? {});
            const deps = Object.keys((pkg.dependencies as object) ?? {});
            const dev = Object.keys((pkg.devDependencies as object) ?? {});
            const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') ? 'bun' : 'npm';
            manifests.push({ file: 'package.json', detail: [
                `name: ${pkg.name ?? '?'} ${pkg.version ?? ''}`.trim(),
                `package manager: ${pm}`,
                `scripts: ${scripts.join(', ') || '(none)'}`,
                `dependencies (${deps.length}): ${deps.slice(0, 25).join(', ')}${deps.length > 25 ? ', …' : ''}`,
                `devDependencies (${dev.length}): ${dev.slice(0, 25).join(', ')}${dev.length > 25 ? ', …' : ''}`
            ] });
        }
        if (exists('pyproject.toml')) {
            const text = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf-8');
            const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
            const deps = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1]?.split('\n').map(l => l.trim().replace(/^"|",?$/g, '')).filter(Boolean) ?? [];
            manifests.push({ file: 'pyproject.toml', detail: [`name: ${name ?? '?'}`, `dependencies (${deps.length}): ${deps.slice(0, 25).join(', ')}`] });
        }
        if (exists('requirements.txt')) {
            const reqs = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            manifests.push({ file: 'requirements.txt', detail: [`packages (${reqs.length}): ${reqs.slice(0, 30).join(', ')}${reqs.length > 30 ? ', …' : ''}`] });
        }
        if (exists('environment.yml')) { manifests.push({ file: 'environment.yml', detail: ['conda environment present'] }); }
        if (exists('Cargo.toml')) { manifests.push({ file: 'Cargo.toml', detail: ['Rust crate'] }); }
        if (exists('go.mod')) { manifests.push({ file: 'go.mod', detail: [fs.readFileSync(path.join(root, 'go.mod'), 'utf-8').split('\n')[0]] }); }
        if (exists('pom.xml')) { manifests.push({ file: 'pom.xml', detail: ['Maven project'] }); }
        if (exists('build.gradle') || exists('build.gradle.kts')) { manifests.push({ file: 'build.gradle', detail: ['Gradle project'] }); }
        if (exists('CMakeLists.txt')) { manifests.push({ file: 'CMakeLists.txt', detail: ['CMake project'] }); }
        if (exists('Makefile')) { manifests.push({ file: 'Makefile', detail: ['Makefile present'] }); }
        if (exists('Dockerfile') || exists('docker-compose.yml') || exists('compose.yaml')) { manifests.push({ file: 'Docker', detail: ['Dockerfile / compose present'] }); }
        if (exists('.github/workflows')) { manifests.push({ file: '.github/workflows', detail: [`CI workflows: ${fs.readdirSync(path.join(root, '.github/workflows')).join(', ')}`] }); }

        const files = walkFiles(root, 8000);
        const byExt = new Map<string, number>();
        for (const f of files) { const ext = path.extname(f).toLowerCase() || '(none)'; byExt.set(ext, (byExt.get(ext) ?? 0) + 1); }
        const langs = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, n]) => `${e} ${n}`).join(', ');
        const topLevel = fs.readdirSync(root, { withFileTypes: true }).filter(e => !e.name.startsWith('.') || e.name === '.github').map(e => e.isDirectory() ? `${e.name}/` : e.name).sort().slice(0, 40);

        const lines: string[] = [`root: ${root}`, `files: ${files.length}${files.length >= 8000 ? '+' : ''} (ignoring node_modules, .git, build outputs)`, `by extension: ${langs}`, '', `top level: ${topLevel.join('  ')}`, ''];
        if (manifests.length) {
            for (const m of manifests) { lines.push(`${m.file}:`, ...m.detail.map(d => `  ${d}`)); }
        } else {
            lines.push('no known project manifest found');
        }
        return lines.join('\n');
    }
};

export { toRelative };
