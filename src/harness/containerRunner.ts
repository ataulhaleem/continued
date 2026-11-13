/**
 * Runs a harness inside a Podman container, by way of its CWL export.
 *
 * The sequence is: plan (dependency analysis) → confirm (a modal that states exactly what
 * will be built, mounted and reachable) → build the image if its tag is not present → run
 * `cwltool` inside the container → collect `output.txt` and `run_record.json` from the output
 * directory. Progress is streamed into a synthetic `HarnessRun` so the Run tab shows it the
 * way it shows an in-editor run.
 *
 * Nothing here executes a harness step. The CWL translator and its runner do that, inside the
 * container; this module only prepares files and drives Podman.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HarnessDefinition, HarnessRun, HarnessStep, StepRun } from '../../core/harness/types';
import { cwlId } from '../../core/harness/cwl';
import { cwlFileNames, toCwl } from '../../core/harness/cwl';
import {
    ContainerNetwork,
    ContainerPlan,
    analyseContainerNeeds,
    containerJobFile,
    CwltoolLogReader,
    containerName,
    describePlan,
    imageTag,
    PackageResolution,
    dependencyLayerTag,
    parseVerifyOutput,
    podmanBuildArgs,
    podmanInstallSuggestion,
    podmanRunArgs,
    podmanVerifyArgs,
    programsForRun,
    renderContainerfile,
    renderDependencyLayer,
    resolvePackages,
    verifyScript
} from '../../core/harness/container';

export interface ContainerEndpoint {
    /** OpenAI-compatible API base, as seen from the host. */
    baseUrl: string;
    /** Model id without the Enclave provider prefix. */
    model: string;
    apiKey: string | null;
}

export interface ContainerRunRequest {
    def: HarnessDefinition;
    input: string;
    workspaceRoot: string;
    /** Editor state at the moment of the run: the active file's absolute path ('' when none) and the selection. */
    editor: { activeFile: string; selection: string };
    endpoint: ContainerEndpoint;
    /** Podman executable (setting `continued.container.podmanPath`). */
    podman: string;
    /** Output directory base, relative to the workspace or absolute (setting `continued.container.outputDir`). */
    outputBase: string;
    /** Extra Debian packages (setting `continued.container.extraPackages`). */
    extraPackages: string[];
    generator: string;
    log: (line: string) => void;
    onUpdate: (run: HarnessRun) => void;
    signal: AbortSignal;
}

export interface PreparedContainerRun {
    plan: ContainerPlan;
    containerfile: string;
    workflow: string;
    tag: string;
    contextDir: string;
    outputDir: string;
    names: { workflow: string; job: string };
    /** Workspace-relative path `{{activeFile}}` resolves to inside the container; '' when the harness does not read it. */
    activeFile: string;
}

export class PodmanNotFoundError extends Error {
    constructor(podman: string) {
        super(`Podman was not found (tried "${podman}"). Install it — https://podman.io/docs/installation — or set continued.container.podmanPath.`);
    }
}

// ---------------------------------------------------------------------------

/** Run a process, streaming each output line, honouring cancellation. Resolves with the exit code. */
function execStreaming(command: string, args: string[], options: { cwd?: string; signal: AbortSignal; onLine: (line: string) => void; onCancel?: () => void }): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let buffered = '';
        const feed = (chunk: Buffer) => {
            buffered += chunk.toString('utf-8');
            let idx: number;
            while ((idx = buffered.indexOf('\n')) !== -1) {
                options.onLine(buffered.slice(0, idx).replace(/\r$/, ''));
                buffered = buffered.slice(idx + 1);
            }
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        const onAbort = () => {
            options.onCancel?.();
            child.kill('SIGTERM');
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', error => {
            options.signal.removeEventListener('abort', onAbort);
            reject(error);
        });
        child.on('close', code => {
            options.signal.removeEventListener('abort', onAbort);
            if (buffered.trim()) { options.onLine(buffered); }
            resolve(code ?? -1);
        });
    });
}

