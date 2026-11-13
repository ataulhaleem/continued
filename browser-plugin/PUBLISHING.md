# Publishing the browser extension

Two stores, one build. `npm run zip` produces `enclave-chrome-<version>.zip` and `enclave-firefox-<version>.zip` in `../artifacts/`; `npm run source-zip` produces the source archive Mozilla asks for, in the same folder.

The side panel's UI and the harness engine are shared with the VS Code extension and live in the repository's top-level `core/` folder, so the source archive contains both `core/` and `browser-plugin/`. Extract it and build from the `browser-plugin/` folder as usual.

## Before every release

1. Bump `version` in **both** `package.json` and `manifest.json` (stores reject re-uploads of the same version).
2. `npm run build` and load `dist/chrome` and `dist/firefox` once each; check the options page, a chat reply, an agent run that asks for approval, and a harness run.
3. `npm run zip` and `npm run source-zip`.
4. Tag the repo (`git tag browser-v<version>`) so the source zip matches a commit.

Assets that already exist in this folder: `store/store-icon-128.png`, `store/promo-small-440x280.png`, `store/promo-marquee-1400x560.png`. Still needed from you: **screenshots** (Chrome wants 1280×800 or 640×400, at least one; Mozilla accepts any size). Good subjects: the side panel answering a question about a page, an approval card, the harness canvas with *Compare open tabs*, the Run tab with lanes lit up.

The privacy policy both stores ask for is `PRIVACY.md` at the repo root — once pushed it is public at
`https://github.com/ataulhaleem/continued/blob/main/PRIVACY.md` (a styled copy is `continued-web/privacy.html` if you deploy the site).

---

## Chrome Web Store

1. **Developer account**: https://chrome.google.com/webstore/devconsole — one-time $5 registration fee, needs a Google account. Verify the email address.
2. **New item** → upload `enclave-chrome-<version>.zip`.
3. **Store listing tab**
   - Name: Enclave. Summary (132 chars max): *Local-first AI agent for your browser: reads and works with your tabs on Ollama or cloud models, with a visual workflow builder.*
   - Description: reuse the README's first paragraphs; mention Ollama, the four modes, harnesses, and that page changes ask for approval.
   - Category: Productivity → Developer Tools (or Productivity → Workflow & Planning).
   - Icon: `store/store-icon-128.png`. Screenshots: yours. Promo tiles: the two files in `store/`.
   - Language: English. Homepage and support URLs: the GitHub repo and its Issues page.
4. **Privacy practices tab** (this is what reviewers read most carefully)
   - Single purpose: *An AI assistant that answers questions about, and performs user-directed actions on, the pages in the user's browser.*
   - Permission justifications (copy, adjust wording if you change permissions):
     - `<all_urls>` / host permissions: *Reads the text of the page the user asks about and fetches URLs the user provides; also needed to reach the user's own Ollama server. Pages are accessed only when the user sends a request.*
     - `tabs`: *Lists open tabs so the user can ask about them and so the "compare tabs" workflow can read several tabs.*
     - `activeTab`, `scripting`: *Reads page text and, with explicit per-action approval, clicks, fills fields or navigates on behalf of the user.*
     - `storage`: *Saves chat sessions, settings, the user's API keys and user-created workflows locally.*
     - `sidePanel`: *Hosts the assistant UI.*
     - `clipboardWrite`: *Copy buttons on code blocks.*
   - Remote code: **No** (everything is bundled).
   - Data usage: tick *Website content* and *User activity* is not collected by the developer; state that data is sent only to the user-selected AI provider. Certify the three data-use statements.
   - Privacy policy URL: `https://github.com/ataulhaleem/continued/blob/main/PRIVACY.md`.
5. **Distribution**: Public, all regions. Submit for review. Reviews for extensions with `<all_urls>` typically take a few days; the reviewer may ask for a demo video or clearer justifications, which is normal.
6. After approval, badge for the site: `https://img.shields.io/chrome-web-store/users/<item-id>`.

