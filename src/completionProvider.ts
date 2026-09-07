import * as vscode from 'vscode';
import { getOllamaBaseUrl } from './llmClient';

export class ContinuedCompletionProvider implements vscode.InlineCompletionItemProvider {

    constructor(private readonly _context: vscode.ExtensionContext) {}

    private _workspaceScopeId(document: vscode.TextDocument): string {
        const workspaceFile = vscode.workspace.workspaceFile?.toString();
        if (workspaceFile) {return workspaceFile;}

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder) {return folder.uri.toString();}

        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.toString();
        }

        return 'global';
    }

    private _getPreferredModel(document: vscode.TextDocument): string {
        const scopedKey = `continued_last_model::${this._workspaceScopeId(document)}`;
        return this._context.globalState.get<string>(scopedKey)
            ?? this._context.globalState.get<string>('continued_last_model')
            ?? 'llama3';
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {

        // Only fire when there's meaningful text on the current line
        const lineText = document.lineAt(position.line).text.substring(0, position.character);
        if (lineText.trim().length < 3) { return null; }

        const model = this._getPreferredModel(document);

        // Build prefix (up to 2000 chars before cursor) and suffix (up to 500 after)
        const offsetBefore = document.offsetAt(position);
        const fullText = document.getText();
        const prefix = fullText.slice(Math.max(0, offsetBefore - 2000), offsetBefore);
        const suffix = fullText.slice(offsetBefore, offsetBefore + 500);

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

        try {
            let completion = '';
            const isBlablador = model.startsWith('blablador/');
            const isOpenAi = model.startsWith('openai/');
            const isGemini = model.startsWith('gemini/');
            const isAnthropic = model.startsWith('anthropic/');

            if (isBlablador) {
                const pureModel = model.replace('blablador/', '');
                const key = await this._context.secrets.get('blablador_api_key');
                if (!key) { return null; }

                const response = await fetch('https://api.blablador.fz-juelich.de/v1/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${key}`
                    },
                    body: JSON.stringify({
                        model: pureModel,
                        prompt: prefix,
                        suffix: suffix || undefined,
                        max_tokens: 120,
                        temperature: 0.1,
                        stop: ['\n\n', '```']
                    }),
                    signal: abortController.signal
                });

                if (!response.ok) { return null; }
                const json = await response.json() as { choices: Array<{ text: string }> };
                completion = json.choices?.[0]?.text || '';

            } else if (isOpenAi) {
                const pureModel = model.replace('openai/', '');
                const key = await this._context.secrets.get('openai_api_key');
                if (!key) { return null; }

                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${key}`
                    },
                    body: JSON.stringify({
                        model: pureModel,
                        messages: [
                            {
                                role: 'system',
                                content: 'You are a code completion engine. Return only code continuation text for the cursor position. Do not include markdown fences.'
                            },
                            {
                                role: 'user',
                                content: `Complete the following code at <CURSOR>.\n\nPREFIX:\n${prefix}\n\nSUFFIX:\n${suffix}`
                            }
                        ],
                        temperature: 0.1,
                        max_tokens: 120,
                        stream: false
                    }),
                    signal: abortController.signal
                });

                if (!response.ok) { return null; }
                const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
                completion = json.choices?.[0]?.message?.content || '';

            } else if (isGemini) {
                const pureModel = model.replace('gemini/', '');
                const key = await this._context.secrets.get('gemini_api_key');
                if (!key) { return null; }

                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pureModel)}:generateContent?key=${encodeURIComponent(key)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [
                                {
                                    text: 'You are a code completion engine. Return only code continuation text for the cursor position. Do not include markdown fences.'
                                }
                            ]
                        },
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    {
                                        text: `Complete the following code at <CURSOR>.\n\nPREFIX:\n${prefix}\n\nSUFFIX:\n${suffix}`
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            temperature: 0.1,
                            maxOutputTokens: 120
                        }
                    }),
                    signal: abortController.signal
                });

                if (!response.ok) { return null; }
                const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
                const parts = json.candidates?.[0]?.content?.parts ?? [];
                completion = parts.map(p => p.text ?? '').join('');

            } else if (isAnthropic) {
                const pureModel = model.replace('anthropic/', '');
                const key = await this._context.secrets.get('anthropic_api_key');
                if (!key) { return null; }

                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': key,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: pureModel,
                        system: 'You are a code completion engine. Return only code continuation text for the cursor position. Do not include markdown fences.',
                        messages: [
                            {
                                role: 'user',
                                content: `Complete the following code at <CURSOR>.\n\nPREFIX:\n${prefix}\n\nSUFFIX:\n${suffix}`
                            }
                        ],
                        max_tokens: 120,
                        temperature: 0.1
                    }),
                    signal: abortController.signal
                });

                if (!response.ok) { return null; }
                const json = await response.json() as { content?: Array<{ type: string; text?: string }> };
                completion = (json.content ?? [])
                    .filter(block => block.type === 'text')
                    .map(block => block.text ?? '')
                    .join('');

            } else {
                // Ollama — use /api/generate with optional FIM suffix
                const response = await fetch(`${getOllamaBaseUrl()}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt: prefix,
                        suffix: suffix || undefined,
                        options: {
                            temperature: 0.1,
                            num_predict: 120,
                            stop: ['\n\n']
                        },
                        stream: false
                    }),
                    signal: abortController.signal
                });

                if (!response.ok) { return null; }
                const json = await response.json() as { response: string };
                completion = json.response || '';
            }

            if (!completion.trim()) { return null; }

            return new vscode.InlineCompletionList([
                new vscode.InlineCompletionItem(
                    completion,
                    new vscode.Range(position, position)
                )
            ]);

        } catch {
            return null;
        } finally {
            cancelDisposable.dispose();
        }
    }
}
