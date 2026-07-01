# Continued

**Continued** is an elite AI coding assistant built directly into your VS Code sidebar. It orchestrates a seamless multi-model experience by combining local offline LLMs with advanced cloud providers to assist you with conversational chat, file creation, and precise repository modifications.

---

## Features

* **Dual-Engine Model Hub:** Access local Ollama instances (e.g., `llama3`) alongside remote high-performance cloud clusters via the **Blablador** API (such as `alias-code` or `alias-large`).
* **Agent Operations (File Auto-Editing & Deletion):** Shift your chat panel into **Agent Mode** or **Agent Auto-Edit** to empower the AI to dynamically generate file contents using `<write_file>` tags or clean up workspace paths with `<delete_file />` tags.
* **Safe Approval Gateway:** Maintain absolute control over your filesystem. In standard Agent Mode, every change or file destruction requires an explicit confirmation click in your sidebar before executing.
* **Transaction Rollbacks / Undo:** Did the model write an unwanted change? Use the built-in **Discard / Undo** loop to cleanly roll back the targeted file to its original snapshot instantly.
* **Secure Credential Allocation:** Cloud provider endpoint tokens are safely managed inside VS Code's OS-level encrypted `SecretStorage` keychain.

---

## Workspace Settings & Configurations

Continued allows you to switch between model endpoints directly from the sidebar. Tap the **⚙️ (Settings Gear Icon)** at the top of the panel to bring up the Provider Registration panel.

### Setting up Cloud Providers (Blablador)
To connect your Helmholtz Blablador remote workspace models:
1. Click the **⚙️** icon in the sidebar control row.
2. Input your **Personal Access Token** obtained via your Helmholtz Codebase profile.
3. The panel will automatically query the API endpoint (`https://api.blablador.fz-juelich.de/v1/models`) and cleanly populate your dropdown menu with prefix tags like `blablador/alias-code`.

---

## Extension Settings

This extension contributes the following internal command allocations:

* `continued.addProvider`: Invokes the secure user token setup modal.
* `continued.helloWorld`: Launches inline command box inputs inside active editors.

---

## Prerequisites & Requirements

* **Local Inference:** To access local models offline, ensure you have [Ollama](https://ollama.com) running locally (`http://localhost:11434`) with at least one model pulled (e.g., `ollama pull llama3`).
* **Cloud Infrastructure:** A GitLab account registered with an EduGAIN or university network is required to claim your Blablador API token for remote usage.

---

## Release Notes

## 0.0.5

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