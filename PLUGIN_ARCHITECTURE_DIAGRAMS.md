# Plugin Architecture Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  VS Code Extension Host                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          Continued Extension (v0.0.7)               │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │   chatViewProvider.ts (Main Extension)      │     │   │
│  │  │                                              │     │   │
│  │  │  ┌──────────────────────────────────────┐   │     │   │
│  │  │  │  PluginRegistry                      │   │     │   │
│  │  │  │  ├─ registerTool()                   │   │     │   │
│  │  │  │  ├─ registerResource()               │   │     │   │
│  │  │  │  ├─ registerSkill()                  │   │     │   │
│  │  │  │  ├─ togglePlugin()                   │   │     │   │
│  │  │  │  └─ getEnabledXXX()                  │   │     │   │
│  │  │  └──────────────────────────────────────┘   │     │   │
│  │  │                                              │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                                                       │   │
│  │  ┌──────────────────────────────────────────────┐    │   │
│  │  │     Plugin Loading System                    │    │   │
│  │  │                                              │    │   │
│  │  │  Built-in Plugins          User Plugins     │    │   │
│  │  │  ├─ fileTools.ts           .continued/      │    │   │
│  │  │  ├─ searchTools.ts         └─ plugins/      │    │   │
│  │  │  ├─ terminalTools.ts       ├─ tool1.ts     │    │   │
│  │  │  └─ load on init()         └─ tool2.ts     │    │   │
│  │  │                            auto-discover   │    │   │
│  │  └──────────────────────────────────────────────┘    │   │
│  │                                                       │   │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │     chatView.html (Webview UI)                       │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  Plugin Manager Tab                         │     │   │
│  │  │  ─────────────────────────────────────────  │     │   │
│  │  │  [🔌 Back]  7 plugins enabled               │     │   │
│  │  │                                              │     │   │
│  │  │  TOOLS                                       │     │   │
│  │  │  ├─ [✓] read_file v1.0.0                     │     │   │
│  │  │  │   Read file contents                      │     │   │
│  │  │  │   🔨 BUILT-IN                             │     │   │
│  │  │  │                                            │     │   │
│  │  │  ├─ [✓] write_file v1.0.0                    │     │   │
│  │  │  │   Create or update files                  │     │   │
│  │  │  │   🔨 BUILT-IN                             │     │   │
│  │  │  │                                            │     │   │
│  │  │  └─ [ ] custom_linter v1.0.0                │     │   │
│  │  │      Team code linter                        │     │   │
│  │  │      👤 USER PLUGIN                          │     │   │
│  │  │                                              │     │   │
│  │  │  RESOURCES                                   │     │   │
│  │  │  └─ [✓] workspace_files v1.0.0              │     │   │
│  │  │      List of workspace files                │     │   │
│  │  │      🔨 BUILT-IN                             │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                                                       │   │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │     VS Code API Layer                               │   │
│  │  ├─ vscode.workspace.fs.*                            │   │
│  │  ├─ vscode.workspace.findFiles()                     │   │
│  │  ├─ vscode.window.showTextDocument()                │   │
│  │  └─ child_process.exec()                             │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Workspace Files    │
              │   & Terminals        │
              └──────────────────────┘