/** Podman's version string, or a `PodmanNotFoundError` with an install hint. */
export async function checkPodman(podman: string): Promise<string> {
    let version = '';
    try {
        const code = await execStreaming(podman, ['--version'], { signal: new AbortController().signal, onLine: l => { version += l; } });
        if (code !== 0) { throw new PodmanNotFoundError(podman); }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw new PodmanNotFoundError(podman); }
        throw error;
    }
    return version.trim();
}

function safeId(def: HarnessDefinition): string {
    return def.id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[.-]+/, '') || 'harness';
}

/** Everything the run needs, computed but not yet written, so the user can be shown it first. */
/**
 * The container sees exactly one directory: the workspace, mounted read-only. A harness that
 * reads `{{activeFile}}` therefore needs that file to be inside the workspace, and the run must
 * know its path before anything is built. Returns the workspace-relative path, or throws with
 * the reason nothing will be built.
 */
export function resolveActiveFile(req: Pick<ContainerRunRequest, 'def' | 'workspaceRoot' | 'editor'>, plan: ContainerPlan): string {
    if (!plan.editor.activeFile) { return ''; }
    const active = req.editor.activeFile;
    if (!active) {
        throw new Error(`"${req.def.name}" reads the active editor file ({{activeFile}}), but no file is open in the editor. Open the file it should work on, then run again.`);
    }
    const relative = path.relative(req.workspaceRoot, active);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`"${req.def.name}" reads the active editor file, but ${active} is outside the workspace. The container only sees the workspace (mounted read-only), so it cannot read that file. Open a file inside the workspace, or run the harness without the container.`);
    }
    return relative.split(path.sep).join('/');
}

export function prepareContainerRun(req: ContainerRunRequest, now: Date = new Date()): PreparedContainerRun {
    const workspaceFiles = fs.readdirSync(req.workspaceRoot);
    const plan = analyseContainerNeeds(req.def, { workspaceFiles, extraAptPackages: req.extraPackages });
    const activeFile = resolveActiveFile(req, plan);
    const { workflow } = toCwl(req.def, { generator: req.generator, defaultModel: req.endpoint.model, now });
    const containerfile = renderContainerfile(req.def, plan, { generator: req.generator, now });
    const id = safeId(req.def);
    const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return {
        plan,
        containerfile,
        workflow,
        tag: imageTag(req.def, containerfile, workflow),
        contextDir: path.join(req.workspaceRoot, '.continued', 'container', id),
        outputDir: path.resolve(req.workspaceRoot, req.outputBase, `${id}-${stamp}`),
        names: cwlFileNames(req.def),
        activeFile
    };
}

/**
 * The confirmation. It says what will be built, that the workspace is read-only, where results
 * go, and that the network is sealed unless the second button is chosen. Returns the network
 * choice, or null if the user cancelled.
 */
export async function confirmContainerRun(def: HarnessDefinition, prepared: PreparedContainerRun, workspaceRoot: string): Promise<ContainerNetwork | null> {
    const relOut = path.relative(workspaceRoot, prepared.outputDir) || prepared.outputDir;
    const detail = [
        describePlan(prepared.plan, relOut),
        ...(prepared.activeFile ? [`Active file: ${prepared.activeFile} (inside the workspace mount, so the container can read it).`] : []),
        '',
        'Podman builds the image on first use (a few minutes; cached afterwards) and runs the workflow with cwltool inside it. Approval prompts do not exist in the container: every command in the harness runs unattended.'
    ].join('\n');
    // A harness that calls a model cannot succeed sealed; the buttons say so rather than a note.
    const usesModel = prepared.plan.usesModel;
    const sealedLabel = usesModel ? 'Run sealed (model steps will fail)' : 'Run sealed (no network)';
    const allowLabel = usesModel ? 'Allow network (needed: this harness calls a model)' : 'Allow network';
    const buttons = usesModel ? [allowLabel, sealedLabel] : [sealedLabel, allowLabel];
    const choice = await vscode.window.showWarningMessage(
        `Run "${def.name}" in a Podman container?`,
        { modal: true, detail },
        ...buttons
    );
    if (choice === sealedLabel) { return 'none'; }
    if (choice === allowLabel) { return 'allow'; }
    return null;
}

