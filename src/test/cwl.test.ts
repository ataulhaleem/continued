/**
 * Tests for the Common Workflow Language export.
 *
 * `cwltool --validate` and an end-to-end run against a stub model server were used while
 * developing the translator; those need a Python environment the unit suite cannot assume. What
 * is pinned here is the structure the translator must produce for each harness construct, the
 * constraints the embedded runner has to satisfy to survive YAML-in-an-expression-field, and the
 * fact that every built-in harness translates without throwing.
 */

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import {
    CWL_RUNNER_SCRIPT,
    CWL_VERSION,
    buildCwlGraph,
    cwlFileNames,
    cwlId,
    referencedVariables,
    toCwl,
    toYaml
} from '../../core/harness/cwl';
import { HarnessDefinition } from '../../core/harness/types';
import { builtInHarnesses } from '../harness/builtInHarnesses';

type Obj = Record<string, any>;

function byId(id: string): HarnessDefinition {
    const def = builtInHarnesses.find(h => h.id === id);
    assert.ok(def, `built-in harness ${id} missing`);
    return def!;
}

function main(def: HarnessDefinition): Obj {
    const { graph } = buildCwlGraph(def, { now: new Date('2026-09-23T12:00:00Z') });
    return graph.$graph.find(p => p.id === 'main') as Obj;
}

function spec(step: Obj): Obj {
    return JSON.parse(step.in.spec.default);
}

suite('cwl — identifiers and file names', () => {
    test('harness ids become safe CWL identifiers', () => {
        assert.strictEqual(cwlId('git-status'), 'git_status');
        assert.strictEqual(cwlId('a.b-c'), 'a_b_c');
        assert.strictEqual(cwlId('9lives'), 's_9lives');
    });

    test('file names are paired and filesystem-safe', () => {
        const names = cwlFileNames(byId('review-todos-harness'));
        assert.deepStrictEqual(names, { workflow: 'review-todos-harness.cwl', job: 'review-todos-harness.cwl-job.yml' });
        const nasty = cwlFileNames({ ...byId('review-todos-harness'), id: '../../etc/passwd' });
        assert.ok(!nasty.workflow.startsWith('.') && !nasty.workflow.includes('/'));
    });
});

suite('cwl — document shape', () => {
    test('emits a v1.2 $graph with the workflow and one generic tool', () => {
        const { graph } = buildCwlGraph(byId('review-todos-harness'));
        assert.strictEqual(graph.cwlVersion, CWL_VERSION);
        assert.deepStrictEqual(graph.$graph.map(p => p.id), ['main', 'enclave_step']);
        const tool = graph.$graph[1] as Obj;
        assert.strictEqual(tool.class, 'CommandLineTool');
        assert.deepStrictEqual(tool.baseCommand, ['python3', 'enclave_step.py', 'inputs.json']);
        assert.ok(tool.requirements.NetworkAccess.networkAccess, 'llm steps need network access');
        const staged = tool.requirements.InitialWorkDirRequirement.listing.map((e: Obj) => e.entryname);
        assert.deepStrictEqual(staged, ['enclave_step.py', 'inputs.json', 'workspace']);
    });

    test('workflow inputs cover the workspace, the input and the model endpoint', () => {
        const m = main(byId('explain-file-harness'));
        assert.deepStrictEqual(Object.keys(m.inputs), ['workspace', 'input', 'active_file', 'selection', 'llm_base_url', 'llm_model', 'llm_api_key']);
        assert.strictEqual(m.inputs.workspace.type, 'Directory');
        assert.strictEqual(m.inputs.llm_api_key.type, 'string?', 'the key must be optional for Ollama');
        assert.deepStrictEqual(Object.keys(m.outputs), ['output', 'run_record']);
    });

    test('every harness step becomes a CWL step, plus a final collect', () => {
        const m = main(byId('explain-file-harness'));
        assert.deepStrictEqual(Object.keys(m.steps), ['read', 'explain', 'collect']);
        assert.ok(m.steps.collect.out.includes('run_record'));
        assert.strictEqual(m.outputs.output.outputSource, 'collect/output');
    });
});