## Firefox Add-ons (AMO)

1. **Account**: https://addons.mozilla.org → Developer Hub → sign in with a Mozilla account. Free.
2. **Submit a New Add-on** → *On this site* (listed) → upload `enclave-firefox-<version>.zip`. The validator runs immediately. Expected result: 0 errors; since 0.3.0 four warnings come from the bundled, unmodified pdf.js (two `new Function` feature probes wrapped in try/catch and two `import()` calls that never run because the worker module is registered on `globalThis.pdfjsWorker`) plus the Android min-version notice (the build rewrites the UI's `innerHTML` assignments to a DOMParser helper, which is what the linter's *Unsafe assignment to innerHTML* check wants). Errors block; if a warning appears after a UI change, check `rewriteInnerHtml` in `build.mjs`.
   - The manifest declares `data_collection_permissions: { required: ["websiteContent", "websiteActivity"] }`. Firefox 140+ shows this to users as a consent prompt at install. It is accurate: page text, tab titles and URLs are sent to the AI provider the user selected, and to nobody else. Do not change it to `none`; that would be a false declaration. Since 0.3.1 this also covers `file://` tabs, but only after the user switches on *Read local files opened in the browser* in the options page (off by default) and the browser grants file access; the privacy policy has a row for it.
   - **Notes to reviewer** (paste into the "Notes for Reviewers" box): *The bundle includes pdfjs-dist (Mozilla's pdf.js, published minified legacy build, unmodified) to read the text of a PDF the user has open; it runs in-process; the linter's DANGEROUS_EVAL and import() warnings point into that library: the Function-constructor probes are wrapped in try/catch and fall back under our CSP, and the dynamic import is short-circuited because the worker module is bundled and registered on globalThis.pdfjsWorker. Markup in the side panel is generated by a small Markdown renderer from HTML-escaped text and inserted via DOMParser (`__setHTML` in shim.js); no user-controlled markup reaches the DOM unescaped and the CSP is `script-src 'self'`. The extension transmits data only to the AI provider the user configures in the options page (Ollama on the user's own machine by default); there is no developer backend. Reading `file://` tabs is an opt-in setting (off by default) that additionally requires the browser's own file-access grant; the agent cannot navigate to or fetch file URLs on its own (only http and https are accepted by its URL policy). Source is in the `browser-plugin/` folder of the linked repository, with shared UI and workflow-engine modules in the top-level `core/` folder; both are in the uploaded source archive. Build with `cd browser-plugin && npm ci && npm run build` (output `dist/firefox`).*
3. **Source code**: because the extension ships bundled/minified JavaScript, answer **Yes** to "Do you need to submit source code?" and upload `enclave-source-<version>.zip`. Reviewers rebuild it; the README's *Build and load* section plus these commands are the required build instructions:
   ```
   npm install
   npm run build        # output in dist/firefox
   ```
   State the Node version you used (`node --version`).
4. **Listing**: name, summary, description, categories (*Productivity*, *Developer Tools*), icon 128 px (`store/store-icon-128.png`), screenshots, support email or URL, privacy policy text (paste the policy or link to it), licence MIT.
5. Submit. Listed add-ons go through human review; the first submission of an add-on with `<all_urls>` and remote API calls usually takes a few days to a couple of weeks. Replies to reviewer questions happen in the Developer Hub.
6. **Unlisted alternative**: if you only want signed files to distribute yourself, choose *On your own* instead; signing is automatic and immediate, and users install the returned `.xpi`.

## Edge (optional, same zip as Chrome)

Microsoft Partner Center → Edge Add-ons → upload `enclave-chrome-<version>.zip`. Free, same listing material, usually reviewed within a week.

## What the AMO listing page shows, and why

- **Green puzzle-piece icon.** AMO takes the listing icon from the *Edit listing → Basic information* form, not from the manifest. Upload `store/store-icon-128.png` there once; it persists across versions.
- **"Some features may require payment" badge.** This is the *Requires payment or non-free services* checkbox under *Edit listing → Additional details*. It was ticked at first submission. The extension is fully usable at no cost with Ollama or Blablador, and paid providers are optional and bring-your-own-key, so the honest setting is **unticked**. Untick it and save; the badge disappears within the hour.
- **"Download the new Firefox and get the extension" instead of "Add to Firefox".** Shown to any visitor whose Firefox is older than the manifest's `strict_min_version` (140, the release that understands the data-collection consent declaration). Not a listing problem.
- **"This add-on is not actively monitored for security by Mozilla."** Standard on every add-on outside Mozilla's *Recommended* programme. Nothing to change.
- **Not found by search.** AMO search indexes a listing only after its first version is approved and the search index has been rebuilt, which can take up to a day, and it ranks by users and ratings. A direct URL working while search does not is the normal state for a new listing with no users yet. Tags and a summary that contain the words people search for (below) are the part you control.

### Listing text for 0.2.0

Paste into *Edit listing*:

- **Summary** (250 chars max): *Local-first AI agent in your sidebar. Runs on Ollama on your own machine or the Blablador endpoint at Jülich Supercomputing Centre; reads and works with your tabs with approval; builds workflow-harnesses you can export to CWL.*
- **Tags**: ai, ollama, local llm, privacy, blablador, sidebar, workflow
- **Categories**: Productivity; Privacy & Security
- **Release notes for 0.3.0** (0.2.x were never published; this supersedes them):
  - The extension is now called Enclave. The add-on ID (`continued@ataulhaleem.github.io`) is unchanged, so existing installs update in place; change the AMO slug from `continued` to `enclave` under Edit listing.
  - PDFs: a tab showing a PDF is now read as text, page by page, with pdf.js. Every harness that reads the page works on a web article or a PDF alike; a new `read-pdf` tool takes a page range.
  - Four built-in harnesses for researchers: *Extract quantitative results* (table + CSV of every reported value with unit, uncertainty, n, condition and source sentence), *Answer a question from this article* (whole text, quotes with page markers), *Referee-style review* (four parallel lanes merged into a structured report with recommendation), *Compare two articles* (two tabs, side-by-side digest, agreements and contradictions).
  - Markdown tables now render as tables in replies and harness output.
  - Long documents no longer get silently cut off with Ollama: the context window is sized to the request.
  - New built-in harness *Blablador: which model should I use?* — lists the models your token can reach, probes all of them in parallel with four mechanically checked micro-tasks (plus your own task), and writes a comparison with a recommendation per use and links to the Blablador documentation.
  - New read-only tools `model-catalog` and `model-probe` behind it; they send only fixed prompts, never page content.
  - Harness export as portable JSON, Markdown playbook for other coding agents, and Common Workflow Language (workflow + job file); import of `.harness.json`.
  - Searchable model picker with per-model detail; approval requests are queued instead of dropped; network tools always ask.
  - A model step now sees every earlier step's output in an export, exactly as inside the extension.

## Updating

Bump the version, rebuild, re-zip, upload the new zip in each dashboard. Chrome and Mozilla review updates again but typically faster. Users receive updates automatically.

## Common rejection reasons and how this build avoids them

| Reason | Status |
| --- | --- |
| Inline scripts / `eval` | None; UI scripts are files, CSP is `script-src 'self'`. |
| Remote code loading | None. |
| Unjustified broad host permissions | Justified above; page access only on user request. |
| Missing privacy policy | `PRIVACY.md` in the repo root (public once pushed). |
| Minified code without source (Mozilla) | `npm run source-zip`. |
| Icons missing | `icons/` in both manifests. |
| Firefox-only keys in Chrome manifest (or vice versa) | The build writes separate manifests. |
