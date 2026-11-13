/**
 * Reproducibility metrics for harness runs.
 *
 * The claim these metrics test is narrow: in a harness run, variation between runs is confined
 * to the steps declared `llm` (and to groups that contain one), and the remaining structure is
 * stable. A run is reduced to a record — one entry per step with its status, attempt count and
 * a hash of its output — and a set of records is summarised into three numbers:
 *
 *   structural stability   share of runs whose step graph (which steps ran, with which
 *                          statuses) equals the most common graph;
 *   step-output stability  distinct output hashes per step across runs, expected to be 1 for
 *                          every step that neither is nor contains an `llm` step;
 *   approval determinism   whether every run raised the same number of approval requests.
 *
 * Free of editor, browser and Node APIs; the hash function is injected so a host can use
 * SHA-256 while this module stays portable. The default is FNV-1a, adequate for distinctness.
 */

import { HarnessDefinition, HarnessRun, HarnessStep, StepRun } from './types';
import { walkSteps } from './portable';

export type Hasher = (text: string) => string;

export const fnv1a: Hasher = (text: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
};

export interface StepRecord {
    /** Path of ids from the root, joined with `/`; distinguishes same-named steps in different groups. */
    path: string;
    id: string;
    type: HarnessStep['type'];
    status: StepRun['status'];
    attempts: number;
    /** Hash of the output, or null when the step produced none. */
    outputHash: string | null;
    outputChars: number;
    /** True when this step is `llm` or contains one — the only places variation is expected. */
    modelDependent: boolean;
}

export interface RunRecord {
    harnessId: string;
    harnessVersion?: string;
    model: string;
    /** 1-based index within its series. */
    index: number;
    status: HarnessRun['status'];
    startedAt: number;
    durationMs: number;
    /** Approval requests raised during the run, whatever the answers were. */
    approvals: number;
    steps: StepRecord[];
    outputHash: string | null;
}

/** Ids of steps that are `llm` or have an `llm` descendant, from the definition. */
export function modelDependentIds(def: HarnessDefinition): Set<string> {
    const ids = new Set<string>();
    const visit = (step: HarnessStep): boolean => {
        const children = (step as { steps?: HarnessStep[] }).steps ?? [];
        let dependent = step.type === 'llm';
        for (const child of children) { if (visit(child)) { dependent = true; } }
        if (dependent) { ids.add(step.id); }
        return dependent;
    };
    for (const step of def.steps) { visit(step); }
    return ids;
}

export function recordRun(def: HarnessDefinition, run: HarnessRun, meta: { model: string; index: number; approvals: number }, hash: Hasher = fnv1a): RunRecord {
    const dependent = modelDependentIds(def);
    const steps: StepRecord[] = [];
    const visit = (list: StepRun[], prefix: string): void => {
        for (const s of list) {
            const path = prefix ? `${prefix}/${s.id}` : s.id;
            steps.push({
                path, id: s.id, type: s.type, status: s.status, attempts: s.attempts,
                outputHash: s.output ? hash(s.output) : null,
                outputChars: s.output?.length ?? 0,
                modelDependent: dependent.has(s.id) || s.type === 'llm'
            });
            if (s.children?.length) { visit(s.children, path); }
        }
    };
    visit(run.steps, '');
    return {
        harnessId: def.id,
        harnessVersion: def.version,
        model: meta.model,
        index: meta.index,
        status: run.status,
        startedAt: run.startedAt,
        durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
        approvals: meta.approvals,
        steps,
        outputHash: run.output ? hash(run.output) : null
    };
}

/** The step graph as a comparable string: every step path with its status, in order. */
export function structureSignature(record: RunRecord): string {
    return record.steps.map(s => `${s.path}:${s.status}`).join('|');
}

export interface StepStability {
    path: string;
    type: HarnessStep['type'];
    modelDependent: boolean;
    statuses: string[];
    attempts: number[];
    distinctOutputs: number;
    /** Runs in which the step produced output. */
    withOutput: number;
    /** False when a step that should be stable produced more than one distinct output. */
    asPredicted: boolean;
}

export interface ReproReport {
    harnessId: string;
    runs: number;
    models: string[];
    completed: number;
    structuralStability: number;
    modalSignature: string;
    steps: StepStability[];
    approvalCounts: number[];
    approvalDeterminism: boolean;
    /** Deterministic steps whose outputs differed between runs — the hypothesis fails on these. */
    violations: string[];
    /** Same summary, restricted to each model's runs. */
    perModel: Record<string, { runs: number; structuralStability: number; violations: string[] }>;
}

