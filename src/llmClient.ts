/**
 * LlmClient — one place for every provider call.
 *
 * Supports local Ollama plus OpenAI, Gemini, Anthropic and Blablador (OpenAI-compatible)
 * through their raw HTTP APIs. Model ids are prefixed with the provider name
 * (`openai/gpt-4o`, `anthropic/claude-opus-5`, `blablador/alias-code`); anything
 * without a prefix is sent to Ollama.
 */

import * as vscode from 'vscode';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type Provider = 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'blablador';

export interface ModelCallOptions {
    /** Ask the provider to constrain output to JSON where the API supports it. */
    jsonMode?: boolean;
    /** External cancellation. */
    signal?: AbortSignal;
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number;
    /** Output token cap (Anthropic requires one; others use it when supported). */
    maxTokens?: number;
}

export interface CompletionResult {
    /** Visible assistant text (may be empty). */
    text: string;
    /** Reasoning / thinking text when the provider exposes it. */
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

export function getOllamaBaseUrl(): string {
    const configured = vscode.workspace.getConfiguration('continued').get<string>('ollama.baseUrl', 'http://localhost:11434');
    return (configured || 'http://localhost:11434').replace(/\/+$/, '');
}

/** Merge consecutive same-role messages so every provider sees strict alternation. */
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
    // Providers require the first message to come from the user.
    if (merged.length > 0 && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(conversation continues)' });
    }
    return merged;
}

export type LlmLogger = (line: string) => void;

