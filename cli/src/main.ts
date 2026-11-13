/**
 * enclave — run, validate, export and reproduce workflow-harnesses from the terminal.
 *
 * The same engine and the same document format as the editor and browser hosts; only the host
 * differs. Commands:
 *
 *   enclave run [harness] [--input TEXT] [--model ID] [--yes] [--out DIR] [--json]
 *   enclave repro <harness> --runs N --model A [--model B …] [--input TEXT] [--yes]
 *   enclave list | show <harness> | validate <file> | export <harness> --format json|md|cwl
 *   enclave models | probe [--provider blablador] [--task TEXT]
 *
 * A harness is a built-in id, a file in .continued/harnesses/, or a path to a .harness.json.
 * With no harness given, `run` asks interactively.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { HarnessDefinition, HarnessRun } from '../../core/harness/types';
import { runHarness, summarizeRun, validateHarness } from '../../core/harness/harnessEngine';
import { fromPortable, toMarkdown, toPortableJson, exportFileName, collectRequirements } from '../../core/harness/portable';
import { toCwl, cwlFileNames } from '../../core/harness/cwl';
import { recordRun, renderReproReport, summariseRuns, RunRecord } from '../../core/harness/repro';
import { catalogJson, normaliseProvider, runProbe, probeTable, ProbeResult } from '../../core/harness/modelBench';
import { checkGrounding, renderGrounding } from '../../core/harness/grounding';
import { renderConformance, CONFORMANCE_CASES } from '../../core/harness/conformance';
import { runConformance, describeCase } from './conformance';
import { builtInHarnesses } from '../../src/harness/builtInHarnesses';
import { CliHost, ApprovalMode, makeLlm, ollamaUrl } from './host';
import { spawn } from 'child_process';
import { tools, resources } from './tools';
import { ProgressPrinter, tree, table, bold, dim, green, red, yellow, paint, ICON } from './render';

const VERSION = '0.1.0';
const GENERATOR = `enclave-cli ${VERSION}`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args { command: string; positional: string[]; flags: Record<string, string[] | boolean> }

function parseArgs(argv: string[]): Args {
    const [command = 'help', ...rest] = argv;
    const positional: string[] = [];
    const flags: Record<string, string[] | boolean> = {};
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--')) { positional.push(a); continue; }
        const [key, inline] = a.slice(2).split('=', 2);
        const next = rest[i + 1];
        if (inline !== undefined) { (flags[key] = (flags[key] as string[] | undefined) ?? []).push(inline); }
        else if (next !== undefined && !next.startsWith('--') && !['yes', 'json', 'quiet', 'no-color', 'help'].includes(key)) { (flags[key] = (flags[key] as string[] | undefined) ?? []).push(next); i++; }
        else { flags[key] = true; }
    }
    return { command, positional, flags };
}

const flag = (a: Args, k: string): string | undefined => { const v = a.flags[k]; return Array.isArray(v) ? v[v.length - 1] : undefined; };
const flags = (a: Args, k: string): string[] => { const v = a.flags[k]; return Array.isArray(v) ? v : []; };
const has = (a: Args, k: string): boolean => a.flags[k] !== undefined;

// ---------------------------------------------------------------------------
// Harness sources
// ---------------------------------------------------------------------------

function workspaceRoot(a: Args): string { return path.resolve(flag(a, 'workspace') ?? process.cwd()); }

function loadUserHarnesses(root: string): HarnessDefinition[] {
    const dir = path.join(root, '.continued', 'harnesses');
    if (!fs.existsSync(dir)) { return []; }
    const out: HarnessDefinition[] = [];
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
        try {
            const def = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as HarnessDefinition;
            if (!def.id) { def.id = name.replace(/\.json$/i, ''); }
            def.source = 'user';
            out.push(def);
        } catch (e) { process.stderr.write(yellow(`skipping ${name}: ${(e as Error).message}\n`)); }
    }
    return out;
}

function catalog(root: string): Map<string, HarnessDefinition> {
    const map = new Map<string, HarnessDefinition>();
    for (const h of builtInHarnesses) { map.set(h.id, h); }
    for (const h of loadUserHarnesses(root)) { map.set(h.id, h); }
    return map;
}

function loadFile(file: string): HarnessDefinition {
    const raw = fs.readFileSync(file, 'utf8');
    const result = fromPortable(raw, validateHarness);
    if (!result.harness) { throw new Error(`${file} is not a usable harness:\n- ${result.problems.join('\n- ')}`); }
    for (const w of result.warnings) { process.stderr.write(yellow(`${w}\n`)); }
    return result.harness;
}

function resolveHarness(ref: string, root: string): HarnessDefinition {
    const known = catalog(root).get(ref);
    if (known) { return known; }
    if (fs.existsSync(ref)) { return loadFile(ref); }
    throw new Error(`No harness "${ref}". Use \`enclave list\` or give a path to a .harness.json file.`);
}

function knownPlugins() {
    return { tools: new Set(tools.map(t => t.id)), resources: new Set(resources.map(r => r.id)), skills: new Set<string>() };
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function pick<T>(title: string, items: T[], label: (t: T) => string): Promise<T> {
    process.stderr.write(`${bold(title)}\n`);
    items.forEach((it, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}. ${label(it)}\n`));
    for (;;) {
        const n = Number(await ask('Choose a number: '));
        if (Number.isInteger(n) && n >= 1 && n <= items.length) { return items[n - 1]; }
    }
}

/** True for the placeholder the model list shows when Ollama is up but has nothing pulled. */
const isPlaceholder = (m: { provider: string; detail?: string }) => m.provider === 'ollama' && m.detail === 'not pulled yet';

