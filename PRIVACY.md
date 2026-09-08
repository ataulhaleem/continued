# Privacy policy

Applies to the Continued VS Code extension and the Continued browser extension (Chrome, Firefox). Last updated 8 September 2026.

**In one sentence:** Continued has no server, no account and no analytics. The only party that receives your data is the AI model provider you select, and with Ollama that is your own computer.

## What the extension does

Continued is an AI assistant. In VS Code it works on the files in your open workspace; in the browser it works on the tabs and pages you point it at. To do that it sends the text of your request, plus the context it needs (file contents, page text, tool results), to a language model and shows you the reply.

## Data that leaves your device

| Data | Sent to | Why |
| --- | --- | --- |
| Your prompts and the conversation history | The model provider you selected in the dropdown | To generate a reply |
| Workspace file contents (VS Code) or page text, selection, tab titles and URLs (browser) | The same provider, only for the files/pages the agent reads for your task | Context for the reply |
| Command output (VS Code) or fetched URL content (browser) | The same provider | Tool results the agent reasons about |
| API key | The provider it belongs to, as an authorization header | Authentication |

Providers you can choose: a local or self-hosted **Ollama** server (data stays on your machine or network), **OpenAI**, **Google Gemini**, **Anthropic**, and the Helmholtz **Blablador** gateway. Their handling of what they receive is governed by their own policies. Nothing is sent to any provider you have not configured, and nothing is sent to the developer of Continued.

## Data stored on your device

- **Chat sessions**, so you can return to them. VS Code: extension global storage. Browser: extension storage (`chrome.storage.local`).
- **Settings**: selected model and mode, Ollama URL, agent limits.
- **API keys.** VS Code stores them in the operating system keychain through VS Code's SecretStorage. The browser extension stores them in extension storage, which is **not encrypted**; the options page says so. Use Ollama if you prefer not to store a key.
- **Harness definitions** you create (workflow JSON).
- A diagnostic **log** of model calls and tool results, kept in memory (browser) or in the VS Code output channel, never transmitted.

Uninstalling the extension removes this data.

## Browser permissions and why they are needed

| Permission | Used for |
| --- | --- |
| Access to all websites (`<all_urls>`) | Reading the page you ask about and fetching URLs you give it; also lets the extension reach your Ollama server. Pages are accessed only when you run a request, never in the background. |
| `tabs`, `activeTab`, `scripting` | Listing tabs, reading the active page, and, with your approval, clicking, filling or navigating. |
| `storage` | Sessions, settings, keys, harnesses. |
| `sidePanel` / sidebar | Showing the assistant next to your pages. |
| `clipboardWrite` | The Copy buttons on code blocks. |

The extension injects no scripts into pages on its own, tracks no browsing, and never fills password fields.

## What Continued does not do

- No analytics, telemetry, crash reporting or usage statistics.
- No accounts, sign-in or developer-operated backend.
- No advertising and no sale or sharing of data with third parties.
- No remote code: all code ships inside the extension package.

## Children

Continued is a developer tool and is not directed at children under 13.

## Changes and contact

Changes to this policy are published on this page and noted in the changelog. Questions and requests: open an issue at https://github.com/ataulhaleem/continued/issues.