export class LlmClient {
    /** Models that rejected `response_format`; we stop sending it to them for this session. */
    private readonly jsonUnsupported = new Set<string>();

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly log: LlmLogger = () => { /* no logging by default */ }
    ) {}

    private describe(request: PreparedRequest, history: ChatMessage[], options: ModelCallOptions): string {
        const chars = history.reduce((n, m) => n + m.content.length, 0);
        return `${request.provider} · ${history.length} messages · ${chars} chars${options.jsonMode ? ' · json' : ''}`;
    }

    // ------------------------------------------------------------------
    // Request preparation
    // ------------------------------------------------------------------

    private async requireKey(secretKey: string, label: string): Promise<string> {
        const key = await this.secrets.get(secretKey);
        if (!key) { throw new Error(`${label} API key is not configured. Add it from the ⚙️ Settings button.`); }
        return key;
    }

    private async prepare(
        model: string,
        systemPrompt: string,
        history: ChatMessage[],
        stream: boolean,
        options: ModelCallOptions
    ): Promise<PreparedRequest> {
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
                return { provider, url: `${getOllamaBaseUrl()}/api/chat`, headers, body };
            }
            case 'openai': {
                headers.Authorization = `Bearer ${await this.requireKey('openai_api_key', 'OpenAI')}`;
                const body: Record<string, unknown> = { model: pureModel, messages: withSystem, stream };
                if (options.jsonMode && !this.jsonUnsupported.has(model)) { body.response_format = { type: 'json_object' }; }
                return { provider, url: 'https://api.openai.com/v1/chat/completions', headers, body };
            }
            case 'blablador': {
                headers.Authorization = `Bearer ${await this.requireKey('blablador_api_key', 'Blablador')}`;
                const body: Record<string, unknown> = { model: pureModel, messages: withSystem, stream };
                // Blablador is vLLM-backed; JSON-constrained output is supported by most of its models.
                if (options.jsonMode && !this.jsonUnsupported.has(model)) { body.response_format = { type: 'json_object' }; }
                return { provider, url: 'https://api.blablador.fz-juelich.de/v1/chat/completions', headers, body };
            }
            case 'gemini': {
                const key = await this.requireKey('gemini_api_key', 'Gemini');
                const contents = messages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));
                const generationConfig: Record<string, unknown> = { temperature: 0.2, maxOutputTokens: options.maxTokens ?? 8192 };
                if (options.jsonMode) { generationConfig.responseMimeType = 'application/json'; }
                return {
                    provider,
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pureModel)}:generateContent?key=${encodeURIComponent(key)}`,
                    headers,
                    body: {
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        contents,
                        generationConfig
                    }
                };
            }
            case 'anthropic': {
                headers['x-api-key'] = await this.requireKey('anthropic_api_key', 'Anthropic');
                headers['anthropic-version'] = '2023-06-01';
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
            const response = await fetch(request.url, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(request.body),
                signal: controller.signal
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`${request.provider} request failed (${response.status}): ${errText.slice(0, 400)}`);
            }
            return response;
        } catch (error: unknown) {
            const err = error as Error & { cause?: unknown };
            if (options.signal?.aborted) { throw new Error('Cancelled.'); }
            if (err.name === 'AbortError' || controller.signal.aborted) {
                throw new Error(`Model call timed out after ${Math.round(timeoutMs / 1000)}s. Try a faster model or raise continued.agent.modelTimeoutMs.`);
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            options.signal?.removeEventListener('abort', onExternalAbort);
        }
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Non-streaming completion with details. `text` is empty when the model produced no
     * visible content (reasoning models occasionally stop after their reasoning channel);
     * `reasoning` then carries whatever it did produce.
     */
    async completeDetailed(model: string, systemPrompt: string, history: ChatMessage[], options: ModelCallOptions = {}): Promise<CompletionResult> {
        const request = await this.prepare(model, systemPrompt, history, false, options);
        this.log(`→ ${model} (${this.describe(request, history, options)})`);
        let response: Response;
        try {
            response = await this.send(request, options);
        } catch (error: unknown) {
            const message = (error as Error).message ?? String(error);
            const usedJsonFormat = options.jsonMode && !this.jsonUnsupported.has(model) && (request.provider === 'blablador' || request.provider === 'openai');
            // Some gateways reject response_format: remember that and retry once without it.
            if (usedJsonFormat && /\(400\)/.test(message) && !options.signal?.aborted) {
                this.jsonUnsupported.add(model);
                this.log(`← ${model}: rejected JSON mode (${message.slice(0, 200)}); retrying without response_format`);
                return this.completeDetailed(model, systemPrompt, history, options);
            }
            throw error;
        }
        const json = await response.json() as Record<string, unknown>;
        const text = this.extractText(request.provider, json).trim();
        const reasoning = this.extractReasoning(request.provider, json).trim();
        const finishReason = this.finishReason(request.provider, json);
        if (!text) {
            this.log(`← ${model}: EMPTY content (finish: ${finishReason}); reasoning: ${reasoning.slice(0, 600).replace(/\s+/g, ' ')}${reasoning ? '' : '(none)'}; raw: ${JSON.stringify(json).slice(0, 800)}`);
        } else {
            this.log(`← ${model}: ${text.length} chars (finish: ${finishReason}): ${text.slice(0, 1500).replace(/\s+/g, ' ')}${text.length > 1500 ? ' …' : ''}`);
        }
        return { text, reasoning, finishReason };
    }

    /** Non-streaming completion. Returns the full assistant text or throws when it is empty. */
    async complete(model: string, systemPrompt: string, history: ChatMessage[], options: ModelCallOptions = {}): Promise<string> {
        const result = await this.completeDetailed(model, systemPrompt, history, options);
        if (!result.text) {
            throw new Error(`Model returned an empty response (finish reason: ${result.finishReason}). The prompt may be too long for this model, or the model timed out.`);
        }
        return result.text;
    }

    private finishReason(provider: Provider, json: Record<string, unknown>): string {
        if (provider === 'gemini') {
            const candidates = json.candidates as Array<{ finishReason?: string }> | undefined;
            return candidates?.[0]?.finishReason ?? 'unknown';
        }
        if (provider === 'anthropic') { return String(json.stop_reason ?? 'unknown'); }
        const choices = json.choices as Array<{ finish_reason?: string }> | undefined;
        return choices?.[0]?.finish_reason ?? String(json.done_reason ?? 'unknown');
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
            const content = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
            return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        }
        const message = json.message as { content?: string } | undefined;
        const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
        return message?.content ?? choices?.[0]?.message?.content ?? '';
    }

    /** Streaming completion. Calls handlers as tokens arrive and returns the full visible text. */
    async stream(
        model: string,
        systemPrompt: string,
        history: ChatMessage[],
        handlers: StreamHandlers,
        options: ModelCallOptions = {}
    ): Promise<string> {
        const request = await this.prepare(model, systemPrompt, history, true, options);
        this.log(`→ ${model} stream (${this.describe(request, history, options)})`);
        const response = await this.send(request, options);

        // Gemini's generateContent is not streamed; emit the whole answer at once.
        if (request.provider === 'gemini') {
            const json = await response.json() as Record<string, unknown>;
            const text = this.extractText('gemini', json);
            if (text) { handlers.onToken(text); }
            this.log(`← ${model}: ${text.length} chars`);
            return text;
        }

        if (!response.body) { throw new Error('No response body'); }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let visible = '';
        let inThink = false;
        let sawThinking = false;
        const onThinking = (token: string) => { sawThinking = true; handlers.onThinking?.(token); };
        const onThinkingDone = () => { if (sawThinking) { handlers.onThinkingDone?.(); } };

        const emitVisible = (token: string) => {
            if (!token) { return; }
            // Inline <think>…</think> tags (DeepSeek / Qwen style) become thinking events.
            if (!token.includes('<think>') && !token.includes('</think>')) {
                if (inThink) { onThinking(token); }
                else { visible += token; handlers.onToken(token); }
                return;
            }
            for (const part of token.split(/(<think>|<\/think>)/)) {
                if (part === '<think>') { inThink = true; onThinking(''); continue; }
                if (part === '</think>') { inThink = false; onThinkingDone(); continue; }
                if (!part) { continue; }
                if (inThink) { onThinking(part); }
                else { visible += part; handlers.onToken(part); }
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
            if (parsed.type === 'error') {
                const err = parsed.error as { message?: string } | undefined;
                throw new Error(err?.message ?? 'Provider streaming error');
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }
            buffered += decoder.decode(value, { stream: true });
            let newlineIdx: number;
            while ((newlineIdx = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, newlineIdx);
                buffered = buffered.slice(newlineIdx + 1);
                handleLine(line);
            }
        }
        if (buffered.trim()) { handleLine(buffered); }

        this.log(`← ${model}: ${visible.length} chars streamed`);
        return visible;
    }

    /** Collect model ids from Ollama and every cloud provider that has a key configured. */
    async listModels(): Promise<string[]> {
        let modelNames: string[] = [];

        try {
            const res = await fetch(`${getOllamaBaseUrl()}/api/tags`);
            const json = await res.json() as { models: Array<{ name: string }> };
            modelNames = json.models.map(m => m.name);
        } catch {
            modelNames = ['llama3'];
        }

        try {
            const openaiKey = await this.secrets.get('openai_api_key');
            if (openaiKey) {
                const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${openaiKey}` } });
                if (res.ok) {
                    const json = await res.json() as { data: Array<{ id: string }> };
                    modelNames.push(...json.data.map(m => m.id).filter(id => id.startsWith('gpt') || id.startsWith('o')).sort().map(id => `openai/${id}`));
                } else {
                    modelNames.push('openai/gpt-4o-mini');
                }
            }
        } catch (err) {
            console.error('Failed to fetch OpenAI models:', err);
        }

        try {
            const geminiKey = await this.secrets.get('gemini_api_key');
            if (geminiKey) {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`);
                if (res.ok) {
                    const json = await res.json() as { models: Array<{ name: string }> };
                    modelNames.push(...json.models.map(m => m.name.replace('models/', '')).filter(n => n.startsWith('gemini-')).map(n => `gemini/${n}`));
                } else {
                    modelNames.push('gemini/gemini-2.5-flash');
                }
            }
        } catch (err) {
            console.error('Failed to fetch Gemini models:', err);
        }

        try {
            const anthropicKey = await this.secrets.get('anthropic_api_key');
            if (anthropicKey) {
                const res = await fetch('https://api.anthropic.com/v1/models', {
                    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' }
                });
                if (res.ok) {
                    const json = await res.json() as { data: Array<{ id: string }> };
                    modelNames.push(...json.data.map(m => m.id).filter(id => id.includes('claude')).map(id => `anthropic/${id}`));
                } else {
                    modelNames.push('anthropic/claude-opus-5');
                }
            }
        } catch (err) {
            console.error('Failed to fetch Anthropic models:', err);
        }

        try {
            const blabladorKey = await this.secrets.get('blablador_api_key');
            if (blabladorKey) {
                const res = await fetch('https://api.blablador.fz-juelich.de/v1/models', { headers: { Authorization: `Bearer ${blabladorKey}` } });
                if (res.ok) {
                    const json = await res.json() as { data: Array<{ id: string }> };
                    modelNames.push(...json.data.map(m => `blablador/${m.id}`));
                }
            }
        } catch (err) {
            console.error('Failed to fetch Blablador models:', err);
        }

        return [...new Set(modelNames)];
    }
}