/** Build if the image is missing, then run; stream everything into a synthetic HarnessRun. */
export async function runInContainer(req: ContainerRunRequest, prepared: PreparedContainerRun, network: ContainerNetwork): Promise<HarnessRun> {
    const { def } = req;
    const startedAt = Date.now();

    // Files Podman needs, written into the workspace's own .continued folder so they are inspectable.
    fs.mkdirSync(prepared.contextDir, { recursive: true });
    fs.mkdirSync(prepared.outputDir, { recursive: true });
    fs.writeFileSync(path.join(prepared.contextDir, 'Containerfile'), prepared.containerfile);
    fs.writeFileSync(path.join(prepared.contextDir, prepared.names.workflow), prepared.workflow);
    fs.writeFileSync(path.join(prepared.contextDir, prepared.names.job), containerJobFile(def, {
        input: req.input,
        activeFile: prepared.activeFile,
        selection: prepared.plan.editor.selection ? req.editor.selection : '',
        network,
        llmBaseUrl: req.endpoint.baseUrl,
        llmModel: req.endpoint.model,
        llmApiKey: req.endpoint.apiKey
    }));
    if (prepared.plan.pipPackages.some(p => p.startsWith('-r '))) {
        fs.copyFileSync(path.join(req.workspaceRoot, 'requirements.txt'), path.join(prepared.contextDir, 'requirements.txt'));
    }

    // The Run tab shows this as a run. One pseudo-step carries the Podman log; the real steps
    // form the same tree the engine would show, and are updated live from cwltool's log, so a
    // failure names its step even when the workflow never reaches `collect`.
    const podmanStep: StepRun = { id: 'container', name: `Podman (${network === 'none' ? 'sealed' : 'network allowed'})`, type: 'tool', status: 'running', attempts: 1, notes: [], output: '', startedAt };
    const tracker = new LiveRunTracker(def);
    const run: HarnessRun = {
        harnessId: def.id,
        harnessName: def.name,
        input: req.input,
        status: 'running',
        steps: [podmanStep, ...tracker.steps],
        output: '',
        startedAt
    };

    let lastUpdate = 0;
    const update = (force = false) => {
        const now = Date.now();
        if (force || now - lastUpdate > 250) { lastUpdate = now; req.onUpdate(JSON.parse(JSON.stringify(run)) as HarnessRun); }
    };
    const logLines: string[] = [];
    const logLine = (line: string) => {
        req.log(line);
        logLines.push(line);
        if (logLines.length > 400) { logLines.splice(0, logLines.length - 400); }
        podmanStep.output = logLines.join('\n');
        tracker.feed(line);
        update();
    };
    const milestone = (line: string) => { podmanStep.notes.push(line); logLine(line); };
    update(true);

    const name = containerName(def, new Date(startedAt));
    try {
        const exists = await execStreaming(req.podman, ['image', 'exists', prepared.tag], { signal: req.signal, onLine: () => { /* silent */ } });
        if (exists !== 0) {
            milestone(`Building image ${prepared.tag} …`);
            const built = await execStreaming(req.podman, podmanBuildArgs({ contextDir: prepared.contextDir, containerfile: path.join(prepared.contextDir, 'Containerfile'), tag: prepared.tag }), { cwd: prepared.contextDir, signal: req.signal, onLine: logLine });
            if (req.signal.aborted) { throw new Error('Cancelled.'); }
            if (built !== 0) { throw new Error(`podman build exited with code ${built}. The Containerfile is at ${path.join(prepared.contextDir, 'Containerfile')}.`); }
        } else {
            milestone(`Using existing image ${prepared.tag}.`);
        }

        // The image is the truth: probe it for the programs this run will invoke, with the input
        // resolved, and let the user decide about anything missing before a single step runs.
        let runTag = prepared.tag;
        const vars = { input: req.input, workspace: '/workspace', activeFile: prepared.activeFile, selection: prepared.plan.editor.selection ? req.editor.selection : '', date: new Date().toISOString().slice(0, 10) };
        const programs = programsForRun(def, vars);
        milestone(`Checking the image for ${programs.length} program(s): ${programs.join(', ')} …`);
        let missing = await probeImage(req, runTag, programs);
        if (missing.length) {
            const resolutions = resolvePackages(missing);
            const decision = await confirmDependencyInstall(def, resolutions);
            if (decision.action === 'cancel') { throw new Error('Cancelled at the dependency check; nothing was run.'); }
            if (decision.action === 'install') {
                const layer = renderDependencyLayer(runTag, decision.aptPackages, decision.pipPackages, { generator: req.generator });
                const layerTag = dependencyLayerTag(runTag, layer);
                const layerFile = path.join(prepared.contextDir, 'Containerfile.deps');
                fs.writeFileSync(layerFile, layer);
                const layerExists = await execStreaming(req.podman, ['image', 'exists', layerTag], { signal: req.signal, onLine: () => { /* silent */ } });
                if (layerExists !== 0) {
                    logLine(`Installing ${[...decision.aptPackages, ...decision.pipPackages].join(', ')} into a new image layer …`);
                    const built = await execStreaming(req.podman, podmanBuildArgs({ contextDir: prepared.contextDir, containerfile: layerFile, tag: layerTag }), { cwd: prepared.contextDir, signal: req.signal, onLine: logLine });
                    if (req.signal.aborted) { throw new Error('Cancelled.'); }
                    if (built !== 0) { throw new Error(`Installing the missing programs failed (podman build exited with ${built}). The layer recipe is at ${layerFile}.`); }
                }
                runTag = layerTag;
                missing = await probeImage(req, runTag, programs);
                if (missing.length) {
                    logLine(`Still missing after install: ${missing.join(', ')}.`);
                    const again = await vscode.window.showWarningMessage(
                        `After installing, the image still lacks: ${missing.join(', ')}. Run anyway?`,
                        { modal: true, detail: 'The package names may be wrong for these programs. Steps that call them will fail and their error policy will apply.' },
                        'Run anyway'
                    );
                    if (again !== 'Run anyway') { throw new Error('Cancelled at the dependency check; nothing was run.'); }
                } else {
                    logLine('All programs present after install.');
                }
            } else {
                logLine(`Running without: ${missing.join(', ')} (steps that call them will fail).`);
            }
        } else {
            milestone('All programs present in the image.');
        }

        milestone(`Running ${name} (workspace read-only, network ${network}) …`);
        const code = await execStreaming(req.podman, podmanRunArgs({ tag: runTag, name, workspaceDir: req.workspaceRoot, outputDir: prepared.outputDir, network }), {
            signal: req.signal,
            onLine: logLine,
            // `podman run --rm` is killed by the parent's SIGTERM, but the container must be told too.
            onCancel: () => { spawn(req.podman, ['kill', name], { stdio: 'ignore' }).on('error', () => { /* already gone */ }); }
        });
        if (req.signal.aborted) { throw new Error('Cancelled.'); }

        // Collect what the workflow produced.
        const outputFile = path.join(prepared.outputDir, 'output.txt');
        const recordFile = path.join(prepared.outputDir, 'run_record.json');
        run.output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '';
        if (fs.existsSync(recordFile)) {
            const record = JSON.parse(fs.readFileSync(recordFile, 'utf-8')) as { steps?: Record<string, string> };
            tracker.applyRecord(record.steps ?? {});
        }
        tracker.finish(code === 0);
        podmanStep.status = code === 0 ? 'done' : 'failed';
        podmanStep.endedAt = Date.now();
        podmanStep.notes.push(`Results in ${prepared.outputDir}`);
        run.status = code === 0 ? 'done' : 'failed';
        if (code !== 0) {
            const failed = tracker.firstFailure();
            run.error = failed
                ? `Step ${failed.id} failed${failed.error ? `: ${failed.error.split('\n')[0]}` : ''} (its policy stopped the harness). cwltool exited with code ${code}.`
                : `cwltool exited with code ${code} inside the container; see the Podman log.`;
        }
    } catch (error) {
        podmanStep.status = 'failed';
        podmanStep.endedAt = Date.now();
        run.status = req.signal.aborted ? 'cancelled' : 'failed';
        run.error = (error as Error).message;
        tracker.abandon();
    }
    run.endedAt = Date.now();
    update(true);
    return run;
}

