/**
 * Tests for containerised execution planning.
 *
 * Podman itself cannot be assumed in the unit suite, so what is pinned here is everything the
 * host hands to it: the dependency analysis, the Containerfile, the in-container job file and
 * the exact command lines. The security properties of the run — read-only workspace, dropped
 * capabilities, sealed network by default — are asserted on the argument vector, since that is
 * the only place they exist.
 */

import * as assert from 'assert';
import {
    CONTAINER_BASE_IMAGE,
    CONTAINER_HOST_ALIAS,
    analyseContainerNeeds,
    containerJobFile,
    containerName,
    describePlan,
    imageTag,
    podmanBuildArgs,
    podmanRunArgs,
    programsIn,
    renderContainerfile,
    podmanInstallSuggestion,
    rewriteBaseUrlForContainer,
    resolveRunTemplates,
    programsForRun,
    verifyScript,
    parseVerifyOutput,
    podmanVerifyArgs,
    resolvePackages,
    renderDependencyLayer,
    dependencyLayerTag,
    ALWAYS_REQUIRED_PROGRAMS,
    parseCwltoolLine,
    CwltoolLogReader
} from '../../core/harness/container';
import { HarnessDefinition } from '../../core/harness/types';
import { builtInHarnesses } from '../harness/builtInHarnesses';

const NOW = new Date('2026-09-23T12:00:00Z');

function harness(steps: HarnessDefinition['steps'], extra: Partial<HarnessDefinition> = {}): HarnessDefinition {
    return { id: 'h', name: 'H', source: 'user', steps, ...extra };
}

suite('container — program detection', () => {
    test('finds the first program of each pipeline segment', () => {
        assert.deepStrictEqual(programsIn('npm test && git status | head -5'), ['npm', 'git', 'head']);
        assert.deepStrictEqual(programsIn('FOO=1 BAR=2 pytest -q; echo done'), ['pytest', 'echo']);
        assert.deepStrictEqual(programsIn('time /usr/bin/make -j4'), ['make']);
        assert.deepStrictEqual(programsIn('(cd sub && cargo test) || true'), ['cd', 'cargo', 'true']);
    });

    test('maps programs to packages and records where each was seen', () => {
        const plan = analyseContainerNeeds(harness([
            { id: 'a', type: 'tool', pluginId: 'run-command', args: { command: 'npm test' } },
            { id: 'b', type: 'tool', pluginId: 'run-command', args: { command: 'pytest -q && git log -1' } }
        ]));
        assert.ok(plan.aptPackages.includes('nodejs') && plan.aptPackages.includes('npm'));
        assert.ok(plan.aptPackages.includes('git'));
        assert.ok(plan.pipPackages.includes('pytest'));
        assert.ok(plan.pipPackages.includes('cwltool'), 'the engine itself must always be installed');
        assert.ok(plan.detections.some(d => d.evidence === 'npm' && d.source === 'step "a"'));
        assert.ok(plan.detections.some(d => d.evidence === 'git' && d.source === 'step "b"'));
    });

    test('is honest about what it cannot see', () => {
        const plan = analyseContainerNeeds(harness([
            { id: 'tests', type: 'tool', pluginId: 'run-command', args: { command: '{{input}}' }, onError: 'continue' },
            { id: 'odd', type: 'tool', pluginId: 'run-command', args: { command: 'frobnicate --all' } },
            { id: 'no', type: 'tool', pluginId: 'run-command', args: { command: 'docker build .' } }
        ]));
        assert.ok(plan.notes.some(n => n.includes('"tests"') && n.includes('template')), 'a templated command must be flagged as unknown');
        assert.ok(plan.notes.some(n => n.includes('frobnicate') && n.includes('does not recognise')));
        assert.ok(plan.notes.some(n => n.includes('docker') && n.includes('cannot run inside a container')));
    });

    test('reads workspace manifests and extra packages', () => {
        const plan = analyseContainerNeeds(harness([]), {
            workspaceFiles: ['package.json', 'requirements.txt', '.git', 'README.md'],
            extraAptPackages: ['imagemagick', 'Not Valid!']
        });
        assert.ok(plan.aptPackages.includes('nodejs'));
        assert.ok(plan.aptPackages.includes('git'));
        assert.ok(plan.aptPackages.includes('imagemagick'));
        assert.ok(plan.pipPackages.includes('-r /workspace/requirements.txt'));
        assert.ok(plan.notes.some(n => n.includes('Not Valid!')), 'an invalid package name is reported, not silently dropped');
    });

    test('flags model use, since a sealed container cannot reach a model server', () => {
        const withModel = analyseContainerNeeds(harness([{ id: 'm', type: 'llm', prompt: 'hi' }]));
        assert.strictEqual(withModel.usesModel, true);
        assert.ok(withModel.notes.some(n => n.includes('allow network')));
        const without = analyseContainerNeeds(harness([{ id: 'g', type: 'tool', pluginId: 'grep-search', args: { query: 'x' } }]));
        assert.strictEqual(without.usesModel, false);
    });
});

