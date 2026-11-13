/**
 * Tests for portable harness documents.
 *
 * Export and import are the interoperability contract: a file written by one install has to
 * be readable by another, by a hand-editing user, and by a future version. These tests pin
 * the round trip, the tolerance for older and newer files, and the fact that a malformed
 * file is rejected with a diagnostic rather than accepted silently.
 */

import * as assert from 'assert';
import {
    PORTABLE_FORMAT_VERSION,
    collectRequirements,
    exportFileName,
    fromPortable,
    toMarkdown,
    toPortable,
    toPortableJson,
    walkSteps
} from '../../core/harness/portable';
import { validateHarness } from '../../core/harness/harnessEngine';
import { HarnessDefinition } from '../../core/harness/types';
import { builtInHarnesses } from '../harness/builtInHarnesses';

const SAMPLE: HarnessDefinition = {
    id: 'triage-harness',
    name: 'Triage failing tests',
    description: 'Runs the tests, then explains each failure.',
    source: 'built-in',
    input: { label: 'Test command', placeholder: 'npm test', required: true },
    steps: [
        { id: 'tests', name: 'Run tests', type: 'tool', pluginId: 'run-command', args: { command: '{{input}}' }, onError: 'continue', timeoutMs: 300000 },
        {
            id: 'each', name: 'Per failure', type: 'foreach', items: '{{steps.tests.lines}}', itemVar: 'failure', maxItems: 10,
            steps: [
                { id: 'read', type: 'tool', pluginId: 'read-file', args: { filePath: '{{activeFile}}' }, onError: 'retry-then-continue', retries: 1 },
                { id: 'explain', type: 'llm', prompt: 'Explain {{failure}} in {{activeFile}}.', expect: 'json' }
            ]
        },
        { id: 'ctx', type: 'resource', pluginId: 'diagnostics' }
    ],
    output: '{{steps.each.output}}'
};

const FIXED = new Date('2026-09-23T10:00:00.000Z');

suite('portable — requirements', () => {
    test('collects every plugin, variable and whether a model is used', () => {
        const requires = collectRequirements(SAMPLE);
        assert.deepStrictEqual(requires.tools, ['read-file', 'run-command']);
        assert.deepStrictEqual(requires.resources, ['diagnostics']);
        assert.deepStrictEqual(requires.skills, []);
        assert.strictEqual(requires.usesModel, true);
        // `input`, `activeFile` and the loop variable are needed; `steps.*` back-references are not.
        assert.deepStrictEqual(requires.variables, ['activeFile', 'failure', 'input']);
    });

    test('reports usesModel false for a harness with no llm step', () => {
        const def: HarnessDefinition = {
            id: 'h', name: 'H', source: 'user',
            steps: [{ id: 's', type: 'tool', pluginId: 'grep-search', args: { query: 'TODO' } }]
        };
        assert.strictEqual(collectRequirements(def).usesModel, false);
    });

    test('walkSteps reaches nested children', () => {
        assert.deepStrictEqual(walkSteps(SAMPLE.steps).map(s => s.id), ['tests', 'each', 'read', 'explain', 'ctx']);
    });
});

suite('portable — export', () => {
    test('wraps the definition with provenance and drops the local source field', () => {
        const doc = toPortable(SAMPLE, { generator: 'enclave/1.0.1', now: FIXED });
        assert.strictEqual(doc.formatVersion, PORTABLE_FORMAT_VERSION);
        assert.strictEqual(doc.exportedAt, '2026-09-23T10:00:00.000Z');
        assert.strictEqual(doc.generator, 'enclave/1.0.1');
        assert.ok(doc.$schema);
        // 'built-in' describes this install, not the file, so it must not travel.
        // Checked through a record view: `in` on the declared type would narrow it to never.
        assert.ok(!('source' in (doc.harness as unknown as Record<string, unknown>)), '"source" leaked into the exported harness');
        assert.strictEqual(doc.harness.id, 'triage-harness');
        assert.deepStrictEqual(doc.requires.tools, ['read-file', 'run-command']);
    });

    test('produces pretty, newline-terminated JSON', () => {
        const json = toPortableJson(SAMPLE, { now: FIXED });
        assert.ok(json.endsWith('\n'));
        assert.ok(json.includes('\n  "formatVersion"'));
        assert.deepStrictEqual(JSON.parse(json).harness.id, 'triage-harness');
    });

    test('file names are filesystem-safe and typed', () => {
        assert.strictEqual(exportFileName(SAMPLE, 'json'), 'triage-harness.harness.json');
        assert.strictEqual(exportFileName(SAMPLE, 'md'), 'triage-harness.harness.md');
        // A crafted id must not produce a name that escapes its directory or hides itself.
        for (const id of ['../../etc/pas swd', '..', '.', './.ssh/config', '   ']) {
            const name = exportFileName({ ...SAMPLE, id }, 'json');
            assert.ok(!name.startsWith('.'), `"${id}" produced a dotted name: ${name}`);
            assert.ok(!name.includes('/') && !name.includes('\\'), `"${id}" produced a path: ${name}`);
            assert.ok(name.endsWith('.harness.json'));
        }
        assert.strictEqual(exportFileName({ ...SAMPLE, id: '../../etc/pas swd' }, 'json'), 'etc-pas-swd.harness.json');
    });
});

