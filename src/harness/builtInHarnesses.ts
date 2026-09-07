/**
 * Built-in harnesses. They ship with the extension and double as examples for users.
 */

import { HarnessDefinition } from './types';

export const builtInHarnesses: HarnessDefinition[] = [
    {
        id: 'workspace-health-harness',
        name: 'Workspace health check (parallel lanes)',
        description: 'Runs four checks at the same time — a git lane (status, recent commits, model summary), a TODO/FIXME scan, a test-file inventory and the workspace file list — then writes a one-page health report. In Agent mode you will be asked to approve the two git commands.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Focus (optional)', placeholder: 'e.g. "we are preparing a release"', required: false },
        steps: [
            {
                id: 'checks',
                name: 'Run checks in parallel',
                type: 'parallel',
                steps: [
                    {
                        id: 'git-lane',
                        name: 'Git',
                        type: 'sequence',
                        steps: [
                            { id: 'git-status', name: 'Working tree', type: 'tool', pluginId: 'run-command', args: { command: 'git status --short' }, onError: 'continue', timeoutMs: 30000 },
                            { id: 'git-log', name: 'Recent commits', type: 'tool', pluginId: 'run-command', args: { command: 'git log -8 --oneline' }, onError: 'continue', timeoutMs: 30000 },
                            {
                                id: 'git-summary',
                                name: 'Summarise git',
                                type: 'llm',
                                when: '{{steps.git-log.status}} == done',
                                prompt: 'In at most 4 bullets: what were the last commits (step git-log) about, and is the working tree clean (step git-status)? If git-status failed, say the repository state is unknown. Plain Markdown bullets, no headings.'
                            }
                        ]
                    },
                    { id: 'todos', name: 'TODO / FIXME scan', type: 'tool', pluginId: 'grep-search', args: { query: 'TODO|FIXME|HACK', filePattern: '**/*.{ts,tsx,js,py,go,rs,java,md}' }, onError: 'continue' },
                    { id: 'tests', name: 'Test files', type: 'tool', pluginId: 'semantic-search', args: { pattern: '**/*.{test,spec}.*' }, onError: 'retry-then-continue', retries: 1 },
                    { id: 'inventory', name: 'File inventory', type: 'resource', pluginId: 'workspace-files', onError: 'continue' }
                ]
            },
            {
                id: 'report',
                name: 'Health report',
                type: 'llm',
                prompt: 'Write a concise workspace health report in Markdown with exactly these sections: "## Repository" (use the git summary), "## Open work" (count and highlight the most important TODO/FIXME/HACK lines from step todos), "## Tests" (how many test files exist, from step tests, and whether that looks thin for the size of the file inventory), "## Risks & next steps" (3 bullets max). {{input}}\nIf any check failed or was skipped, state that in the relevant section instead of guessing.'
            }
        ]
    },
    {
        id: 'explain-file-harness',
        name: 'Explain the active file',
        description: 'Reads the file open in the editor and explains what it does, function by function.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Focus (optional)', placeholder: 'e.g. "focus on error handling"', required: false },
        steps: [
            { id: 'read', name: 'Read active file', type: 'tool', pluginId: 'read-file', args: { filePath: '{{activeFile}}' } },
            {
                id: 'explain',
                name: 'Explain',
                type: 'llm',
                prompt: 'Explain the file `{{activeFile}}` shown in the run context: purpose, main parts, notable risks. {{input}}\nUse Markdown with short sections.'
            }
        ]
    },
    {
        id: 'review-todos-harness',
        name: 'Review TODOs and FIXMEs',
        description: 'Greps the workspace for TODO and FIXME markers in parallel, then produces a prioritised list.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'File pattern', placeholder: '**/*.ts (default: all files)', required: false },
        steps: [
            {
                id: 'scan',
                name: 'Scan markers',
                type: 'parallel',
                steps: [
                    { id: 'todos', name: 'TODO', type: 'tool', pluginId: 'grep-search', args: { query: 'TODO', filePattern: '{{input}}' }, onError: 'continue' },
                    { id: 'fixmes', name: 'FIXME', type: 'tool', pluginId: 'grep-search', args: { query: 'FIXME', filePattern: '{{input}}' }, onError: 'continue' }
                ]
            },
            {
                id: 'report',
                name: 'Prioritise',
                type: 'llm',
                prompt: 'From the grep results in the run context, produce a Markdown table of TODO/FIXME items with columns File, Line, Text, Suggested priority (high/medium/low) and a one-line reason. Group by priority. If a grep step failed or found nothing, say so.'
            }
        ]
    },
    {
        id: 'test-and-explain-harness',
        name: 'Run tests and explain failures',
        description: 'Runs the test command (continues on failure) and asks the model to explain failures and propose fixes.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Test command', placeholder: 'npm test', required: false },
        steps: [
            { id: 'tests', name: 'Run tests', type: 'tool', pluginId: 'run-command', args: { command: '{{input}}' }, onError: 'continue', timeoutMs: 300000 },
            {
                id: 'explain',
                name: 'Explain results',
                type: 'llm',
                when: '{{steps.tests.status}} == failed',
                prompt: 'The test command failed. Using the output and error in the run context, list each failing test, the most likely cause, and a concrete fix. Be specific about file names and lines when they appear in the output.'
            },
            {
                id: 'ok',
                name: 'All green',
                type: 'llm',
                when: '{{steps.tests.status}} == done',
                prompt: 'The test command succeeded. Summarise the test output in three lines or fewer.'
            }
        ],
        output: '{{steps.explain.output}}{{steps.ok.output}}'
    },
    {
        id: 'annotate-files-harness',
        name: 'Annotate matching files',
        description: 'Finds files by glob, then for each file asks the model for a one-line summary and collects them into a Markdown list.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Glob', placeholder: 'src/**/*.ts', required: true },
        steps: [
            { id: 'find', name: 'Find files', type: 'tool', pluginId: 'semantic-search', args: { pattern: '{{input}}' } },
            {
                id: 'each',
                name: 'Summarise each file',
                type: 'foreach',
                items: '{{steps.find.lines}}',
                maxItems: 20,
                steps: [
                    { id: 'read', name: 'Read', type: 'tool', pluginId: 'read-file', args: { filePath: '{{item}}' }, onError: 'continue' },
                    {
                        id: 'summary',
                        name: 'Summarise',
                        type: 'llm',
                        when: '{{steps.read.status}} == done',
                        prompt: 'Write ONE line: `{{item}}` — <what this file is for, max 20 words>. Output only that line.'
                    }
                ]
            },
            {
                id: 'collect',
                name: 'Collect',
                type: 'llm',
                prompt: 'Combine the per-file summaries from the run context into a single Markdown bullet list, one bullet per file, keeping the wording. Mention any file whose read failed.'
            }
        ]
    }
];