suite('container — Containerfile', () => {
    const def = harness([{ id: 'a', type: 'tool', pluginId: 'run-command', args: { command: 'npm test' } }], { id: 'my-harness' });
    const plan = analyseContainerNeeds(def, { workspaceFiles: ['requirements.txt'] });
    const file = renderContainerfile(def, plan, { generator: 'test', now: NOW });

    test('installs exactly what the plan found, then the engine, then the workflow', () => {
        assert.ok(file.startsWith('# Containerfile for the Enclave workflow-harness "my-harness"'));
        assert.ok(file.includes(`FROM ${CONTAINER_BASE_IMAGE}`));
        const apt = file.match(/apt-get install -y --no-install-recommends (.+) \\/)![1];
        assert.deepStrictEqual(apt.split(' '), plan.aptPackages);
        assert.ok(file.includes('pip install --no-cache-dir cwltool'));
        assert.ok(file.includes('COPY requirements.txt /tmp/requirements.txt'), 'workspace requirements are installed at build time');
        assert.ok(file.includes('COPY my-harness.cwl my-harness.cwl-job.yml ./'));
        assert.ok(file.includes('ENTRYPOINT ["cwltool", "--disable-color", "--outdir", "/out", "my-harness.cwl", "my-harness.cwl-job.yml"]'));
    });

    test('documents its own reasoning in comments', () => {
        assert.ok(file.includes('# Detected needs:'));
        assert.ok(file.includes('#   npm (step "a") -> nodejs npm'));
        assert.ok(file.includes('# Notes:'), 'the requirements.txt note must appear');
    });
});

suite('container — job file and endpoint rewriting', () => {
    test('rewrites a host-local model server only when the network is allowed', () => {
        assert.strictEqual(rewriteBaseUrlForContainer('http://localhost:11434/v1'), `http://${CONTAINER_HOST_ALIAS}:11434/v1`);
        assert.strictEqual(rewriteBaseUrlForContainer('http://127.0.0.1:11434/v1'), `http://${CONTAINER_HOST_ALIAS}:11434/v1`);
        assert.strictEqual(rewriteBaseUrlForContainer('https://api.blablador.fz-juelich.de/v1'), 'https://api.blablador.fz-juelich.de/v1');
        assert.strictEqual(rewriteBaseUrlForContainer('http://localhost.example.org/v1'), 'http://localhost.example.org/v1', 'a hostname that merely starts with localhost is not the host');
    });

    test('the sealed job never carries a key and points at the mounted workspace', () => {
        const def = harness([{ id: 'm', type: 'llm', prompt: 'hi' }]);
        const sealed = containerJobFile(def, { input: 'x', network: 'none', llmBaseUrl: 'http://localhost:11434/v1', llmApiKey: 'secret' });
        assert.ok(sealed.includes('path: "/workspace"'));
        assert.ok(sealed.includes('llm_api_key: null'), 'no credential enters a sealed container');
        assert.ok(sealed.includes('llm_base_url: "http://localhost:11434/v1"'), 'no rewrite when there is no network anyway');
        const open = containerJobFile(def, { input: 'x', network: 'allow', llmBaseUrl: 'http://localhost:11434/v1', llmApiKey: 'secret', llmModel: 'alias-code' });
        assert.ok(open.includes(`llm_base_url: "http://${CONTAINER_HOST_ALIAS}:11434/v1"`));
        assert.ok(open.includes('llm_api_key: "secret"'));
        assert.ok(open.includes('llm_model: "alias-code"'));
    });
});

