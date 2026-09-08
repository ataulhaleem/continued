# Publishing the browser extension

Two stores, one build. `npm run zip` produces `continued-chrome-<version>.zip` and `continued-firefox-<version>.zip`; `npm run source-zip` produces the source archive Mozilla asks for.

## Before every release

1. Bump `version` in **both** `package.json` and `manifest.json` (stores reject re-uploads of the same version).
2. `npm run build` and load `dist/chrome` and `dist/firefox` once each; check the options page, a chat reply, an agent run that asks for approval, and a harness run.
3. `npm run zip` and `npm run source-zip`.
4. Tag the repo (`git tag browser-v0.1.0`) so the source zip matches a commit.

Assets that already exist in this folder: `store/store-icon-128.png`, `store/promo-small-440x280.png`, `store/promo-marquee-1400x560.png`. Still needed from you: **screenshots** (Chrome wants 1280×800 or 640×400, at least one; Mozilla accepts any size). Good subjects: the side panel answering a question about a page, an approval card, the harness canvas with *Compare open tabs*, the Run tab with lanes lit up.

The privacy policy both stores ask for is `PRIVACY.md` at the repo root — once pushed it is public at
`https://github.com/ataulhaleem/continued/blob/main/PRIVACY.md` (a styled copy is `continued-web/privacy.html` if you deploy the site).

---

## Chrome Web Store

1. **Developer account**: https://chrome.google.com/webstore/devconsole — one-time $5 registration fee, needs a Google account. Verify the email address.
2. **New item** → upload `continued-chrome-<version>.zip`.
3. **Store listing tab**
   - Name: Continued. Summary (132 chars max): *Local-first AI agent for your browser: reads and works with your tabs on Ollama or cloud models, with a visual workflow builder.*
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
2. **Submit a New Add-on** → *On this site* (listed) → upload `continued-firefox-<version>.zip`. The validator runs immediately; warnings about `browser_specific_settings` or CSP are informational, errors block.
3. **Source code**: because the extension ships bundled/minified JavaScript, answer **Yes** to "Do you need to submit source code?" and upload `continued-source-<version>.zip`. Reviewers rebuild it; the README's *Build and load* section plus these commands are the required build instructions:
   ```
   npm install
   npm run build        # output in dist/firefox
   ```
   State the Node version you used (`node --version`).
4. **Listing**: name, summary, description, categories (*Productivity*, *Developer Tools*), icon 128 px (`store/store-icon-128.png`), screenshots, support email or URL, privacy policy text (paste the policy or link to it), licence MIT.
5. Submit. Listed add-ons go through human review; the first submission of an add-on with `<all_urls>` and remote API calls usually takes a few days to a couple of weeks. Replies to reviewer questions happen in the Developer Hub.
6. **Unlisted alternative**: if you only want signed files to distribute yourself, choose *On your own* instead; signing is automatic and immediate, and users install the returned `.xpi`.

## Edge (optional, same zip as Chrome)

Microsoft Partner Center → Edge Add-ons → upload `continued-chrome-<version>.zip`. Free, same listing material, usually reviewed within a week.

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
