# Change Log

All notable changes to the "continued" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [1.1.0] - 2026-11-13

**Naming.** The project is being renamed from *Continued* to *Enclave*; 1.1.0 is the first release under the new name. The VS Code extension keeps its Marketplace identifier `AtaUlHaleem.continued`, its `continued.*` settings and the `.continued/` workspace folder, and the Firefox add-on keeps its ID, so existing installs update in place with nothing to migrate. The command-line package is `enclave-harness` (command `enclave`).

One engine, three hosts. The workflow-harness engine and the agent protocol moved into a shared `core/` and now run in the VS Code extension, in a browser extension and from the command line, with the same document format everywhere. Harnesses can leave the machine they were written on (JSON, Markdown playbook, Common Workflow Language) and can run sealed in a Podman container. The agent loop is built for long runs: streamed model calls with stall detection, a wall-clock budget, retries on transient errors, and notes you can send while it works.

### Added
- **Browser extension "Enclave"** (`browser-plugin/`, v0.3.1): Chrome side panel and Firefox sidebar with the same chat, agent and harness UI. Reads tabs, including PDFs page by page via pdf.js, with eight research harnesses (extract quantitative results, answer a question from an article, referee-style review, compare two articles, summarise a page, compare open tabs, research a list of URLs, find on page). Opt-in reading of local `file://` tabs and of localhost/private-network URLs; attached PDFs are parsed before they reach the model; a permission bar in the panel requests missing browser grants; privacy policy and Firefox data-collection declaration.
- **Command-line host `enclave-harness`** (`cli/`, command `enclave`): `enclave list`, `run` (terminal approvals, `--yes`, `--no-approvals`), `repro`, `validate`, `export`, `models`, `probe`, `conformance` and `grounding`, against the current directory with the same engine and tools.
- **Portable harness documents**: export and import as `.harness.json` with format version and plugin requirements, a Markdown **playbook** for coding agents that cannot execute the definition, and a **CWL** export (a generic Python runner tool plus one CWL step per harness step) that runs under `cwltool`. Format reference in `docs/harness-schema.md`.
- **Run in a container**: a harness is compiled to CWL and executed with `cwltool` inside Podman. Dependency analysis of `run-command` steps and manifest files produces a Containerfile; a confirmation states what is built, mounted and reachable; `output.txt` and `run_record.json` land in `.continued/harness-runs/`. Settings `continued.container.podmanPath`, `continued.container.outputDir`, `continued.container.extraPackages`.
- **Reproducibility instrument**: `repro` runs a harness *N* times per model and reports structural stability, per-step output stability and approval determinism; records and a Markdown report are written per run.
- **Contract conformance suite**: adversarial cases (forbidden commands, mutations, path traversal, declined steps under retry policies, injected instructions) run through a host with a stub model under both approval modes, with the expected outcome checked mechanically.
- **Grounding check**: quotations and numbers in an LLM step's output are looked up in the outputs of the read steps before it; the unfound ones are listed.
- **Model tools** `model-catalog` and `model-probe` (read-only, send only fixed prompts) and the built-in harness **Blablador: which model should I use?**, which probes every model a token can reach in parallel and writes a comparison.
- **Model picker** with search, grouping by provider and per-model details (parameters, quantisation, context window).
- **Long-running agent runs**: model calls are streamed and bounded by silence rather than a fixed clock (`continued.agent.modelStallTimeoutMs`, default 90 s) under a hard cap (`modelTimeoutMs`, now 10 min); a timeout, stall or dropped connection is retried once; a wall-clock budget per run (`continued.agent.maxRunMinutes`, default 4 h, approval waits excluded, `0` = off); a step limit (`maxIterations`, default 500, `0` = off); a stop after `continued.agent.maxConsecutiveFailures` failed, blocked or declined actions in a row (default 4).
- **Steering a run**: a message sent while the agent works reaches it as a note at its next step; switching the mode dropdown applies from the next action on, and switching to Auto-Edit answers a prompt on screen that Auto-Edit would not have asked.
- **Documentation site** (`documentation/`, Nuxt Content) deployed to GitHub Pages by `.github/workflows/docs.yml`.
- **Tests**: 175 unit tests covering the action parser, guardrails, harness engine, portable documents, CWL export, container plan, reproducibility metrics, conformance, grounding, model bench and the model picker (`npm run test:unit`).