function stabilityOf(records: RunRecord[]): { structural: number; modal: string } {
    if (!records.length) { return { structural: 0, modal: '' }; }
    const counts = new Map<string, number>();
    for (const r of records) { const sig = structureSignature(r); counts.set(sig, (counts.get(sig) ?? 0) + 1); }
    let modal = '';
    let best = -1;
    for (const [sig, n] of counts) { if (n > best) { best = n; modal = sig; } }
    return { structural: best / records.length, modal };
}

function stepTable(records: RunRecord[]): StepStability[] {
    const byPath = new Map<string, StepStability & { hashes: Set<string> }>();
    for (const r of records) {
        for (const s of r.steps) {
            let entry = byPath.get(s.path);
            if (!entry) {
                entry = { path: s.path, type: s.type, modelDependent: s.modelDependent, statuses: [], attempts: [], distinctOutputs: 0, withOutput: 0, asPredicted: true, hashes: new Set() };
                byPath.set(s.path, entry);
            }
            if (!entry.statuses.includes(s.status)) { entry.statuses.push(s.status); }
            if (!entry.attempts.includes(s.attempts)) { entry.attempts.push(s.attempts); }
            if (s.outputHash) { entry.hashes.add(s.outputHash); entry.withOutput++; }
        }
    }
    return Array.from(byPath.values()).map(e => {
        const distinct = e.hashes.size;
        const { hashes: _h, ...rest } = e;
        void _h;
        return { ...rest, distinctOutputs: distinct, asPredicted: e.modelDependent || distinct <= 1 };
    });
}

export function summariseRuns(records: RunRecord[]): ReproReport {
    const harnessId = records[0]?.harnessId ?? '';
    const models = Array.from(new Set(records.map(r => r.model)));
    const { structural, modal } = stabilityOf(records);
    const steps = stepTable(records);
    const approvalCounts = Array.from(new Set(records.map(r => r.approvals))).sort((a, b) => a - b);
    const perModel: ReproReport['perModel'] = {};
    for (const m of models) {
        const mine = records.filter(r => r.model === m);
        perModel[m] = {
            runs: mine.length,
            structuralStability: stabilityOf(mine).structural,
            violations: stepTable(mine).filter(s => !s.asPredicted).map(s => s.path)
        };
    }
    return {
        harnessId,
        runs: records.length,
        models,
        completed: records.filter(r => r.status === 'done').length,
        structuralStability: structural,
        modalSignature: modal,
        steps,
        approvalCounts,
        approvalDeterminism: approvalCounts.length <= 1,
        violations: steps.filter(s => !s.asPredicted).map(s => s.path),
        perModel
    };
}

/** The report as Markdown: headline numbers, then one row per step. */
export function renderReproReport(report: ReproReport): string {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const lines = [
        `# Reproducibility: ${report.harnessId}`,
        '',
        `Runs: ${report.runs} (${report.completed} completed) across ${report.models.length} model(s): ${report.models.join(', ')}`,
        `Structural stability: ${pct(report.structuralStability)} of runs share the modal step graph`,
        `Approval requests per run: ${report.approvalCounts.join(', ') || '0'} → ${report.approvalDeterminism ? 'constant' : 'VARIES'}`,
        `Deterministic steps with differing outputs: ${report.violations.length ? report.violations.join(', ') : 'none'}`,
        '',
        '| Step | Type | Model-dependent | Statuses seen | Attempts | Distinct outputs | As predicted |',
        '| --- | --- | --- | --- | --- | --- | --- |'
    ];
    for (const s of report.steps) {
        lines.push(`| ${s.path} | ${s.type} | ${s.modelDependent ? 'yes' : 'no'} | ${s.statuses.join(', ')} | ${s.attempts.join(', ')} | ${s.distinctOutputs} | ${s.asPredicted ? 'yes' : 'NO'} |`);
    }
    if (report.models.length > 1) {
        lines.push('', '| Model | Runs | Structural stability | Violations |', '| --- | --- | --- | --- |');
        for (const [m, p] of Object.entries(report.perModel)) {
            lines.push(`| ${m} | ${p.runs} | ${pct(p.structuralStability)} | ${p.violations.join(', ') || 'none'} |`);
        }
    }
    return lines.join('\n');
}

/** Read-back of the definition, for `walkSteps` consumers that want the flat step list. */
export function flatSteps(def: HarnessDefinition): HarnessStep[] { return walkSteps(def.steps); }