// ---------------------------------------------------------------------------
// Installing Podman
// ---------------------------------------------------------------------------

export type PodmanInstallOutcome = 'installed' | 'not-found-after-install' | 'unsupported-system';

/**
 * Install Podman for the user: a notification saying what is being run and whether the
 * terminal will ask for the root password, then a VS Code terminal that runs the command.
 *
 * The command is executed, not merely typed. The password is still typed by the user into
 * `sudo`'s own prompt in that visible terminal; the extension never sees it and never passes
 * one. Podman is then polled for until it appears, the terminal closes, or the time limit
 * passes, so the caller can resume the run that needed it.
 */
export async function installPodmanInTerminal(podman: string): Promise<PodmanInstallOutcome> {
    let osRelease = '';
    try { osRelease = fs.readFileSync('/etc/os-release', 'utf-8'); } catch { /* not Linux, or unreadable */ }
    const suggestion = podmanInstallSuggestion(process.platform, osRelease);

    if (!suggestion.command) {
        const open = await vscode.window.showWarningMessage(
            `Podman is needed to run a harness in a container, and it is not installed. ${suggestion.description}`,
            'Open installation guide'
        );
        if (open) { await vscode.env.openExternal(vscode.Uri.parse(suggestion.url)); }
        return 'unsupported-system';
    }

    const terminal = vscode.window.createTerminal({ name: 'Enclave: install Podman' });
    void vscode.window.showInformationMessage(
        `Podman is not installed. Enclave is installing it in the terminal "Enclave: install Podman":  ${suggestion.command}`
        + (suggestion.needsSudo ? '  — the terminal will ask for your root password.' : ''),
        'Show terminal'
    ).then(choice => { if (choice === 'Show terminal') { terminal.show(); } });
    terminal.show(true);
    terminal.sendText(suggestion.command, true);

    // Wait for Podman to appear. Shell-integration exit codes are not available on every
    // VS Code this extension supports, so the presence of the binary is what is polled.
    const deadline = Date.now() + 20 * 60 * 1000;
    let terminalClosed = false;
    const closeListener = vscode.window.onDidCloseTerminal(t => { if (t === terminal) { terminalClosed = true; } });
    try {
        while (Date.now() < deadline) {
            try { await checkPodman(podman); return 'installed'; } catch { /* not yet */ }
            if (terminalClosed) { break; }
            await new Promise(r => setTimeout(r, 3000));
        }
        try { await checkPodman(podman); return 'installed'; } catch { return 'not-found-after-install'; }
    } finally {
        closeListener.dispose();
    }
}

