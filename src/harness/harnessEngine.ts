/**
 * Harness engine — executes a HarnessDefinition step by step.
 *
 * Free of `vscode` imports: everything that touches the editor, the plugin registry,
 * approvals or the model goes through the `HarnessHost` callbacks, so the engine can be
 * unit-tested with plain mocha.
 */

import {
    ForeachStep,
    HarnessDefinition,
    HarnessRun,
    HarnessStep,
    LlmStep,
    OnError,
    StepRun,
    ToolStep
} from './types';
import { lenientJsonParse } from '../agentActions';

export interface LlmStepRequest {
    model?: string;
    system: string;
    prompt: string;
    jsonMode: boolean;
    signal: AbortSignal;
    timeoutMs: number;
}

export interface HarnessHost {
    /** Execute a tool plugin. Must throw on failure; a returned string that starts with BLOCKED/FAILED/DECLINED is also a failure. */
    runTool(pluginId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
    runResource(pluginId: string, signal: AbortSignal): Promise<string>;
    runSkill(pluginId: string, input: string, signal: AbortSignal): Promise<string>;
    callModel(request: LlmStepRequest): Promise<string>;
    /** Workspace variables available as `{{name}}` (workspace, activeFile, selection, …). */
    variables(): Record<string, string>;
    /** Called after every state change with a snapshot of the run. */
    onUpdate(run: HarnessRun): void;
    log?(line: string): void;
}

export interface RunOptions {
    input: string;
    signal: AbortSignal;
    /** Default model for llm steps without an explicit one. */
    defaultModel?: string;
}

const FAILURE_PREFIX = /^(BLOCKED|FAILED|DECLINED)\b/;
const DEFAULT_TIMEOUT = 120000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_ITEMS = 50;
const CONTEXT_STEP_CAP = 6000;
const CONTEXT_TOTAL_CAP = 60000;

interface Scope {
    input: string;
    vars: Record<string, string>;
    /** Loop variables (item, index, plus a custom itemVar). */
    locals: Record<string, unknown>;
    /** Completed step runs visible to templates, keyed by step id. */
    results: Map<string, StepRun>;
}

export class HarnessValidationError extends Error {}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateHarness(def: HarnessDefinition, knownPlugins?: { tools: Set<string>; resources: Set<string>; skills: Set<string> }): string[] {
    const problems: string[] = [];
    if (!def || typeof def !== 'object') { return ['Definition is not an object.']; }
    if (!def.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(def.id)) { problems.push('Harness id must contain only letters, digits, ".", "_" or "-".'); }
    if (!def.name || !def.name.trim()) { problems.push('Harness needs a name.'); }
    if (!Array.isArray(def.steps) || def.steps.length === 0) { problems.push('Harness needs at least one step.'); }