suite('cwl — control structure', () => {
    test('a sequence adds an ordering edge; a parallel group does not', () => {
        const m = main(byId('workspace-health-harness'));
        // git-lane is a sequence: log after status, summary after log.
        assert.strictEqual(m.steps.git_log.in.after.source, 'git_status/output');
        assert.strictEqual(m.steps.git_summary.in.after.source, 'git_log/output');
        // the other lanes of the parallel group have nothing before them.
        assert.strictEqual(m.steps.todos.in.after, undefined);
        assert.strictEqual(m.steps.tests.in.after, undefined);
    });

    test('a group joins its children and the next step reads the join', () => {
        const m = main(byId('workspace-health-harness'));
        const join = m.steps.checks;
        assert.strictEqual(spec(join).mode, 'join');
        assert.strictEqual(spec(join).joinMode, 'group');
        assert.deepStrictEqual(join.in.context.source, ['git_lane/output', 'todos/output', 'tests/output', 'inventory/output']);
        assert.strictEqual(join.in.context.linkMerge, 'merge_nested');
        assert.deepStrictEqual(spec(join).context_ids, ['git-lane', 'todos', 'tests', 'inventory']);
        // the report references {{steps.…}} implicitly through the briefing: it reads the group.
        assert.ok(m.steps.report.in.after.source === 'checks/output');
    });

    test('a status condition becomes a CWL when and makes the step nullable downstream', () => {
        const m = main(byId('test-and-explain-harness'));
        assert.strictEqual(m.steps.explain.when, '$(inputs.when_status == "failed")');
        assert.strictEqual(m.steps.explain.in.when_status.source, 'tests/status');
        assert.strictEqual(m.steps.ok.when, '$(inputs.when_status == "done")');
        assert.strictEqual(spec(m.steps.explain).when, undefined, 'the condition must not also be evaluated by the runner');
        // collect reads both conditional steps; the output template is carried for the runner.
        const collect = m.steps.collect;
        assert.ok(collect.in.context.source.includes('explain/output') && collect.in.context.source.includes('ok/output'));
        assert.strictEqual(spec(collect).outputTemplate, '{{steps.explain.output}}{{steps.ok.output}}');
    });

    test('onError, retries and timeouts travel in the spec', () => {
        const m = main(byId('workspace-health-harness'));
        const s = spec(m.steps.tests);
        assert.strictEqual(s.onError, 'retry-then-continue');
        assert.strictEqual(s.retries, 1);
        assert.strictEqual(spec(m.steps.git_status).timeoutMs, 30000);
    });

    test('a foreach becomes items → parse → scattered sub-workflow → join', () => {
        const m = main(byId('annotate-files-harness'));
        assert.deepStrictEqual(Object.keys(m.steps), ['find', 'each_items', 'each_parse', 'each_body', 'each', 'collect', 'collect_2'].filter(k => k in m.steps));
        assert.strictEqual(spec(m.steps.each_items).mode, 'items');
        assert.strictEqual(spec(m.steps.each_items).items, '{{steps.find.lines}}');
        assert.strictEqual(spec(m.steps.each_items).maxItems, 20);
        assert.ok(m.steps.each_items.out.includes('items'));

        assert.strictEqual(m.steps.each_parse.run.class, 'ExpressionTool');
        assert.strictEqual(m.steps.each_parse.in.list, 'each_items/items');

        const body = m.steps.each_body;
        assert.deepStrictEqual(body.scatter, ['item', 'index']);
        assert.strictEqual(body.scatterMethod, 'dotproduct');
        assert.strictEqual(body.in.item, 'each_parse/items');
        assert.strictEqual(body.run.class, 'Workflow');
        assert.deepStrictEqual(Object.keys(body.run.steps), ['read', 'summary', 'each_iteration']);
        assert.strictEqual(body.run.steps.summary.when, '$(inputs.when_status == "done")');
        assert.strictEqual(body.run.steps.summary.in.item, 'item', 'loop variables come from the sub-workflow inputs');

        assert.strictEqual(m.steps.each.in.context.source, 'each_body/output', 'the scattered array is wired as a single source');
        assert.strictEqual(spec(m.steps.each).joinMode, 'group');
    });
});