function ollamaPull(model: string): Promise<boolean> {
    return new Promise(resolve => {
        const child = spawn('ollama', ['pull', model], { stdio: 'inherit', env: process.env });
        child.on('close', code => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}

/** A bare model name is an Ollama model: make sure it exists there, offering to pull it on a terminal. */
async function ensureModel(model: string, models: { id: string; provider: string; detail?: string }[]): Promise<void> {
    if (model.includes('/')) { return; }   // a cloud provider; its own errors are clear enough
    const present = models.some(m => m.id === model && !isPlaceholder(m));
    if (present) { return; }
    const hint = `ollama pull ${model}`;
    if (!process.stdin.isTTY) { throw new Error(`Model '${model}' is not available on Ollama. Pull it first:  ${hint}`); }
    const answer = (await ask(`Model ${bold(model)} is not pulled yet. Pull it now with \`${hint}\`? [y/N]: `)).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') { throw new Error(`Model '${model}' is not available. Pull it first:  ${hint}`); }
    const ok = await ollamaPull(model);
    if (!ok) { throw new Error(`\`${hint}\` did not succeed. Is Ollama installed and running?`); }
}

async function chooseModel(a: Args, host: { llm: ReturnType<typeof makeLlm> }): Promise<string> {
    const given = flag(a, 'model') ?? process.env.ENCLAVE_MODEL;
    const models = await host.llm.listModels().catch(() => []);
    if (given) { await ensureModel(given, models); return given; }
    const real = models.filter(m => !isPlaceholder(m));
    if (!real.length) {
        const placeholder = models.find(isPlaceholder);
        if (placeholder && process.stdin.isTTY) { await ensureModel(placeholder.id, models); return placeholder.id; }
        throw new Error(`No models found. Is Ollama running at ${ollamaUrl()} with a model pulled (\`ollama pull llama3\`)? Or set ENCLAVE_BLABLADOR_KEY and pass --model blablador/alias-code.`);
    }
    if (!process.stdin.isTTY) { return real[0].id; }
    const m = await pick('Model', real, x => `${x.id} ${dim([x.provider, x.detail].filter(Boolean).join(' · '))}`);
    return m.id;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function outDir(root: string, a: Args, kind: string, id: string): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const dir = path.resolve(root, flag(a, 'out') ?? path.join('.continued', kind), `${id}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** A duration flag in seconds, as milliseconds, with a default. */
function seconds(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return (Number.isFinite(n) && n > 0 ? n : fallback) * 1000;
}

async function executeOnce(def: HarnessDefinition, input: string, model: string, root: string, a: Args, opts: { quiet: boolean; index?: number }): Promise<{ run: HarnessRun; approvals: number; waitMs: number }> {
    const approvals: ApprovalMode = has(a, 'yes') ? 'all' : has(a, 'no-approvals') ? 'none' : 'ask';
    const printer = opts.quiet ? null : new ProgressPrinter();
    const host = new CliHost({
        workspaceRoot: root, approvals, activeFile: flag(a, 'file'), harnesses: catalog(root),
        onUpdate: run => printer?.update(run),
        onPrompt: open => { if (open) { printer?.pause(); } else { printer?.resume(); } },
        log: has(a, 'verbose') ? line => process.stderr.write(dim(`  ${line}\n`)) : undefined
    });
    host.defaultModel = model;
    const abort = new AbortController();
    const onSigint = () => { abort.abort(); process.stderr.write(red('\nStopping…\n')); };
    process.once('SIGINT', onSigint);
    try {
        const run = await runHarness(def, host, {
            input, signal: abort.signal, defaultModel: model,
            defaultTimeoutMs: seconds(flag(a, 'timeout'), 120),
            modelTimeoutMs: seconds(flag(a, 'model-timeout'), 600)
        });
        return { run, approvals: host.approvalsRequested, waitMs: host.approvalWaitMs };
    } finally {
        process.removeListener('SIGINT', onSigint);
    }
}

async function cmdRun(a: Args): Promise<number> {
    const root = workspaceRoot(a);
    let def: HarnessDefinition;
    if (a.positional[0]) { def = resolveHarness(a.positional[0], root); }
    else {
        if (!process.stdin.isTTY) { throw new Error('Give a harness id or file (see `enclave list`).'); }
        def = await pick('Harness', Array.from(catalog(root).values()), h => `${h.name} ${dim(`(${h.id}, ${h.source})`)}`);
    }
    const problems = validateHarness(def, knownPlugins());
    if (problems.length) { process.stderr.write(yellow(`Validation notes:\n- ${problems.join('\n- ')}\n`)); }

    let input = flag(a, 'input') ?? '';
    if (!input && def.input && !a.positional[0] && process.stdin.isTTY) {
        // Labels often already say "(optional)" and placeholders often already start with "e.g."; say each once.
        const label = (def.input.label ?? 'Input').replace(/\s*\((optional|required)\)\s*$/i, '');
        const example = def.input.placeholder ? (/^e\.?g\.?\s/i.test(def.input.placeholder) ? def.input.placeholder : `e.g. ${def.input.placeholder}`) : '';
        input = await ask(`${label}${def.input.required ? '' : ' (optional)'}${example ? dim(` — ${example}`) : ''}: `);
    }
    if (def.input?.required && !input) { throw new Error(`"${def.name}" needs an input: ${def.input.label ?? 'input'} (use --input).`); }

    const model = await chooseModel(a, { llm: makeLlm() });
    const quiet = has(a, 'json') || has(a, 'quiet');
    if (!quiet) { process.stderr.write(`${bold(def.name)} ${dim(`· model ${model} · workspace ${root}`)}\n`); }

    const { run, approvals, waitMs } = await executeOnce(def, input, model, root, a, { quiet });
    const dir = outDir(root, a, 'harness-runs', def.id);
    const record = recordRun(def, run, { model, index: 1, approvals }, sha256);
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run, record, generator: GENERATOR }, null, 2));
    fs.writeFileSync(path.join(dir, 'output.md'), run.output ?? '');

    if (has(a, 'json')) { process.stdout.write(JSON.stringify({ run, record }, null, 2) + '\n'); return run.status === 'done' ? 0 : 1; }
    process.stderr.write(`\n${tree(run)}\n\n`);
    const total = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000;
    const waited = waitMs ? ` (${(waitMs / 1000).toFixed(1)} s of it waiting for approval)` : '';
    process.stderr.write(`${paint(run.status, `${ICON[run.status] ?? ''} ${run.status}`)} ${dim(`· ${total.toFixed(1)} s${waited} · ${approvals} approval request(s) · saved to ${path.relative(root, dir)}`)}\n`);
    if (run.error) { process.stderr.write(red(`${run.error}\n`)); }
    process.stderr.write('\n');
    process.stdout.write((run.output ?? summarizeRun(run)) + '\n');
    if (has(a, 'check-grounding')) {
        const g = checkGrounding(run);
        fs.writeFileSync(path.join(dir, 'grounding.md'), renderGrounding(g) + '\n');
        process.stdout.write(`\n${renderGrounding(g)}\n`);
    }
    return run.status === 'done' ? 0 : 1;
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

async function cmdRepro(a: Args): Promise<number> {
    const root = workspaceRoot(a);
    if (!a.positional[0]) { throw new Error('Usage: enclave repro <harness> --runs N --model A [--model B] [--input TEXT] [--yes]'); }
    const def = resolveHarness(a.positional[0], root);
    const runs = Number(flag(a, 'runs') ?? 5);
    const models = flags(a, 'model');
    if (!models.length) { throw new Error('Give at least one --model.'); }
    const input = flag(a, 'input') ?? '';
    if (!has(a, 'yes') && !has(a, 'no-approvals')) {
        process.stderr.write(yellow('Approval prompts would be counted but also interrupt a series; pass --yes to grant all, or --no-approvals to decline all.\n'));
    }
    const dir = outDir(root, a, 'repro', def.id);
    const records: RunRecord[] = [];
    const total = runs * models.length;
    let n = 0;
    for (const model of models) {
        for (let i = 1; i <= runs; i++) {
            n++;
            process.stderr.write(`${dim(`[${n}/${total}]`)} ${def.id} · ${model} · run ${i} … `);
            const { run, approvals } = await executeOnce(def, input, model, root, a, { quiet: true, index: i });
            const record = recordRun(def, run, { model, index: i, approvals }, sha256);
            records.push(record);
            fs.writeFileSync(path.join(dir, `run-${model.replace(/[^a-z0-9_.-]+/gi, '_')}-${String(i).padStart(3, '0')}.json`), JSON.stringify({ run, record }, null, 2));
            process.stderr.write(`${paint(run.status, run.status)} ${dim(`${(record.durationMs / 1000).toFixed(1)} s`)}\n`);
        }
    }
    const report = summariseRuns(records);
    const md = renderReproReport(report);
    fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify({ generator: GENERATOR, harness: def, records, report }, null, 2));
    fs.writeFileSync(path.join(dir, 'report.md'), md + '\n');
    if (has(a, 'json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
    else {
        process.stdout.write(`\n${md}\n\n`);
        process.stderr.write(dim(`Records and report saved to ${path.relative(root, dir)}\n`));
    }
    return report.violations.length ? 2 : 0;
}

function cmdList(a: Args): number {
    const root = workspaceRoot(a);
    const rows = Array.from(catalog(root).values()).map(h => [h.id, h.source, String(h.steps.length), h.name]);
    process.stdout.write(table(rows, ['id', 'source', 'steps', 'name']) + '\n');
    return 0;
}

function cmdShow(a: Args): number {
    const root = workspaceRoot(a);
    const def = resolveHarness(a.positional[0] ?? '', root);
    process.stdout.write(toMarkdown(def, { generator: GENERATOR }) + '\n');
    return 0;
}

function cmdValidate(a: Args): number {
    const file = a.positional[0];
    if (!file) { throw new Error('Usage: enclave validate <file>'); }
    const raw = fs.readFileSync(file, 'utf8');
    const result = fromPortable(raw, validateHarness);
    if (!result.harness) { process.stdout.write(red(`✕ ${file}\n`) + result.problems.map(p => `  - ${p}`).join('\n') + '\n'); return 1; }
    const req = collectRequirements(result.harness);
    const known = knownPlugins();
    const missing = [...req.tools.filter(t => !known.tools.has(t)), ...req.resources.filter(r => !known.resources.has(r)), ...req.skills];
    process.stdout.write(green(`✓ ${file}`) + ` — ${result.harness.name} (${result.harness.steps.length} top-level steps${req.usesModel ? ', consults a model' : ''})\n`);
    for (const w of result.warnings) { process.stdout.write(yellow(`  ${w}\n`)); }
    if (missing.length) { process.stdout.write(yellow(`  Not available in the CLI: ${missing.join(', ')}\n`)); }
    return 0;
}

function cmdExport(a: Args): number {
    const root = workspaceRoot(a);
    const def = resolveHarness(a.positional[0] ?? '', root);
    const format = flag(a, 'format') ?? 'json';
    const dir = flag(a, 'out') ?? '.';
    fs.mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    if (format === 'json') { const f = path.join(dir, exportFileName(def, 'json')); fs.writeFileSync(f, toPortableJson(def, { generator: GENERATOR })); written.push(f); }
    else if (format === 'md' || format === 'markdown' || format === 'playbook') { const f = path.join(dir, exportFileName(def, 'md')); fs.writeFileSync(f, toMarkdown(def, { generator: GENERATOR })); written.push(f); }
    else if (format === 'cwl') {
        const { workflow, job, notes } = toCwl(def, { generator: GENERATOR, defaultModel: flag(a, 'model') });
        const names = cwlFileNames(def);
        fs.writeFileSync(path.join(dir, names.workflow), workflow); fs.writeFileSync(path.join(dir, names.job), job);
        written.push(path.join(dir, names.workflow), path.join(dir, names.job));
        for (const n of notes) { process.stderr.write(yellow(`note: ${n}\n`)); }
    } else { throw new Error(`Unknown format "${format}". Use json, md or cwl.`); }
    for (const f of written) { process.stdout.write(`${f}\n`); }
    return 0;
}

async function cmdModels(): Promise<number> {
    const llm = makeLlm();
    const models = await llm.listModels();
    if (!models.length) { process.stdout.write('No models. Start Ollama, or set ENCLAVE_BLABLADOR_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY.\n'); return 1; }
    process.stdout.write(table(models.map(m => [m.id, m.provider, m.local ? 'local' : 'remote', m.detail ?? '']), ['id', 'provider', 'where', 'detail']) + '\n');
    return 0;
}

async function cmdProbe(a: Args): Promise<number> {
    const llm = makeLlm();
    const provider = normaliseProvider(flag(a, 'provider') ?? 'blablador');
    const json = JSON.parse(catalogJson(provider, await llm.listModels())) as { ids: string[] };
    const ids = flags(a, 'model').length ? flags(a, 'model') : json.ids;
    const task = flag(a, 'task') ?? '';
    process.stderr.write(`Probing ${ids.length} model(s) on ${provider} …\n`);
    const results: ProbeResult[] = [];
    const call = async (id: string, system: string, prompt: string, o: { maxTokens: number; timeoutMs: number }) =>
        (await llm.completeDetailed(id, system, [{ role: 'user', content: prompt }], o)).text;
    const settled = await Promise.all(ids.map(async id => {
        const text = await runProbe(call, id, task, Number(flag(a, 'timeout') ?? 60000));
        const summary = JSON.parse(text.slice(0, text.indexOf('\n\n|') === -1 ? undefined : text.indexOf('\n\n|'))) as ProbeResult;
        process.stderr.write(`  ${summary.reachable ? green('✓') : red('✕')} ${id} ${dim(`${summary.passed}/${summary.total}${summary.meanMs !== null ? ` · ${(summary.meanMs / 1000).toFixed(1)} s` : ''}`)}\n`);
        return summary;
    }));
    results.push(...settled);
    results.sort((x, y) => (y.passed - x.passed) || ((x.meanMs ?? 1e12) - (y.meanMs ?? 1e12)));
    process.stdout.write(`\n${probeTable(results)}\n`);
    if (has(a, 'json')) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); }
    return 0;
}

async function cmdConformance(a: Args): Promise<number> {
    if (has(a, 'list')) { for (const c of CONFORMANCE_CASES) { process.stdout.write(describeCase(c) + '\n'); } return 0; }
    process.stderr.write(dim(`Running ${CONFORMANCE_CASES.length} adversarial cases, each under "decline all" and "grant all", in a temporary sandbox …\n`));
    const report = await runConformance(v => process.stderr.write(`  ${v.pass ? green('✓') : red('✕')} ${v.caseId} ${dim(`[${v.approvals}]`)} ${v.observed}\n`));
    const md = renderConformance(report);
    if (has(a, 'json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); } else { process.stdout.write(`\n${md}\n`); }
    if (flag(a, 'out')) { fs.mkdirSync(flag(a, 'out')!, { recursive: true }); fs.writeFileSync(path.join(flag(a, 'out')!, 'conformance.md'), md + '\n'); fs.writeFileSync(path.join(flag(a, 'out')!, 'conformance.json'), JSON.stringify(report, null, 2)); }
    return report.passed === report.runs ? 0 : 2;
}

function cmdGrounding(a: Args): number {
    const file = a.positional[0];
    if (!file) { throw new Error('Usage: enclave grounding <run.json | directory with run.json>'); }
    const target = fs.statSync(file).isDirectory() ? path.join(file, 'run.json') : file;
    const saved = JSON.parse(fs.readFileSync(target, 'utf8')) as { run?: HarnessRun } & HarnessRun;
    const run = saved.run ?? saved;
    const report = checkGrounding(run);
    if (has(a, 'json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); } else { process.stdout.write(renderGrounding(report) + '\n'); }
    return 0;
}

function help(): number {
    process.stdout.write(`enclave ${VERSION} — workflow-harnesses from the terminal

  enclave run [harness] [--input TEXT] [--model ID] [--file REL] [--yes|--no-approvals] [--out DIR] [--json] [--verbose] [--check-grounding]
                       [--timeout SEC (tools, default 120)] [--model-timeout SEC (llm steps, default 600)]
  enclave repro <harness> --runs N --model A [--model B …] [--input TEXT] [--yes] [--out DIR] [--json]
  enclave list                          built-in and .continued/harnesses/ harnesses
  enclave show <harness>                the definition as a Markdown playbook
  enclave validate <file>               check a .harness.json document
  enclave export <harness> --format json|md|cwl [--out DIR]
  enclave models                        models reachable from this machine
  enclave probe [--provider P] [--model ID …] [--task TEXT]   micro-task probe of a provider's models
  enclave conformance [--list] [--json] [--out DIR]   adversarial-model conformance suite for the trust contract
  enclave grounding <run.json>          quotes and numbers in model steps checked against the read steps

  A harness is a built-in id, an id from .continued/harnesses/, or a path to a .harness.json.
  Models: bare names are Ollama (ENCLAVE_OLLAMA_URL, default http://localhost:11434);
  blablador/<id>, openai/<id>, anthropic/<id>, gemini/<id> need ENCLAVE_BLABLADOR_KEY etc.
  Approvals: run-command asks unless --yes (grant all) or --no-approvals (decline all).
  Exit codes: 0 ok · 1 run failed · 2 repro found a deterministic step that varied.
`);
    return 0;
}

async function main(): Promise<number> {
    const a = parseArgs(process.argv.slice(2));
    if (has(a, 'help')) { return help(); }
    switch (a.command) {
        case 'run': return cmdRun(a);
        case 'repro': return cmdRepro(a);
        case 'list': return cmdList(a);
        case 'show': return cmdShow(a);
        case 'validate': return cmdValidate(a);
        case 'export': return cmdExport(a);
        case 'models': return cmdModels();
        case 'conformance': return cmdConformance(a);
        case 'grounding': return cmdGrounding(a);
        case 'probe': return cmdProbe(a);
        case 'version': case '--version': process.stdout.write(`${VERSION}\n`); return 0;
        default: return help();
    }
}

main().then(code => process.exit(code)).catch(error => { process.stderr.write(red(`error: ${(error as Error).message}\n`)); process.exit(1); });
