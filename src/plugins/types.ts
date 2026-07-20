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

export interface IPlugin {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  enabled: boolean;
  source: 'built-in' | 'user';
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

export interface ISkill extends IPlugin {
  /**
   * Multi-step workflow orchestration.
   */
  steps: WorkflowStep[];
  execute(): Promise<any>;
}
