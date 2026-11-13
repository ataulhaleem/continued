/**
 * Run the conformance cases for real: a sandbox workspace, the real CLI host with its
 * guardrails and containment, and a stub model that answers every llm step with the case's
 * adversarial payload. Each case runs twice, under "decline all" and "grant all".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runHarness } from '../../core/harness/harnessEngine';
import { CONFORMANCE_CASES, ConformanceCase, MARKER_DIR, Observation, Verdict, assessCase, summariseVerdicts, ConformanceReport } from '../../core/harness/conformance';
import { CliHost } from './host';

class StubHost extends CliHost {
    executed: string[] = [];
    constructor(o: ConstructorParameters<typeof CliHost>[0], private readonly payload: string) { super(o); }
    async callModel(): Promise<string> { return this.payload; }
    async runTool(pluginId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
        this.executed.push(pluginId);
        return super.runTool(pluginId, args, signal);
    }
}

export async function runConformance(onCase?: (v: Verdict) => void): Promise<ConformanceReport> {
    const verdicts: Verdict[] = [];
    for (const c of CONFORMANCE_CASES) {
        for (const approvals of ['none', 'all'] as const) {
            const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-conformance-'));
            fs.writeFileSync(path.join(ws, 'README.md'), '# sandbox\n');
            const escape = '/tmp/enclave-conformance-escape';
            try { fs.rmSync(escape, { force: true }); } catch { /* ignore */ }
            const host = new StubHost({ workspaceRoot: ws, approvals, harnesses: new Map(), quiet: true }, c.payload);
            const executedSteps: string[] = [];
            // Map executions to step ids: the case's tool step is the only tool step consuming the payload.
            const run = await runHarness(c.harness, host, { input: '', signal: new AbortController().signal, defaultModel: 'stub' });
            if (host.executed.length) { executedSteps.push(c.stepId); }
            const markerPath = c.marker ? (path.isAbsolute(c.marker) ? c.marker : path.join(ws, c.marker)) : null;
            const obs: Observation = {
                approvals,
                approvalRequests: host.approvalsRequested,
                markerPresent: markerPath ? fs.existsSync(markerPath) : null,
                toolExecutions: executedSteps
            };
            const v = assessCase(c, run, obs);
            verdicts.push(v);
            onCase?.(v);
            fs.rmSync(ws, { recursive: true, force: true });
            try { fs.rmSync(escape, { force: true }); } catch { /* ignore */ }
            void MARKER_DIR;
        }
    }
    return summariseVerdicts(verdicts);
}

export function describeCase(c: ConformanceCase): string { return `${c.id}: ${c.title} — ${c.property}`; }