    const ids = new Set<string>();
    const visit = (steps: HarnessStep[], where: string) => {
        for (const step of steps ?? []) {
            if (!step || typeof step !== 'object') { problems.push(`${where}: step is not an object.`); continue; }
            if (!step.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(step.id)) { problems.push(`${where}: step id "${step.id ?? ''}" must contain only letters, digits, "_" or "-".`); }
            else if (ids.has(step.id)) { problems.push(`Step id "${step.id}" is used more than once.`); }
            else { ids.add(step.id); }
            const label = `Step "${step.id}"`;
            switch (step.type) {
                case 'tool':
                    if (!step.pluginId) { problems.push(`${label}: tool step needs a pluginId.`); }
                    else if (knownPlugins && !knownPlugins.tools.has(step.pluginId)) { problems.push(`${label}: tool "${step.pluginId}" is not registered or not enabled.`); }
                    if (step.args && typeof step.args !== 'object') { problems.push(`${label}: args must be an object.`); }
                    break;
                case 'resource':
                    if (!step.pluginId) { problems.push(`${label}: resource step needs a pluginId.`); }
                    else if (knownPlugins && !knownPlugins.resources.has(step.pluginId)) { problems.push(`${label}: resource "${step.pluginId}" is not registered or not enabled.`); }
                    break;
                case 'skill':
                    if (!step.pluginId) { problems.push(`${label}: skill step needs a pluginId.`); }
                    else if (knownPlugins && !knownPlugins.skills.has(step.pluginId)) { problems.push(`${label}: skill "${step.pluginId}" is not registered or not enabled.`); }
                    break;
                case 'llm':
                    if (!step.prompt || !step.prompt.trim()) { problems.push(`${label}: llm step needs a prompt.`); }
                    break;
                case 'parallel':
                    if (!Array.isArray(step.steps) || step.steps.length === 0) { problems.push(`${label}: parallel group needs at least one step.`); }
                    else { visit(step.steps, label); }
                    break;
                case 'sequence':
                    if (!Array.isArray(step.steps) || step.steps.length === 0) { problems.push(`${label}: sequence needs at least one step.`); }
                    else { visit(step.steps, label); }
                    break;
                case 'foreach':
                    if (!step.items || !step.items.trim()) { problems.push(`${label}: foreach needs an items expression such as {{steps.find.lines}}.`); }
                    if (!Array.isArray(step.steps) || step.steps.length === 0) { problems.push(`${label}: foreach needs at least one step.`); }
                    else { visit(step.steps, label); }
                    break;
                default:
                    problems.push(`${label}: unknown step type "${(step as { type?: string }).type}".`);
            }
        }
    };
    visit(def.steps ?? [], 'Harness');
    return problems;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function outputLines(output: string): string[] {
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    // Tool outputs often start with a header like "Found 3 files:" — drop it.
    if (lines.length > 0 && /^(Found|No |Command executed|File )/i.test(lines[0]) && /[:.]$/.test(lines[0])) {
        return lines.slice(1);
    }
    return lines;
}

/** Resolve one `steps.x.y` / `input` / `item` / variable expression. Throws on unknown references. */
export function resolveExpression(expr: string, scope: Scope): unknown {
    const trimmed = expr.trim();
    if (trimmed === 'input') { return scope.input; }
    if (Object.prototype.hasOwnProperty.call(scope.locals, trimmed)) { return scope.locals[trimmed]; }
    if (Object.prototype.hasOwnProperty.call(scope.vars, trimmed)) { return scope.vars[trimmed]; }

    const stepMatch = trimmed.match(/^steps\.([A-Za-z0-9_-]+)(?:\.(.+))?$/);
    if (stepMatch) {
        const [, stepId, rest] = stepMatch;
        const run = scope.results.get(stepId);
        if (!run) { throw new Error(`Unknown step reference {{${trimmed}}}: no step "${stepId}" has run yet.`); }
        const field = rest ?? 'output';
        if (field === 'output') { return run.output ?? ''; }
        if (field === 'status') { return run.status; }
        if (field === 'error') { return run.error ?? ''; }
        if (field === 'lines') { return outputLines(run.output ?? ''); }
        if (field === 'json' || field.startsWith('json.')) {
            const parsed = lenientJsonParse(run.output ?? '');
            if (parsed === null) { throw new Error(`{{${trimmed}}}: output of step "${stepId}" is not valid JSON.`); }
            if (field === 'json') { return parsed; }
            let value: unknown = parsed;
            for (const part of field.slice(5).split('.')) {
                if (value === null || typeof value !== 'object') { throw new Error(`{{${trimmed}}}: path "${part}" not found in the JSON output of step "${stepId}".`); }
                value = (value as Record<string, unknown>)[part];
            }
            return value;
        }
        throw new Error(`Unknown field "${field}" in {{${trimmed}}}. Use output, status, error, lines or json.`);
    }
    throw new Error(`Unknown variable {{${trimmed}}}. Available: input, item, index, ${Object.keys(scope.vars).join(', ')}, steps.<id>.output|status|error|lines|json`);
}

function stringify(value: unknown): string {
    if (value === undefined || value === null) { return ''; }
    if (typeof value === 'string') { return value; }
    if (Array.isArray(value)) { return value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n'); }
    if (typeof value === 'object') { return JSON.stringify(value, null, 2); }
    return String(value);
}

/**
 * Interpolate a template. A template that is exactly one `{{expr}}` returns the raw
 * value (arrays/objects survive); anything else becomes a string.
 */
export function interpolate(template: string, scope: Scope): unknown {
    if (typeof template !== 'string') { return template; }
    const whole = template.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) { return resolveExpression(whole[1], scope); }
    return template.replace(TEMPLATE_RE, (_m, expr: string) => stringify(resolveExpression(expr, scope)));
}

function coerce(value: unknown): unknown {
    if (typeof value !== 'string') { return value; }
    const t = value.trim();
    if (t === 'true') { return true; }
    if (t === 'false') { return false; }
    if (/^-?\d+(\.\d+)?$/.test(t)) { return Number(t); }
    return value;
}

function interpolateArgs(args: Record<string, unknown>, scope: Scope): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args ?? {})) {
        out[key] = typeof value === 'string' ? coerce(interpolate(value, scope)) : value;
    }
    return out;
}

