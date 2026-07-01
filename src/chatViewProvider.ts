import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { showProviderSelector } from './providers';

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
        const modelHistory = this._historyForModel();
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

                        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
                        const fileList = files.map(f => vscode.workspace.asRelativePath(f));
                        systemInstructions += `\n\n[WORKSPACE ENVIRONMENT]: The project currently contains these files: ${fileList.join(', ')}`;
                    }

                    const modelHistory = this._historyForModel();

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