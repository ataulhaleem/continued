/**
 * Containerised execution of a harness.
 *
 * "Run in a container" compiles the harness to Common Workflow Language and executes it with
 * `cwltool` inside a Podman container. Nothing new executes the steps: the CWL translator and
 * its embedded runner already do, and both are tested. What this module adds is the plan for
 * the container around them.
 *
 *   1. Dependency analysis — the harness's `run-command` steps are scanned for the programs
 *      they invoke (`npm test`, `pytest`, `git log`, …) and the workspace's manifest files are
 *      consulted (`package.json`, `requirements.txt`, …). Each finding maps to system packages.
 *   2. A Containerfile is generated from the plan: a slim Python base, the detected packages,
 *      `cwltool`, and the workflow files. It is regenerated whenever the harness or the plan
 *      changes; the image tag carries a hash of both, so unchanged harnesses reuse the image.
 *   3. Podman command lines are composed for the build and the run. The run mounts the
 *      workspace read-only, drops all capabilities, and by default has no network at all.
 *
 * The trust posture is the point: the container can read the workspace, cannot write it, and
 * cannot reach anything outside itself unless the user chooses "allow network" — which a
 * harness with model steps needs, since a model server is outside the container.
 *
 * The analysis is deliberately conservative and says what it cannot see: a command that is a
 * template (`{{input}}`) is unknown until run time, and the plan records that as a note.
 *
 * Free of editor and browser APIs; shared by both hosts and unit-tested directly.
 */

import { HarnessDefinition, ToolStep } from './types';
import { walkSteps, collectRequirements } from './portable';
import { CWL_DEFAULT_BASE_URL, cwlFileNames, toYaml, referencedVariables } from './cwl';

export const CONTAINER_BASE_IMAGE = 'docker.io/library/python:3.12-slim';
/** Hostname Podman (≥4.1, rootless) maps to the host, used to reach Ollama from a container. */
export const CONTAINER_HOST_ALIAS = 'host.containers.internal';
/** Where the workspace and the output directory appear inside the container. */
export const CONTAINER_WORKSPACE = '/workspace';
export const CONTAINER_OUTPUT = '/out';

export type ContainerNetwork = 'none' | 'allow';

export interface Detection {
    /** What was seen: a program name or a manifest file. */
    evidence: string;
    /** Where it was seen. */
    source: string;
    /** System packages this implies. */
    apt: string[];
    /** Python packages this implies. */
    pip: string[];
}

export interface ContainerPlan {
    baseImage: string;
    aptPackages: string[];
    pipPackages: string[];
    detections: Detection[];
    /** True when any step consults a model, which needs the network. */
    usesModel: boolean;
    /** Editor state the harness reads through templates; it has to be resolved before the run. */
    editor: { activeFile: boolean; selection: boolean };
    /** Things the analysis could not determine, one line each. */
    notes: string[];
}

export interface AnalysisOptions {
    /** Names of files at the workspace root, for manifest detection. */
    workspaceFiles?: string[];
    /** Extra system packages the user asked for (setting). */
    extraAptPackages?: string[];
}

// ---------------------------------------------------------------------------
// Dependency analysis
// ---------------------------------------------------------------------------