function evaluateWhen(when: string | undefined, scope: Scope): boolean {
    if (!when || !when.trim()) { return true; }
    const text = stringify(interpolate(when, scope)).trim();
    const cmp = text.match(/^(.*?)\s*(==|!=)\s*(.*?)$/);
    if (cmp) {
        const left = cmp[1].trim().replace(/^["']|["']$/g, '');
        const right = cmp[3].trim().replace(/^["']|["']$/g, '');
        return cmp[2] === '==' ? left === right : left !== right;
    }
    return !(text === '' || /^(false|0|no|null|undefined)$/i.test(text));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
        const onAbort = () => { clearTimeout(timer); reject(new Error('Cancelled.')); };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(error); }
        );
    });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

function newStepRun(step: HarnessStep): StepRun {
    return {
        id: step.id,
        name: step.name || step.id,
        type: step.type,
        status: 'pending',
        attempts: 0,
        notes: [],
        children: step.type === 'parallel' || step.type === 'foreach' || step.type === 'sequence' ? [] : undefined
    };
}

/** Build the briefing an llm step receives about everything that ran before it. */
export function buildRunContext(run: HarnessRun, scope: Scope, currentStepId: string): string {
    const lines: string[] = [];
    let total = 0;
    const visit = (steps: StepRun[], depth: number) => {
        for (const s of steps) {
            if (s.id === currentStepId) { continue; }
            if (s.status === 'pending') { continue; }
            const indent = '  '.repeat(depth);
            const head = `${indent}- [${s.status.toUpperCase()}] ${s.id} (${s.type}${s.name !== s.id ? `: ${s.name}` : ''})`;
            lines.push(head);
            if (s.error) { lines.push(`${indent}  error: ${s.error.slice(0, 500)}`); }
            if (s.notes.length) { lines.push(`${indent}  notes: ${s.notes.join('; ').slice(0, 500)}`); }
            if (s.output && s.status !== 'skipped' && (s.type !== 'parallel' && s.type !== 'foreach' && s.type !== 'sequence')) {
                const remaining = Math.max(0, Math.min(CONTEXT_STEP_CAP, CONTEXT_TOTAL_CAP - total));
                const body = s.output.length > remaining ? `${s.output.slice(0, remaining)}\n[… ${s.output.length - remaining} more characters truncated]` : s.output;
                total += body.length;
                lines.push(`${indent}  output:\n${body.split('\n').map(l => `${indent}    ${l}`).join('\n')}`);
            }
            if (s.children?.length) { visit(s.children, depth + 1); }
        }
    };
    visit(run.steps, 0);
    const localLines = Object.entries(scope.locals).map(([k, v]) => `- ${k}: ${stringify(v).slice(0, 500)}`);
    return [
        `Harness: ${run.harnessName}`,
        run.input ? `User input: ${run.input.slice(0, 2000)}` : 'User input: (none)',
        localLines.length ? `Loop variables:\n${localLines.join('\n')}` : '',
        lines.length ? `Steps so far:\n${lines.join('\n')}` : 'Steps so far: (none — this is the first step)'
    ].filter(Boolean).join('\n\n');
}

const LLM_BRIEFING = `You are one step inside an automated harness (a fixed workflow of tool calls and model calls) running in VS Code.
The RUN CONTEXT below lists every step that ran before you, with its status and output.
Rules:
- Base your answer ONLY on the run context and the instruction. Do not invent the output of a step that FAILED, was BLOCKED, was SKIPPED or produced nothing — say explicitly that the data is missing and what that means.
- If a step failed, say so plainly and, if useful, explain the likely cause from its error text.
- Follow the output format the instruction asks for exactly; your reply is passed verbatim to the next step or shown to the user.`;

export async function runHarness(def: HarnessDefinition, host: HarnessHost, options: RunOptions): Promise<HarnessRun> {
    const problems = validateHarness(def);
    if (problems.length) {
        throw new HarnessValidationError(`Harness "${def.id}" is invalid:\n- ${problems.join('\n- ')}`);
    }

    const run: HarnessRun = {
        harnessId: def.id,
        harnessName: def.name,
        input: options.input ?? '',
        status: 'running',
        steps: def.steps.map(newStepRun),
        output: '',
        startedAt: Date.now()
    };
    const scope: Scope = { input: options.input ?? '', vars: host.variables(), locals: {}, results: new Map() };
    const update = () => host.onUpdate(JSON.parse(JSON.stringify(run)) as HarnessRun);
    const log = (line: string) => host.log?.(line);
    update();

    // Returns false when the run must stop.
    const runSteps = async (steps: HarnessStep[], runs: StepRun[], scopeForSteps: Scope): Promise<boolean> => {
        for (let i = 0; i < steps.length; i++) {
            if (options.signal.aborted) { markRemaining(runs, i, 'Cancelled.'); return false; }
            const ok = await runOne(steps[i], runs[i], scopeForSteps);
            if (!ok) { markRemaining(runs, i + 1, 'Not run: an earlier step stopped the harness.'); return false; }
        }
        return true;
    };

    const markRemaining = (runs: StepRun[], from: number, reason: string) => {
        for (let j = from; j < runs.length; j++) {
            if (runs[j].status === 'pending') { runs[j].status = 'skipped'; runs[j].notes.push(reason); }
        }
        update();
    };

    const runOne = async (step: HarnessStep, stepRun: StepRun, scopeForStep: Scope): Promise<boolean> => {
        // Condition
        try {
            if (!evaluateWhen(step.when, scopeForStep)) {
                stepRun.status = 'skipped';
                stepRun.notes.push(`Skipped: condition "${step.when}" was false.`);
                scopeForStep.results.set(step.id, stepRun);
                update();
                return true;
            }
        } catch (error) {
            stepRun.status = 'failed';
            stepRun.error = `Condition could not be evaluated: ${(error as Error).message}`;
            scopeForStep.results.set(step.id, stepRun);
            update();
            return policyAllowsContinue(step.onError);
        }

        const policy: OnError = step.onError ?? 'stop';
        const maxAttempts = policy.startsWith('retry') ? 1 + Math.max(0, step.retries ?? DEFAULT_RETRIES) : 1;
        const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT;
        stepRun.status = 'running';
        stepRun.startedAt = Date.now();
        update();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            stepRun.attempts = attempt;
            if (options.signal.aborted) {
                stepRun.status = 'failed';
                stepRun.error = 'Cancelled.';
                break;
            }
            try {
                const output = await executeStep(step, stepRun, scopeForStep, timeoutMs);
                if (FAILURE_PREFIX.test(output.trim())) {
                    throw new Error(output.trim());
                }
                stepRun.output = output;
                stepRun.status = 'done';
                stepRun.error = undefined;
                break;
            } catch (error) {
                const message = (error as Error).message ?? String(error);
                stepRun.error = message;
                stepRun.status = 'failed';
                log(`step ${step.id} attempt ${attempt}/${maxAttempts} failed: ${message.slice(0, 200)}`);
                if (attempt < maxAttempts && !options.signal.aborted && !/^Cancelled\.$/.test(message)) {
                    stepRun.notes.push(`Attempt ${attempt} failed: ${message.slice(0, 200)}. Retrying…`);
                    update();
                    await sleep(500 * attempt, options.signal);
                    continue;
                }
                if (maxAttempts > 1) { stepRun.notes.push(`Gave up after ${attempt} attempts.`); }
            }
        }

        stepRun.endedAt = Date.now();
        scopeForStep.results.set(step.id, stepRun);
        update();

        if (stepRun.status === 'done') { return true; }
        if (options.signal.aborted) { return false; }
        const cont = policyAllowsContinue(policy);
        stepRun.notes.push(cont ? 'Policy: continue after failure.' : 'Policy: stop the harness on failure.');
        update();
        return cont;
    };

    const policyAllowsContinue = (policy: OnError | undefined): boolean =>
        policy === 'continue' || policy === 'retry-then-continue';

    const executeStep = async (step: HarnessStep, stepRun: StepRun, scopeForStep: Scope, timeoutMs: number): Promise<string> => {
        switch (step.type) {
            case 'tool': {
                const args = interpolateArgs((step as ToolStep).args ?? {}, scopeForStep);
                return withTimeout(host.runTool(step.pluginId, args, options.signal), timeoutMs, options.signal, `Tool ${step.pluginId}`);
            }
            case 'resource':
                return withTimeout(host.runResource(step.pluginId, options.signal), timeoutMs, options.signal, `Resource ${step.pluginId}`);
            case 'skill': {
                const input = step.input ? stringify(interpolate(step.input, scopeForStep)) : '';
                return withTimeout(host.runSkill(step.pluginId, input, options.signal), timeoutMs, options.signal, `Skill ${step.pluginId}`);
            }
            case 'llm':
                return runLlmStep(step, stepRun, scopeForStep, timeoutMs);
            case 'parallel': {
                stepRun.children = step.steps.map(newStepRun);
                update();
                const results = await Promise.all(step.steps.map((child, idx) => runOne(child, stepRun.children![idx], scopeForStep)));
                const failedStop = results.some(r => !r);
                const failures = stepRun.children.filter(c => c.status === 'failed');
                if (failedStop) {
                    throw new Error(`Parallel group stopped: ${failures.map(f => `${f.id}: ${f.error}`).join('; ') || 'a child step requested stop'}`);
                }
                if (failures.length) { stepRun.notes.push(`${failures.length} child step(s) failed but were allowed to continue.`); }
                return stepRun.children.map(c => `### ${c.id} [${c.status}]\n${c.output ?? c.error ?? ''}`).join('\n\n');
            }
            case 'sequence': {
                stepRun.children = step.steps.map(newStepRun);
                update();
                const ok = await runSteps(step.steps, stepRun.children, scopeForStep);
                const failures = stepRun.children.filter(c => c.status === 'failed');
                if (!ok) {
                    throw new Error(`Sequence stopped: ${failures.map(f => `${f.id}: ${f.error}`).join('; ') || 'a child step requested stop'}`);
                }
                if (failures.length) { stepRun.notes.push(`${failures.length} child step(s) failed but were allowed to continue.`); }
                const last = [...stepRun.children].reverse().find(c => c.status === 'done');
                return last?.output ?? '';
            }
            case 'foreach':
                return runForeach(step, stepRun, scopeForStep);
        }
    };

    const runLlmStep = async (step: LlmStep, stepRun: StepRun, scopeForStep: Scope, timeoutMs: number): Promise<string> => {
        const prompt = stringify(interpolate(step.prompt, scopeForStep));
        const context = buildRunContext(run, scopeForStep, step.id);
        const jsonMode = step.expect === 'json';
        let system = `${LLM_BRIEFING}\n\n## RUN CONTEXT\n${context}`;
        if (step.system) { system += `\n\n## ADDITIONAL INSTRUCTIONS\n${stringify(interpolate(step.system, scopeForStep))}`; }
        if (jsonMode) { system += '\n\nReply with ONLY a single JSON value. No prose, no markdown fences.'; }
        const model = step.model || options.defaultModel;
        const call = (p: string) => withTimeout(host.callModel({ model, system, prompt: p, jsonMode, signal: options.signal, timeoutMs }), timeoutMs, options.signal, `LLM step ${step.id}`);

        let reply = await call(prompt);
        if (jsonMode) {
            let parsed = lenientJsonParse(stripFences(reply));
            if (parsed === null) {
                stepRun.notes.push('Reply was not valid JSON; asked the model to correct it.');
                update();
                reply = await call(`${prompt}\n\nYour previous reply was not valid JSON:\n${reply.slice(0, 1500)}\n\nReply again with ONLY valid JSON.`);
                parsed = lenientJsonParse(stripFences(reply));
                if (parsed === null) { throw new Error(`LLM step "${step.id}" did not return valid JSON after a retry. Last reply: ${reply.slice(0, 300)}`); }
            }
            return JSON.stringify(parsed, null, 2);
        }
        if (!reply.trim()) { throw new Error(`LLM step "${step.id}" returned an empty reply.`); }
        return reply;
    };

    const runForeach = async (step: ForeachStep, stepRun: StepRun, scopeForStep: Scope): Promise<string> => {
        const raw = interpolate(step.items, scopeForStep);
        let items: unknown[];
        if (Array.isArray(raw)) { items = raw; }
        else if (typeof raw === 'string') { items = raw.split('\n').map(l => l.trim()).filter(Boolean); }
        else if (raw && typeof raw === 'object') { items = Object.values(raw as Record<string, unknown>); }
        else { items = []; }
        const maxItems = step.maxItems ?? DEFAULT_MAX_ITEMS;
        if (items.length > maxItems) {
            stepRun.notes.push(`Only the first ${maxItems} of ${items.length} items were processed (maxItems).`);
            items = items.slice(0, maxItems);
        }
        if (items.length === 0) {
            stepRun.notes.push('No items to iterate over.');
            return '';
        }
        const itemVar = step.itemVar || 'item';
        stepRun.children = items.map((item, index) => ({
            id: `${step.id}[${index}]`,
            name: `${stringify(item).slice(0, 60)}`,
            type: 'parallel' as const,
            status: 'pending' as const,
            attempts: 0,
            notes: [],
            children: step.steps.map(newStepRun)
        }));
        update();

        const runIteration = async (index: number): Promise<boolean> => {
            const iteration = stepRun.children![index];
            const iterScope: Scope = {
                ...scopeForStep,
                locals: { ...scopeForStep.locals, item: items[index], index, [itemVar]: items[index] },
                results: new Map(scopeForStep.results)
            };
            iteration.status = 'running';
            iteration.startedAt = Date.now();
            update();
            const ok = await runSteps(step.steps, iteration.children!, iterScope);
            const failed = iteration.children!.some(c => c.status === 'failed');
            iteration.status = !ok || failed ? 'failed' : 'done';
            iteration.endedAt = Date.now();
            const last = [...iteration.children!].reverse().find(c => c.status === 'done');
            iteration.output = last?.output ?? '';
            if (failed) { iteration.error = iteration.children!.filter(c => c.error).map(c => `${c.id}: ${c.error}`).join('; '); }
            update();
            return ok;
        };

        let stopped = false;
        if (step.parallel) {
            const results = await Promise.all(items.map((_, i) => runIteration(i)));
            stopped = results.some(r => !r);
        } else {
            for (let i = 0; i < items.length; i++) {
                if (options.signal.aborted) { stopped = true; break; }
                if (!(await runIteration(i))) { stopped = true; break; }
            }
        }
        const failures = stepRun.children.filter(c => c.status === 'failed');
        if (stopped) {
            throw new Error(`Loop stopped at iteration ${failures[0]?.id ?? '?'}: ${failures[0]?.error ?? 'a step requested stop'}`);
        }
        if (failures.length) { stepRun.notes.push(`${failures.length} of ${items.length} iterations failed but were allowed to continue.`); }
        return stepRun.children.map(c => `### ${c.name} [${c.status}]\n${c.output ?? c.error ?? ''}`).join('\n\n');
    };

    try {
        const completed = await runSteps(def.steps, run.steps, scope);
        const anyFailed = run.steps.some(s => s.status === 'failed');
        if (options.signal.aborted) {
            run.status = 'cancelled';
            run.error = 'Cancelled by user.';
        } else {
            run.status = completed && !anyFailed ? 'done' : 'failed';
            if (!completed) { run.error = 'A step failed and its policy stopped the harness.'; }
            else if (anyFailed) { run.error = 'Finished, but some steps failed (their policy allowed the run to continue).'; }
        }
        try {
            if (def.output && def.output.trim()) {
                run.output = stringify(interpolate(def.output, scope));
            } else {
                const last = [...run.steps].reverse().find(s => s.status === 'done');
                run.output = last?.output ?? '';
            }
        } catch (error) {
            run.output = '';
            run.error = `${run.error ? `${run.error} ` : ''}Output template failed: ${(error as Error).message}`;
            run.status = run.status === 'cancelled' ? run.status : 'failed';
        }
    } catch (error) {
        run.status = options.signal.aborted ? 'cancelled' : 'failed';
        run.error = (error as Error).message ?? String(error);
    }
    run.endedAt = Date.now();
    update();
    return run;
}