```

---

## Data Flow: Plugin Execution

```
┌─ User asks Agent to perform task
│
├─ Agent determines it needs a tool
│
├─ Agent sends: <run_tool id="read_file" args='{"path":"src/app.ts"}'/>
│
├─ chatViewProvider._executeShellCommand() intercepts tool tag
│
├─ Looks up in PluginRegistry:
│  └─ getTool('read_file') → ITool object
│
├─ Calls plugin.execute({ path: "src/app.ts" })
│
├─ Plugin uses vscode.workspace.fs.readFile()
│
├─ Returns: { success: true, content: "..." }
│
├─ Sends result to model via _generateModelResponseFromTool()
│
└─ Model synthesizes response to user
```

---

## Plugin Lifecycle

```
                    ┌──────────────────┐
                    │  Extension Init  │
                    └────────┬─────────┘
                             │
                    ┌────────▼──────────┐
                    │ resolveWebviewView │
                    └────────┬──────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
        ┌─────▼──────┐          ┌──────────▼────────┐
        │   Built-in │          │  User Plugins     │
        │   Plugins  │          │  (.continued/)    │
        │ (hardcoded │          │  (dynamic load)   │
        │   import)  │          └──────────┬────────┘
        └─────┬──────┘                     │
              │                            │
              └────────────┬───────────────┘
                           │
              ┌────────────▼─────────────┐
              │  PluginRegistry.register │
              │  - registerTool()        │
              │  - registerResource()    │
              │  - registerSkill()       │
              └────────────┬─────────────┘
                           │
              ┌────────────▼──────────────┐
              │ Load Persisted State      │
              │ (from globalState)        │
              └────────────┬──────────────┘
                           │
         ┌─────────────────┴────────────────┐
         │                                  │
    ┌────▼────┐                      ┌─────▼────┐
    │Webview  │ ◄─────POST─────────► │Extension │
    │UI       │                      │Provider  │
    │         │                      │          │
    │✓read_   │                      │Registry  │
    │file     │                      │Manager   │
    │✓write_  │   setPlugins()       │          │
    │file     │   getPlugins()       │          │
    │□custom  │   togglePlugin()     │          │
    └─────────┘                      └──────────┘
```

---

## Plugin Type Hierarchy

```
                      ┌──────────────┐
                      │   IPlugin    │
                      │ (Base)       │
                      └──────┬───────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐         ┌────▼────┐        ┌────▼────┐
    │  ITool  │         │IResource│        │  ISkill │
    ├─────────┤         ├─────────┤        ├─────────┤
    │         │         │         │        │         │
    │execute()│         │fetch()  │        │steps[]  │
    │  ↓      │         │  ↓      │        │execute()│
    │ Returns │         │Returns  │        │  ↓      │
    │ result  │         │ context │        │Returns  │
    │         │         │         │        │result   │
    └────┬────┘         └─────────┘        └─────────┘
         │
    ┌────┴──────────────────────┐
    │   Examples of Tools       │
    ├──────────────────────────┤
    │ • read_file              │
    │ • write_file             │
    │ • delete_file            │
    │ • run_command            │
    │ • semantic_search        │
    │ • grep_search            │
    │ • open_file              │
    │ • custom_linter          │
    │ • code_review            │
    │ • ... user-defined ...   │
    └──────────────────────────┘
```

---

## State Persistence

```
┌─ User enables plugin via checkbox
│
├─ Webview: togglePlugin('read_file', true)
│     ▼
├─ Extension: pluginRegistry.togglePlugin(pluginId, enabled)
│     ▼
├─ Save to globalState:
│  ┌──────────────────────────────────────────┐
│  │ Key: plugins_enabled_${workspaceId}      │
│  │ Value: ['read_file','write_file',...]    │
│  └──────────────────────────────────────────┘
│
├─ Persist to .vscode/extensions/config
│
└─ On restart:
   ├─ Load from globalState
   ├─ Re-enable plugins per saved state
   └─ Webview reflects saved state
```

---

## User Plugin Auto-Discovery

```
File System                Extension Detection
────────────             ──────────────────

.continued/
  plugins/
    ├─ tool1.ts ─────────► Dynamic require()
    │                     Parse exports
    │                     Register in registry
    │
    ├─ tool2.ts ─────────► Dynamic require()
    │                     Parse exports
    │                     Register in registry
    │
    ├─ tool3.ts ─────────► Dynamic require()
    │                     Parse exports
    │                     Register in registry
    │
    └─ subdir/           Skip (only top-level .ts)
       tool4.ts          (Future: recursive load)

