import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { showProviderSelector } from './providers';
import { PluginRegistry } from './plugins/pluginRegistry';
import { readFileTool, writeFileTool, deleteFileTool } from './plugins/builtIn/fileTools';
import { semanticSearchTool, grepSearchTool, workspaceFilesResource } from './plugins/builtIn/searchTools';
import { runCommandTool, openFileTool } from './plugins/builtIn/terminalTools';

const execAsync = promisify(exec);

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ChatSession {
    id: string;
    title: string;
    history: ChatMessage[];
    mode: string;
}

export class ContinuedSidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _currentSessionId: string | null = null;
    private _chatHistory: ChatMessage[] = [];
    private _pendingEdit: { relativePath: string; newContent: string } | null = null;
    private _pendingDelete: { relativePath: string } | null = null;
    private _pendingCommand: { command: string } | null = null;
    private _lastFileSnapshot: { relativePath: string; originalContent: string; isDeletion: boolean } | null = null;
    private _pluginRegistry?: PluginRegistry;

    constructor(
        private readonly _context: vscode.ExtensionContext
    ) {}

    private _workspaceScopeId(): string {
        const workspaceFile = vscode.workspace.workspaceFile?.toString();
        if (workspaceFile) {return workspaceFile;}

        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.toString();
        }

        return 'global';
    }

    private _scopedStateKey(baseKey: string): string {
        return `${baseKey}::${this._workspaceScopeId()}`;
    }

    private _getScopedState<T>(baseKey: string, legacyKey?: string): T | undefined {
        const scoped = this._context.globalState.get<T>(this._scopedStateKey(baseKey));
        if (scoped !== undefined) {return scoped;}

        if (!legacyKey) {return undefined;}
        return this._context.globalState.get<T>(legacyKey);
    }

    private _setScopedState<T>(baseKey: string, value: T) {
        return this._context.globalState.update(this._scopedStateKey(baseKey), value);
    }

    private _getAllSessions(): ChatSession[] {
        return this._getScopedState<ChatSession[]>('continued_sessions', 'continued_sessions') ?? [];
    }

    private _saveSessions(sessions: ChatSession[]) {
        this._setScopedState('continued_sessions', sessions);
    }

    private _persistCurrentSessionHistory(modeFallback: string = 'chat') {
        if (!this._currentSessionId) {return;}

        const allSessions = this._getAllSessions();
        const idx = allSessions.findIndex(s => s.id === this._currentSessionId);

        if (idx !== -1) {
            allSessions[idx].history = this._chatHistory;
        } else {
            allSessions.unshift({
                id: this._currentSessionId,
                title: 'Session',
                history: this._chatHistory,
                mode: modeFallback
            });
        }

        this._saveSessions(allSessions);
    }

    private _buildCommandHistoryEntry(command: string, output: string): string {
        const cappedOutput = output.length > 12000
            ? `${output.slice(0, 12000)}\n\n...[output truncated]...`
            : output;

        return `[[COMMAND_RESULT]]${JSON.stringify({ command, output: cappedOutput })}`;
    }

    private _isInternalToolHistory(content: string): boolean {
        return content.startsWith('[[COMMAND_RESULT]]');
    }

    private _historyForModel(): ChatMessage[] {
        return this._chatHistory.filter(m => m.role !== 'system' && !this._isInternalToolHistory(m.content));
    }

    private _trimHistoryForPayload(history: ChatMessage[], maxMessages: number = 24, maxChars: number = 24000): ChatMessage[] {
        const recent = history.slice(-maxMessages);
        const selected: ChatMessage[] = [];
        let charCount = 0;

        for (let i = recent.length - 1; i >= 0; i--) {
            const msg = recent[i];
            const nextSize = msg.content.length;
            if (charCount + nextSize > maxChars) {
                break;
            }
            selected.unshift(msg);
            charCount += nextSize;
        }

        return selected;
    }

    private async _buildWorkspaceContextSummary(): Promise<string> {
        const maxFiles = 120;
        const files = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build,.next,target,venv,.venv,.cache}/**',
            maxFiles + 1
        );

        const hasMore = files.length > maxFiles;
        const visibleFiles = files.slice(0, maxFiles).map(f => vscode.workspace.asRelativePath(f));
        let summary = visibleFiles.join(', ');

        if (summary.length > 6000) {
            summary = `${summary.slice(0, 6000)} ...`;
        }

        if (!summary) {
            return 'No files detected.';
        }

        return hasMore
            ? `${summary} (and more files omitted for brevity)`
            : summary;
    }

    private _sanitizeAgentDisplayResponse(response: string): string {
        return response
            .replace(/<write_file\s+path=["'][^"']+["']\s*>[\s\S]*?<\/write_file>/gi, '')
            .replace(/<delete_file\s+path=["'][^"']+["']\s*\/?>/gi, '')
            .replace(/<run_shell\s+command=["'][\s\S]*?["']\s*\/?>/gi, '')
            .replace(/\[\[run_shell\s+command=["'][\s\S]*?["']\s*\]\]/gi, '')
            .replace(/\[\[\/?COMMAND_RESULT\]\]/g, '')
            .replace(/\[\[COMMAND_RESULT\]\]\s*\{[\s\S]*?\}/g, '')
            .trim();
    }

    private _extractRunShellCommand(response: string): string | null {
        const xmlStyle = response.match(/<run_shell\s+command=["']([\s\S]*?)["']\s*\/?>/i);
        if (xmlStyle?.[1]) {
            return xmlStyle[1].trim();
        }

        const bracketStyle = response.match(/\[\[run_shell\s+command=["']([\s\S]*?)["']\s*\]\]/i);
        if (bracketStyle?.[1]) {
            return bracketStyle[1].trim();
        }

        return null;
    }

    private _buildToolNarrative(command: string, output: string): string {
        const trimmed = (output || '').trim();
        const lastUserPrompt = [...this._chatHistory].reverse().find(m => m.role === 'user')?.content ?? '';

        if (!trimmed) {
            return `I executed \`${command}\` successfully, but it did not return visible output.`;
        }

        const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);

        if (/^ls(\s|$)/.test(command.trim())) {
            const names = lines
                .filter(l => !/^total\s+\d+/i.test(l))
                .map(l => {
                    const parts = l.split(/\s+/);
                    return parts[parts.length - 1] || l;
                })
                .filter(n => n && n !== '.' && n !== '..');

            if (names.length === 0) {
                return 'I checked the directory, but there were no visible entries to report.';
            }

            const top = names.slice(0, 8).map(n => `\`${n}\``).join(', ');
            return `I checked the directory and found ${names.length} item(s). Top entries: ${top}.`;
        }

        const pythonDefs = lines
            .map(l => l.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1])
            .filter((x): x is string => Boolean(x));

        if (pythonDefs.length > 0) {
            const fnList = [...new Set(pythonDefs)].slice(0, 10).map(f => `\`${f}()\``).join(', ');
            const prefix = lastUserPrompt ? `Based on your question (“${lastUserPrompt}”), ` : '';
            return `${prefix}this Python file appears to define these functions: ${fnList}.`;
        }

        const preview = lines.slice(0, 4).join(' | ');
        return `I ran \`${command}\` and got output. Key preview: ${preview}`;
    }

    private async _generateModelResponseFromTool(selectedModel: string, command: string, output: string): Promise<string> {
        const toolPrompt = `Tool execution completed.\nCommand: ${command}\nOutput:\n${output || '(no output)'}\n\nNow answer the user's last request using this tool result. Be concise and helpful. Do not output any tool tags.`;
        const modelHistory = this._trimHistoryForPayload(this._historyForModel());
        const payload: ChatMessage[] = [
            { role: 'system', content: 'You are Continued, an elite AI coding assistant. Use the provided tool output to answer the user.' },
            ...modelHistory,
            { role: 'user', content: toolPrompt }
        ];

        const isBlablador = selectedModel.startsWith('blablador/');
        const isOpenAi = selectedModel.startsWith('openai/');
        const isGemini = selectedModel.startsWith('gemini/');
        const isAnthropic = selectedModel.startsWith('anthropic/');

        let fetchUrl = 'http://localhost:11434/api/chat';
        const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        let fetchBody: any = {};

        if (isBlablador) {
            const pureModel = selectedModel.replace('blablador/', '');
            const key = await this._context.secrets.get('blablador_api_key');
            if (!key) {throw new Error('Blablador API key is not configured.');}
            fetchUrl = 'https://api.blablador.fz-juelich.de/v1/chat/completions';
            fetchHeaders.Authorization = `Bearer ${key}`;
            fetchBody = { model: pureModel, messages: payload, stream: false };
        } else if (isOpenAi) {
            const pureModel = selectedModel.replace('openai/', '');
            const key = await this._context.secrets.get('openai_api_key');
            if (!key) {throw new Error('OpenAI API key is not configured.');}
            fetchUrl = 'https://api.openai.com/v1/chat/completions';
            fetchHeaders.Authorization = `Bearer ${key}`;
            fetchBody = { model: pureModel, messages: payload, stream: false };
        } else if (isGemini) {
            const pureModel = selectedModel.replace('gemini/', '');
            const key = await this._context.secrets.get('gemini_api_key');
            if (!key) {throw new Error('Gemini API key is not configured.');}

            const geminiMessages = modelHistory.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));

            fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pureModel)}:generateContent?key=${encodeURIComponent(key)}`;
            fetchBody = {
                systemInstruction: {
                    parts: [{ text: 'You are Continued, an elite AI coding assistant. Use tool output to answer the user.' }]
                },
                contents: [
                    ...geminiMessages,
                    { role: 'user', parts: [{ text: toolPrompt }] }
                ],
                generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
            };
        } else if (isAnthropic) {
            const pureModel = selectedModel.replace('anthropic/', '');
            const key = await this._context.secrets.get('anthropic_api_key');
            if (!key) {throw new Error('Anthropic API key is not configured.');}

            const anthropicMessages = modelHistory.map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content
            }));

            fetchUrl = 'https://api.anthropic.com/v1/messages';
            fetchHeaders['x-api-key'] = key;
            fetchHeaders['anthropic-version'] = '2023-06-01';
            fetchBody = {
                model: pureModel,
                system: 'You are Continued, an elite AI coding assistant. Use tool output to answer the user.',
                messages: [
                    ...anthropicMessages,
                    { role: 'user', content: toolPrompt }
                ],
                max_tokens: 2048
            };
        } else {
            fetchBody = { model: selectedModel || 'llama3', messages: payload, stream: false };
        }

        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify(fetchBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Follow-up response failed (${response.status}): ${errText.slice(0, 300)}`);
        }

        if (isGemini) {
            const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
            const parts = json.candidates?.[0]?.content?.parts ?? [];
            return parts.map(p => p.text ?? '').join('').trim();
        }

        if (isAnthropic) {
            const json = await response.json() as { content?: Array<{ type: string; text?: string }> };
            return (json.content ?? [])
                .filter(block => block.type === 'text')
                .map(block => block.text ?? '')
                .join('')
                .trim();
        }

        const json = await response.json() as {
            message?: { content?: string };
            choices?: Array<{ message?: { content?: string } }>;
        };

        return (json.message?.content ?? json.choices?.[0]?.message?.content ?? '').trim();
    }

    private async _collectAvailableModels(): Promise<string[]> {
        let modelNames: string[] = [];

        try {
            const res = await fetch('http://localhost:11434/api/tags');
            const json = await res.json() as { models: Array<{ name: string }> };
            modelNames = json.models.map(m => m.name);
        } catch {
            modelNames = ['llama3'];
        }

        try {
            const openaiKey = await this._context.secrets.get('openai_api_key');
            if (openaiKey) {
                const openaiRes = await fetch('https://api.openai.com/v1/models', {
                    headers: { Authorization: `Bearer ${openaiKey}` }
                });

                if (openaiRes.ok) {
                    const json = await openaiRes.json() as { data: Array<{ id: string }> };
                    const openaiModels = json.data
                        .map(m => m.id)
                        .filter(id => id.startsWith('gpt') || id.startsWith('o'))
                        .map(id => `openai/${id}`);
                    modelNames = [...modelNames, ...openaiModels];
                } else {
                    modelNames.push('openai/gpt-4o-mini');
                }
            }
        } catch (err) {
            console.error('Failed to fetch OpenAI models:', err);
        }

        try {
            const geminiKey = await this._context.secrets.get('gemini_api_key');
            if (geminiKey) {
                const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`);

                if (geminiRes.ok) {
                    const json = await geminiRes.json() as { models: Array<{ name: string }> };
                    const geminiModels = json.models
                        .map(m => m.name.replace('models/', ''))
                        .filter(name => name.startsWith('gemini-'))
                        .map(name => `gemini/${name}`);
                    modelNames = [...modelNames, ...geminiModels];
                } else {
                    modelNames.push('gemini/gemini-2.5-flash');
                }
            }
        } catch (err) {
            console.error('Failed to fetch Gemini models:', err);
        }

        try {
            const anthropicKey = await this._context.secrets.get('anthropic_api_key');
            if (anthropicKey) {
                const anthropicRes = await fetch('https://api.anthropic.com/v1/models', {
                    headers: {
                        'x-api-key': anthropicKey,
                        'anthropic-version': '2023-06-01'
                    }
                });

                if (anthropicRes.ok) {
                    const json = await anthropicRes.json() as { data: Array<{ id: string }> };
                    const anthropicModels = json.data
                        .map(m => m.id)
                        .filter(id => id.includes('claude'))
                        .map(id => `anthropic/${id}`);
                    modelNames = [...modelNames, ...anthropicModels];
                } else {
                    modelNames.push('anthropic/claude-3-5-haiku-latest');
                }
            }
        } catch (err) {
            console.error('Failed to fetch Anthropic models:', err);
        }

        try {
            const blabladorKey = await this._context.secrets.get('blablador_api_key');
            if (blabladorKey) {
                const blabladorRes = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                    headers: { Authorization: `Bearer ${blabladorKey}` }
                });
                if (blabladorRes.ok) {
                    const json = await blabladorRes.json() as { data: Array<{ id: string }> };
                    const cloudModels = json.data.map(m => `blablador/${m.id}`);
                    modelNames = [...modelNames, ...cloudModels];
                }
            }
        } catch (err) {
            console.error('Failed to fetch Blablador models:', err);
        }

        return [...new Set(modelNames)];
    }

    private async _initializePlugins() {
        const workspaceId = this._workspaceScopeId();
        this._pluginRegistry = new PluginRegistry(this._context, workspaceId);
        
        // Register built-in tools
        this._pluginRegistry.registerTool(readFileTool);
        this._pluginRegistry.registerTool(writeFileTool);
        this._pluginRegistry.registerTool(deleteFileTool);
        this._pluginRegistry.registerTool(semanticSearchTool);
        this._pluginRegistry.registerTool(grepSearchTool);
        this._pluginRegistry.registerTool(runCommandTool);
        this._pluginRegistry.registerTool(openFileTool);
        
        // Register built-in resources
        this._pluginRegistry.registerResource(workspaceFilesResource);
        
        // Load user-defined plugins from .continued/plugins/
        await this._loadUserPlugins();
    }

    private async _loadUserPlugins() {
        if (!this._pluginRegistry) { return; }
        
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }
        
        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        
        try {
            const files = await vscode.workspace.fs.readDirectory(pluginDir);
            for (const [name, fileType] of files) {
                if (fileType === vscode.FileType.File && (name.endsWith('.ts') || name.endsWith('.js'))) {
                    try {
                        const pluginPath = vscode.Uri.joinPath(pluginDir, name).fsPath;
                        // Dynamically load the module
                        const moduleUrl = require.resolve(pluginPath);
                        delete require.cache[moduleUrl];
                        const module = require(moduleUrl);
                        
                        // Register any exported plugins
                        if (module.tool) { this._pluginRegistry.registerTool(module.tool); }
                        if (module.resource) { this._pluginRegistry.registerResource(module.resource); }
                        if (module.skill) { this._pluginRegistry.registerSkill(module.skill); }
                    } catch (e) {
                        console.warn(`Failed to load user plugin ${name}:`, (e as Error).message);
                    }
                }
            }
        } catch (e) {
            // No user plugins directory—skip silently
        }
    }

        private _pluginTypeTemplate(pluginType: 'tool' | 'resource' | 'skill', pluginId: string, displayName: string): string {
                if (pluginType === 'resource') {
                        return `/**
 * Continued user plugin template
 * Type: resource
 * File: ${pluginId}.js
 */