// ---------------------------------------------------------------------------
// Probing the image and confirming installs
// ---------------------------------------------------------------------------

/** Which of `programs` the image cannot find. The probe runs with the network off. */
async function probeImage(req: ContainerRunRequest, tag: string, programs: string[]): Promise<string[]> {
    let output = '';
    const code = await execStreaming(req.podman, podmanVerifyArgs(tag, verifyScript(programs)), { signal: req.signal, onLine: l => { output += l + '\n'; } });
    if (req.signal.aborted) { throw new Error('Cancelled.'); }
    const { missing, completed } = parseVerifyOutput(output);
    if (!completed) { throw new Error(`Could not probe the image for its programs (podman exited with ${code}).\n${output.trim()}`); }
    return missing;
}

interface DependencyDecision {
    action: 'install' | 'run-anyway' | 'cancel';
    aptPackages: string[];
    pipPackages: string[];
}

/**
 * Tell the user what the image lacks and what would be installed for it, marking guesses as
 * guesses, and let them install, run without, or stop. When anything was guessed, the Debian
 * package list is shown for editing before the layer is built.
 */
async function confirmDependencyInstall(def: HarnessDefinition, resolutions: PackageResolution[]): Promise<DependencyDecision> {
    const lines = resolutions.map(r => {
        const what = [...r.apt.map(a => `${a} (apt)`), ...r.pip.map(x => `${x} (pip)`)].join(', ') || 'no package known';
        return `• ${r.program} → ${what}${r.guessed ? '  — guessed from the program name' : ''}`;
    });
    const anyGuessed = resolutions.some(r => r.guessed);
    const choice = await vscode.window.showWarningMessage(
        `The container image for "${def.name}" lacks ${resolutions.length === 1 ? 'a program' : `${resolutions.length} programs`} this run uses. Install into the image?`,
        {
            modal: true,
            detail: [
                ...lines,
                '',
                'A new image layer is built on top of the base image; the workspace is not touched.'
                + (anyGuessed ? ' Guessed package names can be edited in the next step.' : '')
            ].join('\n')
        },
        'Install',
        'Run anyway'
    );
    if (choice === 'Run anyway') { return { action: 'run-anyway', aptPackages: [], pipPackages: [] }; }
    if (choice !== 'Install') { return { action: 'cancel', aptPackages: [], pipPackages: [] }; }

    let apt = Array.from(new Set(resolutions.flatMap(r => r.apt)));
    const pip = Array.from(new Set(resolutions.flatMap(r => r.pip)));
    if (anyGuessed && apt.length) {
        const edited = await vscode.window.showInputBox({
            title: 'Debian packages to install',
            prompt: 'Some names were guessed from the program name. Edit the list if a guess is wrong, then press Enter.',
            value: apt.join(' '),
            validateInput: v => (/^[a-z0-9][a-z0-9.+ -]*$/.test(v.trim()) || v.trim() === '' ? null : 'Package names: lower-case letters, digits, ".", "+", "-", separated by spaces.')
        });
        if (edited === undefined) { return { action: 'cancel', aptPackages: [], pipPackages: [] }; }
        apt = edited.trim().split(/\s+/).filter(Boolean);
    }
    return { action: 'install', aptPackages: apt, pipPackages: pip };
}

