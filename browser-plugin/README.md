# Enclave for the browser

The Enclave agent (formerly Continued) as a **Chrome side panel / Firefox sidebar** extension. Same sidebar UI, same harness engine and same providers as the VS Code extension; the difference is what the agent acts on. In the browser the workspace is your tabs: it reads pages, searches them, follows links, fetches URLs and, with approval, clicks, fills and navigates.

Nothing in this folder touches the VS Code extension. The shared pieces are copies under `src/core/` and `src/ui/`.

## What's inside

| Path | Role |
| --- | --- |
| `src/core/` | Copies of the pure modules: action parser, harness engine and types, plus a browser variant of the LLM client (secrets injected, no VS Code API). |
| `src/ui/` | Copies of the sidebar UI (`chatView.ts`, `layout.ts`, `styles.ts`, `harnessView.ts`), unchanged, plus `theme.css` mapping `--vscode-*` variables to browser colours. |
| `src/background/` | The backend: sessions, chat / agent / plan flows, approvals, the harness host, browser tools and resources, storage. |
| `src/sidepanel/shim.ts` | Makes `acquireVsCodeApi()` exist and bridges `postMessage` to a runtime port, so the UI runs unmodified. |
| `src/options/` | Options page: Ollama URL, provider keys, agent limits, log viewer. |
| `manifest.json` | Base Manifest V3; the build writes a Chrome variant (`side_panel`, service worker) and a Firefox variant (`sidebar_action`, event page). |
| `src/icons/`, `store/` | Extension icons and Chrome Web Store promo images (generated). |
| `PUBLISHING.md` | Step-by-step store submission checklist. |
| `build.mjs` | esbuild pipeline; also splits the UI's inline scripts into files for the extension CSP. |

## Build and load

```bash
cd browser-plugin
npm install
npm run build          # → dist/chrome and dist/firefox
```

**Chrome / Edge / Brave:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick `browser-plugin/dist/chrome`. Click the toolbar icon to open the side panel.

**Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `dist/firefox/manifest.json`. The sidebar opens automatically; `View → Sidebar → Enclave` reopens it. A temporarily loaded Manifest V3 add-on gets **no site access** from Firefox, so cloud model lists and requests fail until you grant it: press *Grant site access* in the bar that appears at the top of the side panel (or on the options page, ⚙️, where every field saves itself as you change it), or allow *Access your data for all websites* under `about:addons → Enclave → Permissions`. The side panel says so when a configured provider returns no models. For a persistent install, see [PUBLISHING.md](PUBLISHING.md).

Then open the options page (⚙️ in the panel) to point it at Ollama or paste a provider key. Because the extension has host permissions, Ollama needs no `OLLAMA_ORIGINS` change.

## Modes and permissions

| Action | Chat / Plan | Agent | Auto-Edit |
| --- | --- | --- | --- |
| read-page, find-in-page, get-selection, extract-links, list-tabs, fetch-url, scroll, wait, resources | not available | automatic | automatic |
| open-tab, navigate | not available | asks | automatic |
| click, fill | not available | asks | asks |
| Password fields, non-http(s) URLs, private network (unless enabled) | blocked | blocked | blocked |
| Local files open in a tab (`file://`), unless *Read local files* is enabled | blocked | blocked | blocked |

## Harnesses

The 🧩 view is the same flow-canvas builder as in VS Code. A tab showing a **PDF** is read as text (pdf.js, page by page), so every harness below works on a web article or a PDF alike. Built-ins for researchers: *Extract quantitative results* (every reported value with unit, uncertainty, n, condition and the sentence it comes from, as a table and CSV), *Answer a question from this article* (whole text, quotes with page markers, says when the answer is not there), *Referee-style review* (four parallel lanes — claims, methods and statistics, evidence and reproducibility, presentation — merged into a structured report), *Compare two articles* (two tabs, same digest structure, side-by-side table with agreements and contradictions). Other built-ins: *Blablador: which model should I use?* (lists the models your token can reach, probes all of them in parallel with four mechanically checked micro-tasks plus your own task, and writes a comparison with links to the Blablador documentation), *Summarise this page*, *Compare open tabs* (parallel lanes over up to six tabs), *Research a list of URLs* (parallel fetch, then notes with sources), *Answer a question from this page*. The two model tools behind the first one, `model-catalog` and `model-probe`, are read-only: they send only the fixed prompts and your task, never page content. Variables: `{{input}}`, `{{item}}`, `{{index}}`, `{{activeUrl}}`, `{{activeTitle}}`, `{{selection}}`, `{{date}}`, `{{steps.<id>.output|status|error|lines|json}}`. Harnesses are stored in extension storage. *JSON* downloads the portable `.harness.json` (importable here or in the VS Code extension), *Playbook* a Markdown version for other coding agents, and *CWL* a Common Workflow Language document plus job file; *Import* reads a `.harness.json` back. Running in a container is a VS Code feature, since a browser extension cannot drive Podman.

## Not in this build (by design)

- Files, shell commands and user plugin files: there is no filesystem in a browser extension. A native-messaging companion could add them later. The one exception is opt-in: with *Read local files opened in the browser* switched on in the options page, `read-page` can read a `file://` tab you opened yourself (HTML or text in both browsers; a PDF only in Chrome, where the bytes are read through the side panel page once *Allow access to file URLs* is on. Firefox blocks every route to a local PDF, both `file://` fetches and scripts in its PDF viewer, so there a local PDF is attach-only). A PDF attached in the chat with the 📎 button is read page by page in both browsers, with no setting needed, and the agent is told to answer from attached text rather than re-reading the tab. The agent still cannot open file URLs itself, and the browser must grant file access too (Chrome: *Allow access to file URLs* on the extension's details page; Firefox: the host-permission grant).
- Image attachments and screenshots.
- The Agent Changes revert panel: page actions cannot be undone generically, which is why clicks and form fills always ask.

## Development notes

- `npm run watch` rebuilds the background, shim and options bundles on change. The sidebar HTML is generated once per build; re-run `npm run build` after editing `src/ui/`.
- The background is a service worker in Chrome. The panel pings it every 20 s so long agent runs are not interrupted; state that must survive a restart lives in `chrome.storage`.
- Logs: options page → *Show log*, or the service worker console in `chrome://extensions`.
