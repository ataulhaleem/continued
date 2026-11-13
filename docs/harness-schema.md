# Workflow-harness document format

**Format version 1.0**

A workflow-harness is a fixed procedure: a graph of typed steps in which the author writes the
control flow, and a language model is consulted only at steps declared as such. This document
specifies the file format so harnesses can be exchanged between installs, checked into a
repository, reviewed in a pull request, and read by tools other than the one that wrote them.

The `$schema` field in every exported document points at this file.

## Three artifacts, three readers

Export produces any of three artifacts from the same definition.

| File | Reader | Purpose |
| --- | --- | --- |
| `<id>.harness.json` | Enclave | Executable. Re-imports exactly, runs directly. |
| `<id>.harness.md` | any agent or person | The same procedure as prose. Not executable. |
| `<id>.cwl` + `<id>.cwl-job.yml` | cwltool or any CWL v1.2 engine | Executable outside the editor. See *CWL export* below. |

The Markdown playbook exists because no other agent reads this schema. Codex reads `AGENTS.md`
(global `~/.codex/`, then repository root down to the working directory), OpenCode reads Markdown
command files in `.opencode/commands/`, Hermes reads a `CLAUDE.md` and a Markdown skills
framework, and Continue.Dev reads Markdown prompt files exposed as slash commands. Markdown is the
one format they all accept, so the playbook drops into any of them — or into a chat window —
without a translation step.

## Document structure

```json
{
  "$schema": "https://github.com/ataulhaleem/continued/blob/main/docs/harness-schema.md",
  "formatVersion": "1.0",
  "exportedAt": "2026-09-23T09:21:17.255Z",
  "generator": "enclave/1.0.1",
  "requires": {
    "tools": ["grep-search", "run-command", "semantic-search"],
    "resources": ["workspace-files"],
    "skills": [],
    "variables": ["input"],
    "usesModel": true
  },
  "harness": { "...": "the definition" }
}
```

| Field | Meaning |
| --- | --- |
| `formatVersion` | Version of *this format*, not of the application. Only the major component is significant. |
| `exportedAt` | ISO-8601 timestamp, for provenance. |
| `generator` | Which application and version wrote the file. |
| `requires` | Derived from the definition, so an importer can report what is missing **before** anything runs. |
| `harness` | The definition itself (see below). |

`requires` is informational and is recomputed on import; a file that disagrees with its own
definition is not trusted.

The definition's `source` field (`built-in` or `user`) describes where it came from *in the
install that exported it*. That is meaningless once the file has moved, so it is omitted on
export, and anything imported becomes a `user` harness.

## Compatibility rules

- An importer **must** accept a bare `HarnessDefinition` with no wrapper. Harnesses written by
  hand into `.continued/harnesses/*.json` have this shape and must keep working.
- An importer **should** accept a document whose major `formatVersion` is higher than its own,
  ignore fields it does not understand, and warn the user that it did so. Refusing outright is
  unhelpful when the definition is usually still readable.
- An importer **must not** accept a document that fails validation. Problems are reported; the
  harness is not saved.

## The definition

```jsonc
{
  "id": "workspace-health-harness",   // required; [A-Za-z0-9][A-Za-z0-9._-]*
  "name": "Workspace health check",   // required
  "description": "...",               // optional
  "version": "1.0.0",                 // optional
  "input": {                          // optional; the free-text input requested at run time
    "label": "Focus",
    "placeholder": "e.g. we are preparing a release",
    "required": false
  },
  "steps": [ /* required, at least one */ ],
  "output": "{{steps.report.output}}" // optional; defaults to the last successful top-level step
}
```

### Step types

Every step has an `id` unique within the harness, and optionally `name`, `when`, `onError`,
`retries` and `timeoutMs`.

| `type` | Required fields | Model-dependent |
| --- | --- | --- |
| `tool` | `pluginId`, `args` | no |
| `resource` | `pluginId` | no |
| `skill` | `pluginId`, optional `input` | composite |
| `llm` | `prompt`, optional `system`, `model`, `expect` | **yes** |
| `sequence` | `steps` | structural |
| `parallel` | `steps` | structural |
| `foreach` | `items`, `steps`, optional `itemVar`, `parallel`, `maxItems` | structural |

Exactly one type — `llm` — consults a language model. This is the property that makes a harness
analysable: the set of non-deterministic positions in a run can be read off the definition
before it is executed.

### Error policies

`onError` is one of:

| Value | Behaviour |
| --- | --- |
| `stop` (default) | The harness stops. |
| `continue` | The failure is recorded and the harness carries on. |
| `retry-then-stop` | Retry up to `retries` times (default 2), then stop. |
| `retry-then-continue` | Retry up to `retries` times, then carry on. |

A step **declined by the user** is not a failure and is never retried, whatever the policy says:
the harness stops. A refusal is a decision, not a transient error.

### Templates

Strings in `args`, `prompt`, `system`, `input`, `items`, `when` and `output` are interpolated.

