/**
 * Built-in code skills: deterministic multi-step helpers that need no model.
 * (Model-driven workflows are harnesses; see src/harness.)
 */

import * as fs from 'fs';
import { ISkill } from '../types';
import { formatBytes, walkFiles, workspaceRoot, toRelative } from './common';
import { diagnosticsResource, gitSummaryResource, projectInfoResource, systemInfoResource } from './resources';

export const projectSnapshotSkill: ISkill = {
    id: 'project-snapshot-skill',
    name: 'Project Snapshot',
    version: '1.0.0',
    author: 'Continued',
    description: 'One Markdown report with project info, git summary, current problems and system info. Handy as the first step of any task or harness.',
    enabled: true,
    source: 'built-in',
    category: 'skill',
    steps: [
        { id: 'project', tool: 'project-info', args: {} },
        { id: 'git', tool: 'git-summary', args: {} },
        { id: 'problems', tool: 'diagnostics', args: {} },
        { id: 'system', tool: 'system-info', args: {} }
    ],
    async execute() {
        const section = async (title: string, fetcher: () => Promise<unknown>) => {
            try {
                const value = await fetcher();
                const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                return `## ${title}\n\n\`\`\`\n${text}\n\`\`\``;
            } catch (error) {
                return `## ${title}\n\n_unavailable: ${(error as Error).message}_`;
            }
        };
        const parts = await Promise.all([
            section('Project', () => projectInfoResource.fetch()),
            section('Git', () => gitSummaryResource.fetch()),
            section('Problems', () => diagnosticsResource.fetch()),
            section('System', () => systemInfoResource.fetch())
        ]);
        return `# Project snapshot\n\n${parts.join('\n\n')}`;
    }
};

export const largestFilesSkill: ISkill = {
    id: 'largest-files-skill',
    name: 'Largest Files',
    version: '1.0.0',
    author: 'Continued',
    description: 'List the largest files in the workspace (ignoring node_modules, .git and build outputs). Input: how many to show (default 20), optionally followed by an extension filter, e.g. "30 .ts".',
    enabled: true,
    source: 'built-in',
    category: 'skill',
    steps: [],
    async execute(_context, input?: string) {
        const [countRaw, extRaw] = String(input ?? '').trim().split(/\s+/);
        const count = Math.max(1, Math.min(200, parseInt(countRaw ?? '', 10) || 20));
        const ext = extRaw && extRaw.startsWith('.') ? extRaw.toLowerCase() : null;
        const root = workspaceRoot();
        const files = walkFiles(root, 20000)
            .filter(f => !ext || f.toLowerCase().endsWith(ext))
            .map(f => { try { return { f, size: fs.statSync(f).size }; } catch { return null; } })
            .filter((x): x is { f: string; size: number } => !!x)
            .sort((a, b) => b.size - a.size);
        const total = files.reduce((s, x) => s + x.size, 0);
        const rows = files.slice(0, count).map((x, i) => `${String(i + 1).padStart(3)}. ${formatBytes(x.size).padStart(9)}  ${toRelative(x.f)}`);
        return [`${files.length} file(s)${ext ? ` with ${ext}` : ''}, ${formatBytes(total)} total. Largest ${rows.length}:`, ...rows].join('\n');
    }
};