module.exports.resource = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: 'Describe the context this resource provides',
    enabled: false,
    source: 'user',
    async fetch() {
        return {
            success: true,
            message: 'Replace this with resource data.',
        };
    },
};
`;
                }

                if (pluginType === 'skill') {
                        return `/**
 * Continued user plugin template
 * Type: skill
 * File: ${pluginId}.js
 */

module.exports.skill = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: 'Describe the workflow this skill orchestrates',
    enabled: false,
    source: 'user',
    steps: [],
    async execute() {
        return {
            success: true,
            message: 'Replace this with skill orchestration logic.',
        };
    },
};
`;
                }

                return `/**
 * Continued user plugin template
 * Type: tool
 * File: ${pluginId}.js
 */

module.exports.tool = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: 'Describe what this tool does',
    enabled: false,
    source: 'user',
    async execute(args) {
        return {
            success: true,
            args,
            message: 'Replace this with your tool logic.',
        };
    },
};
`;
        }

        private async _createUserPlugin(pluginType: 'tool' | 'resource' | 'skill', pluginName: string) {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) {
                        throw new Error('Open a workspace folder before creating a plugin.');
                }

                const safeName = pluginName
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9_-]+/g, '-')
                        .replace(/^-+|-+$/g, '') || 'my-plugin';

                const pluginId = `${safeName}-${pluginType}`;
                const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
                await vscode.workspace.fs.createDirectory(pluginDir);

                const pluginFile = vscode.Uri.joinPath(pluginDir, `${pluginId}.js`);
                const template = this._pluginTypeTemplate(pluginType, pluginId, pluginName.trim() || 'My Plugin');
                const encoded = new TextEncoder().encode(template);

                await vscode.workspace.fs.writeFile(pluginFile, encoded);

                const doc = await vscode.workspace.openTextDocument(pluginFile);
                await vscode.window.showTextDocument(doc, { preview: false });

                await this._loadUserPlugins();
                if (this._view) {
                        this._view.webview.postMessage({
                                type: 'setPlugins',
                                plugins: this._pluginRegistry?.getAllPlugins(),
                                enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
                        });
                }

                return pluginFile.fsPath;
        }

    private async _findUserPluginFileById(pluginId: string): Promise<vscode.Uri> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Open a workspace folder before managing plugins.');
        }

        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        const entries = await vscode.workspace.fs.readDirectory(pluginDir);
        const pluginFiles = entries.filter(([name, fileType]) => {
            return fileType === vscode.FileType.File && (name.endsWith('.js') || name.endsWith('.ts'));
        });

        let targetName = pluginFiles.find(([name]) => {
            const base = name.replace(/\.(js|ts)$/i, '');
            return base === pluginId;
        })?.[0];

        if (!targetName) {
            for (const [name] of pluginFiles) {
                try {
                    const fileUri = vscode.Uri.joinPath(pluginDir, name);
                    const raw = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder().decode(raw);
                    const idRegex = /\bid\s*:\s*['\"]([^'\"]+)['\"]/;
                    const match = content.match(idRegex);
                    if (match && match[1] === pluginId) {
                        targetName = name;
                        break;
                    }
                } catch {
                    // Skip unreadable plugin files.
                }
            }
        }

        if (!targetName) {
            throw new Error(`Could not find plugin file for '${pluginId}' in .continued/plugins/.`);
        }

        return vscode.Uri.joinPath(pluginDir, targetName);
    }

    private async _openUserPluginForEdit(pluginId: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private _sanitizePluginId(rawValue: string): string {
        const value = String(rawValue || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return value || 'my-plugin';
    }

    private _replacePluginMeta(content: string, nextId: string, nextName: string): string {
        let updated = content;
        updated = updated.replace(/(\bid\s*:\s*['"])[^'"]+(['"])/, `$1${nextId}$2`);
        updated = updated.replace(/(\bname\s*:\s*['"])[^'"]+(['"])/, `$1${nextName}$2`);
        return updated;
    }

    private async _openPluginsFolder() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Open a workspace folder before managing plugins.');
        }

        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        await vscode.workspace.fs.createDirectory(pluginDir);

        try {
            await vscode.commands.executeCommand('revealInExplorer', pluginDir);
        } catch {
            await vscode.commands.executeCommand('revealFileInOS', pluginDir);
        }
    }

    private async _duplicateUserPlugin(pluginId: string, duplicateName?: string, duplicateId?: string) {
        const sourceUri = await this._findUserPluginFileById(pluginId);
        const raw = await vscode.workspace.fs.readFile(sourceUri);
        const sourceContent = new TextDecoder().decode(raw);

        const ext = path.extname(sourceUri.fsPath) || '.js';
        const baseType = pluginId.endsWith('-resource') ? 'resource' : pluginId.endsWith('-skill') ? 'skill' : 'tool';
        const targetName = (duplicateName || `${pluginId} copy`).trim();
        let targetId = this._sanitizePluginId(duplicateId || `${pluginId}-copy`);
        if (!targetId.endsWith(`-${baseType}`)) {
            targetId = `${targetId}-${baseType}`;
        }

        const pluginDir = sourceUri.with({ path: sourceUri.path.replace(/\/[^/]+$/, '') });
        let targetUri = vscode.Uri.joinPath(pluginDir, `${targetId}${ext}`);
        let suffix = 1;
        while (true) {
            try {
                await vscode.workspace.fs.stat(targetUri);
                targetUri = vscode.Uri.joinPath(pluginDir, `${targetId}-${suffix}${ext}`);
                suffix += 1;
            } catch {
                break;
            }
        }

        const finalId = path.basename(targetUri.fsPath, ext);
        const duplicatedContent = this._replacePluginMeta(sourceContent, finalId, targetName);
        await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(duplicatedContent));

        await this._loadUserPlugins();
        if (this._view) {
            this._view.webview.postMessage({
                type: 'setPlugins',
                plugins: this._pluginRegistry?.getAllPlugins(),
                enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
            });
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _renameUserPlugin(pluginId: string, nextPluginId: string, nextPluginName: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        const oldTool = this._pluginRegistry?.getTool(pluginId);
        const oldResource = this._pluginRegistry?.getResource(pluginId);
        const oldSkill = this._pluginRegistry?.getSkill(pluginId);
        const wasEnabled = Boolean(oldTool?.enabled || oldResource?.enabled || oldSkill?.enabled);

        const raw = await vscode.workspace.fs.readFile(targetUri);
        const sourceContent = new TextDecoder().decode(raw);

        const ext = path.extname(targetUri.fsPath) || '.js';
        const normalizedId = this._sanitizePluginId(nextPluginId || pluginId);
        const normalizedName = (nextPluginName || '').trim() || nextPluginId || pluginId;
        const updatedContent = this._replacePluginMeta(sourceContent, normalizedId, normalizedName);

        let destinationUri = targetUri;
        const currentBase = path.basename(targetUri.fsPath, ext);
        if (currentBase !== normalizedId) {
            destinationUri = vscode.Uri.joinPath(targetUri.with({ path: targetUri.path.replace(/\/[^/]+$/, '') }), `${normalizedId}${ext}`);
            try {
                await vscode.workspace.fs.stat(destinationUri);
                throw new Error(`A plugin file named '${normalizedId}${ext}' already exists.`);
            } catch (e: any) {
                if (e && e.code !== 'FileNotFound') {
                    throw e;
                }
            }
        }

        await vscode.workspace.fs.writeFile(destinationUri, new TextEncoder().encode(updatedContent));
        if (destinationUri.toString() !== targetUri.toString()) {
            try {
                await vscode.workspace.fs.delete(targetUri, { useTrash: true });
            } catch {
                await vscode.workspace.fs.delete(targetUri, { useTrash: false });
            }
        }

        if (this._pluginRegistry) {
            await this._pluginRegistry.removePlugin(pluginId);
        }

        await this._loadUserPlugins();

        if (wasEnabled && this._pluginRegistry) {
            await this._pluginRegistry.togglePlugin(normalizedId, true);
        }

        if (this._view) {
            this._view.webview.postMessage({
                type: 'setPlugins',
                plugins: this._pluginRegistry?.getAllPlugins(),
                enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
            });
        }

        const doc = await vscode.workspace.openTextDocument(destinationUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _deleteUserPlugin(pluginId: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        try {
            await vscode.workspace.fs.delete(targetUri, { useTrash: true });
        } catch {
            // Fallback for environments where trash is unavailable.
            await vscode.workspace.fs.delete(targetUri, { useTrash: false });
        }

        if (this._pluginRegistry) {
            await this._pluginRegistry.removePlugin(pluginId);
        }

        await this._loadUserPlugins();

        if (this._view) {
            this._view.webview.postMessage({
                type: 'setPlugins',
                plugins: this._pluginRegistry?.getAllPlugins(),
                enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
            });
        }

        vscode.window.showInformationMessage(`Plugin '${pluginId}' deleted successfully.`);
    }

    private _formatPluginExecutionResult(result: any): string {
        if (result === undefined) {
            return 'Done.';
        }

        if (typeof result === 'string') {
            return result;
        }

        try {
            return `\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
        } catch {
            return String(result);
        }
    }

    private _persistSessionAfterLocalReply(userPrompt: string, mode: string) {
        const allSessions = this._getAllSessions();
        const idx = allSessions.findIndex(s => s.id === this._currentSessionId);
        if (idx !== -1) {
            allSessions[idx].history = this._chatHistory;
            allSessions[idx].mode = mode;
        } else {
            allSessions.unshift({
                id: this._currentSessionId!,
                title: userPrompt.length > 28 ? userPrompt.substring(0, 25) + '...' : userPrompt,
                history: this._chatHistory,
                mode
            });
        }
        this._saveSessions(allSessions);
        this._setScopedState('continued_last_session_id', this._currentSessionId!);
    }

    private async _tryHandlePluginChatCommand(userPrompt: string, mode: string, webviewView: vscode.WebviewView): Promise<boolean> {
        const trimmed = String(userPrompt || '').trim();
        if (!trimmed.startsWith('/')) {
            return false;
        }

        if (!this._pluginRegistry) {
            const message = 'Plugin system is not ready yet. Please try again.';
            webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._persistSessionAfterLocalReply(userPrompt, mode);
            return true;
        }

        if (/^\/plugins$/i.test(trimmed)) {
            const enabledTools = this._pluginRegistry.getEnabledTools().map(t => `- tool: ${t.id}`);
            const enabledResources = this._pluginRegistry.getEnabledResources().map(r => `- resource: ${r.id}`);
            const enabledSkills = this._pluginRegistry.getEnabledSkills().map(s => `- skill: ${s.id}`);
            const lines = [
                'Enabled plugins:',
                ...(enabledTools.length ? enabledTools : ['- tool: (none)']),
                ...(enabledResources.length ? enabledResources : ['- resource: (none)']),
                ...(enabledSkills.length ? enabledSkills : ['- skill: (none)']),
                '',
                'Use:',
                '- /tool <plugin-id> {"arg":"value"}',
                '- /resource <plugin-id>',
                '- /skill <plugin-id> {"arg":"value"}'
            ];
            const message = lines.join('\n');
            webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._persistSessionAfterLocalReply(userPrompt, mode);
            return true;
        }

        const match = trimmed.match(/^\/(tool|resource|skill)\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]+))?$/i);
        if (!match) {
            return false;
        }

        const kind = match[1].toLowerCase();
        const pluginId = match[2];
        const rawArgs = (match[3] || '').trim();

        let parsedArgs: any = {};
        if (rawArgs) {
            try {
                parsedArgs = JSON.parse(rawArgs);
            } catch {
                parsedArgs = { input: rawArgs };
            }
        }

        try {
            if (kind === 'tool') {
                const tool = this._pluginRegistry.getTool(pluginId);
                if (!tool) {
                    throw new Error(`Tool not found: ${pluginId}`);
                }
                if (!tool.enabled) {
                    throw new Error(`Tool '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
                }
                const result = await tool.execute(parsedArgs);
                const message = `Tool '${pluginId}' executed.${this._formatPluginExecutionResult(result)}`;
                webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
                this._chatHistory.push({ role: 'assistant', content: message });
                this._persistSessionAfterLocalReply(userPrompt, mode);
                return true;
            }

            if (kind === 'resource') {
                const resource = this._pluginRegistry.getResource(pluginId);
                if (!resource) {
                    throw new Error(`Resource not found: ${pluginId}`);
                }
                if (!resource.enabled) {
                    throw new Error(`Resource '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
                }
                const result = await resource.fetch();
                const message = `Resource '${pluginId}' fetched.${this._formatPluginExecutionResult(result)}`;
                webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
                this._chatHistory.push({ role: 'assistant', content: message });
                this._persistSessionAfterLocalReply(userPrompt, mode);
                return true;
            }

            const skill = this._pluginRegistry.getSkill(pluginId);
            if (!skill) {
                throw new Error(`Skill not found: ${pluginId}`);
            }
            if (!skill.enabled) {
                throw new Error(`Skill '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
            }
            const result = await skill.execute();
            const message = `Skill '${pluginId}' executed.${this._formatPluginExecutionResult(result)}`;
            webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._persistSessionAfterLocalReply(userPrompt, mode);
            return true;
        } catch (error) {
            const message = `Plugin command failed: ${(error as Error).message}`;
            webviewView.webview.postMessage({ type: 'assistantResponse', content: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._persistSessionAfterLocalReply(userPrompt, mode);
            return true;
        }
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        // Load HTML from file (VSIX uses dist/src, dev workspace uses src)
        const distHtmlPath = path.join(this._context.extensionPath, 'dist', 'src', 'chatView.html');
        const srcHtmlPath = path.join(this._context.extensionPath, 'src', 'chatView.html');
        const htmlPath = fs.existsSync(distHtmlPath) ? distHtmlPath : srcHtmlPath;
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        
        // Replace any placeholders if needed
        // htmlContent = htmlContent.replace(/\{\{PLACEHOLDER\}\}/g, 'value');
        
        webviewView.webview.html = htmlContent;

        // Initialize plugins
        await this._initializePlugins();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const sessions = this._getAllSessions();

            switch (data.type) {
                case 'openSettings': {
                    await showProviderSelector(this._context);
                    break;
                }
                case 'getModels': {
                    const modelNames = await this._collectAvailableModels();

                    const savedModel = this._getScopedState<string>('continued_last_model', 'continued_last_model');
                    webviewView.webview.postMessage({ type: 'setModels', models: modelNames, savedModel });
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions });

                    // Auto-restore last active session on startup
                    const lastSessionId = this._getScopedState<string>('continued_last_session_id', 'continued_last_session_id');
                    if (lastSessionId) {
                        const lastSession = sessions.find(s => s.id === lastSessionId);
                        if (lastSession) {
                            this._currentSessionId = lastSession.id;
                            this._chatHistory = [...lastSession.history];
                            webviewView.webview.postMessage({
                                type: 'loadSessionView',
                                history: this._chatHistory.filter(m => m.role !== 'system'),
                                mode: lastSession.mode
                            });
                        }
                    }
                    break;
                }

                case 'startNewChat': {
                    this._currentSessionId = 'session_' + Date.now();
                    this._chatHistory = [];
                    this._pendingEdit = null;
                    this._pendingDelete = null;
                    this._pendingCommand = null;
                    this._setScopedState('continued_last_session_id', this._currentSessionId);
                    webviewView.webview.postMessage({ type: 'loadSessionView', history: [] });
                    break;
                }
                case 'selectSession': {
                    const found = sessions.find(s => s.id === data.sessionId);
                    if (found) {
                        this._currentSessionId = found.id;
                        this._chatHistory = [...found.history];
                        this._pendingEdit = null;
                        this._pendingDelete = null;
                        this._pendingCommand = null;
                        this._setScopedState('continued_last_session_id', this._currentSessionId);
                        webviewView.webview.postMessage({
                            type: 'loadSessionView',
                            history: this._chatHistory.filter(m => m.role !== 'system'),
                            mode: found.mode
                        });
                    }
                    break;
                }
                case 'showHistoryList': {
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions: this._getAllSessions() });
                    break;
                }
                case 'deleteSession': {
                    const filtered = sessions.filter(s => s.id !== data.sessionId);
                    this._saveSessions(filtered);
                    if (this._currentSessionId === data.sessionId) {
                        this._currentSessionId = null;
                        this._chatHistory = [];
                        this._context.globalState.update(this._scopedStateKey('continued_last_session_id'), undefined);
                    }
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions: filtered });
                    break;
                }
                case 'saveModelPreference': {
                    this._setScopedState('continued_last_model', data.model);
                    break;
                }
                case 'clearHistory': {
                    this._chatHistory = [];
                    this._pendingEdit = null;
                    this._pendingDelete = null;
                    this._pendingCommand = null;
                    if (this._currentSessionId) {
                        const active = this._getAllSessions();
                        const idx = active.findIndex(s => s.id === this._currentSessionId);
                        if (idx !== -1) {
                            active[idx].history = [];
                            this._saveSessions(active);
                        }
                    }
                    break;
                }

                case 'getPlugins': {
                    if (this._pluginRegistry) {
                        const allPlugins = this._pluginRegistry.getAllPlugins();
                        webviewView.webview.postMessage({
                            type: 'setPlugins',
                            plugins: allPlugins,
                            enabledCount: this._pluginRegistry.getEnabledCount()
                        });
                    }
                    break;
                }

                case 'togglePlugin': {
                    if (this._pluginRegistry) {
                        await this._pluginRegistry.togglePlugin(data.pluginId, data.enabled);
                        const allPlugins = this._pluginRegistry.getAllPlugins();
                        webviewView.webview.postMessage({
                            type: 'setPlugins',
                            plugins: allPlugins,
                            enabledCount: this._pluginRegistry.getEnabledCount()
                        });
                    }
                    break;
                }

                case 'createPlugin': {
                    try {
                        const rawName = String(data.pluginName || '').trim();
                        const rawType = String(data.pluginType || 'tool').trim().toLowerCase();
                        const pluginType = rawType === 'resource' || rawType === 'skill' ? rawType : 'tool';
                        const pluginName = rawName || 'My Plugin';
                        await this._createUserPlugin(pluginType, pluginName);
                        webviewView.webview.postMessage({
                            type: 'setPlugins',
                            plugins: this._pluginRegistry?.getAllPlugins(),
                            enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not create plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'editPlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        await this._openUserPluginForEdit(pluginId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not open plugin for editing: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'openPluginsFolder': {
                    try {
                        await this._openPluginsFolder();
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not open plugins folder: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'duplicatePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const duplicateName = String(data.duplicateName || '').trim();
                        const duplicateId = String(data.duplicateId || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        await this._duplicateUserPlugin(pluginId, duplicateName, duplicateId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not duplicate plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'renamePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const nextPluginId = String(data.nextPluginId || '').trim();
                        const nextPluginName = String(data.nextPluginName || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        if (!nextPluginId) {
                            throw new Error('New plugin ID is required.');
                        }
                        await this._renameUserPlugin(pluginId, nextPluginId, nextPluginName);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not rename plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'deletePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const pluginName = String(data.pluginName || pluginId || 'this plugin').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }

                        const choice = await vscode.window.showWarningMessage(
                            `Delete plugin '${pluginName}'? This will remove its file from .continued/plugins/.`,
                            { modal: true },
                            'Delete'
                        );
                        if (choice !== 'Delete') {
                            break;
                        }

                        await this._deleteUserPlugin(pluginId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not delete plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'respondToEdit': {
                    if (data.action === 'Allow' && this._pendingEdit) {
                        await this._applyWorkspaceEdit(this._pendingEdit.relativePath, this._pendingEdit.newContent);
                        webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: this._pendingEdit.relativePath, msgType: 'edit' });
                    }
                    this._pendingEdit = null;
                    break;
                }
                case 'respondToDelete': {
                    if (data.action === 'Allow' && this._pendingDelete) {
                        await this._executeFileDeletion(this._pendingDelete.relativePath);
                        webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: this._pendingDelete.relativePath, msgType: 'delete' });
                    }
                    this._pendingDelete = null;
                    break;
                }
                case 'respondToCommand': {
                    if (data.action === 'Allow' && this._pendingCommand) {
                        const result = await this._executeShellCommand(this._pendingCommand.command);
                        webviewView.webview.postMessage({
                            type: 'commandResult',
                            command: this._pendingCommand.command,
                            output: result
                        });

                        const selectedModel = this._getScopedState<string>('continued_last_model', 'continued_last_model') ?? 'llama3';
                        const modelReply = await this._generateModelResponseFromTool(selectedModel, this._pendingCommand.command, result);
                        if (modelReply) {
                            webviewView.webview.postMessage({ type: 'assistantResponse', content: modelReply });
                            this._chatHistory.push({ role: 'assistant', content: modelReply });
                        }

                        this._chatHistory.push({
                            role: 'assistant',
                            content: this._buildCommandHistoryEntry(this._pendingCommand.command, result)
                        });
                        this._persistCurrentSessionHistory();
                    }
                    this._pendingCommand = null;
                    break;
                }
                case 'respondToSaveDiscard': {
                    if (this._lastFileSnapshot) {
                        const ws = vscode.workspace.workspaceFolders;
                        if (ws) {
                            const fileUri = vscode.Uri.joinPath(ws[0].uri, this._lastFileSnapshot.relativePath);
                            if (data.action === 'Keep') {
                                if (!this._lastFileSnapshot.isDeletion) {
                                    const doc = await vscode.workspace.openTextDocument(fileUri);
                                    await doc.save();
                                    vscode.window.showInformationMessage(`Saved changes to ${this._lastFileSnapshot.relativePath}`);
                                } else {
                                    vscode.window.showInformationMessage(`Deletion confirmed for ${this._lastFileSnapshot.relativePath}`);
                                }
                            } else {
                                if (this._lastFileSnapshot.isDeletion) {
                                    try {
                                        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(this._lastFileSnapshot.originalContent));
                                        vscode.window.showInformationMessage(`Restored deleted file: ${this._lastFileSnapshot.relativePath}`);
                                    } catch (e: any) {
                                        vscode.window.showErrorMessage(`Failed to restore file: ${e.message}`);
                                    }
                                } else {
                                    const edit = new vscode.WorkspaceEdit();
                                    const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(100000, 100000));
                                    edit.replace(fileUri, fullRange, this._lastFileSnapshot.originalContent);
                                    await vscode.workspace.applyEdit(edit);
                                    vscode.window.showWarningMessage(`Rolled back ${this._lastFileSnapshot.relativePath}`);
                                }
                            }
                        }
                    }
                    this._lastFileSnapshot = null;
                    break;
                }

                case 'sendPrompt': {
                    const userPrompt = data.value;
                    const selectedModel = data.model || 'llama3';
                    const mode = data.mode || 'chat';

                    if (!this._currentSessionId) {
                        this._currentSessionId = 'session_' + Date.now();
                    }

                    this._chatHistory.push({ role: 'user', content: userPrompt });

                    const handledPluginCommand = await this._tryHandlePluginChatCommand(userPrompt, mode, webviewView);
                    if (handledPluginCommand) {
                        break;
                    }

                    let systemInstructions = "You are Continued, an elite AI coding assistant. Answer the user's latest query directly.";

                    if (mode === 'agent' || mode === 'agent-auto') {
                        systemInstructions += ` You have access to direct file edit and deletion tools via specific custom tags.

CRITICAL OPERATIONAL MANDATES:
1. To write a NEW file or modify an EXISTING file, you MUST use the <write_file> tag block.
DO NOT wrap the <write_file> tag inside markdown code blocks (such as \`\`\`). Output the tags directly in plain text.
Target format:
<write_file path="path/to/file.ext">
complete content
</write_file>

2. To DELETE or REMOVE a file from the workspace, you MUST output the <delete_file /> tag. 
NEVER just tell the user "I have deleted the file" in natural language without emitting this tag. If you do not emit the tag, the file remains alive on the disk and your operation fails.
Target format exactly:
<delete_file path="path/to/file.ext"/>

If the user asks you to delete a file, output the precise <delete_file path="..." /> tag immediately in your response.`;

                        systemInstructions += `

3. To execute shell commands or scripts, you MUST output this exact tag format:
<run_shell command="your command here"/>

Use this only when the task explicitly requires terminal/script execution.

NEVER output internal tokens like [[COMMAND_RESULT]] or [[/COMMAND_RESULT]].`;

                        const workspaceSummary = await this._buildWorkspaceContextSummary();
                        systemInstructions += `\n\n[WORKSPACE ENVIRONMENT]: The project contains these files (truncated): ${workspaceSummary}`;
                    }

                    const modelHistory = this._trimHistoryForPayload(this._historyForModel());

                    const payload: ChatMessage[] = [
                        { role: 'system', content: systemInstructions },
                        ...modelHistory
                    ];

                    webviewView.webview.postMessage({ type: 'startStream' });

                    try {
                        const isBlablador = selectedModel.startsWith('blablador/');
                        const isOpenAi = selectedModel.startsWith('openai/');
                        const isGemini = selectedModel.startsWith('gemini/');
                        const isAnthropic = selectedModel.startsWith('anthropic/');
                        let fetchUrl = 'http://localhost:11434/api/chat';
                        const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                        let fetchBody: any = {};

                        if (isBlablador) {
                            const pureModel = selectedModel.replace('blablador/', '');
                            const key = await this._context.secrets.get('blablador_api_key');
                            fetchUrl = 'https://api.blablador.fz-juelich.de/v1/chat/completions';
                            fetchHeaders.Authorization = `Bearer ${key}`;
                            fetchBody = {
                                model: pureModel,
                                messages: payload,
                                stream: true
                            };
                        } else if (isOpenAi) {
                            const pureModel = selectedModel.replace('openai/', '');
                            const key = await this._context.secrets.get('openai_api_key');
                            if (!key) {
                                throw new Error('OpenAI API key is not configured. Add it from Settings.');
                            }
                            fetchUrl = 'https://api.openai.com/v1/chat/completions';
                            fetchHeaders.Authorization = `Bearer ${key}`;
                            fetchBody = {
                                model: pureModel,
                                messages: payload,
                                stream: true
                            };
                        } else if (isGemini) {
                            const pureModel = selectedModel.replace('gemini/', '');
                            const key = await this._context.secrets.get('gemini_api_key');
                            if (!key) {
                                throw new Error('Gemini API key is not configured. Add it from Settings.');
                            }

                            const geminiMessages = modelHistory
                                .map(m => ({
                                    role: m.role === 'assistant' ? 'model' : 'user',
                                    parts: [{ text: m.content }]
                                }));

                            fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pureModel)}:generateContent?key=${encodeURIComponent(key)}`;
                            fetchBody = {
                                systemInstruction: {
                                    parts: [{ text: systemInstructions }]
                                },
                                contents: geminiMessages,
                                generationConfig: {
                                    temperature: 0.2,
                                    maxOutputTokens: 4096
                                }
                            };
                        } else if (isAnthropic) {
                            const pureModel = selectedModel.replace('anthropic/', '');
                            const key = await this._context.secrets.get('anthropic_api_key');
                            if (!key) {
                                throw new Error('Anthropic API key is not configured. Add it from Settings.');
                            }

                            const anthropicMessages = modelHistory
                                .map(m => ({
                                    role: m.role === 'assistant' ? 'assistant' : 'user',
                                    content: m.content
                                }));

                            fetchUrl = 'https://api.anthropic.com/v1/messages';
                            fetchHeaders['x-api-key'] = key;
                            fetchHeaders['anthropic-version'] = '2023-06-01';
                            fetchBody = {
                                model: pureModel,
                                system: systemInstructions,
                                messages: anthropicMessages,
                                max_tokens: 4096,
                                stream: true
                            };
                        } else {
                            fetchBody = {
                                model: selectedModel,
                                messages: payload,
                                stream: true
                            };
                        }

                        const response = await fetch(fetchUrl, {
                            method: 'POST',
                            headers: fetchHeaders,
                            body: JSON.stringify(fetchBody)
                        });

                        let completeResponse = '';

                        if (!response.ok) {
                            const errText = await response.text();
                            throw new Error(`Provider request failed (${response.status}): ${errText.slice(0, 300)}`);
                        }

                        if (isGemini) {
                            const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
                            const parts = json.candidates?.[0]?.content?.parts ?? [];
                            completeResponse = parts.map(p => p.text ?? '').join('');
                            if (completeResponse) {
                                webviewView.webview.postMessage({ type: 'streamToken', value: completeResponse });
                            }
                        } else {
                            if (!response.body) {
                                throw new Error('No response body');
                            }

                            const reader = response.body.getReader();
                            const decoder = new TextDecoder();

                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) {break;}

                                const chunk = decoder.decode(value, { stream: true });
                                const lines = chunk.split('\n');

                                for (let line of lines) {
                                    line = line.trim();
                                    if (!line || line === 'data: [DONE]') {continue;}

                                    if (line.startsWith('data: ')) {line = line.substring(6);}

                                    try {
                                        const parsed = JSON.parse(line);
                                        let token = '';

                                        if (parsed.message?.content) {token = parsed.message.content;}
                                        else if (parsed.choices?.[0]?.delta?.content) {token = parsed.choices[0].delta.content;}
                                        else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {token = parsed.delta.text;}

                                        if (token) {
                                            completeResponse += token;
                                            webviewView.webview.postMessage({ type: 'streamToken', value: token });
                                        }
                                    } catch { /* ignore malformed lines */ }
                                }
                            }
                        }

                        let displayResponse = completeResponse;
                        if (mode === 'agent' || mode === 'agent-auto') {
                            displayResponse = this._sanitizeAgentDisplayResponse(displayResponse);
                        }

                        webviewView.webview.postMessage({
                            type: 'assistantResponse',
                            content: displayResponse
                        });

                        if (displayResponse) {
                            this._chatHistory.push({ role: 'assistant', content: displayResponse });
                        }

                        const allSessions = this._getAllSessions();
                        const idx = allSessions.findIndex(s => s.id === this._currentSessionId);
                        if (idx !== -1) {
                            allSessions[idx].history = this._chatHistory;
                        } else {
                            allSessions.unshift({
                                id: this._currentSessionId,
                                title: userPrompt.length > 28 ? userPrompt.substring(0, 25) + '...' : userPrompt,
                                history: this._chatHistory,
                                mode
                            });
                        }
                        this._saveSessions(allSessions);
                        this._setScopedState('continued_last_session_id', this._currentSessionId!);

                        if (mode === 'agent' || mode === 'agent-auto') {
                            const writeMatch = completeResponse.match(/<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/);
                            const deleteMatch = completeResponse.match(/<delete_file\s+path=["']([^"']+)["']\s*\/?>/);
                            const command = this._extractRunShellCommand(completeResponse);

                            if (writeMatch) {
                                const relPath = writeMatch[1].trim();
                                const code = writeMatch[2].trim();

                                if (mode === 'agent-auto') {
                                    await this._applyWorkspaceEdit(relPath, code);
                                    webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: relPath, msgType: 'edit' });
                                } else {
                                    this._pendingEdit = { relativePath: relPath, newContent: code };
                                    webviewView.webview.postMessage({ type: 'requestEditApproval', filename: relPath });
                                }
                            } else if (deleteMatch) {
                                const relPath = deleteMatch[1].trim();

                                if (mode === 'agent-auto') {
                                    await this._executeFileDeletion(relPath);
                                    webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: relPath, msgType: 'delete' });
                                } else {
                                    this._pendingDelete = { relativePath: relPath };
                                    webviewView.webview.postMessage({ type: 'requestDeleteApproval', filename: relPath });
                                }
                            } else if (command) {

                                if (mode === 'agent-auto') {
                                    const result = await this._executeShellCommand(command);
                                    webviewView.webview.postMessage({ type: 'commandResult', command, output: result });

                                    const modelReply = await this._generateModelResponseFromTool(selectedModel, command, result);
                                    if (modelReply) {
                                        webviewView.webview.postMessage({ type: 'assistantResponse', content: modelReply });
                                        this._chatHistory.push({ role: 'assistant', content: modelReply });
                                    }

                                    this._chatHistory.push({
                                        role: 'assistant',
                                        content: this._buildCommandHistoryEntry(command, result)
                                    });
                                    this._persistCurrentSessionHistory(mode);
                                } else {
                                    this._pendingCommand = { command };
                                    webviewView.webview.postMessage({ type: 'requestCommandApproval', command });
                                }
                            }
                        }

                    } catch (err: any) {
                        webviewView.webview.postMessage({
                            type: 'streamToken',
                            value: `\n\nError connecting to server: ${err.message}`
                        });
                    }
                    break;
                }
            }
        });
    }

    private async _applyWorkspaceEdit(relativePath: string, newContent: string) {
        const ws = vscode.workspace.workspaceFolders;
        if (!ws) {
            vscode.window.showErrorMessage('No workspace folder open!');
            return;
        }

        const fileUri = vscode.Uri.joinPath(ws[0].uri, relativePath);
        let original = '';

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            original = doc.getText();
        } catch {
            try {
                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
                original = '';
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to create file: ${e.message}`);
                return;
            }
        }

        this._lastFileSnapshot = { relativePath, originalContent: original, isDeletion: false };

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(100000, 100000));
        edit.replace(fileUri, fullRange, newContent);
        const ok = await vscode.workspace.applyEdit(edit);
        if (ok) {
            await vscode.window.showTextDocument(fileUri, { preview: true });
        } else {
            vscode.window.showErrorMessage(`Failed to apply edit to ${relativePath}`);
        }
    }

    private async _executeFileDeletion(relativePath: string) {
        const ws = vscode.workspace.workspaceFolders;
        if (!ws) {return;}

        const fileUri = vscode.Uri.joinPath(ws[0].uri, relativePath);
        let original = '';

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            original = doc.getText();
        } catch {
            return;
        }

        this._lastFileSnapshot = { relativePath, originalContent: original, isDeletion: true };

        try {
            await vscode.workspace.fs.delete(fileUri, { recursive: true, useTrash: false });
            vscode.window.showWarningMessage(`Agent deleted file: ${relativePath}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete file: ${e.message}`);
        }
    }

    private async _executeShellCommand(command: string): Promise<string> {
        const ws = vscode.workspace.workspaceFolders;
        if (!ws || ws.length === 0) {
            return 'No workspace folder open. Cannot run command.';
        }

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: ws[0].uri.fsPath,
                maxBuffer: 1024 * 1024,
                timeout: 120000,
                shell: '/bin/bash'
            });

            const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');
            return combined || 'Command executed successfully (no output).';
        } catch (error: any) {
            const stderr = error?.stderr ? String(error.stderr).trim() : '';
            const stdout = error?.stdout ? String(error.stdout).trim() : '';
            const message = error?.message ? String(error.message).trim() : 'Unknown shell execution error';
            return [stdout, stderr, message].filter(Boolean).join('\n');
        }
    }

    public async triggerModelRefresh() {
        if (!this._view) {return;}

        const modelNames = await this._collectAvailableModels();

        this._view.webview.postMessage({ type: 'setModels', models: modelNames });
    }
}