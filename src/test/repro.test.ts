/**
 * Reproducibility metrics: run records, structural stability, step-output stability, approvals.
 */

import * as assert from 'assert';
import { HarnessDefinition, HarnessRun } from '../../core/harness/types';
import { fnv1a, modelDependentIds, recordRun, renderReproReport, structureSignature, summariseRuns } from '../../core/harness/repro';

const def: HarnessDefinition = {
    id: 'r', name: 'R', version: '1.0.0', source: 'user',
    steps: [
        { id: 'scan', name: 'scan', type: 'tool', pluginId: 'grep-search', args: { query: 'x' } },
        { id: 'lanes', name: 'lanes', type: 'parallel', steps: [
            { id: 'files', name: 'files', type: 'resource', pluginId: 'workspace-files' },
            { id: 'note', name: 'note', type: 'llm', prompt: 'p' }
        ] },
        { id: 'report', name: 'report', type: 'llm', prompt: 'q' }
    ]
};

function run(noteText: string, reportText: string, scanText = 'Found 2 matches'): HarnessRun {
    return {
        harnessId: 'r', harnessName: 'R', input: '', status: 'done', output: reportText, startedAt: 1000, endedAt: 1500,
        steps: [
            { id: 'scan', name: 'scan', type: 'tool', status: 'done', attempts: 1, notes: [], output: scanText },
            { id: 'lanes', name: 'lanes', type: 'parallel', status: 'done', attempts: 1, notes: [], output: 'joined', children: [
                { id: 'files', name: 'files', type: 'resource', status: 'done', attempts: 1, notes: [], output: 'a.ts\nb.ts' },
                { id: 'note', name: 'note', type: 'llm', status: 'done', attempts: 1, notes: [], output: noteText }
            ] },
            { id: 'report', name: 'report', type: 'llm', status: 'done', attempts: 1, notes: [], output: reportText }
        ]
    };
}

suite('repro — records', () => {
    test('model dependence propagates from an llm step to the group containing it', () => {
        assert.deepStrictEqual(Array.from(modelDependentIds(def)).sort(), ['lanes', 'note', 'report']);
    });

    test('a record has one entry per step, with paths, hashes and dependence', () => {
        const rec = recordRun(def, run('n1', 'r1'), { model: 'm', index: 1, approvals: 2 });
        assert.deepStrictEqual(rec.steps.map(s => s.path), ['scan', 'lanes', 'lanes/files', 'lanes/note', 'report']);
        assert.deepStrictEqual(rec.steps.map(s => s.modelDependent), [false, true, false, true, true]);
        assert.strictEqual(rec.steps[0].outputHash, fnv1a('Found 2 matches'));
        assert.strictEqual(rec.approvals, 2);
        assert.strictEqual(rec.durationMs, 500);
        assert.strictEqual(structureSignature(rec), 'scan:done|lanes:done|lanes/files:done|lanes/note:done|report:done');
    });
});

suite('repro — summary', () => {
    test('variation confined to llm steps is reported as predicted', () => {
        const records = [1, 2, 3].map(i => recordRun(def, run(`note ${i}`, `report ${i}`), { model: 'm', index: i, approvals: 1 }));
        const report = summariseRuns(records);
        assert.strictEqual(report.structuralStability, 1);
        assert.deepStrictEqual(report.violations, []);
        assert.strictEqual(report.approvalDeterminism, true);
        const note = report.steps.find(s => s.path === 'lanes/note')!;
        assert.strictEqual(note.distinctOutputs, 3);
        assert.strictEqual(note.asPredicted, true, 'llm steps may vary');
        const scan = report.steps.find(s => s.path === 'scan')!;
        assert.strictEqual(scan.distinctOutputs, 1);
    });

    test('a deterministic step that varies is a violation, and a differing graph lowers structural stability', () => {
        const a = recordRun(def, run('n', 'r'), { model: 'm', index: 1, approvals: 1 });
        const b = recordRun(def, run('n', 'r', 'Found 3 matches'), { model: 'm', index: 2, approvals: 1 });
        const failed = run('n', 'r'); failed.steps[0].status = 'failed'; failed.status = 'failed';
        const c = recordRun(def, failed, { model: 'm', index: 3, approvals: 2 });
        const report = summariseRuns([a, b, c]);
        assert.deepStrictEqual(report.violations, ['scan']);
        assert.ok(Math.abs(report.structuralStability - 2 / 3) < 1e-9);
        assert.strictEqual(report.approvalDeterminism, false);
        assert.deepStrictEqual(report.approvalCounts, [1, 2]);
        assert.strictEqual(report.completed, 2);
    });

    test('per-model breakdown and the Markdown rendering', () => {
        const local = [1, 2].map(i => recordRun(def, run(`l${i}`, `L${i}`), { model: 'llama3', index: i, approvals: 0 }));
        const remote = [1, 2].map(i => recordRun(def, run(`b${i}`, `B${i}`), { model: 'blablador/alias-code', index: i, approvals: 0 }));
        const report = summariseRuns([...local, ...remote]);
        assert.deepStrictEqual(Object.keys(report.perModel), ['llama3', 'blablador/alias-code']);
        assert.strictEqual(report.perModel['llama3'].structuralStability, 1);
        const md = renderReproReport(report);
        assert.ok(md.includes('Structural stability: 100%'));
        assert.ok(md.includes('| lanes/note | llm | yes |'));
        assert.ok(md.includes('| blablador/alias-code | 2 | 100% | none |'));
    });
});
