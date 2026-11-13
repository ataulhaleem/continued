/**
 * Conformance cases: well-formed, and the assessment logic recognises each outcome.
 */

import * as assert from 'assert';
import { HarnessRun, StepRun } from '../../core/harness/types';
import { validateHarness } from '../../core/harness/harnessEngine';
import { assessCase, CONFORMANCE_CASES, summariseVerdicts, renderConformance } from '../../core/harness/conformance';

const step = (id: string, status: StepRun['status'], extra: Partial<StepRun> = {}): StepRun => ({ id, name: id, type: 'tool', status, attempts: 1, notes: [], ...extra });
const run = (steps: StepRun[], status: HarnessRun['status'] = 'done'): HarnessRun => ({ harnessId: 'c', harnessName: 'c', input: '', status, steps, output: '', startedAt: 0, endedAt: 1 });
const byId = (id: string) => CONFORMANCE_CASES.find(c => c.id === id)!;

suite('conformance — cases', () => {
    test('every case is a valid harness whose payload reaches the step under test', () => {
        const known = { tools: new Set(['run-command', 'read-file', 'list-directory']), resources: new Set<string>(), skills: new Set<string>() };
        for (const c of CONFORMANCE_CASES) {
            assert.deepStrictEqual(validateHarness(c.harness, known), [], c.id);
            const target = c.harness.steps.find(s => s.id === c.stepId);
            assert.ok(target, `${c.id}: step ${c.stepId} exists`);
            if (c.expectation !== 'inert') {
                assert.ok(JSON.stringify((target as { args?: unknown }).args).includes('{{steps.plan.output}}'), `${c.id}: the tool consumes the model output`);
            }
        }
        assert.ok(CONFORMANCE_CASES.length >= 10);
    });
});

suite('conformance — assessment', () => {
    test('blocked: BLOCKED error, no execution, no question', () => {
        const c = byId('forbidden-rm');
        const good = assessCase(c, run([step('plan', 'done', { type: 'llm' }), step('act', 'failed', { error: 'BLOCKED: Command is forbidden' })]), { approvals: 'all', approvalRequests: 0, markerPresent: null, toolExecutions: [] });
        assert.strictEqual(good.pass, true);
        const asked = assessCase(c, run([step('act', 'failed', { error: 'BLOCKED: x' })]), { approvals: 'all', approvalRequests: 1, markerPresent: null, toolExecutions: [] });
        assert.strictEqual(asked.pass, false);
        const ran = assessCase(c, run([step('act', 'done', { output: 'gone' })]), { approvals: 'all', approvalRequests: 0, markerPresent: null, toolExecutions: ['act'] });
        assert.strictEqual(ran.pass, false);
        assert.strictEqual(ran.observed, 'executed');
    });

    test('requires-approval: declined leaves no trace and is not retried; granted runs', () => {
        const c = byId('decline-terminal');
        const declined = run([step('plan', 'done', { type: 'llm' }), step('act', 'failed', { error: 'DECLINED: the user did not approve this step.', attempts: 1 }), step('after', 'pending')], 'failed');
        assert.strictEqual(assessCase(c, declined, { approvals: 'none', approvalRequests: 1, markerPresent: false, toolExecutions: [] }).pass, true);
        const retried = run([step('act', 'failed', { error: 'DECLINED: no', attempts: 3 })], 'failed');
        assert.strictEqual(assessCase(c, retried, { approvals: 'none', approvalRequests: 1, markerPresent: false, toolExecutions: [] }).pass, false);
        const carried = run([step('act', 'failed', { error: 'DECLINED: no' }), step('after', 'done')], 'done');
        assert.strictEqual(assessCase(c, carried, { approvals: 'none', approvalRequests: 1, markerPresent: false, toolExecutions: [] }).pass, false);
        const granted = run([step('act', 'done', { output: '' })]);
        assert.strictEqual(assessCase(c, granted, { approvals: 'all', approvalRequests: 1, markerPresent: true, toolExecutions: ['act'] }).pass, true);
        const silent = assessCase(c, granted, { approvals: 'all', approvalRequests: 0, markerPresent: true, toolExecutions: ['act'] });
        assert.strictEqual(silent.pass, false);
        assert.strictEqual(silent.observed, 'executed without asking');
    });

    test('denied and inert', () => {
        const d = byId('read-traversal');
        assert.strictEqual(assessCase(d, run([step('act', 'failed', { error: "Access denied: '../../etc/passwd' is outside the workspace" })]), { approvals: 'all', approvalRequests: 0, markerPresent: null, toolExecutions: ['act'] }).pass, true);
        assert.strictEqual(assessCase(d, run([step('act', 'done', { output: 'root:x:0:0' })]), { approvals: 'all', approvalRequests: 0, markerPresent: null, toolExecutions: ['act'] }).pass, false);
        const i = byId('injection-inert');
        assert.strictEqual(assessCase(i, run([step('plan', 'done', { type: 'llm' }), step('summary', 'done', { type: 'llm', output: 'It asks to delete things.' })]), { approvals: 'none', approvalRequests: 0, markerPresent: null, toolExecutions: [] }).pass, true);
    });

    test('summary counts unapproved executions and renders', () => {
        const c = byId('forbidden-rm');
        const v = [assessCase(c, run([step('act', 'done')]), { approvals: 'all', approvalRequests: 0, markerPresent: null, toolExecutions: ['act'] })];
        const report = summariseVerdicts(v);
        assert.strictEqual(report.unapprovedExecutions, 1);
        assert.ok(renderConformance(report).includes('| forbidden-rm | blocked | all | executed | NO |'));
    });
});
