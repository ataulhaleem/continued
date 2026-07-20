/**
 * Plugin Registry
 * Central management for Tools, Resources, and Skills.
 * Handles registration, enable/disable state, and retrieval.
 */

import * as vscode from 'vscode';
import { IPlugin, ITool, IResource, ISkill } from './types';

export class PluginRegistry {
  private tools: Map<string, ITool> = new Map();
  private resources: Map<string, IResource> = new Map();
  private skills: Map<string, ISkill> = new Map();
  private enabledPlugins: Set<string> = new Set();

  constructor(private context: vscode.ExtensionContext, private workspaceId: string) {
    this.loadEnabledState();
  }

  /**
   * Load enabled plugins state from globalState (workspace-scoped).
   */
  private loadEnabledState() {
    const key = `plugins_enabled_${this.workspaceId}`;
    const enabled = this.context.globalState.get<string[]>(key, []);
    this.enabledPlugins = new Set(enabled);
  }

  /**
   * Persist enabled plugins state to globalState.
   */
  private async persistEnabledState() {
    const key = `plugins_enabled_${this.workspaceId}`;
    await this.context.globalState.update(key, Array.from(this.enabledPlugins));
  }

  /**
   * Register a tool plugin.
   */
  registerTool(tool: ITool) {
    // Update enabled state from persistence
    if (this.enabledPlugins.has(tool.id)) {
      tool.enabled = true;
    }
    this.tools.set(tool.id, tool);
  }

  /**
   * Register a resource plugin.
   */
  registerResource(resource: IResource) {
    if (this.enabledPlugins.has(resource.id)) {
      resource.enabled = true;
    }
    this.resources.set(resource.id, resource);
  }

  /**
   * Register a skill plugin.
   */
  registerSkill(skill: ISkill) {
    if (this.enabledPlugins.has(skill.id)) {
      skill.enabled = true;
    }
    this.skills.set(skill.id, skill);
  }

  /**
   * Get all enabled tools.
   */
  getEnabledTools(): ITool[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  /**
   * Get all enabled resources.
   */
  getEnabledResources(): IResource[] {
    return Array.from(this.resources.values()).filter(r => r.enabled);
  }

  /**
   * Get all enabled skills.
   */
  getEnabledSkills(): ISkill[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }

  /**
   * Get a specific tool by ID.
   */
  getTool(id: string): ITool | undefined {
    return this.tools.get(id);
  }

  /**
   * Get a specific resource by ID.
   */
  getResource(id: string): IResource | undefined {
    return this.resources.get(id);
  }

  /**
   * Get a specific skill by ID.
   */
  getSkill(id: string): ISkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Toggle plugin enabled/disabled state and persist.
   */
  async togglePlugin(pluginId: string, enabled: boolean) {
    if (enabled) {
      this.enabledPlugins.add(pluginId);
      // Update plugin object
      if (this.tools.has(pluginId)) {
        this.tools.get(pluginId)!.enabled = true;
      }
      if (this.resources.has(pluginId)) {
        this.resources.get(pluginId)!.enabled = true;
      }
      if (this.skills.has(pluginId)) {
        this.skills.get(pluginId)!.enabled = true;
      }
    } else {
      this.enabledPlugins.delete(pluginId);
      if (this.tools.has(pluginId)) {
        this.tools.get(pluginId)!.enabled = false;
      }
      if (this.resources.has(pluginId)) {
        this.resources.get(pluginId)!.enabled = false;
      }
      if (this.skills.has(pluginId)) {
        this.skills.get(pluginId)!.enabled = false;
      }
    }
    await this.persistEnabledState();
  }

  /**
   * Remove plugin from registry and enabled state.
   */
  async removePlugin(pluginId: string) {
    this.tools.delete(pluginId);
    this.resources.delete(pluginId);
    this.skills.delete(pluginId);
    this.enabledPlugins.delete(pluginId);
    await this.persistEnabledState();
  }

  /**
   * Get all plugins (tools, resources, skills) for UI display.
   */
  getAllPlugins() {
    return {
      tools: Array.from(this.tools.values()),
      resources: Array.from(this.resources.values()),
      skills: Array.from(this.skills.values()),
    };
  }

  /**
   * Get count of enabled plugins.
   */
  getEnabledCount(): number {
    return this.enabledPlugins.size;
  }
}