suite('portable — import', () => {
    test('round-trips an exported document', () => {
        const json = toPortableJson(SAMPLE, { now: FIXED });
        const result = fromPortable(json, validateHarness);
        assert.deepStrictEqual(result.problems, []);
        assert.deepStrictEqual(result.warnings, []);
        assert.ok(result.harness);
        assert.strictEqual(result.harness!.id, SAMPLE.id);
        assert.deepStrictEqual(result.harness!.steps, SAMPLE.steps);
        // Whatever the file claimed, an imported harness belongs to this user.
        assert.strictEqual(result.harness!.source, 'user');
    });

    test('accepts a bare definition, as hand-written files are', () => {
        const bare = JSON.stringify({ ...SAMPLE, source: 'built-in' });
        const result = fromPortable(bare, validateHarness);
        assert.deepStrictEqual(result.problems, []);
        assert.strictEqual(result.harness!.id, SAMPLE.id);
        assert.strictEqual(result.harness!.source, 'user');
        assert.ok(result.warnings.length === 0, 'a bare definition should not warn about versions');
    });

    test('warns but still imports a file from a newer format', () => {
        const doc = toPortable(SAMPLE, { now: FIXED });
        const newer = JSON.stringify({ ...doc, formatVersion: '99.0', somethingNew: true });
        const result = fromPortable(newer, validateHarness);
        assert.deepStrictEqual(result.problems, []);
        assert.ok(result.harness);
        assert.ok(result.warnings.some(w => w.includes('99.0')), `expected a version warning, got ${result.warnings.join(' / ')}`);
    });

    test('warns when a wrapped document has no version', () => {
        const result = fromPortable(JSON.stringify({ harness: SAMPLE }), validateHarness);
        assert.deepStrictEqual(result.problems, []);
        assert.ok(result.warnings.some(w => /no format version/i.test(w)));
    });

    test('rejects malformed input with a diagnostic, never silently', () => {
        const cases: Array<[string, RegExp]> = [
            ['{ not json', /not valid JSON/i],
            ['[1,2,3]', /must contain a JSON object/i],
            ['{"hello":"world"}', /neither a "harness" object nor a "steps" array/i],
            ['{"harness": 42}', /not valid JSON|must be an object|harness/i]
        ];
        for (const [input, expected] of cases) {
            const result = fromPortable(input, validateHarness);
            assert.strictEqual(result.harness, undefined, `accepted bad input: ${input}`);
            assert.ok(result.problems.length > 0, `no problem reported for: ${input}`);
            assert.ok(expected.test(result.problems.join(' ')), `unexpected problem for ${input}: ${result.problems.join(' ')}`);
        }
    });

    test('surfaces validation problems rather than importing a broken harness', () => {
        const broken = JSON.stringify({ harness: { id: 'x', name: 'X', steps: [{ id: 'a', type: 'nonsense' }] }, formatVersion: '1.0' });
        const result = fromPortable(broken, validateHarness);
        assert.strictEqual(result.harness, undefined);
        assert.ok(result.problems.some(p => /unknown step type/i.test(p)), result.problems.join(' / '));
    });
});

suite('portable — markdown rendering', () => {
    const md = toMarkdown(SAMPLE, { generator: 'Enclave 1.0.1' });

    test('states the title, description and what the procedure needs', () => {
        assert.ok(md.startsWith('# Triage failing tests'));
        assert.ok(md.includes('Runs the tests, then explains each failure.'));
        assert.ok(md.includes('`run-command`') && md.includes('`read-file`'), 'tools not listed');
        assert.ok(md.includes('`diagnostics`'), 'resources not listed');
        assert.ok(md.includes('A language model: yes'));
    });

    test('describes the input contract', () => {
        assert.ok(md.includes('Test command (required)'));
        assert.ok(md.includes('npm test'));
    });

    test('renders every step, nesting children under their parent', () => {
        for (const id of ['tests', 'each', 'read', 'explain', 'ctx']) {
            assert.ok(md.includes(`\`[${id}]\``), `step ${id} missing from the playbook`);
        }
        const nested = md.split('\n').find(l => l.includes('`[read]`'));
        assert.ok(nested && nested.startsWith('  -'), `child step not indented: ${nested}`);
    });

    test('marks where judgement is required and carries the prompt', () => {
        assert.ok(md.includes('**Ask the model**'));
        assert.ok(md.includes('Explain {{failure}} in {{activeFile}}.'));
        assert.ok(md.includes('must be valid JSON'));
    });

    test('explains error policies in words rather than enum names', () => {
        assert.ok(md.includes('note the failure and carry on'), 'onError: continue not explained');
        assert.ok(md.includes('retry, then carry on'), 'onError: retry-then-continue not explained');
        assert.ok(!md.includes('retry-then-continue.'), 'raw enum value leaked into the prose');
    });

    test('documents the template notation a foreign agent would not know', () => {
        assert.ok(md.includes('{{steps.<id>.output}}'));
        assert.ok(md.includes('{{item}}'));
    });

    test('provenance can be suppressed for embedding in a larger document', () => {
        assert.ok(md.includes('Generated from the `triage-harness` workflow-harness'));
        assert.ok(!toMarkdown(SAMPLE, { includeProvenance: false }).includes('Generated from'));
    });
});

suite('portable — every built-in harness survives a round trip', () => {
    for (const def of builtInHarnesses) {
        test(`${def.id} exports, re-imports and renders`, () => {
            const result = fromPortable(toPortableJson(def, { now: FIXED }), validateHarness);
            assert.deepStrictEqual(result.problems, [], `${def.id} failed to re-import`);
            assert.deepStrictEqual(result.harness!.steps, def.steps);

            const rendered = toMarkdown(def);
            assert.ok(rendered.includes(def.name), `${def.id} markdown lacks its name`);
            for (const step of walkSteps(def.steps)) {
                assert.ok(rendered.includes(`\`[${step.id}]\``), `${def.id} markdown omits step ${step.id}`);
            }
        });
    }
});
