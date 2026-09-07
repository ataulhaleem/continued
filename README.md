# Continued

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/AtaUlHaleem.continued?label=VS%20Marketplace&color=6d8bff)](https://marketplace.visualstudio.com/items?itemName=AtaUlHaleem.continued)
[![Marketplace installs](https://img.shields.io/visual-studio-marketplace/i/AtaUlHaleem.continued?label=installs)](https://marketplace.visualstudio.com/items?itemName=AtaUlHaleem.continued)
[![Open VSX](https://img.shields.io/open-vsx/v/AtaUlHaleem/continued?label=Open%20VSX&color=38d9c7)](https://open-vsx.org/extension/AtaUlHaleem/continued)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/AtaUlHaleem/continued?label=downloads)](https://open-vsx.org/extension/AtaUlHaleem/continued)
[![License: MIT](https://img.shields.io/badge/license-MIT-4ade80)](LICENSE)

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AtaUlHaleem.continued) · [Open VSX](https://open-vsx.org/extension/AtaUlHaleem/continued) (VSCodium, Cursor, code-server, Gitpod, Theia) · `code --install-extension AtaUlHaleem.continued`

**Continued** is an elite AI coding assistant built directly into your VS Code sidebar. It orchestrates a seamless multi-model experience by combining local offline LLMs with advanced cloud providers to assist you with conversational chat, file creation, and precise repository modifications.

---

## Features

* **Multi-provider model hub:** Local Ollama models (e.g. `llama3`) side by side with OpenAI, Gemini, Anthropic and the Helmholtz **Blablador** gateway. Pick any model from the sidebar dropdown.
* **Four modes:**
  * **💬 Chat** — streaming conversation, no tools.
  * **🤖 Agent** — an autonomous loop that reads, searches, writes, deletes and runs commands. Read-only steps run automatically; every write, delete, command and plugin call asks for your approval first.
  * **⚡ Agent Auto-Edit** — the same loop, but changes are applied immediately and collected in an **Agent Changes** panel where each file can be kept or reverted. Risky shell commands (`rm -r`, `git push`, `git reset --hard`, redirects, …) still ask.
  * **📋 Plan** — the model writes a numbered plan first; one click hands the plan to the agent for execution.
* **Extensible plugin platform:** Enabled tools, resources and skills from `.continued/plugins/` are offered to the agent as actions (`use-tool`, `use-resource`, `use-skill`) and can be invoked in chat with `/tool`, `/resource` and `/skill`.
* **Guardrails:** Destructive commands (`sudo`, `rm -rf /`, `mkfs`, `curl | sh`, …) and sensitive paths are blocked before execution, paths are confined to the workspace, secrets are masked in command output, and every run has an iteration cap.
* **Context you control:** Attach text files to a message with 📎, and the active editor file is always passed along.
* **Secure credentials:** Cloud provider keys live in VS Code's encrypted `SecretStorage`.

---

## How the agent works

Each agent turn the model replies with exactly one JSON action. Continued executes it, feeds the result back, and repeats until the model replies with `final-answer`:

```json
{"action":"read-file","path":"src/app.ts"}
{"action":"write-file","path":"src/app.ts","content":"...full file..."}
{"action":"delete-file","path":"old.txt"}
{"action":"semantic-search","query":"src/**/*.ts"}
{"action":"grep-search","query":"TODO","filePattern":"**/*.ts"}
{"action":"run-command","command":"npm test"}
{"action":"use-tool","tool":"<plugin-id>","args":{}}
{"action":"use-resource","resource":"<plugin-id>"}
{"action":"use-skill","skill":"<plugin-id>"}
{"action":"final-answer","message":"What I did"}
```

The parser is tolerant: JSON wrapped in prose or code fences, `<think>` blocks, function-call style shapes and the older `<write_file>` tags are all understood. Where the provider supports it (Ollama, OpenAI, Gemini) the request is sent in JSON mode for extra reliability.

Tool results that start with `BLOCKED`, `FAILED` or `DECLINED` are sent back to the model so it can choose a different approach instead of silently stopping.

---

## Harnesses: visual workflows

Open the 🧩 **Harness** view to build and run fixed workflows out of your plugins and model calls. Where the agent decides what to do next, a harness runs exactly the steps you designed, in the order you designed them, and the model is only consulted where you put an LLM step.

The **Builder** is a flow canvas: Start → nodes → End. Click any **+** on a connector to insert a step there (with a searchable menu of tools, resources, skills, LLM, parallel, for-each and sequence), click a node to edit it in the properties panel, drag nodes onto any **+** to move them, press **⇶** on a node to run it in parallel with a new step, and use **+ lane** to add branches. While a harness runs, the nodes on the canvas light up with their status.

**Step types**

| Type | What it does |
| --- | --- |
| Tool | Runs a tool plugin with arguments (built-in or yours). Mutating tools follow the mode's approval rules and land in Agent Changes. |
| Resource | Fetches a resource plugin. |
| Skill | Runs a skill plugin or another harness, with an optional input. |
| LLM | Asks the model. It is briefed with every earlier step's status, output and error and told never to invent missing data. `Expect: JSON` validates the reply and retries once. |
| Parallel | Runs its lanes at the same time. A lane is one step, or a Sequence for several. |
| Sequence | Groups steps that run in order; its output is the last successful step. |
| For each | Runs its children once per item of a list, e.g. `{{steps.find.lines}}`. |

**Error handling per step**: *Stop* (default), *Continue*, *Retry then stop*, *Retry then continue*, with retries, a timeout, and a *Run only when* condition such as `{{steps.tests.status}} == failed`. Unresolved `{{variables}}` fail the step with a clear message instead of silently becoming empty.

**Variables**: `{{input}}`, `{{item}}`, `{{index}}`, `{{activeFile}}`, `{{selection}}`, `{{workspace}}`, `{{steps.<id>.output}}`, `{{steps.<id>.status}}`, `{{steps.<id>.error}}`, `{{steps.<id>.lines}}`, `{{steps.<id>.json.<key>}}`.

Harnesses are saved as JSON in `.continued/harnesses/` and registered as skills, so the agent can call them (`{"action":"use-skill","skill":"<id>","input":"..."}`) and you can run one from chat with `/harness <id> <input>`. Five built-in harnesses ship as examples; duplicate one to start from it. **Workspace health check** is the one to look at first: four lanes run in parallel (a multi-step git lane with its own LLM step, a TODO/FIXME grep, a test-file search and the file inventory), each with its own error policy, and a final LLM step turns them into a report that states plainly which checks failed. The Run tab shows each step live and lets you stop the run.

---

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `continued.ollama.baseUrl` | `http://localhost:11434` | Ollama server for local models and inline completion |
| `continued.agent.maxIterations` | `20` | Steps per agent run before it pauses |
| `continued.agent.modelTimeoutMs` | `120000` | Timeout for one model call in agent mode |
| `continued.agent.commandTimeoutMs` | `60000` | Timeout for shell commands run by the agent |
| `continued.agent.maxContextChars` | `80000` | History budget sent to the model (lower it for small local models) |
| `continued.agent.maxHistoryMessages` | `40` | Recent messages kept in the prompt |
| `continued.agent.maxToolOutputChars` | `40000` | Cap for `read-file` results returned to the model |

---

## Community Launch (v1.0.0 Stable)

`v1.0.0` marks Continued's stable, community-oriented plugin platform release.

### What's New

* Extensible plugin system with `tools`, `resources`, and `skills`
* Built-in plugin suite for file, search, terminal, and workspace context operations
* Plugin Manager UI with checkbox enable/disable
* In-UI creation for user plugins under `.continued/plugins/`
* User plugin actions: `Edit` and `Delete`

### Community First

* Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md)
* Issue templates are included for bug reports, feature requests, and plugin showcases
* User plugins are workspace-local and can be versioned with your project

---

## Workspace Settings & Configurations

Continued allows you to switch between model endpoints directly from the sidebar. Tap the **⚙️ (Settings Gear Icon)** at the top of the panel to bring up the Provider Registration panel.

### Setting up Cloud Providers (Blablador)
To connect your Helmholtz Blablador remote workspace models:
1. Click the **⚙️** icon in the sidebar control row.
2. Input your **Personal Access Token** obtained via your Helmholtz Codebase profile.
3. The panel will automatically query the API endpoint (`https://api.blablador.fz-juelich.de/v1/models`) and cleanly populate your dropdown menu with prefix tags like `blablador/alias-code`.

---

## Commands

* `Continued: Add Cloud Provider` (`continued.addProvider`) — store an API key for OpenAI, Gemini, Anthropic or Blablador.
* `Continued: Refresh Model List` (`continued.refreshModels`) — re-query every configured provider.

## Writing plugins

Open the 🔌 Plugin Manager, press **+ Tool**, **+ Skill** or **+ Resource**, give it a name and a description (the description is what the agent sees), and a JavaScript file is created under `.continued/plugins/` and opened for editing. Plugins are plain CommonJS modules:

```js
module.exports.tool = {
    id: 'count-lines-tool',
    name: 'Count Lines',
    version: '1.0.0',
    description: 'Count the lines of a file. args: { path }',
    enabled: false,
    source: 'user',
    async execute(args) {
        const fs = require('fs');
        return { lines: fs.readFileSync(args.path, 'utf-8').split('\n').length };
    },
};
```

Add `readOnly: true` for inspection-only tools (no approval prompts) or `touches(args) { return [args.path]; }` for tools that change files (so they land in Agent Changes). Enable it with the checkbox, then either let the agent call it (`{"action":"use-tool","tool":"count-lines-tool","args":{"path":"README.md"}}`) or call it yourself with `/tool count-lines-tool {"path":"README.md"}`. Use **↻ Reload** after editing a plugin file. See [PLUGIN_QUICK_START.md](PLUGIN_QUICK_START.md) for resources and skills.

## Built-in plugins

| Kind | Id | What it does |
| --- | --- | --- |
| tool | `read-file`, `write-file`, `delete-file` | Core file actions (also exposed as dedicated agent actions) |
| tool | `semantic-search`, `grep-search`, `open-file` | Find files by glob, search text, open a file at a line |
| tool | `run-command` | Shell command in the workspace root, guarded |
| tool | `list-directory`, `file-info` | Directory tree with sizes; size, line/word count, language and head of a file *(read-only)* |
| tool | `edit-file` | Find & replace inside a file (exact once, all, or regex) instead of rewriting it |
| tool | `append-file`, `move-file`, `copy-file`, `make-directory` | Small file operations, all revertable from Agent Changes |
| tool | `csv-preview`, `json-query` | Columns, row count and numeric stats of a CSV/TSV; dot-path lookup in JSON *(read-only)* |
| tool | `git-info` | status, diff, log, branches, show *(read-only)* |
| tool | `python-run`, `http-fetch` | Run a Python snippet/script; GET a public URL as text. **Disabled by default**, enable in Plugin Manager |
| resource | `workspace-files`, `project-info` | File inventory; detected manifests, package manager, scripts, dependencies, languages |
| resource | `git-summary`, `diagnostics`, `open-editors` | Branch/status/commits; current errors and warnings; open files, cursor and selection |
| resource | `dev-environment`, `system-info` | Installed toolchains with versions; OS, CPU, memory, Node, VS Code |
| skill | `project-snapshot-skill` | One Markdown report: project, git, problems, system |
| skill | `largest-files-skill` | Largest files in the workspace, e.g. `/skill largest-files-skill 30 .ts` |

Read-only tools never prompt for approval. Tools that change files declare which paths they touch, so their changes appear in the Agent Changes panel and can be reverted. User plugins can use the same two flags: `readOnly: true` and `touches(args) { return [path] }`.

## Development

```bash
npm install
npm run compile      # type-check, lint, bundle to dist/
npm run test:unit    # mocha tests for the action parser and guardrails
./bundle.sh          # build versions/continued-<version>.vsix (add --install to install it into VS Code)
```

Press F5 in VS Code to launch an Extension Development Host with the sidebar.

---

## Prerequisites & Requirements

* **Local Inference:** To access local models offline, ensure you have [Ollama](https://ollama.com) running locally (`http://localhost:11434`) with at least one model pulled (e.g., `ollama pull llama3`).
* **Cloud Infrastructure:** A GitLab account registered with an EduGAIN or university network is required to claim your Blablador API token for remote usage.

---

## Release Notes

## 1.0.1

The release that turns Continued from a chat assistant with file tags into a full agent platform: a hardened autonomous loop, real guardrails, a change-review panel, a visual harness builder for workflows, and a much larger set of built-in plugins.

### Harnesses: visual workflows
- New 🧩 **Harness** view with three tabs: **Harnesses** (pick, run with input, edit, duplicate, delete, open JSON), **Builder**, and **Run**.
- The Builder is an n8n-style flow canvas: Start → nodes → End. Click **+** on any connector to insert a step from a searchable menu, click a node to edit it in a properties panel, drag nodes onto any **+** to move them, press **⇶** to run a node in parallel with a new step, and add branches with **+ lane**.
- Step types: **Tool**, **Resource**, **Skill** (including other harnesses), **LLM**, **Parallel** lanes, **Sequence** groups and **For each** loops, nested freely.
- Rigorous error handling per step: *Stop*, *Continue*, *Retry then stop*, *Retry then continue*, with retries, timeouts and *Run only when* conditions (`{{steps.tests.status}} == failed`). Unresolved `{{variables}}` fail the step with a clear message.
- LLM steps are briefed with every earlier step's status, output and error and told never to invent missing data; `Expect: JSON` validates the reply with one corrected retry.
- Mutating steps follow the mode's approval rules and land in Agent Changes. The Run tab shows each step live with attempts, elapsed time, errors and collapsible output, plus a Stop button; nodes on the canvas light up with their status.
- Harnesses are JSON in `.continued/harnesses/` and are registered as skills: the agent can call them with `use-skill` (with input), and `/harness <id> <input>` runs one from chat. Runs are recorded in the conversation.
- Five built-in examples, led by **Workspace health check** (four parallel lanes incl. a multi-step git lane with its own LLM step, then a report that states which checks failed).

### Built-in plugins (20 new)
- **File tools:** `list-directory`, `file-info`, `edit-file` (find & replace: exact-once, all, or regex), `append-file`, `move-file`, `copy-file`, `make-directory`.
- **Data tools:** `csv-preview` (auto delimiter, column types, numeric stats, sample rows), `json-query` (dot-path lookup or shape summary).
- **OS tools:** `git-info` (status, diff, log, branches, show), `python-run` and `http-fetch` (both **disabled by default**; enable in Plugin Manager).
- **Resources:** `project-info`, `git-summary`, `diagnostics` (VS Code's current errors and warnings), `open-editors`, `dev-environment` (22 toolchains probed), `system-info`.
- **Skills:** `project-snapshot-skill`, `largest-files-skill`.
- Plugins can declare `args` (rendered as fields in the harness builder and shown to the agent), `readOnly: true` (never prompts for approval) and `touches(args)` (paths the tool changes, snapshotted so the change is revertable).

### Agent loop
- Typed action protocol (`src/agentActions.ts`) with a tolerant parser: prose or fences around JSON, `<think>` blocks, raw newlines inside strings, function-call shapes, legacy XML tags. Fixed a bug that stripped code fences out of file contents the model wanted to write.
- Provider calls are deduplicated in `src/llmClient.ts` with line-buffered streaming, cancellation, and JSON mode on Ollama, OpenAI, Gemini and Blablador (with automatic fallback when a gateway rejects it).
- The current task, the workspace file list and a **progress ledger** (read, written, deleted, failed) are in every prompt, so multi-file tasks keep their place.
- **No blind overwrites:** a write to a file not read in this run is refused and the current content is handed back in the same result.
- **Completion is verified:** a `final-answer` with no successful change behind it, or after a failed action, is challenged once; if the model insists, the answer is labelled *Not verified* in the chat and in history so the claim does not poison later turns.
- Reasoning-only replies (models that stop after thinking) and empty replies get up to two correction rounds; hallucinated `[TOOL RESULT]` text is rejected.
- Read-only actions run without prompts in Agent mode; writes, deletes, commands and plugin calls ask. Deny feeds `DECLINED` back to the model. Cancel aborts the in-flight model call.
- Enabled user plugins are callable via `use-tool`, `use-resource` and `use-skill`; disabled built-ins vanish from the action list.
- Every model call, raw reply, finish reason and tool result is logged to the **Continued** output channel.

### Guardrails (now actually wired in)
- Forbidden commands and pipelines (`sudo`, `rm -rf /`, `curl | sh`, fork bombs, block-device writes, …) are blocked per pipeline segment; risky commands (`rm -r`, `git push`, `git reset --hard`, redirects, global installs, outbound POSTs) need approval even in Auto-Edit.
- File paths are confined to the workspace; sensitive locations are refused; secrets are masked in command output.
- Configurable iteration cap, model timeout, command timeout and context budget; a loop that repeats the same action is stopped.

### UI
- **Plan mode** writes a plan and offers **Execute Plan** / **Edit Plan**.
- **Agent Changes** panel lists every file the agent created, modified or deleted, with per-file and bulk **Keep** / **Revert**.
- Plugin Manager: working create modal (type, name, description, optional code), **Edit** / **Delete** for user plugins, **Reload** and **Folder** buttons, cards with id, source, description and harness badges.
- File attachments (📎) are sent to the model as context; write-approval cards show a content preview; the status line states the mode's permission policy at run start.

### Fixes
- Send button no longer stays locked after a Chat reply, a `/plugins` command, or a provider error.
- Disabling a built-in plugin now persists across reloads.
- Agent sessions get a real title instead of "Session".
- Ollama URL is configurable (`continued.ollama.baseUrl`) and shared by chat, agent, harnesses and inline completion.
- Shell commands no longer assume `/bin/bash` on Windows.

### Settings, tests, docs
- New settings under `continued.ollama.*` and `continued.agent.*` (see the Settings table above).
- 41 unit tests for the action parser, guardrails and harness engine: `npm run test:unit`.
- README rewritten; new marketing site in `continued-web/`; README badges for Marketplace and Open VSX.

---

## 1.0.0

### Stable Platform Release
- Introduced the extensible plugin architecture for tools, resources, and skills
- Added the Plugin Manager UI with checkbox-based enable/disable controls
- Registered built-in file, search, terminal, and workspace resource plugins
- Enabled user-defined plugins from `.continued/plugins/` with workspace-scoped persistence

### Documentation
- Added full plugin architecture, quick start, diagrams, and implementation summary guides

### Stability
- Continued now ships as a stable extensible agent platform rather than a monolithic chat-only assistant

---
## 0.0.7

### Bug Fixes
- Fixed `continued.refreshModels` command never being registered — saving a cloud provider API key now correctly triggers a model list refresh in the sidebar dropdown
- Fixed agent tool-tag leakage in chat bubbles (`<run_shell .../>`, `<write_file ...>`, `<delete_file ...>`) so users now see clean assistant responses
- Fixed command/tool-call responses not being properly restored after reload

### Inline Code Completion
- New `ContinuedCompletionProvider` registered for all file types, powered by whichever model is currently selected in the sidebar
- Sends up to 2000 chars of prefix context and 500 chars of suffix for fill-in-the-middle (FIM) support
- Works with local **Ollama** (`/api/generate`) and cloud providers (**Blablador**, **OpenAI**, **Gemini**, **Anthropic**)
- Cancels in-flight requests immediately when you continue typing

### Persistence & State Restore
- Last selected model is saved and automatically restored on next launch
- Last active chat session is saved and auto-loaded when VS Code is relaunched — picks up exactly where you left off
- Session history and model preference are now workspace-scoped (per opened folder/workspace), so chats no longer bleed across unrelated projects

### Provider Coverage
- Added OpenAI chat/model support (`openai/...`)
- Added Gemini chat/model support (`gemini/...`)
- Added Anthropic chat/model support (`anthropic/...`)

### Agent & Tooling UX
- Agent can execute shell commands via `<run_shell command="..."/>` with approval in Agent Mode and automatic execution in Agent Auto-Edit
- Shell command results are now presented as assistant-style narrative responses with compact tool-result notes
- Command results are persisted into session history and restored with formatting

### Chat UI Improvements
- Cleaner Markdown rendering for headings, lists, links, blockquotes, inline code, and fenced code blocks
- Removed the blue left accent stripe from assistant responses
- Modernized command approval prompt to a cleaner, compact style

---
## 0.0.4

## 0.0.3

### Visual & UX
- Modern glassmorphic UI with fluid animations and pill-shaped inputs
- Native VS Code scrollbar integration

### Model Management
- Dynamic model syncing - no restart required for credential updates
- Instant model list refresh after API key configuration

### Session Management
- Improved session caching with clean title generation
- Individual chat deletion with × button interface

### Stability
- Stream buffer optimization with line-buffering for SSE parsing
- Enhanced error handling for broken JSON packets


### 0.0.2
### 0.0.1
* Initial Release of the modularized core.
* Implemented the sidebar panel architecture containing historic chat session caching.
* Added multi-mode execution: **Chat**, **Agent**, and **Agent Auto-Edit**.
* Unified Local Ollama tags with OpenAI-compatible streaming endpoints from Blablador.

---

**Enjoy a frictionless assistant experience with Continued!**