suite('cwl — what cannot be translated is said, not dropped', () => {
    test('an editor-only plugin becomes a failing step with an explanation, and a note', () => {
        const def: HarnessDefinition = {
            id: 'x', name: 'X', source: 'user',
            steps: [
                { id: 'diag', type: 'resource', pluginId: 'diagnostics', onError: 'continue' },
                { id: 'w', type: 'tool', pluginId: 'write-file', args: { filePath: 'a', content: 'b' } },
                { id: 'sk', type: 'skill', pluginId: 'other-harness' },
                { id: 'm', type: 'llm', prompt: 'hi', model: 'openai/gpt-4o' }
            ]
        };
        const { graph, notes } = buildCwlGraph(def);
        const m = graph.$graph[0] as Obj;
        assert.ok(spec(m.steps.diag).note.includes('editor state'));
        assert.ok(spec(m.steps.w).note.includes('not available outside the editor'));
        assert.ok(spec(m.steps.sk).note.includes('cannot be exported'));
        assert.ok(notes.some(n => n.includes('"diag"') && n.includes('continue')));
        assert.ok(notes.some(n => n.includes('"w"') && n.includes('stop')));
        assert.ok(notes.some(n => n.includes('"sk"')));
        assert.ok(notes.some(n => n.includes('"m"') && n.includes('llm_model')), 'a per-step model must be reported as overridden');
        assert.ok(notes[0].includes('Approval prompts do not exist'), 'the approval caveat leads the notes');
        assert.ok(m.doc.includes('Translation notes:'));
    });

    test('a reference to a step that has not run is reported', () => {
        const def: HarnessDefinition = {
            id: 'x', name: 'X', source: 'user',
            steps: [{ id: 'a', type: 'llm', prompt: '{{steps.zzz.output}}' }]
        };
        const { notes } = buildCwlGraph(def);
        assert.ok(notes.some(n => n.includes('steps.zzz')));
    });
});

suite('cwl — the embedded runner', () => {
    test('contains nothing CWL would evaluate or YAML would mangle', () => {
        assert.ok(!CWL_RUNNER_SCRIPT.includes('$('), 'CWL evaluates $( … ) inside entry');
        assert.ok(!CWL_RUNNER_SCRIPT.includes('${'), 'CWL evaluates ${ … } inside entry');
        assert.ok(!CWL_RUNNER_SCRIPT.includes('```'), 'backticks end the JS template literal');
        assert.ok(!/\t/.test(CWL_RUNNER_SCRIPT), 'tabs break the literal block');
        assert.ok(!/ \n/.test(CWL_RUNNER_SCRIPT), 'trailing spaces are lost in a literal block');
    });

    test('is valid Python (skipped when python3 is absent)', function () {
        const probe = spawnSync('python3', ['-c', 'import sys, ast; ast.parse(sys.stdin.read())'], { input: CWL_RUNNER_SCRIPT, encoding: 'utf-8' });
        if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') { this.skip(); return; }
        assert.strictEqual(probe.status, 0, probe.stderr);
    });

    test('is emitted as a literal block, so it stays readable in the file', () => {
        const { workflow } = toCwl(byId('explain-file-harness'));
        assert.ok(workflow.includes('entry: |\n'), 'runner should be a | block');
        // Block content is indented two spaces deeper than its key, whatever depth the key sits at.
        assert.ok(/entry: \|\n( +)import json, os, re, subprocess, sys, time, urllib\.error, urllib\.request\n\1?\n?\1inputs = json\.load/.test(workflow),
            'runner lines must all share the block indentation');
        assert.ok(workflow.startsWith('#!/usr/bin/env cwl-runner\n'));
    });
});

suite('cwl — YAML emitter', () => {
    test('quotes scalars as JSON, which YAML accepts and which escapes prompts', () => {
        assert.strictEqual(toYaml({ a: 'x: y', b: 'say "hi"', c: 3, d: true, e: null }),
            'a: "x: y"\nb: "say \\"hi\\""\nc: 3\nd: true\ne: null');
    });

    test('renders nested blocks and lists, including a list of mappings', () => {
        const out = toYaml({ listing: [{ entryname: 'a', entry: 'b' }, 'plain'], empty: [], none: {} });
        assert.strictEqual(out, 'listing:\n  - entryname: "a"\n    entry: "b"\n  - "plain"\nempty: []\nnone: {}');
    });

    test('uses a literal block only for strings that round-trip', () => {
        assert.ok(toYaml({ s: 'line1\nline2' }).includes('s: |\n  line1\n  line2'));
        assert.ok(toYaml({ s: 'trailing \nx' }).startsWith('s: "trailing '), 'trailing space must force quoting');
        assert.ok(toYaml({ s: ' leading\nx' }).startsWith('s: " leading'), 'leading space must force quoting');
        assert.ok(toYaml({ s: 'a\tb\nc' }).startsWith('s: "a\\tb'), 'tabs must force quoting');
    });
});