suite('container — Podman command lines', () => {
    const def = harness([], { id: 'Review TODOs' });

    test('the run is sealed, read-only and unprivileged by default', () => {
        const args = podmanRunArgs({ tag: 'localhost/x:1', name: 'n', workspaceDir: '/home/u/proj', outputDir: '/home/u/proj/.continued/harness-runs/r1', network: 'none' });
        assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none');
        assert.ok(args.includes('--cap-drop=ALL'));
        assert.ok(args.includes('--security-opt=no-new-privileges'));
        assert.ok(args.includes('/home/u/proj:/workspace:ro,z'), 'the workspace must be mounted read-only');
        assert.ok(args.includes('/home/u/proj/.continued/harness-runs/r1:/out:z'));
        assert.ok(args.includes('--rm'));
        assert.strictEqual(args[args.length - 1], 'localhost/x:1');
    });

    test('allowing the network removes only the network=none restriction', () => {
        const sealed = podmanRunArgs({ tag: 't', name: 'n', workspaceDir: '/w', outputDir: '/o', network: 'none' });
        const open = podmanRunArgs({ tag: 't', name: 'n', workspaceDir: '/w', outputDir: '/o', network: 'allow' });
        assert.deepStrictEqual(sealed.filter(a => !open.includes(a)), ['--network', 'none']);
        assert.deepStrictEqual(open.filter(a => !sealed.includes(a)), [], 'no network backend is hard-coded; Podman picks its rootless default');
        assert.ok(open.includes('/w:/workspace:ro,z'), 'the workspace stays read-only even with network');
        assert.ok(open.includes('--cap-drop=ALL'), 'capabilities stay dropped even with network');
    });

    test('build arguments and names are well formed', () => {
        assert.deepStrictEqual(podmanBuildArgs({ contextDir: '/ctx', containerfile: '/ctx/Containerfile', tag: 'localhost/x:1' }),
            ['build', '--file', '/ctx/Containerfile', '--tag', 'localhost/x:1', '/ctx']);
        assert.strictEqual(containerName(def, NOW), 'enclave-review-todos-20260923120000');
        assert.ok(/^localhost\/enclave-harness-review-todos:[0-9a-f]{8}$/.test(imageTag(def, 'FROM x', 'cwl')));
    });

    test('the image tag changes when the harness or the plan changes, and not otherwise', () => {
        const a = imageTag(def, 'FROM x\nRUN a', 'cwlVersion: v1.2');
        assert.strictEqual(imageTag(def, 'FROM x\nRUN a', 'cwlVersion: v1.2'), a);
        assert.notStrictEqual(imageTag(def, 'FROM x\nRUN b', 'cwlVersion: v1.2'), a);
        assert.notStrictEqual(imageTag(def, 'FROM x\nRUN a', 'cwlVersion: v1.3'), a);
    });
});

suite('container — every built-in harness plans cleanly', () => {
    for (const def of builtInHarnesses) {
        test(`${def.id} yields a plan and a Containerfile`, () => {
            const plan = analyseContainerNeeds(def, { workspaceFiles: ['package.json', '.git'] });
            assert.ok(plan.aptPackages.includes('nodejs'));
            assert.ok(plan.pipPackages.includes('cwltool'));
            const file = renderContainerfile(def, plan, { now: NOW });
            assert.ok(file.includes('ENTRYPOINT ["cwltool"'));
            const summary = describePlan(plan, '.continued/harness-runs');
            assert.ok(summary.includes('read-only') && summary.includes('Network: none'));
        });
    }
});

