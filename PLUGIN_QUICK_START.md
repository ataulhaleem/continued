# Plugin System Quick Start

Welcome to Continued's extensible plugin architecture! This guide helps you get started in 5 minutes.

## What You Got

✅ **Plugin Registry** - Centralized management of Tools, Resources, and Skills
✅ **7 Built-in Plugins** - File ops, search, terminal commands ready to use
✅ **Plugin Manager UI** - Enable/disable plugins with checkboxes (no config files!)
✅ **User Plugin Support** - Drop custom TypeScript files in `.continued/plugins/`
✅ **Workspace-Scoped State** - Each project remembers its plugin settings

## 30-Second Setup

### For Users

1. Open Continued sidebar (🔌 icon in chat)
2. Click **"🔌 Plugins"** button
3. Toggle plugins on/off with checkboxes
4. Done! Settings persist automatically

### For Developers

Create `.continued/plugins/myTool.ts`:

```typescript
import { ITool } from '../../src/plugins/types';

export const myTool: ITool = {
  id: 'my_tool',
  name: 'My Tool',
  version: '1.0.0',
  description: 'Does cool things',
  enabled: false, // Users enable via checkbox
  source: 'user',
  
  async execute(args: { input: string }) {
    return { processed: args.input.toUpperCase() };
  },
};
```

That's it! Your plugin auto-loads and appears in the Plugin Manager.

## Built-in Tools at a Glance

### File Operations
- `read_file` - Read file contents
- `write_file` - Create/update files  
- `delete_file` - Delete files

### Search
- `semantic_search` - AI-powered search by meaning
- `grep_search` - Fast keyword/regex search

### Execution
- `run_command` - Execute shell commands
- `open_file` - Open file in editor

### Resources
- `workspace_files` - Lists all workspace files

## Real-World Example: Custom Linter

```typescript
// .continued/plugins/customLinter.ts
import { ITool } from '../../src/plugins/types';
import * as vscode from 'vscode';

export const customLinter: ITool = {
  id: 'custom_lint',
  name: 'Project Linter',
  version: '1.0.0',
  description: 'Checks code against team standards',
  enabled: false,
  source: 'user',
  
  async execute(args: { filePath: string }) {
    const uri = vscode.Uri.file(args.filePath);
    const data = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(data);
    
    const issues = [];
    if (content.includes('console.log')) issues.push('❌ Remove console.log');
    if (content.includes(' == ')) issues.push('❌ Use === instead of ==');
    if (!content.includes('// ') && content.length > 500) {
      issues.push('⚠️ Consider adding comments');
    }
    
    return { filePath: args.filePath, issues, passed: issues.length === 0 };
  },
};
```

Users enable it → checkbox toggles on → Agent can invoke `custom_lint` tool!

## How It Works (Behind the Scenes)

```
┌─ User enables plugin in UI
│
├─ PluginRegistry.togglePlugin(pluginId, true)
│  └─ Saves state to VS Code globalState (workspace-scoped)
│
├─ Plugin appears in Agent's available tools
│
└─ Agent can call: <run_command tool="custom_lint" args='{"filePath":"src/app.ts"}'/>
   └─ Extension routes to plugin.execute() → returns result → Model synthesizes response
```

## File Structure

```
.continued/
├── plugins/                    # Your custom plugins go here
│   ├── exampleUserPlugin.ts   # Example template (included)
│   ├── myLinter.ts            # Your custom linter
│   └── myAnalyzer.ts          # Your custom analyzer
│
src/plugins/
├── types.ts                    # Plugin interface definitions
├── pluginRegistry.ts           # Plugin management engine
└── builtIn/
    ├── fileTools.ts           # read_file, write_file, delete_file
    ├── searchTools.ts         # semantic_search, grep_search, workspace_files
    └── terminalTools.ts       # run_command, open_file
```

## Plugin State Persistence

- **Where**: VS Code `globalState` (workspace-scoped)
- **Key**: `plugins_enabled_${workspaceId}`
- **Lifetime**: Survives VS Code restarts, per-workspace
- **Manual override**: Edit VS Code settings (usually not needed)

## Common Patterns

### Pattern 1: Tool with Validation

```typescript
async execute(args: { path: string; timeout?: number }) {
  if (!args.path) throw new Error('path is required');
  
  const timeout = args.timeout || 30000;
  // ... your logic
}
```

### Pattern 2: Tool that Uses VS Code API

```typescript
import * as vscode from 'vscode';

async execute(args: { pattern: string }) {
  const files = await vscode.workspace.findFiles(args.pattern, null, 100);
  return { found: files.length, files: files.map(f => f.fsPath) };
}
```

### Pattern 3: Resource that Fetches Context

```typescript
export const teamPolicies: IResource = {
  // ...
  async fetch() {
    const files = await vscode.workspace.findFiles('**/POLICIES.json');
    if (files.length > 0) {
      const data = await vscode.workspace.fs.readFile(files[0]);
      return JSON.parse(new TextDecoder().decode(data));
    }
    return { policies: [] };
  },
};
```

## Debugging Plugins

### Plugin not appearing?
- Check `.continued/plugins/` directory exists
- Verify export syntax: `export const myTool: ITool = { ... }`
- Look at Extension output panel for load errors

### Plugin enabled but not working?
- Check plugin IDs match what agent tries to call
- Verify error handling (throw descriptive errors)
- Test `execute()` method with sample args

### Plugin conflicts?
- Unique `id` values prevent conflicts
- Built-in plugins always available, can't be removed
- Disable conflicting plugin via checkbox

## Next Steps

1. **Read Full Guide**: [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md)
2. **Browse Examples**: [.continued/plugins/exampleUserPlugin.ts](.continued/plugins/exampleUserPlugin.ts)
3. **Explore Built-ins**: [src/plugins/builtIn/](src/plugins/builtIn/)
4. **Create Your First**: Copy example, modify, enable via checkbox!

---

**Pro Tip**: Plugins are pure TypeScript—leverage the entire VS Code API. Share your best plugins on GitHub with `#continued-plugins` tag!
