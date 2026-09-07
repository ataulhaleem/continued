/**
 * Plugin Type Definitions
 * Defines the contract for Tools, Resources, and Skills
 */

export interface WorkflowStep {
  id: string;
  tool: string; // plugin ID to execute
  args: Record<string, any>;
  description?: string;
}

export interface PluginArgSpec {
  name: string;
  description?: string;
  required?: boolean;
  /** Render as a textarea in the harness builder. */
  multiline?: boolean;
  default?: string;
}

export interface IPlugin {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  enabled: boolean;
  source: 'built-in' | 'user';
  category?: 'tool' | 'resource' | 'skill'; // Helps UI categorize plugins
  /** Declared arguments (tools) — used by the harness builder to render fields and by the agent prompt. */
  args?: PluginArgSpec[];
  /** Set on skills that are backed by a harness definition. */
  harness?: boolean;
  /** Tools that only inspect the workspace: never ask for approval, even in Agent mode. */
  readOnly?: boolean;
  /**
   * For tools that change files: return the workspace-relative paths the call will touch.
   * The host snapshots them before execution so the change shows up in the Agent Changes
   * panel and can be reverted.
   */
  touches?(args: Record<string, any>): string[];
}

export interface ITool extends IPlugin {
  /**
   * Execute the tool with the given arguments.
   * Should throw an error if execution fails.
   */
  execute(args: Record<string, any>): Promise<any>;
}

export interface IResource extends IPlugin {
  /**
   * Fetch resource data (e.g., workspace files, terminal output).
   */
  fetch(): Promise<any>;
}

export interface SkillContext {
  /**
   * Read a file from the workspace
   */
  readFile(filePath: string): Promise<string>;
  
  /**
   * Get the active editor's file content
   */
  getActiveEditorContent(): Promise<string>;
  
  /**
   * Get the active editor's file path
   */
  getActiveEditorPath(): Promise<string>;
  
  /**
   * Search for files matching a pattern
   */
  searchFiles(pattern: string): Promise<string[]>;
  
  /**
   * Get workspace folder path
   */
  getWorkspaceFolder(): string;
  
  /**
   * Get recent git changes/diffs
   */
  getGitDiff(): Promise<string>;
}

export interface ISkill extends IPlugin {
  /**
   * Multi-step workflow orchestration.
   */
  steps: WorkflowStep[];
  execute(context: SkillContext, input?: string): Promise<any>;
}
