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