// ---------------------------------------------------------------------------
// Live step tracking from cwltool's log
// ---------------------------------------------------------------------------

/**
 * Mirrors the harness step tree as `StepRun`s and updates it from cwltool's log as it streams.
 * cwltool reports steps by their CWL identifiers, which are the harness ids sanitised, so the
 * mapping is exact. Tool stderr — the runner's own message about why a step failed — is not
 * prefixed by cwltool; it is attributed to the job most recently started.
 */
class LiveRunTracker {
    readonly steps: StepRun[];
    private readonly byCwlId = new Map<string, StepRun>();
    private readonly parentOf = new Map<StepRun, StepRun | null>();
    private currentJob: StepRun | null = null;
    private readonly stderr = new Map<StepRun, string[]>();
    private readonly reader = new CwltoolLogReader();

    constructor(def: HarnessDefinition) {
        this.steps = def.steps.map(s => this.build(s, null));
    }

    private build(step: HarnessStep, parent: StepRun | null): StepRun {
        const run: StepRun = { id: step.id, name: step.name ?? step.id, type: step.type, status: 'pending', attempts: 0, notes: [] };
        const children = (step as { steps?: HarnessStep[] }).steps;
        if (Array.isArray(children)) { run.children = children.map(c => this.build(c, run)); }
        this.byCwlId.set(cwlId(step.id), run);
        this.parentOf.set(run, parent);
        return run;
    }

