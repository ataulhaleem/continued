/**
 * The model benchmark: fixed micro-tasks scored mechanically, summarised per model.
 */

import * as assert from 'assert';
import { BENCH_TASKS, failedTask, probeTable, scoreTask, stripFences, summariseProbe } from '../../core/harness/modelBench';
import { builtInHarnesses } from '../harness/builtInHarnesses';
import { validateHarness } from '../../core/harness/harnessEngine';

const task = (id: string) => BENCH_TASKS.find(t => t.id === id)!;

suite('modelBench — scoring', () => {
    test('instruction following accepts the bare word with punctuation and rejects chatter', () => {
        assert.strictEqual(task('follow').check('pineapple'), true);
        assert.strictEqual(task('follow').check('Pineapple.'), true);
        assert.strictEqual(task('follow').check('Sure! The word is pineapple.'), false);
    });

    test('arithmetic reads the first integer in the reply', () => {
        assert.strictEqual(task('arithmetic').check('391'), true);
        assert.strictEqual(task('arithmetic').check('The answer is 391.'), true);
        assert.strictEqual(task('arithmetic').check('17 × 23 = 391'), false, 'a restated question puts 17 first; the model was told to reply with only the number');
        assert.strictEqual(task('arithmetic').check('390'), false);
    });

    test('code task needs the function and a parity test', () => {
        assert.strictEqual(task('code').check('```python\ndef is_even(n):\n    return n % 2 == 0\n```'), true);
        assert.strictEqual(task('code').check('def is_even(n): return n & 1 == 0'), true);
        assert.strictEqual(task('code').check('def is_even(n):\n    return True'), false);
    });

    test('structured output parses fenced or bare JSON and checks both keys', () => {
        assert.strictEqual(task('json').check('{"city":"Paris","country":"France"}'), true);
        assert.strictEqual(task('json').check('```json\n{"city": "Paris", "country": "France"}\n```'), true);
        assert.strictEqual(task('json').check('{"city":"Lyon","country":"France"}'), false);
        assert.strictEqual(task('json').check('Paris, France'), false);
        assert.strictEqual(stripFences('```\nx\n```'), 'x');
    });
});

suite('modelBench — summary', () => {
    test('a reachable model: pass count, mean latency and speed over answered calls only', () => {
        const results = [
            scoreTask(task('follow'), 'pineapple', 500),
            scoreTask(task('arithmetic'), '392', 1500),
            failedTask(task('code'), 'timed out', 60000),
            scoreTask(task('json'), '{"city":"Paris","country":"France"}', 1000)
        ];
        const s = summariseProbe('blablador/alias-fast', results);
        assert.strictEqual(s.reachable, true);
        assert.strictEqual(s.passed, 2);
        assert.strictEqual(s.total, 4);
        assert.strictEqual(s.meanMs, 1000, 'the timed-out call is not averaged in');
        const chars = 'pineapple'.length + '392'.length + '{"city":"Paris","country":"France"}'.length;
        assert.strictEqual(s.charsPerSecond, Math.round(chars / 3));
        assert.strictEqual(s.error, undefined);
        const table = probeTable([s]);
        assert.ok(table.includes('| blablador/alias-fast | yes | 2/4 | 1.0 s |'), table);
        assert.ok(table.includes('Arithmetic'), 'failed tasks are named');
    });

    test('an unreachable model carries the first error and no numbers', () => {
        const results = BENCH_TASKS.map((t, i) => failedTask(t, i === 0 ? 'Blablador API key is not configured.' : 'Not attempted after the first call failed.', 0));
        const s = summariseProbe('blablador/alias-code', results);
        assert.strictEqual(s.reachable, false);
        assert.strictEqual(s.error, 'Blablador API key is not configured.');
        assert.strictEqual(s.meanMs, null);
        assert.strictEqual(s.charsPerSecond, null);
        assert.ok(probeTable([s]).includes('| blablador/alias-code | no | 0/4 | — | — | Blablador API key'));
    });

    test('the custom task rides along when given', () => {
        const s = summariseProbe('m', [scoreTask(task('follow'), 'pineapple', 10)], { ms: 20, answer: 'hi' });
        assert.deepStrictEqual(s.custom, { ms: 20, answer: 'hi' });
    });
});

suite('modelBench — the Blablador harness', () => {
    const def = builtInHarnesses.find(h => h.id === 'blablador-models-harness')!;

    test('is well-formed against the tools it uses and fans out over the catalog in parallel', () => {
        const known = { tools: new Set(['model-catalog', 'model-probe']), resources: new Set<string>(), skills: new Set<string>() };
        assert.deepStrictEqual(validateHarness(def, known), []);
        const probes = def.steps.find(s => s.id === 'probes') as { type: string; items: string; parallel?: boolean; itemVar?: string };
        assert.strictEqual(probes.type, 'foreach');
        assert.strictEqual(probes.parallel, true);
        assert.strictEqual(probes.items, '{{steps.catalog.json.ids}}');
        assert.strictEqual(probes.itemVar, 'model');
    });

    test('its output ends with the documentation links', () => {
        assert.ok(def.output?.includes('blablador_models/'));
        assert.ok(def.output?.includes('blablador_api_access/'));
        assert.ok(def.output?.startsWith('{{steps.compare.output}}'));
    });
});