| Reference | Yields |
| --- | --- |
| `{{input}}` | The run input. |
| `{{steps.<id>.output}}` | That step's output (`.output` is the default, so `{{steps.<id>}}` is equivalent). |
| `{{steps.<id>.lines}}` | The output split into non-empty trimmed lines. |
| `{{steps.<id>.json}}` | The output parsed as JSON; `.json.path.to.value` navigates into it. |
| `{{steps.<id>.status}}` | `done`, `failed` or `skipped`. |
| `{{steps.<id>.error}}` | The error text, if any. |
| `{{item}}`, `{{index}}` | The current item and its position inside a `foreach`. |
| `{{workspace}}`, `{{activeFile}}`, `{{selection}}`, `{{date}}` | Host-supplied variables. |

A template that is exactly one reference yields the raw value, so arrays and objects survive;
anything else is stringified. An unresolvable reference fails its step with a message naming the
available bindings rather than interpolating an empty string.

## Security

Importing a harness does not run it, but a harness can run tools and shell commands when it is
executed. Treat a harness file from someone else the way you would treat a script: read it
first. Enclave shows what a harness requires and asks for confirmation before saving an import,
and mutating steps still ask for approval at run time.

## CWL export

The **CWL** button writes a Common Workflow Language v1.2 document plus a job file. The
document is a `$graph` holding the workflow and one generic `CommandLineTool`, `enclave_step`:
a stdlib-only Python runner staged by `InitialWorkDirRequirement` that implements the same
`{{…}}` template substitution as the engine. Every harness step becomes a CWL step calling it.

| Harness construct | CWL |
| --- | --- |
| `tool` / `resource` | step calling `enclave_step`; read-only built-ins are reimplemented (`run-command`, `read-file`, `grep-search`, `semantic-search`, `list-directory`, `file-info`, `workspace-files`, `git-info`, `git-summary`, `csv-preview`, `json-query`) |
| `llm` | step calling `enclave_step` in `llm` mode: POST to `llm_base_url` + `/chat/completions` (any OpenAI-compatible endpoint — Ollama, Blablador) with `NetworkAccess` |
| `parallel` | children flattened; CWL runs independent steps concurrently |
| `sequence` | children flattened with an ordering edge (`after`) between siblings |
| `foreach` | items step → `ExpressionTool` → sub-workflow with `scatter: [item, index]` |
| `when: {{steps.x.status}} == value` | a real CWL `when`; the step yields `null` when skipped |
| other `when` forms | evaluated by the runner, which reports `skipped` |
| `onError`, `retries`, `timeoutMs` | honoured by the runner; `continue` exits 0 on failure, `stop` exits 1 |
| `{{activeFile}}`, `{{selection}}` | workflow inputs `active_file` (a workspace-relative path) and `selection`; the job file says when the harness needs them |
| an `llm` step's run context | `context` edges from every step that runs before it, as in the engine, not only the steps its prompt names |
| harness `output` | a final `collect` step; the workflow also emits `run_record` (per-step statuses) |

Run it with:

```
cwltool <id>.cwl <id>.cwl-job.yml
```

Edit the job file first: `workspace.path` is the directory the harness operates on; for Blablador
set `llm_base_url: https://api.blablador.fz-juelich.de/v1`, `llm_model: alias-code` and
`llm_api_key`. A harness that reads `{{activeFile}}` needs `active_file` set to the
workspace-relative path of the file to work on. `python3` must be on `PATH`, or the engine must
provide a Python-capable container.

What does **not** translate is stated in the document header as *Translation notes*, never
dropped silently:

- **Approval prompts do not exist in CWL.** Every `run-command` executes without asking. Run
  only harnesses you have reviewed.
- Mutating plugins (`write-file`, `edit-file`, …), `skill` steps and editor-only resources
  (`diagnostics`, `open-editors`, …) become steps whose output says why they could not run;
  their `onError` policy then applies.
- A per-step `model` is overridden by the workflow's `llm_model` input.
- A sequential `foreach` may run concurrently under a CWL engine.
- cwltool warns *"conditional step, but pickValue is not used"* for steps downstream of a
  `when`. That is expected: a `null` context entry is how a skipped step is represented.

The export was validated with `cwltool --validate` and executed end-to-end against a stub
OpenAI-compatible server for every built-in harness, including both branches of the
`test-and-explain-harness` status condition.

### Timeouts

`timeoutMs` bounds one attempt of a step's own work. Without it, a tool, resource or skill step
gets 120 s and an `llm` step 10 minutes, because a local model on a CPU may need that long once
the context window is sized to a whole document. Time spent at an approval prompt is never
counted: the engine asks the host to gate a tool step before the clock starts. The command line
overrides the defaults with `--timeout` and `--model-timeout` (seconds); the editor's
`agent.modelTimeoutMs` setting raises the model default when it is larger.

## Run from the command line