/** Program name → packages. Anything not listed is assumed to be in the base image or unknown. */
const PROGRAMS: Record<string, { apt: string[]; pip?: string[] }> = {
    node: { apt: ['nodejs', 'npm'] }, npm: { apt: ['nodejs', 'npm'] }, npx: { apt: ['nodejs', 'npm'] },
    yarn: { apt: ['nodejs', 'npm'] }, pnpm: { apt: ['nodejs', 'npm'] }, tsc: { apt: ['nodejs', 'npm'] },
    python: { apt: [] }, python3: { apt: [] }, pip: { apt: [] }, pip3: { apt: [] },
    pytest: { apt: [], pip: ['pytest'] }, tox: { apt: [], pip: ['tox'] }, ruff: { apt: [], pip: ['ruff'] },
    black: { apt: [], pip: ['black'] }, mypy: { apt: [], pip: ['mypy'] }, flake8: { apt: [], pip: ['flake8'] },
    jupyter: { apt: [], pip: ['jupyter'] },
    git: { apt: ['git'] },
    make: { apt: ['build-essential'] }, gcc: { apt: ['build-essential'] }, 'g++': { apt: ['build-essential'] },
    cc: { apt: ['build-essential'] }, cmake: { apt: ['build-essential', 'cmake'] },
    cargo: { apt: ['cargo'] }, rustc: { apt: ['cargo'] },
    go: { apt: ['golang'] },
    java: { apt: ['default-jdk-headless'] }, javac: { apt: ['default-jdk-headless'] },
    mvn: { apt: ['default-jdk-headless', 'maven'] }, gradle: { apt: ['default-jdk-headless', 'gradle'] },
    R: { apt: ['r-base'] }, Rscript: { apt: ['r-base'] },
    curl: { apt: ['curl'] }, wget: { apt: ['wget'] }, jq: { apt: ['jq'] },
    rg: { apt: ['ripgrep'] }, latexmk: { apt: ['latexmk', 'texlive'] }, pdflatex: { apt: ['texlive'] },
    bash: { apt: [] }, sh: { apt: [] }, ls: { apt: [] }, cat: { apt: [] }, grep: { apt: [] }, find: { apt: [] },
    echo: { apt: [] }, sed: { apt: [] }, awk: { apt: [] }, wc: { apt: [] }, head: { apt: [] }, tail: { apt: [] },
    sort: { apt: [] }, uniq: { apt: [] }, xargs: { apt: [] }, test: { apt: [] }, true: { apt: [] }, false: { apt: [] }
};

/** Programs that cannot run inside the container at all. */
const IMPOSSIBLE = new Set(['docker', 'podman', 'systemctl', 'sudo', 'code']);

/** Workspace manifest → packages, and the install step the Containerfile should run. */
const MANIFESTS: Record<string, { apt: string[]; pip?: string[]; note?: string }> = {
    'package.json': { apt: ['nodejs', 'npm'] },
    'requirements.txt': { apt: [], pip: ['-r /workspace/requirements.txt'], note: 'requirements.txt is installed at build time from the workspace' },
    'pyproject.toml': { apt: [] },
    'Cargo.toml': { apt: ['cargo'] },
    'go.mod': { apt: ['golang'] },
    'pom.xml': { apt: ['default-jdk-headless', 'maven'] },
    'build.gradle': { apt: ['default-jdk-headless', 'gradle'] },
    'Makefile': { apt: ['build-essential'] },
    'CMakeLists.txt': { apt: ['build-essential', 'cmake'] },
    'DESCRIPTION': { apt: ['r-base'] }
};

