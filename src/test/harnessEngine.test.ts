import * as assert from 'assert';
import { HarnessHost, LlmStepRequest, runHarness, summarizeRun, validateHarness } from '../harness/harnessEngine';
import { HarnessDefinition, HarnessRun } from '../harness/types';
import { builtInHarnesses } from '../harness/builtInHarnesses';

interface FakeHost extends HarnessHost {
    calls: string[];
    updates: number;
}

function makeHost(overrides: Partial<HarnessHost> = {}): FakeHost {
    const host: FakeHost = {
        calls: [],
        updates: 0,
        async runTool(pluginId, args) {
            host.calls.push(`tool:${pluginId}:${JSON.stringify(args)}`);
            if (pluginId === 'boom') { throw new Error('kaboom'); }
            if (pluginId === 'blocked') { return 'BLOCKED: nope'; }
            if (pluginId === 'find') { return 'Found 2 files:\na.ts\nb.ts'; }
            if (pluginId === 'read-file') { return `content of ${String(args.filePath)}`; }
            if (pluginId === 'flaky') {
                const n = host.calls.filter(c => c.startsWith('tool:flaky')).length;
                if (n < 2) { throw new Error('transient'); }
                return 'finally ok';
            }
            return `ran ${pluginId}`;
        },
        async runResource(pluginId) { host.calls.push(`resource:${pluginId}`); return `resource ${pluginId}`; },
        async runSkill(pluginId, input) { host.calls.push(`skill:${pluginId}:${input}`); return `skill ${pluginId} ${input}`; },
        async callModel(req: LlmStepRequest) {
            host.calls.push(`llm:${req.prompt}`);
            if (req.prompt.includes('give json')) { return req.prompt.includes('previous reply was not valid JSON') ? '{"ok":true}' : 'not json'; }
            return `echo:${req.prompt}|ctx:${req.system.includes('RUN CONTEXT') ? 'yes' : 'no'}`;
        },
        variables() { return { workspace: '/ws', activeFile: 'src/a.ts', selection: '' }; },
        onUpdate() { host.updates++; },
        ...overrides
    } as FakeHost;
    return host;
}

function def(steps: HarnessDefinition['steps'], extra: Partial<HarnessDefinition> = {}): HarnessDefinition {
    return { id: 'test-harness', name: 'Test', source: 'user', steps, ...extra };
}

async function run(d: HarnessDefinition, host: FakeHost, input = ''): Promise<HarnessRun> {
    return runHarness(d, host, { input, signal: new AbortController().signal, defaultModel: 'm' });
}

suite('harnessEngine — validation', () => {
    test('rejects missing pieces and duplicate ids', () => {
        const problems = validateHarness(def([
            { id: 'a', type: 'tool', pluginId: '', args: {} },
            { id: 'a', type: 'llm', prompt: '' },
            { id: 'bad id!', type: 'resource', pluginId: 'r' }
        ]));
        assert.ok(problems.some(p => p.includes('needs a pluginId')));
        assert.ok(problems.some(p => p.includes('used more than once')));
        assert.ok(problems.some(p => p.includes('needs a prompt')));
        assert.ok(problems.some(p => p.includes('bad id!')));
        assert.ok(validateHarness(def([])).some(p => p.includes('at least one step')));
    });

    test('every built-in harness is valid against the built-in plugins', () => {
        const known = {
            tools: new Set(['read-file', 'write-file', 'delete-file', 'semantic-search', 'grep-search', 'run-command', 'open-file']),
            resources: new Set(['workspace-files']),
            skills: new Set<string>()
        };
        for (const def of builtInHarnesses) {
            assert.deepStrictEqual(validateHarness(def, known), [], `built-in ${def.id} should validate`);
        }
        assert.ok(builtInHarnesses.some(d => d.steps.some(s => s.type === 'parallel')), 'a built-in should demonstrate parallel lanes');
    });

    test('checks plugin ids against the registry when given', () => {
        const problems = validateHarness(def([{ id: 'a', type: 'tool', pluginId: 'nope', args: {} }]), { tools: new Set(['read-file']), resources: new Set(), skills: new Set() });
        assert.ok(problems.some(p => p.includes('"nope" is not registered')));
    });
});