On resolveWebviewView():
  await _loadUserPlugins()
    ├─ vscode.workspace.fs.readDirectory('.continued/plugins')
    ├─ Filter for .ts/.js files
    ├─ Dynamic require() each
    ├─ Check for tool/resource/skill exports
    └─ Register with pluginRegistry
```

---

## Enable/Disable State Machine

```
              ┌──────────────────┐
              │    Plugin Loaded │
              │   (disabled by   │
              │    default)      │
              └────────┬─────────┘
                       │
              User enables checkbox
                       │
                       ▼
        ┌──────────────────────────────┐
        │  Plugin in enabledPlugins Set │
        │  plugin.enabled = true        │
        │  State persisted to globalState│
        └──────────────────────────────┘
                       │
        ┌──────────────┴───────────────┐
        │                              │
        │  Agent can invoke           │  Appears in UI
        │  this tool now              │  with ✓ checkbox
        │                              │
        └──────────────┬───────────────┘
                       │
         User disables checkbox
                       │
                       ▼
        ┌──────────────────────────────┐
        │ Plugin NOT in enabledPlugins  │
        │ plugin.enabled = false        │
        │ State persisted to globalState│
        └──────────────────────────────┘
                       │
        ┌──────────────┴───────────────┐
        │                              │
        │  Agent CANNOT invoke        │  Appears in UI
        │  this tool                  │  with ☐ checkbox
        │                              │
        └──────────────────────────────┘
```

---

## Message Routing

```
Webview (UI)                Extension                    Plugin
────────────               ─────────                    ──────

{
  type: 'getPlugins'
}  ─────────────────────────►  onDidReceiveMessage()
                                case 'getPlugins': {
                                  getAllPlugins()
                                }  ────────────┐
                                              │
                                              ▼
                                        PluginRegistry
                                        .getAllPlugins()
                                        returns {
                                          tools: [...],
                                          resources: [...],
                                          skills: [...]
                                        }
                                              │
                        ◄─────────────────────┘
{
  type: 'setPlugins',
  plugins: {
    tools: [...],
    resources: [...],
    skills: [...]
  },
  enabledCount: 7
}  ◄─────────────────────────
      renders plugin cards
      with checkboxes

User clicks checkbox ──────┐
                           │
                           ▼
{
  type: 'togglePlugin',
  pluginId: 'read_file',
  enabled: true
}  ─────────────────────────►  onDidReceiveMessage()
                                case 'togglePlugin': {
                                  togglePlugin()
                                }
                                              │
                                              ▼
                                        PluginRegistry
                                        .togglePlugin()
                                        ├─ Update enabledPlugins
                                        ├─ Update plugin.enabled
                                        └─ Persist to globalState
                                              │
                        ◄─────────────────────┘
{
  type: 'setPlugins',
  plugins: {...updated...},
  enabledCount: 7
}  ◄─────────────────────────
      re-renders with
      new checkbox state
```

---

## Integration with Agent Workflow

```
User Message        Chat Flow              Plugin System
──────────────      ──────────             ──────────────

"Review my code"
    │
    ▼
Agent generates response:
"I'll review your code"
<run_tool id="code_review" args='{"path":"src/app.ts"}'/>
    │
    ▼
Extension detects tool tag
_extractRunShellCommand()
    │
    ▼
Look up in PluginRegistry:
getTool('code_review')
    │
    ▼
Plugin found (if enabled)
    │
    ▼
plugin.execute({ path: "src/app.ts" })
    │
    ▼
Plugin runs analysis
Finds issues: [ "no comments", "var usage" ]
    │
    ▼
Return result:
{
  file: 'src/app.ts',
  issuesFound: 2,
  issues: [...],
  quality: 85
}
    │
    ▼
Send to model:
"Tool output: [result]"
    │
    ▼
Model synthesizes response:
"I found 2 issues... quality score 85%"
    │
    ▼
Display to user
```

---

These diagrams provide a comprehensive visual reference for understanding the plugin architecture! 🎨
