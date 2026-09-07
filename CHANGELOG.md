# Change Log

All notable changes to the "continued" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
