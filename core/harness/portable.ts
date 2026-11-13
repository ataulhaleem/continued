/**
 * Portable harness documents: export, import, and rendering for other agents.
 *
 * A harness is only useful to a research group if it can leave the machine it was written
 * on. Two things have to travel:
 *
 *  1. The **executable document** — the definition plus enough metadata to tell an importer
 *     what it is, which version of the format it speaks, and which plugins it expects to
 *     find. This is what `toPortable` produces and `fromPortable` accepts.
 *
 *  2. The **procedure**, for tools that cannot execute the definition. None of the agents
 *     documented alongside Blablador read this schema: Codex reads `AGENTS.md`, OpenCode
 *     reads Markdown command files in `.opencode/commands/`, Hermes reads a `CLAUDE.md` and
 *     Markdown skills, and Continue.Dev reads Markdown prompt files. The one interchange
 *     format they share is Markdown, so `toMarkdown` renders the same harness as a
 *     numbered playbook that any of them — or a human — can follow.
 *
 * This module is free of editor and browser APIs so both hosts share it and it can be
 * unit-tested directly.
 */

import { HarnessDefinition, HarnessStep, OnError } from './types';

/**
 * Format version of the exported document, independent of the application version.
 * Bumped only when a change would stop an older importer reading a newer file.
 */
export const PORTABLE_FORMAT_VERSION = '1.0';

export const PORTABLE_SCHEMA_URL = 'https://github.com/ataulhaleem/continued/blob/main/docs/harness-schema.md';

/** What a harness expects to find in the host that runs it. */
export interface HarnessRequirements {
    tools: string[];
    resources: string[];
    skills: string[];
    /** Template variables the harness reads, excluding its own step references. */
    variables: string[];
    /** True when any step consults a language model. */
    usesModel: boolean;
}

/** The exported document. The harness itself is nested so metadata cannot collide with it. */
export interface PortableHarness {
    $schema: string;
    /** Format version, not application version. */
    formatVersion: string;
    exportedAt: string;
    generator: string;
    /** Declared so an importer can report what is missing before running anything. */
    requires: HarnessRequirements;
    harness: HarnessDefinition;
}

