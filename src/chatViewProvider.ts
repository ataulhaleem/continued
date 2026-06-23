import * as vscode from 'vscode';
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
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const sessions = this._getAllSessions();

            switch (data.type) {
                case 'openSettings': {
                    await showProviderSelector(this._context);
                    break;
                }
                case 'getModels': {
                    let modelNames: string[] = [];

                    // 1. Fetch Local Ollama Models
                    try {
                        const res = await fetch('http://localhost:11434/api/tags');
                        const json = await res.json() as { models: Array<{ name: string }> };
                        modelNames = json.models.map((m) => m.name);
                    } catch {
                        modelNames = ['llama3']; 
                    }

                    // 2. Fetch Blablador Cloud Models if API Key exists
                    try {
                        const blabladorKey = await this._context.secrets.get('blablador_api_key');
                        if (blabladorKey) {
                            const blabladorRes = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                                headers: { 'Authorization': `Bearer ${blabladorKey}` }
                            });
                            
                            if (blabladorRes.ok) {
                                const json = await blabladorRes.json() as { data: Array<{ id: string }> };
                                const cloudModels = json.data.map(m => `blablador/${m.id}`);
                                modelNames = [...modelNames, ...cloudModels];
                            }
                        }
                    } catch (err) {
                        console.error("Failed to append Blablador models:", err);
                    }

                    // 3. Post combined array cleanly to the webview
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
                        const activeSessions = this._getAllSessions();
                        const index = activeSessions.findIndex(s => s.id === this._currentSessionId);
                        if (index !== -1) {
                            activeSessions[index].history = [];
                            this._saveSessions(activeSessions);
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
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, this._lastFileSnapshot.relativePath);
                            
                            if (data.action === 'Keep') {
                                if (!this._lastFileSnapshot.isDeletion) {
                                    const doc = await vscode.workspace.openTextDocument(fileUri);
                                    await doc.save();
                                    vscode.window.showInformationMessage(`Saved changes cleanly to ${this._lastFileSnapshot.relativePath}!`);
                                } else {
                                    vscode.window.showInformationMessage(`Deletion permanently confirmed for ${this._lastFileSnapshot.relativePath}!`);
                                }
                            } else if (data.action === 'Discard') {
                                if (this._lastFileSnapshot.isDeletion) {
                                    try {
                                        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(this._lastFileSnapshot.originalContent));
                                        vscode.window.showInformationMessage(`Restored deleted file: ${this._lastFileSnapshot.relativePath}`);
                                    } catch (err: any) {
                                        vscode.window.showErrorMessage(`Failed to restore file: ${err.message}`);
                                    }
                                } else {
                                    const edit = new vscode.WorkspaceEdit();
                                    const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(100000, 100000));
                                    edit.replace(fileUri, fullRange, this._lastFileSnapshot.originalContent);
                                    await vscode.workspace.applyEdit(edit);
                                    vscode.window.showWarningMessage(`Discarded changes. Rolled back ${this._lastFileSnapshot.relativePath}.`);
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

                    let dynamicPayload: ChatMessage[] = [
                        { role: 'system', content: systemInstructions },
                        ...this._chatHistory.filter(m => m.role !== 'system')
                    ];

                    webviewView.webview.postMessage({ type: 'startStream' });

                    try {
                        const isBlablador = selectedModel.startsWith('blablador/');
                        let fetchUrl = 'http://localhost:11434/api/chat';
                        let fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                        let fetchBody: any = {};

                        if (isBlablador) {
                            const pureModelName = selectedModel.replace('blablador/', '');
                            const blabladorKey = await this._context.secrets.get('blablador_api_key');
                            
                            fetchUrl = 'https://api.blablador.fz-juelich.de/v1/chat/completions';
                            fetchHeaders['Authorization'] = `Bearer ${blabladorKey}`;
                            fetchBody = {
                                model: pureModelName,
                                messages: dynamicPayload,
                                stream: true
                            };
                        } else {
                            fetchBody = {
                                model: selectedModel,
                                messages: dynamicPayload,
                                stream: true
                            };
                        }

                        const response = await fetch(fetchUrl, {
                            method: 'POST',
                            headers: fetchHeaders,
                            body: JSON.stringify(fetchBody)
                        });

                        if (!response.body) { throw new Error('No response body'); }

                        const reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let completeResponse = "";

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) { break; }

                            const chunk = decoder.decode(value, { stream: true });
                            const lines = chunk.split('\n');
                            
                            for (let line of lines) {
                                line = line.trim();
                                if (line === '' || line === 'data: [DONE]') { continue; }
                                
                                if (line.startsWith('data: ')) {
                                    line = line.substring(6);
                                }

                                try {
                                    const parsed = JSON.parse(line);
                                    let token = "";
                                    
                                    if (parsed.message?.content) {
                                        token = parsed.message.content;
                                    } else if (parsed.choices?.[0]?.delta?.content) {
                                        token = parsed.choices[0].delta.content;
                                    }

                                    if (token) {
                                        completeResponse += token;
                                        webviewView.webview.postMessage({ 
                                            type: 'streamToken', 
                                            value: token 
                                        });
                                    }
                                } catch (e) {}
                            }
                        }

                        this._chatHistory.push({ role: 'assistant', content: completeResponse });

                        const activeSessions = this._getAllSessions();
                        const existingIdx = activeSessions.findIndex(s => s.id === this._currentSessionId);
                        
                        if (existingIdx !== -1) {
                            activeSessions[existingIdx].history = this._chatHistory;
                        } else {
                            activeSessions.unshift({
                                id: this._currentSessionId,
                                title: userPrompt.length > 28 ? userPrompt.substring(0, 25) + '...' : userPrompt,
                                history: this._chatHistory,
                                mode: mode
                            });
                        }
                        this._saveSessions(activeSessions);

                        if (mode === 'agent' || mode === 'agent-auto') {
                            const writeMatch = completeResponse.match(/<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/);
                            const deleteMatch = completeResponse.match(/<delete_file\s+path=["']([^"']+)["']\s*\/?>/);

                            if (writeMatch) {
                                const relPath = writeMatch[1].trim();
                                const codeBlock = writeMatch[2].trim();

                                if (mode === 'agent-auto') {
                                    await this._applyWorkspaceEdit(relPath, codeBlock);
                                    webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: relPath, msgType: 'edit' });
                                } else {
                                    this._pendingEdit = { relativePath: relPath, newContent: codeBlock };
                                    webviewView.webview.postMessage({ 
                                        type: 'requestEditApproval', 
                                        filename: relPath 
                                    });
                                }
                            } else if (deleteMatch) {
                                const delPath = deleteMatch[1].trim();

                                if (mode === 'agent-auto') {
                                    await this._executeFileDeletion(delPath);
                                    webviewView.webview.postMessage({ type: 'showSaveDiscardPanel', filename: delPath, msgType: 'delete' });
                                } else {
                                    this._pendingDelete = { relativePath: delPath };
                                    webviewView.webview.postMessage({
                                        type: 'requestDeleteApproval',
                                        filename: delPath
                                    });
                                }
                            }
                        }

                    } catch (error: any) {
                        webviewView.webview.postMessage({ 
                            type: 'streamToken', 
                            value: `\n\nError connecting to server: ${error.message}` 
                        });
                    }
                    break;
                }
            }
        });
    }

    private async _applyWorkspaceEdit(relativePath: string, newContent: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { 
            vscode.window.showErrorMessage("No active workspace folder open!");
            return; 
        }

        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
        
        let originalContent = "";
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            originalContent = doc.getText();
        } catch {
            try {
                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
                originalContent = "";
            } catch (fsErr: any) {
                vscode.window.showErrorMessage(`Failed to create file path: ${fsErr.message}`);
                return;
            }
        }
        this._lastFileSnapshot = { relativePath, originalContent, isDeletion: false };

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(100000, 100000));
        
        edit.replace(fileUri, fullRange, newContent);
        const success = await vscode.workspace.applyEdit(edit);
        
        if (success) {
            await vscode.window.showTextDocument(fileUri, { preview: true });
        } else {
            vscode.window.showErrorMessage(`VS Code workspace edit failed to apply to ${relativePath}`);
        }
    }

    private async _executeFileDeletion(relativePath: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return; }

        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
        
        let originalContent = "";
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            originalContent = doc.getText();
        } catch {
            return;
        }

        this._lastFileSnapshot = { relativePath, originalContent, isDeletion: true };

        try {
            await vscode.workspace.fs.delete(fileUri, { recursive: true, useTrash: false });
            vscode.window.showWarningMessage(`Agent deleted file: ${relativePath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete file: ${err.message}`);
        }
    }

