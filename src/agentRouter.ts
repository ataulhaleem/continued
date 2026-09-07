import * as vscode from 'vscode';
import { PluginRegistry } from './plugins/pluginRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ToolInfo {
    name: string;
    type: 'skill' | 'tool' | 'resource' | 'shell-command';
    description: string;
    example?: string;
    riskLevel: 'low' | 'medium' | 'high';
}

interface AgentResourcesType {
    skills: ToolInfo[];
    tools: ToolInfo[];
    resources: ToolInfo[];
    shellCommands: ToolInfo[];
    workspace: {
        rootPath: string;
        fileTypes: string[];
        totalFiles: number;
    };
}

/**
 * AgentRouter: Discovers and catalogs all available tools, skills, and resources
 * for the Agent Mode to use. Provides recommendations for which tools suit specific tasks.
 */
export class AgentRouter {
    private pluginRegistry: PluginRegistry | null = null;
    private cachedResources: AgentResourcesType | null = null;
    private lastRefreshTime = 0;
    private readonly CACHE_TTL = 30000; // 30 seconds

    constructor(pluginRegistry?: PluginRegistry) {
        this.pluginRegistry = pluginRegistry || null;
    }

    /**
     * Discover all available resources (plugins, skills, tools, OS commands)
     */
    async discoverResources(): Promise<AgentResourcesType> {
        const now = Date.now();
        
        // Return cached if still fresh
        if (this.cachedResources && (now - this.lastRefreshTime) < this.CACHE_TTL) {
            return this.cachedResources;
        }

        const resources: AgentResourcesType = {
            skills: [],
            tools: [],
            resources: [],
            shellCommands: [],
            workspace: {
                rootPath: vscode.workspace.rootPath || 'unknown',
                fileTypes: [],
                totalFiles: 0
            }
        };

        // Discover plugin-based resources
        if (this.pluginRegistry) {
            const allPlugins = this.pluginRegistry.getAllPlugins();
            
            if (allPlugins.skills) {
                resources.skills = allPlugins.skills.map((s: any) => ({
                    name: s.name,
                    type: 'skill',
                    description: s.description || `Skill: ${s.name}`,
                    example: `Use this skill for complex analysis or specialized tasks.`,
                    riskLevel: 'low'
                }));
            }

            if (allPlugins.tools) {
                resources.tools = allPlugins.tools.map((t: any) => ({
                    name: t.name,
                    type: 'tool',
                    description: t.description || `Tool: ${t.name}`,
                    example: `Integrates ${t.name} for specific operations.`,
                    riskLevel: 'medium'
                }));
            }

            if (allPlugins.resources) {
                resources.resources = allPlugins.resources.map((r: any) => ({
                    name: r.name,
                    type: 'resource',
                    description: r.description || `Resource: ${r.name}`,
                    example: `Access or configure ${r.name}.`,
                    riskLevel: 'low'
                }));
            }
        }

        // Discover common shell commands (safe ones)
        resources.shellCommands = this.getCommonShellCommands();

        // Catalog workspace
        if (vscode.workspace.workspaceFolders) {
            const folder = vscode.workspace.workspaceFolders[0];
            resources.workspace.rootPath = folder.uri.fsPath;
            
            try {
                const pattern = new vscode.RelativePattern(folder, '**/*');
                const files = await vscode.workspace.findFiles(pattern);
                resources.workspace.totalFiles = files.length;
                
                const extensions = new Set<string>();
                files.forEach(file => {
                    const ext = file.fsPath.split('.').pop();
                    if (ext) extensions.add(ext);
                });
                resources.workspace.fileTypes = Array.from(extensions);
            } catch (e) {
                // Workspace enumeration failed, continue anyway
            }
        }

        this.cachedResources = resources;
        this.lastRefreshTime = now;
        return resources;
    }