export interface ImportResult {
    harness?: HarnessDefinition;
    /** Fatal problems: when non-empty, `harness` is undefined. */
    problems: string[];
    /** Non-fatal remarks, e.g. a newer format version that still parsed. */
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/** Every step in the tree, depth first. */
export function walkSteps(steps: HarnessStep[]): HarnessStep[] {
    const out: HarnessStep[] = [];
    const visit = (list: HarnessStep[]) => {
        for (const step of list ?? []) {
            if (!step || typeof step !== 'object') { continue; }
            out.push(step);
            const children = (step as { steps?: HarnessStep[] }).steps;
            if (Array.isArray(children)) { visit(children); }
        }
    };
    visit(steps);
    return out;
}

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Template variables referenced anywhere in a step, excluding `steps.<id>` back-references. */
function variablesIn(text: unknown, into: Set<string>): void {
    if (typeof text !== 'string') { return; }
    let match: RegExpExecArray | null;
    TEMPLATE_RE.lastIndex = 0;
    while ((match = TEMPLATE_RE.exec(text)) !== null) {
        const name = match[1].trim();
        if (!name || name.startsWith('steps.')) { continue; }
        into.add(name.split('.')[0]);
    }
}

/**
 * What the harness needs from its host. Reported on export so someone opening the file in a
 * different workspace — or a different product — can see what it assumes before running it.
 */
export function collectRequirements(def: HarnessDefinition): HarnessRequirements {
    const tools = new Set<string>();
    const resources = new Set<string>();
    const skills = new Set<string>();
    const variables = new Set<string>();
    let usesModel = false;

    for (const step of walkSteps(def.steps ?? [])) {
        switch (step.type) {
            case 'tool':
                if (step.pluginId) { tools.add(step.pluginId); }
                for (const value of Object.values(step.args ?? {})) { variablesIn(value, variables); }
                break;
            case 'resource':
                if (step.pluginId) { resources.add(step.pluginId); }
                break;
            case 'skill':
                if (step.pluginId) { skills.add(step.pluginId); }
                variablesIn(step.input, variables);
                break;
            case 'llm':
                usesModel = true;
                variablesIn(step.prompt, variables);
                variablesIn(step.system, variables);
                break;
            case 'foreach':
                variablesIn(step.items, variables);
                break;
            default:
                break;
        }
        variablesIn(step.when, variables);
    }
    variablesIn(def.output, variables);

    const sorted = (set: Set<string>) => Array.from(set).sort();
    return { tools: sorted(tools), resources: sorted(resources), skills: sorted(skills), variables: sorted(variables), usesModel };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportOptions {
    /** Application name and version recorded in the document, for provenance. */
    generator?: string;
    /** Fixed timestamp; defaults to now. Present so tests are deterministic. */
    now?: Date;
}

export function toPortable(def: HarnessDefinition, options: ExportOptions = {}): PortableHarness {
    // `source` says where the definition came from in *this* install, which is meaningless
    // once the file has moved, so it is dropped rather than exported as a misleading value.
    const { source: _source, ...rest } = def;
    return {
        $schema: PORTABLE_SCHEMA_URL,
        formatVersion: PORTABLE_FORMAT_VERSION,
        exportedAt: (options.now ?? new Date()).toISOString(),
        generator: options.generator ?? 'enclave',
        requires: collectRequirements(def),
        harness: rest as HarnessDefinition
    };
}

/** Pretty-printed document, newline-terminated, ready to write to a file. */
export function toPortableJson(def: HarnessDefinition, options: ExportOptions = {}): string {
    return `${JSON.stringify(toPortable(def, options), null, 2)}\n`;
}

/**
 * File name for an exported harness, without a directory.
 *
 * Harness ids are user-supplied, so the name is reduced to a safe basename: separators become
 * hyphens and leading dots are stripped, because a name beginning `..` would escape the
 * directory it is joined to and a name beginning `.` would be hidden from the user.
 */
export function exportFileName(def: HarnessDefinition, extension: 'json' | 'md'): string {
    const base = (def.id || def.name || 'harness')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[.\-]+|[.\-]+$/g, '')
        || 'harness';
    return `${base}.harness.${extension}`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function majorOf(version: string): number {
    const n = parseInt(String(version).split('.')[0], 10);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Read an exported document back.
 *
 * Accepts the wrapped form produced by `toPortable` and also a bare `HarnessDefinition`,
 * because harnesses written by hand into `.continued/harnesses/` are bare and must keep
 * importing. `validate` is injected rather than imported so this module stays independent
 * of the engine.
 */
export function fromPortable(
    raw: unknown,
    validate: (def: HarnessDefinition) => string[]
): ImportResult {
    const warnings: string[] = [];

    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            return { problems: [`This file is not valid JSON: ${(error as Error).message}`], warnings };
        }
    }

    if (!isObject(parsed)) {
        return { problems: ['A harness file must contain a JSON object.'], warnings };
    }

    let candidate: unknown = parsed;
    if (isObject(parsed.harness)) {
        candidate = parsed.harness;
        const version = typeof parsed.formatVersion === 'string' ? parsed.formatVersion : '';
        if (version) {
            const theirs = majorOf(version);
            const ours = majorOf(PORTABLE_FORMAT_VERSION);
            if (Number.isNaN(theirs)) {
                warnings.push(`Unrecognised format version "${version}"; importing anyway.`);
            } else if (theirs > ours) {
                // Refusing would be unhelpful — the definition may well be readable — but the
                // user should know the file was written by something newer.
                warnings.push(`This file uses harness format ${version}, newer than the supported ${PORTABLE_FORMAT_VERSION}. Anything this version does not understand was ignored.`);
            }
        } else {
            warnings.push('No format version in this file; importing it as the current format.');
        }
    } else if (!Array.isArray((parsed as { steps?: unknown }).steps)) {
        return { problems: ['This does not look like a harness: it has neither a "harness" object nor a "steps" array.'], warnings };
    }

    if (!isObject(candidate)) {
        return { problems: ['The "harness" field must be an object.'], warnings };
    }

    // An imported harness is always a user harness in this install, whatever the file says.
    const harness = { ...(candidate as unknown as HarnessDefinition), source: 'user' as const };
    const problems = validate(harness);
    if (problems.length) { return { problems, warnings }; }

    return { harness, warnings, problems: [] };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const ON_ERROR_TEXT: Record<OnError, string> = {
    'stop': 'stop the procedure',
    'continue': 'note the failure and carry on',
    'retry-then-stop': 'retry, then stop if it still fails',
    'retry-then-continue': 'retry, then carry on if it still fails'
};

function stepHeadline(step: HarnessStep): string {
    switch (step.type) {
        case 'tool':     return `Run the \`${step.pluginId}\` tool`;
        case 'resource': return `Collect the \`${step.pluginId}\` context`;
        case 'skill':    return `Run the \`${step.pluginId}\` procedure`;
        case 'llm':      return 'Ask the model';
        case 'parallel': return `Do the following ${step.steps?.length ?? 0} things, independently of each other`;
        case 'sequence': return 'Do the following in order';
        case 'foreach':  return `For each item in \`${step.items}\``;
    }
}

function renderStep(step: HarnessStep, depth: number, lines: string[]): void {
    const indent = '  '.repeat(depth);
    const title = step.name && step.name !== step.id ? `**${step.name}** — ${stepHeadline(step)}` : `**${stepHeadline(step)}**`;
    lines.push(`${indent}- ${title}  \`[${step.id}]\``);

    const detail = (text: string) => lines.push(`${indent}  - ${text}`);

    if (step.when) { detail(`Only if \`${step.when}\`.`); }

    switch (step.type) {
        case 'tool': {
            const args = Object.entries(step.args ?? {});
            if (args.length) {
                detail('Arguments:');
                for (const [key, value] of args) {
                    lines.push(`${indent}    - \`${key}\`: \`${typeof value === 'string' ? value : JSON.stringify(value)}\``);
                }
            }
            break;
        }
        case 'skill':
            if (step.input) { detail(`Input: \`${step.input}\``); }
            break;
        case 'llm':
            detail(`Prompt:\n\n${indent}    > ${String(step.prompt ?? '').split('\n').join(`\n${indent}    > `)}\n`);
            if (step.system) { detail(`Extra instructions: ${step.system}`); }
            if (step.expect === 'json') { detail('The reply must be valid JSON and nothing else.'); }
            if (step.model) { detail(`Model: \`${step.model}\``); }
            break;
        case 'foreach':
            if (step.itemVar) { detail(`Each item is available as \`{{${step.itemVar}}}\`.`); }
            if (step.parallel) { detail('Iterations are independent and may be done in any order.'); }
            if (step.maxItems) { detail(`Process at most ${step.maxItems} items.`); }
            break;
        default:
            break;
    }

    if (step.onError && step.onError !== 'stop') { detail(`If this fails: ${ON_ERROR_TEXT[step.onError]}.`); }

    const children = (step as { steps?: HarnessStep[] }).steps;
    if (Array.isArray(children)) {
        for (const child of children) { renderStep(child, depth + 1, lines); }
    }
}

export interface MarkdownOptions {
    /** Name shown in the provenance footer. */
    generator?: string;
    /** Include the footer explaining where the document came from. Default true. */
    includeProvenance?: boolean;
}

/**
 * Render a harness as a procedure any agent or person can follow.
 *
 * The result is plain Markdown so it can be dropped into an `AGENTS.md`, a `CLAUDE.md`, an
 * OpenCode command, a Continue.Dev prompt file, or simply pasted into a chat. It states the
 * steps, the data that flows between them and where judgement is required, without assuming
 * the reader can execute the JSON.
 */
export function toMarkdown(def: HarnessDefinition, options: MarkdownOptions = {}): string {
    const requires = collectRequirements(def);
    const lines: string[] = [];

    lines.push(`# ${def.name || def.id}`, '');
    if (def.description) { lines.push(def.description, ''); }

    lines.push('## How to use this document', '');
    lines.push(
        'This is a fixed procedure. Follow the steps in the order given; nested steps belong to',
        'the step above them. Steps marked **Ask the model** are the only ones that call for',
        'judgement — everything else is a defined action with defined arguments.',
        ''
    );

    if (def.input?.label || def.input?.required) {
        lines.push('## Input', '');
        const label = def.input.label || 'Free-text input';
        // Authors often write "(optional)" into the label themselves; do not say it twice.
        const marked = /\((optional|required)\)\s*$/i.test(label)
            ? label
            : `${label}${def.input.required ? ' (required)' : ' (optional)'}`;
        lines.push(`${marked}.`);
        if (def.input.placeholder) { lines.push('', `Example: ${def.input.placeholder}`); }
        lines.push('', 'Referred to below as `{{input}}`.', '');
    }

    lines.push('## What this procedure needs', '');
    if (requires.tools.length) { lines.push(`- Tools: ${requires.tools.map(t => `\`${t}\``).join(', ')}`); }
    if (requires.resources.length) { lines.push(`- Context sources: ${requires.resources.map(r => `\`${r}\``).join(', ')}`); }
    if (requires.skills.length) { lines.push(`- Other procedures: ${requires.skills.map(s => `\`${s}\``).join(', ')}`); }
    if (requires.variables.length) { lines.push(`- Variables to supply: ${requires.variables.map(v => `\`{{${v}}}\``).join(', ')}`); }
    lines.push(`- A language model: ${requires.usesModel ? 'yes' : 'no'}`);
    lines.push('');

    lines.push('## Steps', '');
    for (const step of def.steps ?? []) { renderStep(step, 0, lines); }
    lines.push('');

    lines.push('## Notation', '');
    lines.push(
        '- `{{steps.<id>.output}}` means the output of the step with that identifier.',
        '- `.lines` splits that output into a list; `.json` parses it; `.status` is `done`, `failed` or `skipped`.',
        '- `{{input}}` is the input above; `{{item}}` is the current item inside a "for each" step.',
        ''
    );

    if (def.output) {
        lines.push('## Result', '', `Report: \`${def.output}\``, '');
    }

    if (options.includeProvenance !== false) {
        lines.push('---', '');
        lines.push(
            `Generated from the \`${def.id}\` workflow-harness by ${options.generator ?? 'Enclave'}. ` +
            'The machine-readable definition is in the accompanying `.harness.json` file, which ' +
            'Enclave can run directly.'
        );
    }

    return `${lines.join('\n')}\n`;
}