private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                :root {
                    --border-radius-sm: 4px;
                    --border-radius-md: 8px;
                    --border-radius-lg: 12px;
                    --transition-fast: 0.15s ease;
                }

                body {
                    padding: 12px;
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-sideBar-background);
                    margin: 0;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                }

                .hidden { display: none !important; }
                
                /* Global Scrollbar Customization */
                ::-webkit-scrollbar { width: 6px; height: 6px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 10px; }
                ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

                /* History Screen Styling */
                #history-screen { display: flex; flex-direction: column; gap: 12px; height: 100%; }
                
                .new-chat-btn {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 10px 14px;
                    font-weight: 600;
                    border-radius: var(--border-radius-md);
                    cursor: pointer;
                    text-align: center;
                    transition: filter var(--transition-fast), transform var(--transition-fast);
                    font-size: 13px;
                }
                .new-chat-btn:hover {
                    filter: brightness(1.15);
                    transform: translateY(-1px);
                }
                .new-chat-btn:active { transform: translateY(0); }

                .section-header {
                    font-size: 11px;
                    font-weight: 700;
                    margin-top: 8px;
                    letter-spacing: 0.05em;
                    color: var(--vscode-descriptionForeground);
                    text-transform: uppercase;
                }

                #sessions-list-container {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    overflow-y: auto;
                    flex-grow: 1;
                }

                .session-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: var(--vscode-keybindingTable-rowsBackground, var(--vscode-textBlockQuote-background));
                    padding: 10px 12px;
                    border-radius: var(--border-radius-md);
                    cursor: pointer;
                    border: 1px solid var(--vscode-widget-border, transparent);
                    transition: border-color var(--transition-fast), background var(--transition-fast);
                }
                .session-item:hover { 
                    border-color: var(--vscode-button-background);
                    background: var(--vscode-list-hoverBackground);
                }
                .session-title { flex-grow: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
                .delete-session-btn { 
                    background: transparent; 
                    color: var(--vscode-descriptionForeground); 
                    border: none; 
                    cursor: pointer; 
                    font-size: 16px;
                    line-height: 1;
                    padding: 2px 6px; 
                    border-radius: var(--border-radius-sm);
                    transition: color var(--transition-fast), background var(--transition-fast);
                }
                .delete-session-btn:hover {
                    color: var(--vscode-errorForeground);
                    background: var(--vscode-list-invalidItemForeground, rgba(255,0,0,0.1));
                }

                /* Active Chat Interface layout */
                #chat-container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
                
                #controls-row { 
                    display: flex; 
                    gap: 6px; 
                    margin-bottom: 12px; 
                    align-items: center; 
                    width: 100%;
                    background: var(--vscode-editor-background);
                    padding: 6px;
                    border-radius: var(--border-radius-md);
                    border: 1px solid var(--vscode-panel-border);
                    box-sizing: border-box;
                }
                
                select, button.control-btn {
                    background: var(--vscode-dropdown-background);
                    color: var(--vscode-dropdown-foreground);
                    border: 1px solid var(--vscode-dropdown-border);
                    padding: 5px 8px;
                    font-size: 12px;
                    border-radius: var(--border-radius-sm);
                    outline: none;
                }
                select { cursor: pointer; }
                button.control-btn:hover {
                    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
                    cursor: pointer;
                }
                
                #messages {
                    flex-grow: 1;
                    overflow-y: auto;
                    margin-bottom: 12px;
                    padding: 4px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                
                .message { 
                    padding: 10px 14px; 
                    border-radius: var(--border-radius-md); 
                    word-wrap: break-word; 
                    white-space: pre-wrap; 
                    font-size: 13px;
                    line-height: 1.45;
                    max-width: 90%;
                }
                .user { 
                    background: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                    align-self: flex-end;
                    border-bottom-right-radius: 2px;
                }
                .ai { 
                    background: var(--vscode-textBlockQuote-background); 
                    color: var(--vscode-foreground);
                    align-self: flex-start;
                    border-left: 3px solid var(--vscode-button-background);
                    border-top-left-radius: 2px;
                }
                
                /* Agent Dynamic Notification Sheets */
                #approval-panel, #delete-panel, #save-discard-panel {
                    display: none;
                    flex-direction: column;
                    background: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-editorWidget-border);
                    padding: 12px;
                    margin-bottom: 12px;
                    border-radius: var(--border-radius-lg);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                }
                @keyframes slideUp {
                    from { transform: translateY(8px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                
                .panel-header { font-size: 12px; margin-bottom: 10px; font-weight: 600; line-height: 1.3; }
                .approval-header { color: var(--vscode-editorWarning-foreground); }
                .delete-header { color: var(--vscode-errorForeground); }
                .save-discard-header { color: var(--vscode-editorInfo-foreground); }
                
                .button-row { display: flex; gap: 8px; }
                .button-row button { 
                    flex: 1; 
                    padding: 6px 10px; 
                    border: none; 
                    cursor: pointer; 
                    font-weight: 600; 
                    font-size: 12px;
                    border-radius: var(--border-radius-sm);
                    transition: filter var(--transition-fast);
                }
                .button-row button:hover { filter: brightness(1.1); }
                
                .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
                .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                .btn-danger { background: var(--vscode-errorForeground); color: white; }

                /* Modern Chat Input Box Pill */
                #input-area { 
                    display: flex; 
                    flex-direction: column;
                    background: var(--vscode-input-background); 
                    border: 1px solid var(--vscode-input-border);
                    border-radius: var(--border-radius-lg);
                    padding: 8px;
                    transition: border-color var(--transition-fast);
                }
                #input-area:focus-within {
                    border-color: var(--vscode-focusBorder);
                }
                
                textarea { 
                    width: 100%;
                    background: transparent; 
                    color: var(--vscode-input-foreground); 
                    border: none;
                    resize: none; 
                    outline: none;
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    box-sizing: border-box;
                    padding: 2px 4px;
                }
                
                .input-actions-row {
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 4px;
                }

                button#send-btn { 
                    background: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                    border: none; 
                    cursor: pointer; 
                    padding: 6px 14px; 
                    font-weight: 600;
                    font-size: 12px;
                    border-radius: var(--border-radius-sm);
                    transition: filter var(--transition-fast), transform var(--transition-fast);
                }
                button#send-btn:hover { filter: brightness(1.1); }
                button#send-btn:active { transform: scale(0.98); }
            </style>
        </head>
        <body>
            <div id="history-screen">
                <button class="new-chat-btn" id="new-chat-btn">+ Start New Conversation</button>
                <div class="section-header">Recent Chats</div>
                <div id="sessions-list-container"></div>
            </div>

            <div id="chat-container" class="hidden">
                <div id="controls-row">
                    <button id="back-btn" class="control-btn" title="Go Back">⬅</button>
                    <select id="model-select" style="flex: 1 1 40%; min-width: 0;"><option value="llama3">Loading...</option></select>
                    <select id="mode-select" style="flex: 1 1 40%; min-width: 0;">
                        <option value="agent">Agent Mode</option>
                        <option value="agent-auto">Agent Auto-Edit</option>
                        <option value="chat">Chat Mode</option>
                    </select>
                    <button id="clear-btn" class="control-btn" title="Clear Chat">Clear</button>
                    <button id="settings-btn" class="control-btn" style="padding: 4px 6px;" title="Import Cloud Provider">⚙️</button>
                </div>
                
                <div id="messages"></div>

                <div id="approval-panel">
                    <div id="approval-msg" class="panel-header approval-header">Agent wants to edit file...</div>
                    <div class="button-row">
                        <button id="allow-btn" class="btn-primary">Allow Edit</button>
                        <button id="deny-btn" class="btn-secondary">Deny</button>
                    </div>
                </div>

                <div id="delete-panel">
                    <div id="delete-msg" class="panel-header delete-header">Agent wants to delete file...</div>
                    <div class="button-row">
                        <button id="allow-del-btn" class="btn-danger">Allow Delete</button>
                        <button id="deny-del-btn" class="btn-secondary">Deny</button>
                    </div>
                </div>

                <div id="save-discard-panel">
                    <div id="save-discard-msg" class="panel-header save-discard-header">Review transaction...</div>
                    <div class="button-row">
                        <button id="keep-btn" class="btn-primary">Keep Action</button>
                        <button id="discard-btn" class="btn-danger">Discard / Undo</button>
                    </div>
                </div>

                <div id="input-area">
                    <textarea id="prompt" rows="3" placeholder="Ask Continued..."></textarea>
                    <div class="input-actions-row">
                        <button id="send-btn">Send</button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                const historyScreen = document.getElementById('history-screen');
                const sessionsListContainer = document.getElementById('sessions-list-container');
                const newChatBtn = document.getElementById('new-chat-btn');
                
                const chatContainer = document.getElementById('chat-container');
                const backBtn = document.getElementById('back-btn');
                const sendBtn = document.getElementById('send-btn');
                const clearBtn = document.getElementById('clear-btn');
                const settingsBtn = document.getElementById('settings-btn');
                const promptInput = document.getElementById('prompt');
                const messagesDiv = document.getElementById('messages');
                const modelSelect = document.getElementById('model-select');
                const modeSelect = document.getElementById('mode-select');
                
                const approvalPanel = document.getElementById('approval-panel');
                const approvalMsg = document.getElementById('approval-msg');
                const allowBtn = document.getElementById('allow-btn');
                const denyBtn = document.getElementById('deny-btn');

                const deletePanel = document.getElementById('delete-panel');
                const deleteMsg = document.getElementById('delete-msg');
                const allowDelBtn = document.getElementById('allow-del-btn');
                const denyDelBtn = document.getElementById('deny-del-btn');

                const saveDiscardPanel = document.getElementById('save-discard-panel');
                const saveDiscardMsg = document.getElementById('save-discard-msg');
                const keepBtn = document.getElementById('keep-btn');
                const discardBtn = document.getElementById('discard-btn');
                
                let currentAiBubble = null;

                vscode.postMessage({ type: 'getModels' });

                newChatBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'startNewChat' });
                });

                settingsBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openSettings' });
                });

                backBtn.addEventListener('click', () => {
                    chatContainer.classList.add('hidden');
                    historyScreen.classList.remove('hidden');
                    vscode.postMessage({ type: 'showHistoryList' });
                });

                clearBtn.addEventListener('click', () => {
                    messagesDiv.innerHTML = '';
                    approvalPanel.style.display = 'none';
                    deletePanel.style.display = 'none';
                    saveDiscardPanel.style.display = 'none';
                    vscode.postMessage({ type: 'clearHistory' });
                });

                sendBtn.addEventListener('click', () => {
                    const text = promptInput.value.trim();
                    if (!text) return;
                    
                    appendMessage(text, 'user');
                    vscode.postMessage({ 
                        type: 'sendPrompt', 
                        value: text,
                        model: modelSelect.value,
                        mode: modeSelect.value
                    });
                    promptInput.value = '';
                });

                promptInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendBtn.click();
                    }
                });

                allowBtn.addEventListener('click', () => {
                    approvalPanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToEdit', action: 'Allow' });
                });

                denyBtn.addEventListener('click', () => {
                    approvalPanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToEdit', action: 'Deny' });
                });

                allowDelBtn.addEventListener('click', () => {
                    deletePanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToDelete', action: 'Allow' });
                });

                denyDelBtn.addEventListener('click', () => {
                    deletePanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToDelete', action: 'Deny' });
                });

                keepBtn.addEventListener('click', () => {
                    saveDiscardPanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToSaveDiscard', action: 'Keep' });
                });

                discardBtn.addEventListener('click', () => {
                    saveDiscardPanel.style.display = 'none';
                    vscode.postMessage({ type: 'respondToSaveDiscard', action: 'Discard' });
                });

                function appendMessage(text, role) {
                    chatContainer.classList.remove('hidden');
                    historyScreen.classList.add('hidden');
                    
                    const msgDiv = document.createElement('div');
                    msgDiv.className = 'message ' + (role === 'user' ? 'user' : 'ai');
                    msgDiv.textContent = text;
                    messagesDiv.appendChild(msgDiv);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                    
                    if (role === 'assistant') {
                        currentAiBubble = msgDiv;
                    }
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'loadSessionView': {
                            chatContainer.classList.remove('hidden');
                            historyScreen.classList.add('hidden');
                            messagesDiv.innerHTML = '';
                            if(message.mode) { modeSelect.value = message.mode; }
                            message.history.forEach(m => {
                                appendMessage(m.content, m.role);
                            });
                            break;
                        }
                        case 'renderSessions': {
                            sessionsListContainer.innerHTML = '';
                            message.sessions.forEach(s => {
                                const item = document.createElement('div');
                                item.className = 'session-item';
                                
                                const titleSpan = document.createElement('span');
                                titleSpan.className = 'session-title';
                                titleSpan.textContent = s.title || 'Untitled Chat';
                                titleSpan.addEventListener('click', () => {
                                    vscode.postMessage({ type: 'selectSession', sessionId: s.id });
                                });
                                
                                const delBtn = document.createElement('button');
                                delBtn.className = 'delete-session-btn';
                                delBtn.textContent = '×';
                                delBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
                                });
                                
                                item.appendChild(titleSpan);
                                item.appendChild(delBtn);
                                sessionsListContainer.appendChild(item);
                            });
                            break;
                        }
                        case 'setModels': {
                            modelSelect.innerHTML = '';
                            message.models.forEach(m => {
                                const opt = document.createElement('option');
                                opt.value = m;
                                opt.textContent = m;
                                modelSelect.appendChild(opt);
                            });
                            break;
                        }
                        case 'startStream': {
                            appendMessage('', 'assistant');
                            break;
                        }
                        case 'streamToken': {
                            if (currentAiBubble) {
                                currentAiBubble.textContent += message.value;
                                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                            }
                            break;
                        }
                        case 'requestEditApproval': {
                            approvalMsg.textContent = 'Agent wants to edit: ' + message.filename;
                            approvalPanel.style.display = 'flex';
                            break;
                        }
                        case 'requestDeleteApproval': {
                            deleteMsg.textContent = 'Agent wants to delete: ' + message.filename;
                            deletePanel.style.display = 'flex';
                            break;
                        }
                        case 'showSaveDiscardPanel': {
                            saveDiscardMsg.textContent = (message.msgType === 'delete' ? 'Deleted ' : 'Modified ') + message.filename + '. Commit changes?';
                            saveDiscardPanel.style.display = 'flex';
                            break;
                        }
                    }
                });
            </script>
        </body>
        </html>`;
    }

    public async triggerModelRefresh() {
        if (!this._view) {
            return; // Webview isn't open or active yet
        }
        
        let modelNames: string[] = [];

        // 1. Fetch Local Ollama Models
        try {
            const res = await fetch('http://localhost:11434/api/tags');
            const json = await res.json() as { models: Array<{ name: string }> };
            modelNames = json.models.map((m) => m.name);
        } catch {
            modelNames = ['llama3']; 
        }

        // 2. Fetch Blablador Cloud Models
        try {
            const blabladorKey = await this._context.secrets.get('blabladoor_api_key');
            if (blabladorKey) {
                const blabladorRes = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                    headers: { 'Authorization': `Bearer ${blabladorKey}` }
                });
                
                if (blabladorRes.ok) {
                    const json = await blabladorRes.json() as { data: Array<{ id: string }> };
                    const cloudModels = json.data.map(m => `blablador/${m.id}`);
                    modelNames = [...modelNames, ...cloudModels];
                }
            }
        } catch (err) {
            console.error("Failed to append Blablador models:", err);
        }

        // Push the fresh array directly to the active webview window immediately
        this._view.webview.postMessage({ type: 'setModels', models: modelNames });
    }
}