suite('harnessEngine — execution', () => {
    test('runs steps in order, interpolates variables, and returns the last output', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'read', type: 'tool', pluginId: 'read-file', args: { filePath: '{{activeFile}}' } },
            { id: 'ask', type: 'llm', prompt: 'Explain {{steps.read.output}} for {{input}}' }
        ]), host, 'me');
        assert.strictEqual(result.status, 'done');
        assert.deepStrictEqual(host.calls[0], 'tool:read-file:{"filePath":"src/a.ts"}');
        assert.strictEqual(result.output, 'echo:Explain content of src/a.ts for me|ctx:yes');
        assert.ok(host.updates > 3);
    });

    test('stops on failure by default and marks later steps skipped', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'a', type: 'tool', pluginId: 'boom', args: {} },
            { id: 'b', type: 'tool', pluginId: 'ok', args: {} }
        ]), host);
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.steps[0].status, 'failed');
        assert.strictEqual(result.steps[0].error, 'kaboom');
        assert.strictEqual(result.steps[1].status, 'skipped');
        assert.ok(!host.calls.some(c => c.startsWith('tool:ok')));
    });

    test('continue policy keeps going and BLOCKED outputs count as failures', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'a', type: 'tool', pluginId: 'blocked', args: {}, onError: 'continue' },
            { id: 'b', type: 'tool', pluginId: 'ok', args: {} }
        ]), host);
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.steps[0].status, 'failed');
        assert.ok(result.steps[0].error?.startsWith('BLOCKED'));
        assert.strictEqual(result.steps[1].status, 'done');
        assert.strictEqual(result.output, 'ran ok');
        assert.ok(result.error?.includes('some steps failed'));
    });

    test('retry policy retries flaky steps', async () => {
        const host = makeHost();
        const result = await run(def([{ id: 'f', type: 'tool', pluginId: 'flaky', args: {}, onError: 'retry-then-stop', retries: 2 }]), host);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(result.steps[0].attempts, 2);
        assert.strictEqual(result.output, 'finally ok');
        assert.ok(result.steps[0].notes.some(n => n.includes('Retrying')));
    });

    test('when conditions skip steps and can compare statuses', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 't', type: 'tool', pluginId: 'boom', args: {}, onError: 'continue' },
            { id: 'onfail', type: 'llm', prompt: 'failed branch', when: '{{steps.t.status}} == failed' },
            { id: 'onok', type: 'llm', prompt: 'ok branch', when: '{{steps.t.status}} == done' }
        ], { output: '{{steps.onfail.output}}{{steps.onok.output}}' }), host);
        assert.strictEqual(result.steps[1].status, 'done');
        assert.strictEqual(result.steps[2].status, 'skipped');
        assert.ok(result.output.startsWith('echo:failed branch'));
    });

    test('unknown variables fail the step with a helpful error', async () => {
        const host = makeHost();
        const result = await run(def([{ id: 'a', type: 'tool', pluginId: 'ok', args: { x: '{{steps.nothing.output}}' } }]), host);
        assert.strictEqual(result.steps[0].status, 'failed');
        assert.ok(result.steps[0].error?.includes('no step "nothing"'));
    });

    test('parallel groups run children together and report each', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'p', type: 'parallel', steps: [
                { id: 'x', type: 'tool', pluginId: 'ok', args: {} },
                { id: 'y', type: 'resource', pluginId: 'r' }
            ] },
            { id: 'after', type: 'llm', prompt: '{{steps.x.output}} + {{steps.y.output}}' }
        ]), host);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(result.steps[0].children?.length, 2);
        assert.ok(result.output.startsWith('echo:ran ok + resource r'));
    });

    test('sequence groups run in order and make lanes inside parallel groups', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'p', type: 'parallel', steps: [
                { id: 'lane1', type: 'sequence', steps: [
                    { id: 'a', type: 'tool', pluginId: 'ok', args: {} },
                    { id: 'b', type: 'llm', prompt: 'after {{steps.a.output}}' }
                ] },
                { id: 'c', type: 'resource', pluginId: 'r' }
            ] },
            { id: 'end', type: 'llm', prompt: '{{steps.lane1.output}} / {{steps.b.output}} / {{steps.c.output}}' }
        ]), host);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(result.steps[0].children?.[0].children?.length, 2);
        assert.ok(result.output.startsWith('echo:echo:after ran ok|ctx:yes / echo:after ran ok|ctx:yes / resource r'));
        const stopped = await run(def([{ id: 's', type: 'sequence', steps: [
            { id: 'x', type: 'tool', pluginId: 'boom', args: {} },
            { id: 'y', type: 'tool', pluginId: 'ok', args: {} }
        ] }]), makeHost());
        assert.strictEqual(stopped.status, 'failed');
        assert.ok(stopped.steps[0].error?.includes('Sequence stopped'));
        assert.strictEqual(stopped.steps[0].children?.[1].status, 'skipped');
    });

    test('foreach iterates over lines and exposes item/index', async () => {
        const host = makeHost();
        const result = await run(def([
            { id: 'find', type: 'tool', pluginId: 'find', args: {} },
            { id: 'each', type: 'foreach', items: '{{steps.find.lines}}', steps: [
                { id: 'r', type: 'tool', pluginId: 'read-file', args: { filePath: '{{item}}', n: '{{index}}' } }
            ] }
        ]), host);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(result.steps[1].children?.length, 2);
        assert.ok(host.calls.includes('tool:read-file:{"filePath":"a.ts","n":0}'));
        assert.ok(host.calls.includes('tool:read-file:{"filePath":"b.ts","n":1}'));
        assert.ok(result.output.includes('content of a.ts') && result.output.includes('content of b.ts'));
    });

    test('llm json steps validate and retry once', async () => {
        const host = makeHost();
        const result = await run(def([{ id: 'j', type: 'llm', prompt: 'give json', expect: 'json' }]), host);
        assert.strictEqual(result.status, 'done');
        assert.deepStrictEqual(JSON.parse(result.output), { ok: true });
        assert.ok(result.steps[0].notes.some(n => n.includes('not valid JSON')));
    });

    test('llm steps are briefed about failed steps', async () => {
        let captured = '';
        const host = makeHost({ async callModel(req) { captured = req.system; return 'ok'; } });
        await run(def([
            { id: 'a', type: 'tool', pluginId: 'boom', args: {}, onError: 'continue' },
            { id: 'b', type: 'llm', prompt: 'x' }
        ]), host);
        assert.ok(captured.includes('[FAILED] a'));
        assert.ok(captured.includes('error: kaboom'));
        assert.ok(captured.includes('Do not invent'));
    });

    test('cancellation marks the run cancelled', async () => {
        const controller = new AbortController();
        const host = makeHost({ async runTool() { controller.abort(); return 'x'; } });
        const result = await runHarness(def([
            { id: 'a', type: 'tool', pluginId: 'ok', args: {} },
            { id: 'b', type: 'tool', pluginId: 'ok', args: {} }
        ]), host, { input: '', signal: controller.signal });
        assert.strictEqual(result.status, 'cancelled');
        assert.strictEqual(result.steps[1].status, 'skipped');
    });

    test('summary mentions status and failures', async () => {
        const host = makeHost();
        const result = await run(def([{ id: 'a', type: 'tool', pluginId: 'boom', args: {} }]), host);
        const text = summarizeRun(result);
        assert.ok(text.includes('failed'));
        assert.ok(text.includes('kaboom'));
    });
});