    /**
     * Get list of safe shell commands available on the system
     */
    private getCommonShellCommands(): ToolInfo[] {
        const commands: ToolInfo[] = [
            {
                name: 'ls',
                type: 'shell-command',
                description: 'List directory contents',
                example: 'ls -la /path/to/dir',
                riskLevel: 'low'
            },
            {
                name: 'find',
                type: 'shell-command',
                description: 'Search for files by name, type, size',
                example: 'find . -name "*.ts" -type f',
                riskLevel: 'low'
            },
            {
                name: 'grep',
                type: 'shell-command',
                description: 'Search text within files',
                example: 'grep -r "pattern" /path',
                riskLevel: 'low'
            },
            {
                name: 'cat',
                type: 'shell-command',
                description: 'Display file contents',
                example: 'cat /path/to/file.txt',
                riskLevel: 'low'
            },
            {
                name: 'sed',
                type: 'shell-command',
                description: 'Stream editor for text manipulation',
                example: 'sed -i "s/old/new/g" file.txt',
                riskLevel: 'medium'
            },
            {
                name: 'awk',
                type: 'shell-command',
                description: 'Text processing and extraction',
                example: 'awk \'{print $1}\' file.txt',
                riskLevel: 'low'
            },
            {
                name: 'npm',
                type: 'shell-command',
                description: 'Node package manager',
                example: 'npm install',
                riskLevel: 'medium'
            },
            {
                name: 'git',
                type: 'shell-command',
                description: 'Version control operations',
                example: 'git status',
                riskLevel: 'medium'
            }
        ];
        return commands;
    }

    /**
     * Build a natural language description of available resources for the model
     */
    async buildResourceCatalog(): Promise<string> {
        const resources = await this.discoverResources();
        let catalog = `=== AVAILABLE AGENT RESOURCES ===\n\n`;

        if (resources.skills.length > 0) {
            catalog += `SKILLS (complex analysis & specialized tasks):\n`;
            resources.skills.forEach((s: ToolInfo) => {
                catalog += `  • ${s.name}: ${s.description}\n`;
            });
            catalog += '\n';
        }

        if (resources.tools.length > 0) {
            catalog += `TOOLS (integrations & specific operations):\n`;
            resources.tools.forEach((t: ToolInfo) => {
                catalog += `  • ${t.name}: ${t.description}\n`;
            });
            catalog += '\n';
        }

        if (resources.resources.length > 0) {
            catalog += `RESOURCES (configuration & data access):\n`;
            resources.resources.forEach((r: ToolInfo) => {
                catalog += `  • ${r.name}: ${r.description}\n`;
            });
            catalog += '\n';
        }

        if (resources.shellCommands.length > 0) {
            catalog += `SHELL COMMANDS (file system & OS operations):\n`;
            resources.shellCommands.forEach((c: ToolInfo) => {
                catalog += `  • ${c.name}: ${c.description}\n`;
            });
            catalog += '\n';
        }

        catalog += `WORKSPACE:\n`;
        catalog += `  • Root: ${resources.workspace.rootPath}\n`;
        catalog += `  • Total files: ${resources.workspace.totalFiles}\n`;
        catalog += `  • File types: ${resources.workspace.fileTypes.slice(0, 10).join(', ')}\n`;

        return catalog;
    }

    /**
     * Recommend best tools for a given task type
     */
    async recommendTools(taskDescription: string): Promise<string[]> {
        const resources = await this.discoverResources();
        const recommended: string[] = [];

        const taskLower = taskDescription.toLowerCase();

        // Pattern matching for recommendations
        if (taskLower.includes('list') || taskLower.includes('find') || taskLower.includes('search')) {
            recommended.push('find', 'grep', 'ls');
        }
        if (taskLower.includes('file') && (taskLower.includes('edit') || taskLower.includes('modify') || taskLower.includes('create'))) {
            recommended.push('write-file-tag');
        }
        if (taskLower.includes('delete') || taskLower.includes('remove')) {
            recommended.push('delete-file-tag');
        }
        if (taskLower.includes('analyze') || taskLower.includes('pattern')) {
            recommended.push('grep', 'awk', 'sed');
            resources.skills.forEach((s: ToolInfo) => recommended.push(s.name));
        }
        if (taskLower.includes('deploy') || taskLower.includes('install') || taskLower.includes('build')) {
            recommended.push('npm', 'git');
        }

        return [...new Set(recommended)]; // Remove duplicates
    }

    /**
     * Get detailed info about a specific tool
     */
    async getToolInfo(toolName: string): Promise<ToolInfo | null> {
        const resources = await this.discoverResources();
        
        const allTools = [
            ...resources.skills,
            ...resources.tools,
            ...resources.resources,
            ...resources.shellCommands
        ];

        return allTools.find(t => t.name.toLowerCase() === toolName.toLowerCase()) || null;
    }
}
