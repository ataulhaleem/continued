/**
 * LlmClient for the browser build. Same provider logic as the VS Code extension,
 * with secrets and the Ollama URL injected instead of read from the VS Code API.
 *
 * Extension pages and background workers may call any host listed in
 * `host_permissions`, so no CORS configuration is needed on the Ollama side.
 */

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type Provider = 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'blablador';

export interface ModelCallOptions {
    jsonMode?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxTokens?: number;
}

export interface CompletionResult {
    text: string;
    reasoning: string;
    finishReason: string;
}

export interface StreamHandlers {
    onToken: (token: string) => void;
    onThinking?: (token: string) => void;
    onThinkingDone?: () => void;
}

interface PreparedRequest {
    provider: Provider;
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

export type SecretGetter = (name: 'openai' | 'gemini' | 'anthropic' | 'blablador') => Promise<string | undefined>;
export type LlmLogger = (line: string) => void;

export function detectProvider(model: string): Provider {
    if (model.startsWith('blablador/')) { return 'blablador'; }
    if (model.startsWith('openai/')) { return 'openai'; }
    if (model.startsWith('gemini/')) { return 'gemini'; }
    if (model.startsWith('anthropic/')) { return 'anthropic'; }
    return 'ollama';
}

export function stripProviderPrefix(model: string): string {
    return model.replace(/^(blablador|openai|gemini|anthropic)\//, '');
}

export function mergeConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
    const merged: ChatMessage[] = [];
    for (const message of messages) {
        const last = merged[merged.length - 1];
        if (last && last.role === message.role) {
            last.content = `${last.content}\n\n${message.content}`;
        } else {
            merged.push({ ...message });
        }
    }
    if (merged.length > 0 && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(conversation continues)' });
    }
    return merged;
}

export class LlmClient {
    private readonly jsonUnsupported = new Set<string>();

    constructor(
        private readonly secrets: SecretGetter,
        private readonly ollamaBaseUrl: () => Promise<string>,
        private readonly log: LlmLogger = () => { /* silent */ }
    ) {}

    private async requireKey(name: 'openai' | 'gemini' | 'anthropic' | 'blablador', label: string): Promise<string> {
        const key = await this.secrets(name);
        if (!key) { throw new Error(`${label} API key is not configured. Add it in the extension options.`); }
        return key;
    }