suite('container — Podman install suggestion', () => {
    const ubuntu = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n';
    const fedora = 'NAME="Fedora Linux"\nID=fedora\n';
    const mint = 'ID=linuxmint\nID_LIKE="ubuntu debian"\n';
    const rocky = 'ID="rocky"\nID_LIKE="rhel centos fedora"\n';
    const arch = 'ID=arch\n';
    const suse = 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n';

    test('chooses the package manager from the distribution family', () => {
        assert.strictEqual(podmanInstallSuggestion('linux', ubuntu).command, 'sudo apt-get update && sudo apt-get install -y podman');
        assert.strictEqual(podmanInstallSuggestion('linux', mint).command, 'sudo apt-get update && sudo apt-get install -y podman', 'ID_LIKE must be consulted');
        assert.strictEqual(podmanInstallSuggestion('linux', fedora).command, 'sudo dnf install -y podman');
        assert.strictEqual(podmanInstallSuggestion('linux', rocky).command, 'sudo dnf install -y podman');
        assert.strictEqual(podmanInstallSuggestion('linux', arch).command, 'sudo pacman -S --needed podman');
        assert.strictEqual(podmanInstallSuggestion('linux', suse).command, 'sudo zypper install -y podman');
    });

    test('says when a password will be needed', () => {
        assert.strictEqual(podmanInstallSuggestion('linux', ubuntu).needsSudo, true);
        assert.strictEqual(podmanInstallSuggestion('darwin').needsSudo, false);
        assert.strictEqual(podmanInstallSuggestion('linux', 'ID=nixos\n').needsSudo, false);
    });

    test('macOS and Windows also start the machine Podman needs there', () => {
        assert.ok(podmanInstallSuggestion('darwin').command!.includes('podman machine init'));
        assert.ok(podmanInstallSuggestion('win32').command!.includes('winget install'));
    });

    test('an unrecognised system gets the documentation, not a guessed command', () => {
        const s = podmanInstallSuggestion('linux', 'ID=haiku\n');
        assert.strictEqual(s.command, null);
        assert.ok(s.url.startsWith('https://podman.io/'));
        assert.strictEqual(podmanInstallSuggestion('linux', '').command, null, 'no os-release at all must not guess');
    });
});

