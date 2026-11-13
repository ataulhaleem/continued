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

/** A model offered in the picker, with whatever the provider tells us about it. */
export interface ModelInfo {
    /** Prefixed id actually sent to the provider, e.g. `openai/gpt-4o`. */
    id: string;
    /** Short name shown in the list. */
    label: string;
    provider: Provider;
    /** True when the model runs on the user's own machine. */
    local: boolean;
    /** One compact line: parameters, quantisation, size, context window. */
    detail?: string;
    /** Longer prose from the provider, when it offers any. */
    description?: string;
    contextTokens?: number;
    sizeBytes?: number;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) { return ''; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) { return ''; }
    if (tokens >= 1000000) { return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`; }
    if (tokens >= 1000) { return `${Math.round(tokens / 1000)}K`; }
    return String(tokens);
}

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
                // Ollama's default context window (a few thousand tokens) silently truncates a long
                // document; size it to the request instead, within what a workstation can hold.
                const promptChars = withSystem.reduce((n, m) => n + m.content.length, 0);
                const numCtx = Math.min(32768, Math.max(8192, Math.ceil((promptChars / 3 + (options.maxTokens ?? 2048)) / 1024) * 1024));
                body.options = { num_ctx: numCtx, ...(options.maxTokens ? { num_predict: options.maxTokens } : {}) };
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
        const timeoutMs = options.timeoutMs ?? 600000;
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

    /**
     * Collect the models on offer: Ollama plus every cloud provider with a key configured.
     *
     * Each provider is asked for whatever it knows about its models — Ollama reports parameter
     * count, quantisation and on-disk size; Gemini reports a context window and a description;
     * Anthropic reports a display name — so the picker can say more than a bare id. A provider
     * that fails or returns an unexpected shape contributes a plain entry rather than breaking
     * the list.
     */
    /** Why providers with a key returned no list in the last listModels() call, one line each. */
    listProblems: string[] = [];

    async listModels(): Promise<ModelInfo[]> {
        const models: ModelInfo[] = [];
        this.listProblems = [];

        try {
            const base = (await this.ollamaBaseUrl()).replace(/\/+$/, '');
            const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
            const json = await res.json() as {
                models?: Array<{
                    name?: string;
                    size?: number;
                    details?: { family?: string; parameter_size?: string; quantization_level?: string };
                }>;
            };
            for (const m of json.models ?? []) {
                if (!m?.name) { continue; }
                const d = m.details ?? {};
                models.push({
                    id: m.name,
                    label: m.name,
                    provider: 'ollama',
                    local: true,
                    detail: [d.parameter_size, d.quantization_level, formatBytes(m.size ?? 0)].filter(Boolean).join(' · '),
                    description: d.family ? `${d.family} family · runs on this machine` : 'Runs on this machine',
                    sizeBytes: m.size
                });
            }
        } catch (error) {
            // Ollama is not running or not reachable; the cloud providers below may still answer.
            this.log(`models: Ollama not reachable (${(error as Error).message})`);
        }

        const cloud = (provider: Exclude<Provider, 'ollama'>, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
            id: `${provider}/${id}`,
            label: id,
            provider,
            local: false,
            ...extra
        });

        const addCloud = async (
            provider: Exclude<Provider, 'ollama'>,
            fetchModels: (key: string) => Promise<ModelInfo[]>,
            fallback: ModelInfo[]
        ) => {
            try {
                const key = await this.secrets(provider);
                if (!key) { return; }
                models.push(...await fetchModels(key));
            } catch (error) {
                const why = (error as Error).message || String(error);
                this.log(`models: ${provider} list failed (${why})`);
                this.listProblems.push(`${provider}: ${/^\d{3}$/.test(why) ? `HTTP ${why}` : why}`);
                models.push(...fallback);
            }
        };

        await addCloud('openai', async key => {
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data?: Array<{ id?: string; owned_by?: string }> };
            return (json.data ?? [])
                .filter(m => !!m.id && (m.id.startsWith('gpt') || m.id.startsWith('o')))
                .sort((a, b) => a.id!.localeCompare(b.id!))
                .map(m => cloud('openai', m.id!, { detail: m.owned_by ? `by ${m.owned_by}` : undefined }));
        }, [cloud('openai', 'gpt-4o-mini', { detail: 'model list unavailable' })]);

        await addCloud('gemini', async key => {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as {
                models?: Array<{ name?: string; displayName?: string; description?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
            };
            return (json.models ?? [])
                .filter(m => !!m.name && (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
                .map(m => {
                    const id = m.name!.replace(/^models\//, '');
                    const context = formatTokens(m.inputTokenLimit ?? 0);
                    return cloud('gemini', id, {
                        label: m.displayName || id,
                        detail: context ? `${context} context` : undefined,
                        description: m.description,
                        contextTokens: m.inputTokenLimit
                    });
                })
                .filter(m => m.id.includes('gemini'));
        }, [cloud('gemini', 'gemini-2.5-flash', { detail: 'model list unavailable' })]);

        await addCloud('anthropic', async key => {
            const res = await fetch('https://api.anthropic.com/v1/models', {
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data?: Array<{ id?: string; display_name?: string }> };
            return (json.data ?? [])
                .filter(m => !!m.id && m.id.includes('claude'))
                .map(m => cloud('anthropic', m.id!, { label: m.display_name || m.id!, detail: m.display_name ? m.id : undefined }));
        }, [cloud('anthropic', 'claude-opus-5', { detail: 'model list unavailable' })]);

        await addCloud('blablador', async key => {
            const res = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(String(res.status)); }
            const json = await res.json() as { data?: Array<{ id?: string; owned_by?: string }> };
            return (json.data ?? [])
                .filter(m => !!m.id)
                .map(m => cloud('blablador', m.id!, { detail: m.owned_by ? `by ${m.owned_by}` : undefined, description: 'Hosted at Jülich Supercomputing Centre' }));
        }, []);

        if (models.length === 0) {
            models.push({ id: 'llama3', label: 'llama3', provider: 'ollama', local: true, detail: 'not pulled yet', description: 'Start Ollama and run `ollama pull llama3`' });
        }

        const seen = new Set<string>();
        return models.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    }
}
