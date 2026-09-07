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
  /** Explicit user choices (id → enabled). Plugins without an entry keep their declared default. */
  private overrides: Record<string, boolean> = {};

  constructor(private context: vscode.ExtensionContext, private workspaceId: string) {
    this.loadEnabledState();
  }

  private get stateKey(): string {
    return `plugins_enabled_state_${this.workspaceId}`;
  }

  /**
   * Load enabled-state overrides from globalState (workspace-scoped).
   * Migrates the pre-1.0.1 "list of enabled ids" format.
   */
  private loadEnabledState() {
    const stored = this.context.globalState.get<Record<string, boolean>>(this.stateKey);
    if (stored && typeof stored === 'object') {
      this.overrides = { ...stored };
      return;
    }
    const legacy = this.context.globalState.get<string[]>(`plugins_enabled_${this.workspaceId}`, []);
    this.overrides = {};
    for (const id of legacy) { this.overrides[id] = true; }
  }

  private async persistEnabledState() {
    await this.context.globalState.update(this.stateKey, this.overrides);
  }

  private applyOverride(plugin: IPlugin) {
    if (Object.prototype.hasOwnProperty.call(this.overrides, plugin.id)) {
      plugin.enabled = this.overrides[plugin.id];
    }
  }

  registerTool(tool: ITool) {
    this.applyOverride(tool);
    this.tools.set(tool.id, tool);
  }

  registerResource(resource: IResource) {
    this.applyOverride(resource);
    this.resources.set(resource.id, resource);
  }

  registerSkill(skill: ISkill) {
    this.applyOverride(skill);
    this.skills.set(skill.id, skill);
  }

  getEnabledTools(): ITool[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  getEnabledResources(): IResource[] {
    return Array.from(this.resources.values()).filter(r => r.enabled);
  }

  getEnabledSkills(): ISkill[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }

  getTool(id: string): ITool | undefined {
    return this.tools.get(id);
  }

  getResource(id: string): IResource | undefined {
    return this.resources.get(id);
  }

  getSkill(id: string): ISkill | undefined {
    return this.skills.get(id);
  }

  /** Toggle plugin enabled/disabled state and persist the choice. */
  async togglePlugin(pluginId: string, enabled: boolean) {
    this.overrides[pluginId] = enabled;
    const plugin = this.tools.get(pluginId) ?? this.resources.get(pluginId) ?? this.skills.get(pluginId);
    if (plugin) { plugin.enabled = enabled; }
    await this.persistEnabledState();
  }

  /** Remove plugin from registry and forget its enabled state. */
  async removePlugin(pluginId: string) {
    this.tools.delete(pluginId);
    this.resources.delete(pluginId);
    this.skills.delete(pluginId);
    delete this.overrides[pluginId];
    await this.persistEnabledState();
  }

  /** All plugins (tools, resources, skills) for UI display. */
  getAllPlugins() {
    return {
      tools: Array.from(this.tools.values()),
      resources: Array.from(this.resources.values()),
      skills: Array.from(this.skills.values()),
    };
  }

  /** Number of currently enabled plugins. */
  getEnabledCount(): number {
    return this.getEnabledTools().length + this.getEnabledResources().length + this.getEnabledSkills().length;
  }
}
