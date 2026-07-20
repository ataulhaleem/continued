# Continued Plugin Architecture

The plugin system allows you to extend Continued with custom **Tools**, **Resources**, and **Skills** without modifying the core extension code. Users can enable/disable plugins via a simple checkbox interface.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│         Plugin Manager (Webview UI)             │
│  [☑ read_file] [☑ write_file] [☐ my_tool]     │
├─────────────────────────────────────────────────┤
│                                                  │
│  PluginRegistry (Core)                         │
│  ├─ Tools (Actions)                            │
│  ├─ Resources (Context)                        │
│  └─ Skills (Workflows)                         │
│                                                  │
│  Built-in Plugins        User Plugins          │
│  ├─ read_file            .continued/plugins/   │
│  ├─ write_file           ├─ myTool.ts         │
│  ├─ delete_file          └─ myResource.ts     │
│  ├─ run_command                                │
│  ├─ semantic_search                            │
│  └─ grep_search                                │
└─────────────────────────────────────────────────┘
```

## Plugin Types

### 1. Tools (Executable Actions)

Tools are atomic operations the LLM can invoke to modify state or run commands.

```typescript
import { ITool } from '../src/plugins/types';

export const myTool: ITool = {
  id: 'my_tool_id',              // Unique identifier
  name: 'My Tool',               // Display name
  version: '1.0.0',              // Semantic versioning
  author: 'Your Name',           // Optional
  description: 'Does something', // Show in UI
  enabled: false,                // Default state (user can toggle)
  source: 'user',                // 'user' or 'built-in'
  
  // Main execution method
  async execute(args: Record<string, any>) {
    if (!args.required) {
      throw new Error('missing required argument');
    }
    
    // Your logic here
    return { success: true, result: '...' };
  },
};
```

### 2. Resources (Context Providers)

Resources fetch information that can be used by the LLM for analysis.

```typescript
import { IResource } from '../src/plugins/types';

export const myResource: IResource = {
  id: 'my_resource',
  name: 'My Context',
  version: '1.0.0',
  description: 'Provides useful context',
  enabled: false,
  source: 'user',
  
  // Fetch data when needed
  async fetch() {
    return {
      data: 'contextual information',
      metadata: { ... },
    };
  },
};
```

### 3. Skills (Multi-Step Workflows)

Skills orchestrate multiple tools into reusable workflows.

```typescript
import { ISkill, WorkflowStep } from '../src/plugins/types';

export const mySkill: ISkill = {
  id: 'my_skill',
  name: 'My Workflow',
  version: '1.0.0',
  description: 'Multi-step workflow',
  enabled: false,
  source: 'user',
  
  steps: [
    {
      id: 'step1',
      tool: 'read_file',
      args: { path: 'src/file.ts' },
      description: 'Read the file',
    },
    {
      id: 'step2',
      tool: 'semantic_search',
      args: { query: 'authentication logic' },
      description: 'Find auth code',
    },
  ],
  
  async execute() {
    // Orchestration logic
    return { success: true };
  },
};
```

## Creating a User Plugin

### Step 1: Create Plugin Directory

```bash
mkdir -p .continued/plugins
```

### Step 2: Write Your Plugin

Create `.continued/plugins/myPlugin.ts`:

```typescript
import { ITool } from '../../src/plugins/types';

export const myCustomTool: ITool = {
  id: 'my_custom_tool',
  name: 'My Custom Tool',
  version: '1.0.0',
  description: 'A tool I created',
  enabled: false,
  source: 'user',
  
  async execute(args: { input: string }) {
    // Use vscode API if needed:
    // import * as vscode from 'vscode';
    // const files = await vscode.workspace.findFiles('**/*.ts');
    
    return {
      success: true,
      processed: args.input.toUpperCase(),
    };
  },
};
```

### Step 3: Enable in UI

1. Open Continued sidebar
2. Click the **🔌 Plugins** button
3. Find your plugin in the "User Plugins" section
4. Toggle the checkbox to enable

## Built-in Plugins

### Tools

| ID | Name | Description |
|----|------|-------------|
| `read_file` | Read File | Read file contents from workspace |
| `write_file` | Write File | Create/update files |
| `delete_file` | Delete File | Delete files from workspace |
| `run_command` | Run Command | Execute shell commands |
| `semantic_search` | Semantic Search | AI-powered code search by meaning |
| `grep_search` | Grep Search | Fast keyword/regex search |
| `open_file` | Open File | Open file in editor |

### Resources

| ID | Name | Description |
|----|------|-------------|
| `workspace_files` | Workspace Files | Lists all accessible files |

## Plugin State Persistence

- Plugin enabled/disabled state is **workspace-scoped** in VS Code's `globalState`
- State key: `plugins_enabled_${workspaceId}`
- Persists across sessions automatically

## Example: Code Review Tool

```typescript
// .continued/plugins/codeReviewTool.ts
import { ITool } from '../../src/plugins/types';
import * as vscode from 'vscode';

export const codeReviewTool: ITool = {
  id: 'code_review',
  name: 'Code Reviewer',
  version: '1.0.0',
  description: 'Reviews code for quality issues',
  enabled: false,
  source: 'user',
  
  async execute(args: { filePath: string; rules?: string[] }) {
    const uri = vscode.Uri.file(args.filePath);
    const data = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(data);
    
    // Analyze code
    const issues = [];
    if (content.includes('var ')) {
      issues.push('⚠️ Found "var" keyword (prefer const/let)');
    }
    if (!content.includes('//') && !content.includes('/*')) {
      issues.push('⚠️ No comments found');
    }
    
    return {
      success: true,
      file: args.filePath,
      issues,
      score: Math.max(0, 100 - issues.length * 10),
    };
  },
};
```

## API Reference

### ITool

```typescript
interface ITool extends IPlugin {
  execute(args: Record<string, any>): Promise<any>;
}
```

### IResource

```typescript
interface IResource extends IPlugin {
  fetch(): Promise<any>;
}
```

### ISkill

```typescript
interface ISkill extends IPlugin {
  steps: WorkflowStep[];
  execute(): Promise<any>;
}
```

### IPlugin (Base)

```typescript
interface IPlugin {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  version: string;               // Semantic version
  author?: string;               // Author name
  description?: string;          // Short description
  enabled: boolean;              // Enable/disable state
  source: 'built-in' | 'user';  // Plugin origin
}
```

## Error Handling

Always throw descriptive errors:

```typescript
async execute(args: { path: string }) {
  if (!args.path) {
    throw new Error('execute requires "path" argument');
  }
  
  try {
    // Your logic
  } catch (e) {
    throw new Error(`Operation failed: ${(e as Error).message}`);
  }
}
```

## Best Practices

1. **Keep plugins focused** - One tool = one responsibility
2. **Use workspace API** - Access files via `vscode.workspace.fs` and `vscode.workspace.findFiles()`
3. **Add timeouts** - Long operations should have user-facing progress
4. **Version your plugins** - Increment semver when you update
5. **Document args** - Always list required/optional arguments in description
6. **Return structured data** - Enable the agent to parse results easily
7. **Test locally** - Verify plugins work before sharing

## Marketplace Distribution

To share plugins:

1. Publish to GitHub with `.continued/plugins/` examples
2. Add to Continued Plugin Registry (future feature)
3. Users copy to their `.continued/plugins/` directory

---

**Questions?** Check [src/plugins/](src/plugins/) for built-in plugin implementations.