### Changed
- The agent action protocol (`core/agentActions.ts`), harness engine (`core/harness/`) and sidebar UI (`core/ui/`) are shared by all hosts; the editor-specific copies under `src/` were removed.
- Harness LLM steps default to a 10-minute timeout; other steps keep 120 s. Time at an approval prompt is never counted.
- Default limits: model call cap 120 s → 600 s, steps per run 20 → 500, plus the new 4-hour time budget.
- Attachments are listed by name in the agent's task line while their contents stay in the user message, so a large attachment is not sent twice. A PDF attached in VS Code is declined with a note (text extraction runs in the browser host only).
- `bundle.sh` builds the VSIX, the CLI tarball and both browser zips into `artifacts/` and cleans intermediates; `--vsix-only` skips the other hosts.

### Fixed
- An agent run ended on the first model timeout; a slow model that was still generating was cut off at 120 s.
- Time spent waiting for an approval counted against the run.
- A mode change in the dropdown had no effect on a run already in progress.
- Settings on the browser options page took effect only after Save; permission checkboxes now apply immediately and Save also requests the browser's site access.
- Browser: unreadable model dropdown in the light theme; model-listing failures were silent (now logged and explained in the panel, with a one-click grant for missing site access); a notice posted before the session restore was wiped; Firefox local PDFs fail fast with a clear message (Firefox blocks every route an extension has to them; attach the file instead).
- The agent could go looking online for a local file it was not allowed to read; it is now told to ask for the file to be attached instead.

## [1.0.1] - 2026-09-07

### Added
- 🧩 Harness view: build workflows visually from tools, resources, skills and LLM steps (sequential, parallel, for-each), with per-step error policies, retries, timeouts and conditions; run them live with per-step status, stop, and approvals by mode
- Harness engine (`src/harness/`) with unit tests; harnesses are stored in `.continued/harnesses/*.json` and registered as skills for the agent (`use-skill` with input) and chat (`/harness <id>`)
- Five built-in harnesses: workspace health check (parallel lanes), explain active file, review TODOs, run tests and explain failures, annotate matching files
- Flow-canvas builder: (+) insert slots with a searchable menu, click-to-edit properties panel, drag-and-drop, parallel lanes, one-click parallelise, live run status on nodes; new `sequence` step type
- Plugin tools now declare their arguments, used by the harness builder; `readOnly` tools skip approval prompts and `touches()` lets mutating tools join the Agent Changes revert panel
- New built-ins — tools: list-directory, file-info, edit-file (find & replace), append-file, move-file, copy-file, make-directory, csv-preview, json-query, git-info, python-run (opt-in), http-fetch (opt-in); resources: project-info, git-summary, diagnostics, open-editors, dev-environment, system-info; skills: project-snapshot, largest-files
- Plan mode with Execute Plan / Edit Plan
- Agent Changes review panel with per-file and bulk Keep / Revert
- Agent access to enabled user plugins via `use-tool`, `use-resource`, `use-skill`
- Working plugin create modal, Edit / Delete for user plugins, Reload and Folder buttons
- File attachments are passed to the model as context
- Settings: `continued.ollama.baseUrl`, `continued.agent.*` (iterations, timeouts, context budget)
- Agent loop defenses for weak models: progress ledger in every prompt, refusal of writes to files not read in the run (current content handed back), one-time challenge of completion claims with no successful change, `Not verified` label on unbacked final answers, recovery from empty and reasoning-only replies
- `Continued` output channel logging every model call, raw reply, finish reason and tool result
- Unit tests for the action parser, guardrails and harness engine (41 tests, `npm run test:unit`)
- Marketing site in `continued-web/` and Marketplace / Open VSX badges in the README

### Changed
- Agent loop rebuilt around typed actions (`src/agentActions.ts`); provider calls moved to `src/llmClient.ts`
- Guardrails are enforced on every action; risky commands require approval even in Auto-Edit
- Read-only actions run without approval prompts in Agent mode
- JSON mode requested from providers that support it (Ollama, OpenAI, Gemini, Blablador with automatic fallback)

### Fixed
- Code fences inside file contents were stripped before writing
- Cancel did not stop the agent loop; Deny left the UI locked
- Send button stayed disabled after Chat replies, `/plugins` commands and provider errors
- Disabling a built-in plugin did not persist
- Agent sessions were titled "Session"
- Shell commands assumed `/bin/bash` on Windows

## [1.0.0] - 2026-07-19

### Added
- Plugin architecture for user-defined tools, resources, and skills
- Plugin Manager UI with checkbox-based enable/disable controls
- Built-in file, search, terminal, and workspace resource plugins
- Auto-loading user plugins from `.continued/plugins/`
- Workspace-scoped plugin enablement persistence

### Changed
- Promoted Continued to a stable extensible agent platform
- Expanded release documentation for plugin development and usage

### Stability
- Kept existing chat, agent, and provider workflows backward compatible