suite('container — verifying the built image', () => {
    const vars = { input: 'npm test -- --ci', workspace: '/workspace', activeFile: 'src/a.ts', selection: '', date: '2026-09-23' };

    test('resolves the templates that are knowable before the run and leaves the rest', () => {
        assert.strictEqual(resolveRunTemplates('{{input}} && cat {{activeFile}}', vars), 'npm test -- --ci && cat src/a.ts');
        assert.strictEqual(resolveRunTemplates('echo {{steps.x.output}} {{item}}', vars), 'echo {{steps.x.output}} {{item}}');
    });

    test('the program list for a run includes the input-resolved command and the engine', () => {
        const programs = programsForRun(harness([
            { id: 'tests', type: 'tool', pluginId: 'run-command', args: { command: '{{input}}' } },
            { id: 'log', type: 'tool', pluginId: 'run-command', args: { command: 'git log -1 | head -3' } },
            { id: 'later', type: 'tool', pluginId: 'run-command', args: { command: '{{steps.tests.output}}' } }
        ]), vars);
        for (const p of ALWAYS_REQUIRED_PROGRAMS) { assert.ok(programs.includes(p), `${p} must always be probed`); }
        assert.ok(programs.includes('npm'), 'the input must be resolved before probing');
        assert.ok(programs.includes('git'));
        assert.ok(!programs.includes('head'), 'trivial utilities are not probed');
        assert.ok(!programs.some(p => p.includes('{{')), 'a still-templated program cannot be probed');
    });

    test('the probe script reports exactly the missing programs and a completion marker', () => {
        const script = verifyScript(['python3', 'npm', "we'ird"]);
        assert.ok(script.includes("'python3' 'npm'"));
        assert.ok(script.includes('VERIFY-DONE'));
        assert.deepStrictEqual(parseVerifyOutput('MISSING npm\nsome noise\nMISSING pytest\nVERIFY-DONE\n'), { missing: ['npm', 'pytest'], completed: true });
        assert.deepStrictEqual(parseVerifyOutput('Error: image not found'), { missing: [], completed: false }, 'a probe that never ran must not look like "nothing missing"');
    });

    test('the probe overrides the entrypoint and runs without network', () => {
        const args = podmanVerifyArgs('localhost/x:1', 'echo VERIFY-DONE');
        assert.deepStrictEqual(args.slice(0, 6), ['run', '--rm', '--network', 'none', '--entrypoint', 'sh']);
        assert.strictEqual(args[6], 'localhost/x:1');
    });

    test('package resolution uses known mappings and marks guesses as guesses', () => {
        const r = resolvePackages(['npm', 'pytest', 'frobnicate', 'cwltool']);
        assert.deepStrictEqual(r.find(x => x.program === 'npm'), { program: 'npm', apt: ['nodejs', 'npm'], pip: [], guessed: false });
        assert.deepStrictEqual(r.find(x => x.program === 'pytest'), { program: 'pytest', apt: [], pip: ['pytest'], guessed: false });
        assert.deepStrictEqual(r.find(x => x.program === 'frobnicate'), { program: 'frobnicate', apt: ['frobnicate'], pip: [], guessed: true });
        assert.deepStrictEqual(r.find(x => x.program === 'cwltool'), { program: 'cwltool', apt: [], pip: ['cwltool'], guessed: false });
    });

    test('the dependency layer builds on the base tag and gets a tag of its own', () => {
        const layer = renderDependencyLayer('localhost/enclave-harness-h:abcd1234', ['nodejs', 'npm'], ['pytest'], { now: NOW });
        assert.ok(layer.includes('FROM localhost/enclave-harness-h:abcd1234'));
        assert.ok(layer.includes('apt-get install -y --no-install-recommends nodejs npm'));
        assert.ok(layer.includes('pip install --no-cache-dir pytest'));
        const tag = dependencyLayerTag('localhost/enclave-harness-h:abcd1234', layer);
        assert.ok(/^localhost\/enclave-harness-h:abcd1234-deps-[0-9a-f]{8}$/.test(tag));
        assert.notStrictEqual(tag, dependencyLayerTag('localhost/enclave-harness-h:abcd1234', renderDependencyLayer('localhost/enclave-harness-h:abcd1234', ['git'], [], { now: NOW })));
        assert.ok(!renderDependencyLayer('t', [], ['x']).includes('apt-get'), 'no apt step when nothing to apt-install');
    });
});

suite('container — reading cwltool\'s log', () => {
    test('classifies the lines cwltool writes about steps and jobs', () => {
        assert.deepStrictEqual(parseCwltoolLine('INFO [step git_status] start'), { kind: 'step-start', step: 'git_status' });
        assert.deepStrictEqual(parseCwltoolLine('INFO [step git_status] completed success'), { kind: 'step-done', step: 'git_status', status: 'done' });
        assert.deepStrictEqual(parseCwltoolLine('WARNING [step git_summary] completed permanentFail'), { kind: 'step-done', step: 'git_summary', status: 'failed' });
        assert.deepStrictEqual(parseCwltoolLine('INFO [step ok] completed skipped'), { kind: 'step-done', step: 'ok', status: 'skipped' });
        assert.deepStrictEqual(parseCwltoolLine('WARNING [job git_summary] exited with status: 1'), { kind: 'job-exit', step: 'git_summary', code: 1 });
        assert.deepStrictEqual(parseCwltoolLine('INFO [job inventory] /tmp/chbnwkvl$ python3 \\'), { kind: 'job-command', step: 'inventory' });
        assert.deepStrictEqual(parseCwltoolLine('INFO [workflow ] completed permanentFail'), { kind: 'workflow-done', status: 'failed' });
        assert.deepStrictEqual(parseCwltoolLine('INFO [workflow each_body] completed success'), { kind: 'workflow-done', status: 'done' });
    });

    test('lines cwltool did not write are the tool\'s own output, and noise is dropped', () => {
        assert.deepStrictEqual(parseCwltoolLine('URLError: <urlopen error [Errno -3] Temporary failure in name resolution>'),
            { kind: 'tool-output', text: 'URLError: <urlopen error [Errno -3] Temporary failure in name resolution>' });
        assert.strictEqual(parseCwltoolLine('INFO [workflow ] starting step inventory'), null, 'informational lines are not attributed to a tool');
        assert.strictEqual(parseCwltoolLine('WARNING Final process status is permanentFail'), null);
        assert.strictEqual(parseCwltoolLine('{'), null);
        assert.strictEqual(parseCwltoolLine('    "output": null,'), null);
        assert.strictEqual(parseCwltoolLine(''), null);
        assert.strictEqual(parseCwltoolLine('\x1b[1;30mINFO\x1b[0m [step tests] completed success')?.kind, 'step-done', 'colour codes are stripped');
    });
});