/** First program of each pipeline segment, after environment assignments and wrappers. */
export function programsIn(command: string): string[] {
    const out: string[] = [];
    for (const raw of command.replace(/\r/g, '').split(/\n|;|&&|\|\||\|/)) {
        const tokens = raw.trim().replace(/^\(+/, '').split(/\s+/).filter(Boolean);
        let i = 0;
        while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i++; }          // FOO=1
        while (i < tokens.length && /^(time|nice|env|exec|nohup)$/.test(tokens[i])) { i++; }     // wrappers
        if (i >= tokens.length) { continue; }
        const program = tokens[i].replace(/^.*\//, '');                                            // /usr/bin/git → git
        if (/^[A-Za-z0-9_.+-]+$/.test(program)) { out.push(program); }
    }
    return out;
}

/**
 * Determine what the container must contain for this harness to run.
 *
 * Conservative by design: it lists what it saw and where, and records what it could not see,
 * so the user reads a plan rather than trusts a guess.
 */
export function analyseContainerNeeds(def: HarnessDefinition, options: AnalysisOptions = {}): ContainerPlan {
    const apt = new Set<string>();
    const pip = new Set<string>(['cwltool']);
    const detections: Detection[] = [];
    const notes: string[] = [];
    const seenPrograms = new Set<string>();

    // cwltool evaluates CWL expressions with Node, and every workflow here uses them.
    apt.add('nodejs');
    detections.push({ evidence: 'cwltool expressions', source: 'always', apt: ['nodejs'], pip: ['cwltool'] });

    for (const step of walkSteps(def.steps ?? [])) {
        if (step.type !== 'tool' || (step as ToolStep).pluginId !== 'run-command') { continue; }
        const command = String((step as ToolStep).args?.command ?? '');
        if (/\{\{/.test(command)) {
            notes.push(`Step "${step.id}" runs a command that is a template (${command.slice(0, 60)}); it is resolved with the run input and checked in the built image before the run.`);
        }
        for (const program of programsIn(command)) {
            if (seenPrograms.has(program)) { continue; }
            seenPrograms.add(program);
            if (IMPOSSIBLE.has(program)) {
                notes.push(`Step "${step.id}" runs "${program}", which cannot run inside a container; that step will fail and its policy (${step.onError ?? 'stop'}) applies.`);
                continue;
            }
            const known = PROGRAMS[program];
            if (!known) {
                notes.push(`Step "${step.id}" runs "${program}", which the analysis does not recognise; it is assumed to be present or unnecessary. Add a package with continued.container.extraPackages if it fails.`);
                continue;
            }
            if (known.apt.length || known.pip?.length) {
                detections.push({ evidence: program, source: `step "${step.id}"`, apt: known.apt, pip: known.pip ?? [] });
                known.apt.forEach(p => apt.add(p));
                known.pip?.forEach(p => pip.add(p));
            }
        }
    }

    for (const file of options.workspaceFiles ?? []) {
        const manifest = MANIFESTS[file];
        if (!manifest) { continue; }
        detections.push({ evidence: file, source: 'workspace root', apt: manifest.apt, pip: manifest.pip ?? [] });
        manifest.apt.forEach(p => apt.add(p));
        manifest.pip?.forEach(p => pip.add(p));
        if (manifest.note) { notes.push(manifest.note); }
    }

    // A git checkout is read by git-info / git-summary steps and by many test scripts.
    if ((options.workspaceFiles ?? []).includes('.git') && !apt.has('git')) {
        apt.add('git');
        detections.push({ evidence: '.git', source: 'workspace root', apt: ['git'], pip: [] });
    }

    for (const extra of options.extraAptPackages ?? []) {
        const name = extra.trim();
        if (/^[a-z0-9][a-z0-9.+-]*$/.test(name)) { apt.add(name); detections.push({ evidence: name, source: 'setting continued.container.extraPackages', apt: [name], pip: [] }); }
        else if (name) { notes.push(`Ignored extra package "${name}": not a valid Debian package name.`); }
    }

    const usesModel = collectRequirements(def).usesModel;
    const variables = referencedVariables(def);
    if (variables.has('activeFile')) {
        notes.push('Reads the active editor file ({{activeFile}}): the file must be inside the workspace, which is the only directory mounted into the container.');
    }
    if (usesModel) {
        notes.push('This harness calls a language model. With the network sealed (the default) those steps fail; choose "allow network" to reach a model server on this machine or an institutional endpoint.');
    }

    return {
        baseImage: CONTAINER_BASE_IMAGE,
        aptPackages: Array.from(apt).sort(),
        pipPackages: Array.from(pip).sort(),
        detections,
        usesModel,
        editor: { activeFile: variables.has('activeFile'), selection: variables.has('selection') },
        notes
    };
}

// ---------------------------------------------------------------------------
// Containerfile
// ---------------------------------------------------------------------------

export interface ContainerfileOptions {
    generator?: string;
    now?: Date;
}

/**
 * The image recipe. Everything the plan found is installed at build time, when the network
 * is available; at run time the container needs nothing from outside.
 */
export function renderContainerfile(def: HarnessDefinition, plan: ContainerPlan, options: ContainerfileOptions = {}): string {
    const names = cwlFileNames(def);
    const stamp = (options.now ?? new Date()).toISOString();
    const pipRequirements = plan.pipPackages.filter(p => p.startsWith('-r '));
    const pipPlain = plan.pipPackages.filter(p => !p.startsWith('-r '));
    const lines = [
        `# Containerfile for the Enclave workflow-harness "${def.id}"`,
        `# Generated by ${options.generator ?? 'enclave'} on ${stamp}. Regenerated when the harness or its needs change.`,
        '#',
        '# Detected needs:',
        ...plan.detections.map(d => `#   ${d.evidence} (${d.source}) -> ${[...d.apt, ...d.pip].join(' ') || 'nothing to install'}`),
        ...(plan.notes.length ? ['#', '# Notes:', ...plan.notes.map(n => `#   ${n}`)] : []),
        '',
        `FROM ${plan.baseImage}`,
        'ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1',
        '',
        '# System packages the harness was found to need.',
        'RUN apt-get update \\',
        ` && apt-get install -y --no-install-recommends ${plan.aptPackages.join(' ')} \\`,
        ' && rm -rf /var/lib/apt/lists/*',
        '',
        '# The CWL engine that runs the workflow, plus any Python tools the steps invoke.',
        `RUN pip install --no-cache-dir ${pipPlain.join(' ')}`
    ];
    if (pipRequirements.length) {
        lines.push(
            '',
            '# Python dependencies declared by the workspace, installed from the build context.',
            'COPY requirements.txt /tmp/requirements.txt',
            'RUN pip install --no-cache-dir -r /tmp/requirements.txt'
        );
    }
    lines.push(
        '',
        '# The exported workflow and its job file.',
        'WORKDIR /work',
        `COPY ${names.workflow} ${names.job} ./`,
        '',
        `# Results are collected under ${CONTAINER_OUTPUT}; the workspace is mounted at ${CONTAINER_WORKSPACE} read-only.`,
        `ENTRYPOINT ["cwltool", "--disable-color", "--outdir", "${CONTAINER_OUTPUT}", "${names.workflow}", "${names.job}"]`,
        ''
    );
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Job file inside the container
// ---------------------------------------------------------------------------

export interface ContainerJobOptions {
    input: string;
    /** Workspace-relative path of the file `{{activeFile}}` resolves to, or '' when none. */
    activeFile?: string;
    /** Text `{{selection}}` resolves to, or ''. */
    selection?: string;
    network: ContainerNetwork;
    llmBaseUrl?: string;
    llmModel?: string;
    llmApiKey?: string | null;
}

/**
 * A model server on this machine is `localhost` to the host but not to the container; Podman
 * exposes the host as `host.containers.internal`. Anything else is left alone.
 */
export function rewriteBaseUrlForContainer(url: string): string {
    return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i, `$1${CONTAINER_HOST_ALIAS}`);
}

/** The job file the container runs with: workspace at its mount point, endpoint reachable. */
export function containerJobFile(def: HarnessDefinition, options: ContainerJobOptions): string {
    const baseUrl = options.llmBaseUrl ?? CWL_DEFAULT_BASE_URL;
    const job = {
        workspace: { class: 'Directory', path: CONTAINER_WORKSPACE },
        input: options.input,
        active_file: options.activeFile ?? '',
        selection: options.selection ?? '',
        llm_base_url: options.network === 'allow' ? rewriteBaseUrlForContainer(baseUrl) : baseUrl,
        llm_model: options.llmModel ?? 'llama3',
        llm_api_key: options.network === 'allow' ? (options.llmApiKey ?? null) : null
    };
    return [
        `# Job file for ${cwlFileNames(def).workflow} inside the container (network: ${options.network}).`,
        toYaml(job),
        ''
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Podman command lines
// ---------------------------------------------------------------------------

/** Stable tag: same harness and plan → same image, so a rebuild is only needed when they change. */
export function imageTag(def: HarnessDefinition, containerfile: string, workflow: string): string {
    // FNV-1a over the two documents; short, deterministic, no dependency.
    let h = 0x811c9dc5;
    for (const ch of `${containerfile}\u0000${workflow}`) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    const safe = def.id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[.-]+/, '') || 'harness';
    return `localhost/enclave-harness-${safe}:${h.toString(16).padStart(8, '0')}`;
}

export interface BuildArgsOptions {
    podman?: string;
    contextDir: string;
    containerfile: string;
    tag: string;
}

export function podmanBuildArgs(o: BuildArgsOptions): string[] {
    return ['build', '--file', o.containerfile, '--tag', o.tag, o.contextDir];
}

export interface RunArgsOptions {
    tag: string;
    /** Container name, so it can be stopped by name. */
    name: string;
    workspaceDir: string;
    outputDir: string;
    network: ContainerNetwork;
}

/**
 * The run: read-only workspace, all capabilities dropped, no privilege escalation, and no
 * network unless the user chose otherwise. With network allowed no `--network` flag is passed,
 * so Podman uses its own rootless default (slirp4netns on 4.x, pasta on 5.x) rather than one
 * that may not be installed; `host.containers.internal` resolves with either. `:z` relabels
 * for SELinux where present and is a no-op elsewhere.
 */
export function podmanRunArgs(o: RunArgsOptions): string[] {
    return [
        'run', '--rm', '--name', o.name,
        ...(o.network === 'none' ? ['--network', 'none'] : []),
        '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--volume', `${o.workspaceDir}:${CONTAINER_WORKSPACE}:ro,z`,
        '--volume', `${o.outputDir}:${CONTAINER_OUTPUT}:z`,
        o.tag
    ];
}

/** A container name safe for Podman and unique per run. */
export function containerName(def: HarnessDefinition, now: Date = new Date()): string {
    const safe = def.id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[.-]+/, '') || 'harness';
    return `enclave-${safe}-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

/** Human-readable summary for the confirmation dialog. */
export function describePlan(plan: ContainerPlan, outputDir: string): string {
    const install = plan.aptPackages.length ? plan.aptPackages.join(', ') : 'nothing beyond the base image';
    const lines = [
        `Image: ${plan.baseImage} + ${install}; Python: ${plan.pipPackages.filter(p => !p.startsWith('-r')).join(', ')}.`,
        `Workspace: mounted read-only. Results: ${outputDir}.`,
        'Network: none unless you choose "Allow network" below.'
    ];
    if (plan.notes.length) { lines.push('', 'Notes:', ...plan.notes.map(n => `• ${n}`)); }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Installing Podman
// ---------------------------------------------------------------------------

export interface InstallSuggestion {
    /** The command to place in a terminal, or null when the system is not recognised. */
    command: string | null;
    /** What the command does, in one sentence, for the confirmation dialog. */
    description: string;
    /** Where to read more; always present. */
    url: string;
    /** Whether the command escalates privileges, so the dialog can say a password will be asked. */
    needsSudo: boolean;
}

const PODMAN_DOCS = 'https://podman.io/docs/installation';

/** `ID` and `ID_LIKE` from an `/etc/os-release` file, lower-cased. */
function osReleaseIds(osRelease: string): string[] {
    const ids: string[] = [];
    for (const key of ['ID', 'ID_LIKE']) {
        const m = osRelease.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (m) { ids.push(...m[1].replace(/"/g, '').toLowerCase().split(/\s+/).filter(Boolean)); }
    }
    return ids;
}

/**
 * The install command for this system, determined from the platform and, on Linux, the
 * distribution family in `/etc/os-release`. Placed in a terminal for the user to run; never
 * executed by the extension, since it needs the user's password and the user's consent.
 */
export function podmanInstallSuggestion(platform: string, osRelease = ''): InstallSuggestion {
    if (platform === 'darwin') {
        return {
            command: 'brew install podman && podman machine init && podman machine start',
            description: 'Installs Podman with Homebrew and starts the Linux VM it needs on macOS.',
            url: PODMAN_DOCS, needsSudo: false
        };
    }
    if (platform === 'win32') {
        return {
            command: 'winget install --id RedHat.Podman -e; podman machine init; podman machine start',
            description: 'Installs Podman with winget and starts the WSL machine it needs on Windows.',
            url: PODMAN_DOCS, needsSudo: false
        };
    }
    const ids = osReleaseIds(osRelease);
    const has = (...names: string[]) => names.some(n => ids.includes(n));
    if (has('debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'raspbian')) {
        return { command: 'sudo apt-get update && sudo apt-get install -y podman', description: 'Installs Podman from the distribution repositories with apt.', url: PODMAN_DOCS, needsSudo: true };
    }
    if (has('fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol')) {
        return { command: 'sudo dnf install -y podman', description: 'Installs Podman from the distribution repositories with dnf.', url: PODMAN_DOCS, needsSudo: true };
    }
    if (has('arch', 'manjaro', 'endeavouros')) {
        return { command: 'sudo pacman -S --needed podman', description: 'Installs Podman from the distribution repositories with pacman.', url: PODMAN_DOCS, needsSudo: true };
    }
    if (has('opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'sles', 'suse')) {
        return { command: 'sudo zypper install -y podman', description: 'Installs Podman from the distribution repositories with zypper.', url: PODMAN_DOCS, needsSudo: true };
    }
    if (has('alpine')) {
        return { command: 'sudo apk add podman', description: 'Installs Podman from the distribution repositories with apk.', url: PODMAN_DOCS, needsSudo: true };
    }
    if (has('nixos')) {
        return { command: 'nix-env -iA nixpkgs.podman', description: 'Installs Podman into the user profile with nix-env.', url: PODMAN_DOCS, needsSudo: false };
    }
    return { command: null, description: 'This system was not recognised; the Podman documentation lists installation steps for each platform.', url: PODMAN_DOCS, needsSudo: false };
}

// ---------------------------------------------------------------------------
// Verifying the built image
// ---------------------------------------------------------------------------
//
// Static analysis guesses; the image is the truth. Once the base image exists, the programs
// the harness will actually invoke are probed inside it with `command -v`. At that point the
// run input is known, so a templated command such as `{{input}}` = `npm test` resolves to a
// real program list. What is missing becomes a proposal the user confirms, and an extra layer
// is built on top of the base image.

/** Shell builtins and trivial utilities that `command -v` always finds; not worth probing. */
const NOT_WORTH_PROBING = new Set([
    'cd', 'echo', 'test', 'true', 'false', 'exit', 'export', 'set', 'unset', 'source', '.', 'eval', 'exec',
    'printf', 'read', 'shift', 'trap', 'wait', 'pwd', 'sh', 'bash', 'ls', 'cat', 'grep', 'sed', 'awk', 'find',
    'wc', 'head', 'tail', 'sort', 'uniq', 'xargs', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'tr', 'cut',
    'tee', 'env', 'date', 'sleep', 'basename', 'dirname', 'readlink', 'chmod', 'chown', 'ln', 'tar', 'gzip',
    'stat', 'diff', 'cmp', 'sha256sum', 'md5sum'
]);

/** Programs every generated workflow needs regardless of the harness. */
export const ALWAYS_REQUIRED_PROGRAMS = ['python3', 'node', 'cwltool'];

/**
 * Resolve the templates that are knowable before the run: the input and the host variables.
 * `{{steps.*}}` and loop variables are left in place; they exist only during the run.
 */
export function resolveRunTemplates(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
        const key = name.trim();
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole;
    });
}

/** The programs this run will invoke, with the run input already substituted. */
export function programsForRun(def: HarnessDefinition, vars: Record<string, string>): string[] {
    const out = new Set<string>(ALWAYS_REQUIRED_PROGRAMS);
    for (const step of walkSteps(def.steps ?? [])) {
        if (step.type !== 'tool' || (step as ToolStep).pluginId !== 'run-command') { continue; }
        const command = resolveRunTemplates(String((step as ToolStep).args?.command ?? ''), vars);
        for (const program of programsIn(command)) {
            // A program that is still a template cannot be probed; the run will find out.
            if (/\{\{/.test(program) || NOT_WORTH_PROBING.has(program)) { continue; }
            out.add(program);
        }
    }
    return Array.from(out);
}

/** A POSIX sh script that prints `MISSING <program>` for each program `command -v` cannot find. */
export function verifyScript(programs: string[]): string {
    const quoted = programs.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
    return `for p in ${quoted}; do command -v "$p" >/dev/null 2>&1 || echo "MISSING $p"; done; echo VERIFY-DONE`;
}

export function parseVerifyOutput(output: string): { missing: string[]; completed: boolean } {
    const missing: string[] = [];
    let completed = false;
    for (const line of output.split(/\r?\n/)) {
        const m = line.match(/^MISSING (\S+)$/);
        if (m) { missing.push(m[1]); }
        if (line.trim() === 'VERIFY-DONE') { completed = true; }
    }
    return { missing, completed };
}

/** `podman run` that probes the image with the entrypoint overridden and the network off. */
export function podmanVerifyArgs(tag: string, script: string): string[] {
    return ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', tag, '-c', script];
}

export interface PackageResolution {
    program: string;
    apt: string[];
    pip: string[];
    /** True when the package name was taken from the program name rather than a known mapping. */
    guessed: boolean;
}

/** Packages for missing programs: known mappings where they exist, an explicit guess otherwise. */
export function resolvePackages(missing: string[]): PackageResolution[] {
    return missing.map(program => {
        const known = PROGRAMS[program];
        if (known && (known.apt.length || known.pip?.length)) {
            return { program, apt: known.apt, pip: known.pip ?? [], guessed: false };
        }
        if (program === 'cwltool') { return { program, apt: [], pip: ['cwltool'], guessed: false }; }
        if (program === 'node') { return { program, apt: ['nodejs'], pip: [], guessed: false }; }
        if (program === 'python3') { return { program, apt: ['python3'], pip: [], guessed: false }; }
        // Debian packages are usually named after their principal program; say that it is a guess.
        const guess = program.toLowerCase().replace(/[^a-z0-9.+-]/g, '');
        return { program, apt: guess ? [guess] : [], pip: [], guessed: true };
    });
}

/** Containerfile for one more layer on the base image, installing what the probe found missing. */
export function renderDependencyLayer(baseTag: string, aptPackages: string[], pipPackages: string[], options: ContainerfileOptions = {}): string {
    const stamp = (options.now ?? new Date()).toISOString();
    const lines = [
        `# Dependency layer generated by ${options.generator ?? 'enclave'} on ${stamp}: programs the harness`,
        '# uses that were not found in the base image when it was probed with `command -v`.',
        `FROM ${baseTag}`
    ];
    if (aptPackages.length) {
        lines.push(
            'RUN apt-get update \\',
            ` && apt-get install -y --no-install-recommends ${aptPackages.join(' ')} \\`,
            ' && rm -rf /var/lib/apt/lists/*'
        );
    }
    if (pipPackages.length) {
        lines.push(`RUN pip install --no-cache-dir ${pipPackages.join(' ')}`);
    }
    lines.push('');
    return lines.join('\n');
}

/** Tag for the dependency layer: the base tag plus a hash of what the layer installs. */
export function dependencyLayerTag(baseTag: string, layerContainerfile: string): string {
    let h = 0x811c9dc5;
    for (const ch of layerContainerfile) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${baseTag}-deps-${h.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Reading cwltool's log
// ---------------------------------------------------------------------------
//
// When the workflow fails, `collect` never runs and there is no run_record. cwltool's log still
// states what every step did, so it is parsed as it streams and drives the Run tab live.

export type CwltoolEvent =
    | { kind: 'step-start'; step: string }
    | { kind: 'step-done'; step: string; status: 'done' | 'failed' | 'skipped' }
    | { kind: 'job-exit'; step: string; code: number }
    | { kind: 'job-command'; step: string }
    | { kind: 'workflow-done'; status: 'done' | 'failed' }
    | { kind: 'tool-output'; text: string };

const CWL_STATUS: Record<string, 'done' | 'failed' | 'skipped'> = { success: 'done', permanentFail: 'failed', temporaryFail: 'failed', skipped: 'skipped' };

/** One line of `cwltool` output, classified. Lines cwltool did not write are the tools' own stderr. */
/**
 * `parseCwltoolLine` with one piece of state: cwltool prints a job's command line over several
 * lines, each but the last ending in a backslash. Those continuation lines are not tool output
 * and must not be mistaken for a step's error.
 */
export class CwltoolLogReader {
    private continuing = false;

    next(line: string): CwltoolEvent | null {
        const text = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (this.continuing) {
            this.continuing = /\\$/.test(text);
            return null;
        }
        const event = parseCwltoolLine(line);
        if (event?.kind === 'job-command') { this.continuing = /\\$/.test(text); }
        return event;
    }
}

export function parseCwltoolLine(line: string): CwltoolEvent | null {
    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!text) { return null; }
    let m = text.match(/^(?:INFO|WARNING|ERROR)\s+\[step ([^\]\s]+)\] start$/);
    if (m) { return { kind: 'step-start', step: m[1] }; }
    m = text.match(/^(?:INFO|WARNING|ERROR)\s+\[step ([^\]\s]+)\] completed (\w+)$/);
    if (m) { return { kind: 'step-done', step: m[1], status: CWL_STATUS[m[2]] ?? 'failed' }; }
    m = text.match(/^(?:INFO|WARNING|ERROR)\s+\[job ([^\]\s]+)\] exited with status: (\d+)$/);
    if (m) { return { kind: 'job-exit', step: m[1], code: Number(m[2]) }; }
    m = text.match(/^(?:INFO|WARNING|ERROR)\s+\[job ([^\]\s]+)\] \S+\$ /);
    if (m) { return { kind: 'job-command', step: m[1] }; }
    m = text.match(/^(?:INFO|WARNING|ERROR)\s+\[workflow[^\]]*\] completed (\w+)$/);
    if (m) { return { kind: 'workflow-done', status: m[1] === 'success' ? 'done' : 'failed' }; }
    if (/^(?:INFO|WARNING|ERROR|DEBUG)\s/.test(text) || /^\{|^\}|^"(output|run_record)":/.test(text)) { return null; }
    return { kind: 'tool-output', text };
}
