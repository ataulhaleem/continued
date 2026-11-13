/**
 * Grounding checker: claim extraction and lookup against deterministic step outputs.
 */

import * as assert from 'assert';
import { HarnessRun } from '../../core/harness/types';
import { checkGrounding, extractNumbers, extractQuotes, renderGrounding } from '../../core/harness/grounding';

const source = `[page 3]\nResults\nThe mean concentration was 42.5 mg/L (SD 3.1, n = 18) in the treatment group and 17.2 mg/L in controls (p < 0.001).\nA total of 1,204 samples were analysed over 12 weeks.`;

const runWith = (llmOutput: string): HarnessRun => ({
    harnessId: 'g', harnessName: 'g', input: '', status: 'done', output: llmOutput, startedAt: 0, endedAt: 1,
    steps: [
        { id: 'read', name: 'read', type: 'tool', status: 'done', attempts: 1, notes: [], output: source },
        { id: 'answer', name: 'answer', type: 'llm', status: 'done', attempts: 1, notes: [], output: llmOutput }
    ]
});

suite('grounding — extraction', () => {
    test('quotes: straight, curly and block quotes of passage length', () => {
        const q = extractQuotes('He wrote "The mean concentration was 42.5 mg/L" and “in the treatment group and 17.2 mg/L” and "short".\n> A total of 1,204 samples were analysed');
        assert.deepStrictEqual(q, ['The mean concentration was 42.5 mg/L', 'in the treatment group and 17.2 mg/L', 'A total of 1,204 samples were analysed']);
    });

    test('numbers: decimals, thousands, percents; not list numbering, citation years or page markers', () => {
        const n = extractNumbers('1. First point: 42.5 mg/L and 1,204 samples, 17.2% (Smith et al., 2021) [page 3] [12]\n2. p < 0.001');
        assert.deepStrictEqual(n, ['42.5', '1,204', '17.2%', '0.001']);
    });
});

suite('grounding — checking', () => {
    test('grounded claims are found with normalised whitespace and separators', () => {
        const r = checkGrounding(runWith('The paper reports "the mean concentration was 42.5 mg/L (SD 3.1, n = 18)" across 1204 samples over 12 weeks; the control value was 17.2 mg/L.'));
        assert.strictEqual(r.quotes, 1); assert.strictEqual(r.quotesGrounded, 1);
        assert.strictEqual(r.numbers, 6, JSON.stringify(r.steps[0]));
        assert.strictEqual(r.numbersGrounded, 6, JSON.stringify(r.steps[0].ungrounded));
        assert.strictEqual(r.rate, 1);
    });

    test('fabricated numbers and misquotes are listed', () => {
        const r = checkGrounding(runWith('It says "the mean concentration was 44.5 mg/L" and that 2,000 samples were used, with a p-value of 0.001.'));
        assert.strictEqual(r.quotesGrounded, 0);
        assert.deepStrictEqual(r.steps[0].ungrounded.map(c => c.text), ['the mean concentration was 44.5 mg/L', '44.5', '2,000']);
        assert.ok(renderGrounding(r).includes('| answer | 0/1 | 1/3 |'));
    });

    test('a run with no checkable claims has a null rate', () => {
        assert.strictEqual(checkGrounding(runWith('The article discusses concentrations in two groups.')).rate, null);
    });
});