    private async prepare(model: string, systemPrompt: string, history: ChatMessage[], stream: boolean, options: ModelCallOptions): Promise<PreparedRequest> {
        const provider = detectProvider(model);
        const pureModel = stripProviderPrefix(model);
        const messages = mergeConsecutiveRoles(history.filter(m => m.role !== 'system'));
        const withSystem: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        switch (provider) {
            case 'ollama': {
                const body: Record<string, unknown> = { model: pureModel || 'llama3', messages: withSystem, stream };
                if (options.jsonMode) { body.format = 'json'; }
                if (options.maxTokens) { body.options = { num_predict: options.maxTokens }; }
                return { provider, url: `${(await this.ollamaBaseUrl()).replace(/\/+$/, '')}/api/chat`, headers, body };
            }
            case 'openai': {
                headers.Authorization = `Bearer ${await this.requireKey('openai', 'OpenAI')}`;
                const body: Record<string, unknown> = { model: pureModel, messages: withSystem, stream };
                if (options.jsonMode && !this.jsonUnsupported.has(model)) { body.response_format = { type: 'json_object' }; }
                return { provider, url: 'https://api.openai.com/v1/chat/completions', headers, body };
            }
            case 'blablador': {
                headers.Authorization = `Bearer ${await this.requireKey('blablador', 'Blablador')}`;
                const body: Record<string, unknown> = { model: pureModel, messages: withSystem, stream };
                if (options.jsonMode && !this.jsonUnsupported.has(model)) { body.response_format = { type: 'json_object' }; }
                return { provider, url: 'https://api.blablador.fz-juelich.de/v1/chat/completions', headers, body };
            }
            case 'gemini': {
                const key = await this.requireKey('gemini', 'Gemini');
                const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
                const generationConfig: Record<string, unknown> = { temperature: 0.2, maxOutputTokens: options.maxTokens ?? 8192 };
                if (options.jsonMode) { generationConfig.responseMimeType = 'application/json'; }
                return {
                    provider,
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pureModel)}:generateContent?key=${encodeURIComponent(key)}`,
                    headers,
                    body: { systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig }
                };
            }
            case 'anthropic': {
                headers['x-api-key'] = await this.requireKey('anthropic', 'Anthropic');
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
                return {
                    provider,
                    url: 'https://api.anthropic.com/v1/messages',
                    headers,
                    body: {
                        model: pureModel,
                        system: systemPrompt,
                        messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                        max_tokens: options.maxTokens ?? 16000,
                        stream
                    }
                };
            }
        }
    }

    private async send(request: PreparedRequest, options: ModelCallOptions): Promise<Response> {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? 120000;
        const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        const onExternalAbort = () => controller.abort(new Error('cancelled'));
        if (options.signal) {
            if (options.signal.aborted) { onExternalAbort(); }
            else { options.signal.addEventListener('abort', onExternalAbort, { once: true }); }
        }
        try {
            const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`${request.provider} request failed (${response.status}): ${errText.slice(0, 400)}`);
            }
            return response;
        } catch (error: unknown) {
            const err = error as Error;
            if (options.signal?.aborted) { throw new Error('Cancelled.'); }
            if (err.name === 'AbortError' || controller.signal.aborted) {
                throw new Error(`Model call timed out after ${Math.round(timeoutMs / 1000)}s.`);
            }
            if (/Failed to fetch|NetworkError/i.test(err.message) && request.provider === 'ollama') {
                throw new Error(`Could not reach Ollama at ${request.url}. Is it running? Check the URL in the extension options.`);
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            options.signal?.removeEventListener('abort', onExternalAbort);
        }
    }

    async completeDetailed(model: string, systemPrompt: string, history: ChatMessage[], options: ModelCallOptions = {}): Promise<CompletionResult> {
        const request = await this.prepare(model, systemPrompt, history, false, options);
        this.log(`→ ${model} (${request.provider}, ${history.length} msgs${options.jsonMode ? ', json' : ''})`);
        let response: Response;
        try {
            response = await this.send(request, options);
        } catch (error: unknown) {
            const message = (error as Error).message ?? String(error);
            const usedJson = options.jsonMode && !this.jsonUnsupported.has(model) && (request.provider === 'blablador' || request.provider === 'openai');
            if (usedJson && /\(400\)/.test(message) && !options.signal?.aborted) {
                this.jsonUnsupported.add(model);
                this.log(`← ${model}: rejected JSON mode; retrying without`);
                return this.completeDetailed(model, systemPrompt, history, options);
            }
            throw error;
        }
        const json = await response.json() as Record<string, unknown>;
        const text = this.extractText(request.provider, json).trim();
        const reasoning = this.extractReasoning(request.provider, json).trim();
        const finishReason = this.finishReason(request.provider, json);
        this.log(`← ${model}: ${text.length} chars (finish: ${finishReason})${text ? `: ${text.slice(0, 300).replace(/\s+/g, ' ')}` : ' EMPTY'}`);
        return { text, reasoning, finishReason };
    }

    async complete(model: string, systemPrompt: string, history: ChatMessage[], options: ModelCallOptions = {}): Promise<string> {
        const result = await this.completeDetailed(model, systemPrompt, history, options);
        if (!result.text) { throw new Error(`Model returned an empty response (finish reason: ${result.finishReason}).`); }
        return result.text;
    }

    private finishReason(provider: Provider, json: Record<string, unknown>): string {
        if (provider === 'gemini') { return (json.candidates as Array<{ finishReason?: string }> | undefined)?.[0]?.finishReason ?? 'unknown'; }
        if (provider === 'anthropic') { return String(json.stop_reason ?? 'unknown'); }
        return (json.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason ?? String(json.done_reason ?? 'unknown');
    }

    private extractReasoning(provider: Provider, json: Record<string, unknown>): string {
        if (provider === 'gemini' || provider === 'anthropic') { return ''; }
        const message = json.message as { thinking?: string } | undefined;
        const choices = json.choices as Array<{ message?: { reasoning_content?: string; reasoning?: string } }> | undefined;
        return message?.thinking ?? choices?.[0]?.message?.reasoning_content ?? choices?.[0]?.message?.reasoning ?? '';
    }

    private extractText(provider: Provider, json: Record<string, unknown>): string {
        if (provider === 'gemini') {
            const candidates = (json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined) ?? [];
            return (candidates[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
        }
        if (provider === 'anthropic') {
            return ((json.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        }
        const message = json.message as { content?: string } | undefined;
        const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
        return message?.content ?? choices?.[0]?.message?.content ?? '';
    }

    async stream(model: string, systemPrompt: string, history: ChatMessage[], handlers: StreamHandlers, options: ModelCallOptions = {}): Promise<string> {
        const request = await this.prepare(model, systemPrompt, history, true, options);
        this.log(`→ ${model} stream (${request.provider}, ${history.length} msgs)`);
        const response = await this.send(request, options);

        if (request.provider === 'gemini') {
            const json = await response.json() as Record<string, unknown>;
            const text = this.extractText('gemini', json);
            if (text) { handlers.onToken(text); }
            return text;
        }
        if (!response.body) { throw new Error('No response body'); }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let visible = '';
        let inThink = false;
        let sawThinking = false;
        const onThinking = (t: string) => { sawThinking = true; handlers.onThinking?.(t); };
        const onThinkingDone = () => { if (sawThinking) { handlers.onThinkingDone?.(); } };

        const emitVisible = (token: string) => {
            if (!token) { return; }
            if (!token.includes('<think>') && !token.includes('</think>')) {
                if (inThink) { onThinking(token); } else { visible += token; handlers.onToken(token); }
                return;
            }
            for (const part of token.split(/(<think>|<\/think>)/)) {
                if (part === '<think>') { inThink = true; onThinking(''); continue; }
                if (part === '</think>') { inThink = false; onThinkingDone(); continue; }
                if (!part) { continue; }
                if (inThink) { onThinking(part); } else { visible += part; handlers.onToken(part); }
            }
        };

        const handleLine = (rawLine: string) => {
            let line = rawLine.trim();
            if (!line || line === 'data: [DONE]' || line.startsWith('event:') || line.startsWith(':')) { return; }
            if (line.startsWith('data:')) { line = line.slice(5).trim(); }
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(line); } catch { return; }
            const ollamaMessage = parsed.message as { content?: string } | undefined;
            const choices = parsed.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }> | undefined;
            const delta = parsed.delta as { type?: string; text?: string; thinking?: string } | undefined;
            if (ollamaMessage?.content) { emitVisible(ollamaMessage.content); return; }
            if (choices?.[0]?.delta) {
                const d = choices[0].delta;
                const reasoning = d.reasoning_content ?? d.reasoning;
                if (reasoning) { onThinking(reasoning); }
                if (d.content) { if (sawThinking && !visible) { onThinkingDone(); } emitVisible(d.content); }
                return;
            }
            if (parsed.type === 'content_block_delta' && delta) {
                if (delta.type === 'thinking_delta') { onThinking(delta.thinking ?? ''); }
                else if (delta.text) { emitVisible(delta.text); }
                return;
            }
            if (parsed.type === 'content_block_stop') { onThinkingDone(); }
            if (parsed.type === 'error') { throw new Error((parsed.error as { message?: string })?.message ?? 'Provider streaming error'); }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }
            buffered += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffered.indexOf('\n')) !== -1) {
                handleLine(buffered.slice(0, idx));
                buffered = buffered.slice(idx + 1);
            }
        }
        if (buffered.trim()) { handleLine(buffered); }
        this.log(`← ${model}: ${visible.length} chars streamed`);
        return visible;
    }

    async listModels(): Promise<string[]> {
        let names: string[] = [];
        try {
            const res = await fetch(`${(await this.ollamaBaseUrl()).replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(8000) });
            const json = await res.json() as { models: Array<{ name: string }> };
            names = json.models.map(m => m.name);
        } catch {
            names = [];
        }
        const tryList = async (name: 'openai' | 'gemini' | 'anthropic' | 'blablador', fn: (key: string) => Promise<string[]>, fallback: string[]) => {
            try {
                const key = await this.secrets(name);
                if (!key) { return; }
                names.push(...await fn(key));
            } catch {
                names.push(...fallback);
            }
        };
        await tryList('openai', async key => {
            const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data: Array<{ id: string }> };
            return json.data.map(m => m.id).filter(id => id.startsWith('gpt') || id.startsWith('o')).sort().map(id => `openai/${id}`);
        }, ['openai/gpt-4o-mini']);
        await tryList('gemini', async key => {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { models: Array<{ name: string }> };
            return json.models.map(m => m.name.replace('models/', '')).filter(n => n.startsWith('gemini-')).map(n => `gemini/${n}`);
        }, ['gemini/gemini-2.5-flash']);
        await tryList('anthropic', async key => {
            const res = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data: Array<{ id: string }> };
            return json.data.map(m => m.id).filter(id => id.includes('claude')).map(id => `anthropic/${id}`);
        }, ['anthropic/claude-opus-5']);
        await tryList('blablador', async key => {
            const res = await fetch('https://api.blablador.fz-juelich.de/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data: Array<{ id: string }> };
            return json.data.map(m => `blablador/${m.id}`);
        }, []);
        if (names.length === 0) { names.push('llama3'); }
        return [...new Set(names)];
    }
}
