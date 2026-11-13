/**
 * A small, fixed benchmark for comparing the models a provider offers.
 *
 * The tasks are deliberately tiny and mechanically checkable: the point is not to rank models
 * on a leaderboard but to give a user of a shared service such as Blablador a same-day answer
 * to "which of these is fast, which follows instructions, which can write a line of code, and
 * which of them are actually reachable with my token". Every prompt is public text written
 * here, so a probe sends nothing from the workspace; the one exception is the user's own task,
 * which they typed for exactly this purpose.
 *
 * Free of editor and browser APIs. Each host supplies one function that calls a model; the
 * probe, the catalog formatting and the harness that uses them are shared here so the editor
 * and the browser extension behave identically.
 */

import { HarnessDefinition } from './types';

export interface BenchTask {
    id: string;
    name: string;
    prompt: string;
    /** Output token cap for the call; small so slow models stay comparable. */
    maxTokens: number;
    /** What a passing reply looks like, in words, for the report. */
    expects: string;
    check: (answer: string) => boolean;
}

const FENCE_RE = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/;

export function stripFences(text: string): string {
    const m = text.trim().match(FENCE_RE);
    return m ? m[1] : text.trim();
}

export const BENCH_TASKS: readonly BenchTask[] = [
    {
        id: 'follow',
        name: 'Instruction following',
        prompt: 'Reply with exactly one word and nothing else: pineapple',
        maxTokens: 20,
        expects: 'the single word "pineapple"',
        check: a => /^\W*pineapple\W*$/i.test(a)
    },
    {
        id: 'arithmetic',
        name: 'Arithmetic',
        prompt: 'What is 17 × 23? Reply with only the number.',
        maxTokens: 20,
        expects: '391',
        check: a => (a.match(/-?\d+/g) ?? [])[0] === '391'
    },
    {
        id: 'code',
        name: 'Small code task',
        prompt: 'Write a Python function is_even(n) that returns True when n is even. Reply with only the code, no explanation.',
        maxTokens: 200,
        expects: 'a `def is_even(` that tests divisibility by 2',
        check: a => /def\s+is_even\s*\(/.test(a) && /%\s*2|&\s*1|bin\s*\(|divmod/.test(a)
    },
    {
        id: 'json',
        name: 'Structured output',
        prompt: 'Return a JSON object with the keys "city" and "country" for the capital of France. Reply with only the JSON.',
        maxTokens: 60,
        expects: '{"city": "Paris", "country": "France"}',
        check: a => {
            try {
                const v = JSON.parse(stripFences(a)) as Record<string, unknown>;
                return /paris/i.test(String(v.city)) && /france/i.test(String(v.country));
            } catch { return false; }
        }
    }
];

export interface TaskResult {
    id: string;
    name: string;
    /** true/false when the model answered; null when the call itself failed. */
    passed: boolean | null;
    ms: number;
    chars: number;
    /** The reply, cut to a readable length. */
    answer: string;
    error?: string;
}

export interface ProbeResult {
    model: string;
    /** False when the model could not be called at all (bad key, unknown model, endpoint down). */
    reachable: boolean;
    error?: string;
    passed: number;
    total: number;
    /** Mean wall-clock time of the calls that returned, in milliseconds. */
    meanMs: number | null;
    /** Reply characters per second over the calls that returned; a rough speed signal. */
    charsPerSecond: number | null;
    tasks: TaskResult[];
    /** The user's own task, when one was given. */
    custom?: { ms: number; answer: string; error?: string };
}

export function scoreTask(task: BenchTask, answer: string, ms: number): TaskResult {
    return { id: task.id, name: task.name, passed: task.check(answer), ms, chars: answer.length, answer: answer.slice(0, 300) };
}

export function failedTask(task: BenchTask, error: string, ms: number): TaskResult {
    return { id: task.id, name: task.name, passed: null, ms, chars: 0, answer: '', error: error.slice(0, 300) };
}

export function summariseProbe(model: string, tasks: TaskResult[], custom?: ProbeResult['custom']): ProbeResult {
    const answered = tasks.filter(t => t.passed !== null);
    const totalMs = answered.reduce((s, t) => s + t.ms, 0);
    const totalChars = answered.reduce((s, t) => s + t.chars, 0);
    const reachable = answered.length > 0;
    const firstError = tasks.find(t => t.error)?.error;
    return {
        model,
        reachable,
        ...(reachable ? {} : { error: firstError ?? 'No call returned.' }),
        passed: tasks.filter(t => t.passed === true).length,
        total: tasks.length,
        meanMs: answered.length ? Math.round(totalMs / answered.length) : null,
        charsPerSecond: answered.length && totalMs > 0 ? Math.round((totalChars / totalMs) * 1000) : null,
        tasks,
        ...(custom ? { custom } : {})
    };
}

/** One Markdown table row per probe, in the order given — a deterministic companion to the model's prose. */
export function probeTable(results: ProbeResult[]): string {
    const lines = ['| Model | Reachable | Tasks passed | Mean latency | Speed | Failed tasks |', '| --- | --- | --- | --- | --- | --- |'];
    for (const r of results) {
        const failed = r.tasks.filter(t => t.passed === false).map(t => t.name).join(', ') || (r.reachable ? '—' : (r.error ?? 'unreachable').slice(0, 80));
        lines.push(`| ${r.model} | ${r.reachable ? 'yes' : 'no'} | ${r.passed}/${r.total} | ${r.meanMs === null ? '—' : `${(r.meanMs / 1000).toFixed(1)} s`} | ${r.charsPerSecond === null ? '—' : `${r.charsPerSecond} chars/s`} | ${failed} |`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared tool bodies: the hosts only supply the model call
// ---------------------------------------------------------------------------

/** Providers a catalog can be asked for; the hosts' `Provider` unions agree with this list. */
export const MODEL_PROVIDERS: readonly string[] = ['blablador', 'ollama', 'openai', 'gemini', 'anthropic'];

export interface CatalogModel {
    id: string;
    label: string;
    provider: string;
    detail?: string;
    description?: string;
    contextTokens?: number;
}

/** The `model-catalog` output: JSON with `ids` for loops and per-model detail for reports. */
export function catalogJson(provider: string, all: CatalogModel[]): string {
    const models = all.filter(m => m.provider === provider);
    if (!models.length) {
        throw new Error(provider === 'ollama'
            ? 'No Ollama models were listed. Is Ollama running, and has a model been pulled?'
            : `No ${provider} models were listed. Add the ${provider} API key in the settings first.`);
    }
    return JSON.stringify({
        provider,
        count: models.length,
        ids: models.map(m => m.id),
        models: models.map(m => ({
            id: m.id, label: m.label,
            ...(m.detail ? { detail: m.detail } : {}),
            ...(m.description ? { description: m.description } : {}),
            ...(m.contextTokens ? { contextTokens: m.contextTokens } : {})
        }))
    }, null, 2);
}

export function normaliseProvider(raw: unknown): string {
    const provider = String(raw ?? 'blablador').trim().toLowerCase() || 'blablador';
    if (!MODEL_PROVIDERS.includes(provider)) { throw new Error(`Unknown provider "${provider}". Use one of: ${MODEL_PROVIDERS.join(', ')}.`); }
    return provider;
}

/** One non-streaming model call; the host binds its client. Must resolve to the reply text. */
export type ModelCall = (model: string, system: string, prompt: string, options: { maxTokens: number; timeoutMs: number }) => Promise<string>;

export const BENCH_SYSTEM = 'You are being benchmarked. Follow the instruction exactly and answer as briefly as it allows.';

/** Errors after which the remaining tasks are pointless: the key, the model name or the endpoint is wrong. */
const FATAL_RE = /API key|not configured|\b(401|403|404)\b|ENOTFOUND|ECONNREFUSED|unreachable|Failed to fetch|model .* not found/i;

/** The `model-probe` body: the fixed tasks, then the user's own task, summarised as JSON plus a table row. */
export async function runProbe(call: ModelCall, model: string, task: string, timeoutMs: number): Promise<string> {
    const results: TaskResult[] = [];
    for (const bench of BENCH_TASKS) {
        const started = Date.now();
        try {
            const reply = await call(model, BENCH_SYSTEM, bench.prompt, { maxTokens: bench.maxTokens, timeoutMs });
            results.push(scoreTask(bench, reply, Date.now() - started));
        } catch (error) {
            const message = (error as Error).message ?? String(error);
            results.push(failedTask(bench, message, Date.now() - started));
            if (results.length === 1 && FATAL_RE.test(message)) {
                for (const rest of BENCH_TASKS.slice(1)) { results.push(failedTask(rest, 'Not attempted after the first call failed.', 0)); }
                break;
            }
        }
    }
    let custom: ProbeResult['custom'] | undefined;
    if (task && results.some(r => r.passed !== null)) {
        const started = Date.now();
        try {
            const reply = await call(model, 'Answer the user\'s task directly.', task, { maxTokens: 600, timeoutMs });
            custom = { ms: Date.now() - started, answer: reply.slice(0, 1200) };
        } catch (error) {
            custom = { ms: Date.now() - started, answer: '', error: ((error as Error).message ?? String(error)).slice(0, 300) };
        }
    }
    const summary = summariseProbe(model, results, custom);
    // The row repeats the numbers as Markdown so a report can quote them without re-deriving.
    return `${JSON.stringify(summary, null, 2)}\n\n${probeTable([summary])}`;
}

export const MODEL_CATALOG_DESCRIPTION = 'List the models one provider offers to you (Blablador by default), as JSON: ids (usable as model names in llm steps and model-probe), plus label, detail and description per model. args: { provider (blablador | ollama | openai | gemini | anthropic) }';
export const MODEL_PROBE_DESCRIPTION = `Call one model with ${BENCH_TASKS.length} fixed, mechanically checked micro-tasks (${BENCH_TASKS.map(t => t.name.toLowerCase()).join(', ')}) and optionally your own task; returns JSON with pass/fail per task, mean latency and reply speed. Sends nothing from the workspace or the page. args: { model (required, e.g. blablador/alias-code), task (optional), timeoutMs (per call, default 60000) }`;

// ---------------------------------------------------------------------------
// The harness both hosts ship
// ---------------------------------------------------------------------------

export const BLABLADOR_MODELS_HARNESS: HarnessDefinition = {
    id: 'blablador-models-harness',
    name: 'Blablador: which model should I use?',
    description: 'Lists the models your Blablador token can reach, probes every one of them in parallel with the same four mechanically checked micro-tasks (instruction following, arithmetic, a line of code, JSON output) and, if you give one, your own task, then writes a comparison with a recommendation per use and links to the Blablador documentation. Only the fixed prompts and your task are sent; nothing from the workspace or the page.',
    version: '1.0.0',
    source: 'built-in',
    input: { label: 'Your own task (optional)', placeholder: 'e.g. "Write a Python function that parses ISO 8601 dates"', required: false },
    steps: [
        { id: 'catalog', name: 'List Blablador models', type: 'tool', pluginId: 'model-catalog', args: { provider: 'blablador' }, timeoutMs: 30000 },
        {
            id: 'probes',
            name: 'Probe every model',
            type: 'foreach',
            items: '{{steps.catalog.json.ids}}',
            itemVar: 'model',
            parallel: true,
            maxItems: 40,
            steps: [
                { id: 'probe', name: 'Probe', type: 'tool', pluginId: 'model-probe', args: { model: '{{model}}', task: '{{input}}' }, onError: 'continue', timeoutMs: 600000 }
            ]
        },
        {
            id: 'compare',
            name: 'Compare and recommend',
            type: 'llm',
            prompt: 'The run context holds one JSON probe result per Blablador model (step probes: fields model, reachable, passed/total, meanMs, charsPerSecond, tasks with passed true/false/null and the reply, and custom when the user gave a task) and the catalog (step catalog: label, detail, description per model). Write a Markdown report with exactly these sections. "## Models available" — one bullet per model from the catalog: id, then its detail/description if any. "## Benchmark" — a table with columns Model, Reachable, Tasks passed, Mean latency (s), Speed (chars/s), Failed tasks, copying the numbers from the probe JSON exactly; do not round differently or invent a value. "## Recommendation" — for each of these uses name the model you would pick and one reason drawn from the numbers: everyday chat and writing; coding; structured output (JSON); fastest replies. {{input}}\nIf the user gave their own task, add "## Your task" and compare the custom answers side by side in two or three sentences each. "## Caveats" — three bullets at most: these are four micro-tasks, not a benchmark suite; latency depends on load at the time of the run; unreachable models and what the error said. Never present a failed or unreachable model as usable.'
        }
    ],
    output: '{{steps.compare.output}}\n\n## Further reading\n- Available models and aliases: https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_models/\n- API access and tokens: https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_api_access/\n- Blablador in VS Code: https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_on_vscode/\n- Helmholtz Cloud service entry: https://helmholtz.cloud/services/?serviceID=d7d5c597-a2f6-4bd1-b71e-4d6499d98570\n- HIFIS note on using LLMs responsibly: https://hifis.net/tips/2025/05/05/tip-llm/\n- API base URL: https://api.blablador.fz-juelich.de/v1/'
};