suite('cwl — every built-in harness translates', () => {
    for (const def of builtInHarnesses) {
        test(`${def.id} produces a workflow and a job file`, () => {
            const { workflow, job, graph } = toCwl(def, { generator: 'test', now: new Date('2026-09-23T12:00:00Z') });
            assert.ok(workflow.includes(`"${def.id}"`), 'header names the harness');
            assert.ok(job.includes('class: "Directory"') && job.includes('llm_base_url'));
            const m = graph.$graph[0] as Obj;
            for (const s of def.steps) {
                assert.ok(cwlId(s.id) in m.steps, `${def.id}: top-level step ${s.id} missing`);
            }
            // Every step reads the shared inputs so the runner always has a workspace and an endpoint.
            for (const [id, step] of Object.entries<Obj>(m.steps)) {
                if (step.run === '#enclave_step') {
                    assert.strictEqual(step.in.workspace, 'workspace', `${id} lacks workspace`);
                    assert.strictEqual(step.in.llm_base_url, 'llm_base_url', `${id} lacks llm_base_url`);
                }
            }
        });
    }
});

suite('cwl — editor state travels as inputs', () => {
    const explain: HarnessDefinition = {
        id: 'x', name: 'X', version: '1.0.0', source: 'user',
        steps: [
            { id: 'read', name: 'Read', type: 'tool', pluginId: 'read-file', args: { filePath: '{{activeFile}}' } },
            { id: 'explain', name: 'Explain', type: 'llm', prompt: 'Explain {{activeFile}} given {{selection}}' }
        ]
    };

    test('referencedVariables lists bare variables but not step references', () => {
        const def: HarnessDefinition = {
            id: 'v', name: 'V', version: '1.0.0', source: 'user',
            steps: [
                { id: 'a', name: 'a', type: 'tool', pluginId: 'run-command', args: { command: 'echo {{input}}' } },
                { id: 'g', name: 'g', type: 'sequence', steps: [{ id: 'b', name: 'b', type: 'llm', prompt: '{{steps.a.output}} {{ activeFile }}' }] }
            ],
            output: '{{steps.b.output}} {{date}}'
        };
        assert.deepStrictEqual(Array.from(referencedVariables(def)).sort(), ['activeFile', 'date', 'input']);
        assert.deepStrictEqual(Array.from(referencedVariables(explain)).sort(), ['activeFile', 'selection']);
    });

    test('every step call receives active_file and selection, and the runner maps them to the template variables', () => {
        const { graph, job } = toCwl(explain, { generator: 't' });
        const main = graph.$graph.find(n => n.id === 'main') as { steps: Record<string, { in: Record<string, unknown> }> };
        for (const [id, step] of Object.entries(main.steps)) {
            if (id === 'collect') { continue; }
            assert.strictEqual(step.in.active_file, 'active_file', `${id} lacks active_file`);
            assert.strictEqual(step.in.selection, 'selection', `${id} lacks selection`);
        }
        const tool = graph.$graph.find(n => n.id === 'enclave_step') as { inputs: Record<string, { type: string; default?: string }> };
        assert.deepStrictEqual(tool.inputs.active_file, { type: 'string', default: '' });
        assert.ok(CWL_RUNNER_SCRIPT.includes('"activeFile": inputs.get("active_file") or ""'));
        assert.ok(CWL_RUNNER_SCRIPT.includes('"selection": inputs.get("selection") or ""'));
        assert.ok(job.includes('# active_file: this harness reads {{activeFile}}'), 'the job file tells the reader the harness needs it');
        assert.ok(job.includes('active_file: ""'));
    });

    test('a model step receives every earlier step as context, as the engine does, not only the ones its prompt names', () => {
        const { graph } = toCwl(explain, { generator: 't' });
        const main = graph.$graph.find(n => n.id === 'main') as { steps: Record<string, { in: { context?: { source: string[] }; spec: { default: string } } }> };
        assert.deepStrictEqual(main.steps.explain.in.context?.source, ['read/output']);
        assert.deepStrictEqual(JSON.parse(main.steps.explain.in.spec.default).context_ids, ['read']);
    });

    test('read-file with an empty path fails with an explanation rather than opening "None"', () => {
        assert.ok(CWL_RUNNER_SCRIPT.includes('": no file path was given'));
        assert.ok(!CWL_RUNNER_SCRIPT.includes('inside(args.get("filePath") or args.get("path"))'));
    });
});