`enclave run <harness>` (package `enclave-cli`, folder `cli/`) executes a harness with the same
engine against the current directory; `enclave repro <harness> --runs N --model A --model B`
runs it repeatedly and reports structural stability, per-step output stability and approval
determinism from the run records. Approval prompts appear on the terminal; `--yes` grants all,
`--no-approvals` declines all. See `cli/README.md`.

## Testing the contract and the text

`enclave conformance` runs ten adversarial cases through the CLI host: a stub model returns a
harmful payload that a tool step consumes, twice per case (all approvals declined, all granted),
and the outcome is compared with what the contract requires. It exits non-zero if any case
deviates; the count of executions without an approval request must be zero.
`enclave grounding <run.json>` checks every quotation and numeral in a run's model steps
against the outputs of its deterministic steps and lists what it could not find.
`enclave run … --check-grounding` does the same right after a run.

## Run in a container

Ticking **Run in a container (Podman)** on the harness screen runs the harness through its CWL
export inside a Podman container, instead of through the editor's engine. The sequence is:

1. **Analyse.** The harness's `run-command` steps are scanned for the programs they invoke
   (`npm`, `pytest`, `git`, `make`, …) and the workspace root for manifests (`package.json`,
   `requirements.txt`, `Cargo.toml`, …). Each finding maps to Debian or Python packages. What the
   analysis cannot see — a command that is a `{{template}}`, a program it does not recognise — is
   written into the plan as a note, not guessed. The harness is also read for editor state: one
   that uses `{{activeFile}}` needs the file open in the editor to be **inside the workspace**,
   because the workspace is the only directory the container sees. That is resolved before
   anything is built; no file, or a file outside the workspace, ends the run there with the
   reason. The container is only the execution environment: the workspace is its input and
   `.continued/harness-runs/` its output.
2. **Confirm.** A dialog states the image that will be built, that the workspace is mounted
   read-only, which file `{{activeFile}}` will name, where results go, and that the container
   has **no network** unless you pick *Allow network*. A harness with `llm` steps needs the network, since the model server is
   outside the container; the dialog says so.
3. **Build.** A `Containerfile` is generated from the plan — `python:3.12-slim`, the detected
   packages, `cwltool`, and the exported `.cwl` and job file — and built with `podman build`.
   The image tag carries a hash of the harness and the plan, so an unchanged harness reuses its
   image.
4. **Verify in the image.** Static analysis guesses; the image is the truth. Before anything
   runs, the programs this run will invoke are probed inside the built image with `command -v`,
   network off, entrypoint overridden. The run input is known by now, so a templated command
   such as `{{input}}` = `npm test` resolves to a real program list. Anything missing is shown
   with the packages that would supply it — known mappings where they exist, and an explicit
   *"guessed from the program name"* otherwise — with three choices: **Install** (a new image
   layer is built on top of the base; guessed package names can be edited first), **Run
   anyway** (the steps that need them will fail and their `onError` policy applies), or
   cancel. After an install the image is probed again; if something is still missing you are
   asked once more before the run proceeds.
5. **Run.** `podman run --rm --network none --cap-drop=ALL --security-opt=no-new-privileges`
   with the workspace at `/workspace` **read-only** and the output directory at `/out`. With
   *Allow network*, no `--network` flag is passed (Podman's rootless default) and a model server on this machine
   (`localhost`) is reached as `host.containers.internal`; the API key is passed only in this
   mode.
6. **Collect.** `output.txt` and `run_record.json` are read from the output directory and shown
   in the Run tab like any other run, with the Podman log in a leading pseudo-step.

Generated files live in `.continued/container/<id>/` so they can be inspected; results go to
`.continued/harness-runs/<id>-<timestamp>/` by default.

**If Podman is not installed**, Enclave installs it. A notification states the command being
run — chosen from the platform and, on Linux, the distribution family in `/etc/os-release`
(`apt`, `dnf`, `pacman`, `zypper`, `apk`, `nix-env`; Homebrew on macOS, `winget` on Windows) —
and says when the terminal will ask for your root password. The command runs in a VS Code
terminal named *Enclave: install Podman* that you can watch; the password goes to `sudo`'s own
prompt in that terminal, never to the extension. Enclave then waits for Podman to appear and
resumes the container run automatically. An unrecognised system gets the Podman documentation
rather than a guessed command.

| Setting | Default | Meaning |
| --- | --- | --- |
| `continued.container.podmanPath` | `podman` | Podman executable. |
| `continued.container.outputDir` | `.continued/harness-runs` | Where results are written, relative to the workspace unless absolute. |
| `continued.container.extraPackages` | `[]` | Extra Debian packages for tools the analysis cannot see. |

Limits, stated rather than implied: only Ollama, OpenAI and Blablador models can be used, because
the CWL runner speaks the OpenAI-compatible API; approval prompts do not exist inside the
container, so every command runs unattended — the confirmation dialog says this; the workspace is
read-only, so a command that writes into it (`npm install`, a test that writes coverage) fails
there; and the browser extension does not offer the option, since it cannot drive Podman.