suite('container — editor state', () => {
    const explain = builtInHarnesses.find(h => h.id === 'explain-file-harness')!;

    test('the plan records that the harness reads the active file and says it must be in the workspace', () => {
        const plan = analyseContainerNeeds(explain, {});
        assert.deepStrictEqual(plan.editor, { activeFile: true, selection: false });
        assert.ok(plan.notes.some(n => n.includes('{{activeFile}}') && n.includes('inside the workspace')));
        const health = builtInHarnesses.find(h => h.id === 'workspace-health-harness')!;
        assert.deepStrictEqual(analyseContainerNeeds(health, {}).editor, { activeFile: false, selection: false });
    });

    test('the job file carries the workspace-relative active file and the selection', () => {
        const job = containerJobFile(explain, { input: '', network: 'none', activeFile: 'src/a.ts', selection: 'let x = 1;' });
        assert.ok(job.includes('active_file: "src/a.ts"'), job);
        assert.ok(job.includes('selection: "let x = 1;"'), job);
        const none = containerJobFile(explain, { input: '', network: 'none' });
        assert.ok(none.includes('active_file: ""'));
    });

    test('the log reader skips a job command\'s continuation lines so the error is the real error', () => {
        // The exact lines cwltool printed for the failed "Explain the active file" run.
        const lines = [
            'INFO [workflow ] starting step read',
            'INFO [step read] start',
            'INFO [job read] /tmp/o34z7r32$ python3 \\',
            '    enclave_step.py \\',
            '    inputs.json',
            'step failed and policy is stop',
            "FileNotFoundError: [Errno 2] No such file or directory: '/tmp/o34z7r32/workspace/None'",
            'WARNING [job read] exited with status: 1',
            'WARNING [job read] completed permanentFail',
            'WARNING [step read] completed permanentFail'
        ];
        const reader = new CwltoolLogReader();
        const events = lines.map(l => reader.next(l)).filter((e): e is NonNullable<typeof e> => e !== null);
        assert.deepStrictEqual(events.map(e => e.kind), ['step-start', 'job-command', 'tool-output', 'tool-output', 'job-exit', 'step-done']);
        const outputs = events.filter(e => e.kind === 'tool-output').map(e => (e as { text: string }).text);
        assert.deepStrictEqual(outputs, ['step failed and policy is stop', "FileNotFoundError: [Errno 2] No such file or directory: '/tmp/o34z7r32/workspace/None'"]);
    });

    test('a single-line job command does not swallow the next line', () => {
        const reader = new CwltoolLogReader();
        assert.strictEqual(reader.next('INFO [job a] /tmp/x$ python3 enclave_step.py inputs.json')?.kind, 'job-command');
        assert.deepStrictEqual(reader.next('Traceback (most recent call last):'), { kind: 'tool-output', text: 'Traceback (most recent call last):' });
    });
});
