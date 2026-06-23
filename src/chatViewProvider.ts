import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { showProviderSelector } from './providers';

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
    private _lastFileSnapshot: { relativePath: string; originalContent: string; isDeletion: boolean } | null = null;

    constructor(
        private readonly _context: vscode.ExtensionContext
    ) {}

    private _getAllSessions(): ChatSession[] {
        return this._context.globalState.get<ChatSession[]>('continued_sessions', []);
    }

    private _saveSessions(sessions: ChatSession[]) {
        this._context.globalState.update('continued_sessions', sessions);
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

        // Load HTML from file
        const htmlPath = path.join(this._context.extensionPath, 'src', 'chatView.html');
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
                    let modelNames: string[] = [];

                    try {
                        const res = await fetch('http://localhost:11434/api/tags');
                        const json = await res.json() as { models: Array<{ name: string }> };
                        modelNames = json.models.map(m => m.name);
                    } catch {
                        modelNames = ['llama3'];
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

                    webviewView.webview.postMessage({ type: 'setModels', models: modelNames });
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions });
                    break;
                }

                case 'startNewChat': {
                    this._currentSessionId = 'session_' + Date.now();
                    this._chatHistory = [];
                    this._pendingEdit = null;
                    this._pendingDelete = null;
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
                    }
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions: filtered });
                    break;
                }
                case 'clearHistory': {
                    this._chatHistory = [];
                    this._pendingEdit = null;
                    this._pendingDelete = null;
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

                        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
                        const fileList = files.map(f => vscode.workspace.asRelativePath(f));
                        systemInstructions += `\n\n[WORKSPACE ENVIRONMENT]: The project currently contains these files: ${fileList.join(', ')}`;
                    }

                    const payload: ChatMessage[] = [
                        { role: 'system', content: systemInstructions },
                        ...this._chatHistory.filter(m => m.role !== 'system')
                    ];

                    webviewView.webview.postMessage({ type: 'startStream' });

                    try {
                        const isBlablador = selectedModel.startsWith('blablador/');
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

                        if (!response.body) {
                            throw new Error('No response body');
                        }

                        const reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let completeResponse = '';

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

                                    if (token) {
                                        completeResponse += token;
                                        webviewView.webview.postMessage({ type: 'streamToken', value: token });
                                    }
                                } catch { /* ignore malformed lines */ }
                            }
                        }

                        webviewView.webview.postMessage({
                            type: 'assistantResponse',
                            content: completeResponse
                        });

                        this._chatHistory.push({ role: 'assistant', content: completeResponse });

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

                        if (mode === 'agent' || mode === 'agent-auto') {
                            const writeMatch = completeResponse.match(/<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/);
                            const deleteMatch = completeResponse.match(/<delete_file\s+path=["']([^"']+)["']\s*\/?>/);

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

    public async triggerModelRefresh() {
        if (!this._view) {return;}

        let modelNames: string[] = [];

        try {
            const res = await fetch('http://localhost:11434/api/tags');
            const json = await res.json() as { models: Array<{ name: string }> };
            modelNames = json.models.map(m => m.name);
        } catch {
            modelNames = ['llama3'];
        }

        try {
            const blabladorKey = await this._context.secrets.get('blablador_api_key');
            if (blabladorKey) {
                const blabladorRes = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                    headers: { Authorization: `Bearer ${blabladorKey}` }
                });
                if (blabladorRes.ok) {
                    const json = await blabladorRes.json() as { data: Array<{ id: string }> };
                    const cloud = json.data.map(m => `blablador/${m.id}`);
                    modelNames = [...modelNames, ...cloud];
                }
            }
        } catch (err) {
            console.error('Failed to fetch Blablador models:', err);
        }

        this._view.webview.postMessage({ type: 'setModels', models: modelNames });
    }
}