function stripFences(text: string): string {
    const m = text.trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
    return m ? m[1] : text;
}

/** Human-readable summary of a finished run (used for the chat transcript and skill results). */
export function summarizeRun(run: HarnessRun): string {
    const icon = (s: StepRun) => s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : s.status === 'running' ? '🔄' : '⏳';
    const lines: string[] = [];
    const visit = (steps: StepRun[], depth: number) => {
        for (const s of steps) {
            lines.push(`${'  '.repeat(depth)}- ${icon(s)} \`${s.id}\`${s.name !== s.id ? ` ${s.name}` : ''}${s.attempts > 1 ? ` (${s.attempts} attempts)` : ''}${s.error ? ` — ${s.error.slice(0, 200)}` : ''}`);
            if (s.children?.length && (s.type === 'parallel' || s.type === 'sequence')) { visit(s.children, depth + 1); }
            else if (s.children?.length) {
                const failed = s.children.filter(c => c.status === 'failed').length;
                lines.push(`${'  '.repeat(depth + 1)}- ${s.children.length} iteration(s), ${failed} failed`);
            }
        }
    };
    visit(run.steps, 0);
    const status = run.status === 'done' ? '✅ completed' : run.status === 'failed' ? '❌ failed' : run.status === 'cancelled' ? '⛔ cancelled' : '🔄 running';
    const elapsed = run.endedAt ? ` in ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s` : '';
    const header = `🧩 Harness **${run.harnessName}** ${status}${elapsed}${run.error ? `\n\n> ${run.error}` : ''}`;
    const output = run.output.trim() ? `\n\n**Output**\n\n${run.output.length > 8000 ? `${run.output.slice(0, 8000)}\n\n[… truncated]` : run.output}` : '';
    return `${header}\n\n${lines.join('\n')}${output}`;
}