    feed(line: string): void {
        const event = this.reader.next(line);
        if (!event) { return; }
        switch (event.kind) {
            case 'step-start': {
                const step = this.byCwlId.get(event.step);
                if (step) { step.status = 'running'; step.attempts = Math.max(1, step.attempts); step.startedAt ??= Date.now(); this.markRunning(this.parentOf.get(step) ?? null); }
                break;
            }
            case 'job-command': {
                const step = this.byCwlId.get(event.step);
                if (step) { this.currentJob = step; }
                break;
            }
            case 'tool-output': {
                if (this.currentJob) {
                    const lines = this.stderr.get(this.currentJob) ?? [];
                    lines.push(event.text);
                    if (lines.length > 20) { lines.splice(0, lines.length - 20); }
                    this.stderr.set(this.currentJob, lines);
                }
                break;
            }
            case 'step-done': {
                const step = this.byCwlId.get(event.step);
                if (!step) { break; }
                step.status = event.status;
                step.endedAt = Date.now();
                if (event.status === 'failed') {
                    const text = (this.stderr.get(step) ?? []).filter(l => !/^step failed and policy is/.test(l)).join('\n').trim();
                    step.error = text || 'The step failed inside the container; see the Podman log.';
                }
                break;
            }
            default:
                break;
        }
    }

    private markRunning(step: StepRun | null): void {
        while (step) {
            if (step.status === 'pending') { step.status = 'running'; step.startedAt ??= Date.now(); }
            step = this.parentOf.get(step) ?? null;
        }
    }

    /** Statuses from run_record.json are authoritative where present. */
    applyRecord(statuses: Record<string, string>): void {
        for (const step of this.all()) {
            const status = statuses[step.id];
            if (status === 'done' || status === 'failed' || status === 'skipped') { step.status = status; }
        }
    }

    /** Settle whatever the log left open: groups from their children, untouched steps as not run. */
    finish(exitOk: boolean): void {
        const settle = (step: StepRun): void => {
            step.children?.forEach(settle);
            if (step.children?.length && (step.status === 'running' || step.status === 'pending')) {
                if (step.children.some(c => c.status === 'failed')) { step.status = 'failed'; }
                else if (step.children.every(c => c.status === 'done' || c.status === 'skipped')) { step.status = 'done'; }
            }
            if (step.status === 'running') { step.status = exitOk ? 'done' : 'failed'; step.notes.push('The log ended before this step reported completion.'); }
            if (step.status === 'pending') { step.status = 'skipped'; step.notes.push('Not run: an earlier step stopped the harness.'); }
            step.endedAt ??= Date.now();
        };
        this.steps.forEach(settle);
    }

    abandon(): void {
        for (const step of this.all()) {
            if (step.status === 'pending' || step.status === 'running') { step.status = 'skipped'; step.notes.push('Not run.'); }
        }
    }

    firstFailure(): StepRun | null {
        for (const step of this.all()) { if (step.status === 'failed' && !step.children?.length) { return step; } }
        for (const step of this.all()) { if (step.status === 'failed') { return step; } }
        return null;
    }

    private all(): StepRun[] {
        const out: StepRun[] = [];
        const visit = (list: StepRun[]) => { for (const s of list) { out.push(s); if (s.children) { visit(s.children); } } };
        visit(this.steps);
        return out;
    }
}
