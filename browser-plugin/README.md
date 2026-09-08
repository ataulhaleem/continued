# Continued for the browser

The Continued agent as a **Chrome side panel / Firefox sidebar** extension. Same sidebar UI, same harness engine and same providers as the VS Code extension; the difference is what the agent acts on. In the browser the workspace is your tabs: it reads pages, searches them, follows links, fetches URLs and, with approval, clicks, fills and navigates.

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

**Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `dist/firefox/manifest.json`. The sidebar opens automatically; `View → Sidebar → Continued` reopens it. For a persistent install, see [PUBLISHING.md](PUBLISHING.md).

Then open the options page (⚙️ in the panel) to point it at Ollama or paste a provider key. Because the extension has host permissions, Ollama needs no `OLLAMA_ORIGINS` change.

## Modes and permissions

| Action | Chat / Plan | Agent | Auto-Edit |
| --- | --- | --- | --- |
| read-page, find-in-page, get-selection, extract-links, list-tabs, fetch-url, scroll, wait, resources | not available | automatic | automatic |
| open-tab, navigate | not available | asks | automatic |
| click, fill | not available | asks | asks |
| Password fields, non-http(s) URLs, private network (unless enabled) | blocked | blocked | blocked |

## Harnesses

The 🧩 view is the same flow-canvas builder as in VS Code. Built-ins for the web: *Summarise this page*, *Compare open tabs* (parallel lanes over up to six tabs), *Research a list of URLs* (parallel fetch, then notes with sources), *Answer a question from this page*. Variables: `{{input}}`, `{{item}}`, `{{index}}`, `{{activeUrl}}`, `{{activeTitle}}`, `{{selection}}`, `{{date}}`, `{{steps.<id>.output|status|error|lines|json}}`. Harnesses are stored in extension storage; *JSON* shows the definition so you can copy it.

## Not in this build (by design)

- Files, shell commands and user plugin files: there is no filesystem in a browser extension. A native-messaging companion could add them later.
- Image attachments and screenshots.
- The Agent Changes revert panel: page actions cannot be undone generically, which is why clicks and form fills always ask.

## Development notes

- `npm run watch` rebuilds the background, shim and options bundles on change. The sidebar HTML is generated once per build; re-run `npm run build` after editing `src/ui/`.
- The background is a service worker in Chrome. The panel pings it every 20 s so long agent runs are not interrupted; state that must survive a restart lives in `chrome.storage`.
- Logs: options page → *Show log*, or the service worker console in `chrome://extensions`.
