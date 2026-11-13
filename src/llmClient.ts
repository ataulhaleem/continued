/**
 * LlmClient — one place for every provider call.
 *
 * Supports local Ollama plus OpenAI, Gemini, Anthropic and Blablador (OpenAI-compatible)
 * through their raw HTTP APIs. Model ids are prefixed with the provider name
 * (`openai/gpt-4o`, `anthropic/claude-opus-5`, `blablador/alias-code`); anything
 * without a prefix is sent to Ollama.
 */

import * as vscode from 'vscode';

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

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export type Provider = 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'blablador';

/** Hard cap for one model call when the caller gives none: long enough for a slow local model to finish a big file. */
export const DEFAULT_MODEL_TIMEOUT_MS = 600000;
/** How long a streamed response may stay silent before it is treated as dead. */
export const DEFAULT_STALL_TIMEOUT_MS = 90000;

export interface ModelCallOptions {
    /** Ask the provider to constrain output to JSON where the API supports it. */
    jsonMode?: boolean;
    /** External cancellation. */
    signal?: AbortSignal;
    /** Hard cap for the whole request in milliseconds (connect + generation). */
    timeoutMs?: number;
    /**
     * Stall cap: how long the provider may stay silent before the call is abandoned. A healthy
     * model emits tokens (or reasoning) continuously, so this catches a dead connection or a
     * wedged server far sooner than `timeoutMs` while still allowing long generations.
     * Only applies where the response is streamed.
     */
    stallTimeoutMs?: number;
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
    /** The provider's stop / finish reason, once it is known. */
    onFinish?: (reason: string) => void;
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
                // Ollama's default context window (a few thousand tokens) silently truncates a long
                // document; size it to the request instead, within what a workstation can hold.
                const promptChars = withSystem.reduce((n, m) => n + m.content.length, 0);
                const numCtx = Math.min(32768, Math.max(8192, Math.ceil((promptChars / 3 + (options.maxTokens ?? 2048)) / 1024) * 1024));
                body.options = { num_ctx: numCtx, ...(options.maxTokens ? { num_predict: options.maxTokens } : {}) };
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
        const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
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

    /**
     * Read a streamed body line by line, abandoning it when the provider goes quiet for longer
     * than `stallTimeoutMs` or when the whole call exceeds `timeoutMs` / is cancelled.
     *
     * `send()` releases its hard cap once the headers arrive, so this is where a long-running
     * generation is bounded: a stall is a connection problem, the hard cap is a runaway model.
     */
    private async readStreamLines(response: Response, options: ModelCallOptions, startedAt: number, onLine: (line: string) => void): Promise<void> {
        if (!response.body) { throw new Error('No response body'); }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const stallMs = Math.max(5000, options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
        const hardMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
        let buffered = '';
        const onExternalAbort = () => { void reader.cancel('cancelled').catch(() => undefined); };
        options.signal?.addEventListener('abort', onExternalAbort, { once: true });

        try {
            while (true) {
                const remaining = hardMs - (Date.now() - startedAt);
                if (remaining <= 0) {
                    await reader.cancel('timeout').catch(() => undefined);
                    throw new Error(`Model call exceeded the ${Math.round(hardMs / 1000)}s cap while still generating. Raise continued.agent.modelTimeoutMs for very long outputs.`);
                }
                let timer: ReturnType<typeof setTimeout> | undefined;
                const guard = new Promise<'stall'>(resolve => { timer = setTimeout(() => resolve('stall'), Math.min(stallMs, remaining)); });
                const next = await Promise.race([reader.read(), guard]);
                clearTimeout(timer);
                if (options.signal?.aborted) { throw new Error('Cancelled.'); }
                if (next === 'stall') {
                    await reader.cancel('stall').catch(() => undefined);
                    const quietFor = Math.min(stallMs, remaining);
                    throw new Error(quietFor >= remaining
                        ? `Model call timed out after ${Math.round(hardMs / 1000)}s. Try a faster model or raise continued.agent.modelTimeoutMs.`
                        : `Model stopped sending for ${Math.round(stallMs / 1000)}s mid-response (connection or server stall). Raise continued.agent.modelStallTimeoutMs if the provider is just slow.`);
                }
                const { done, value } = next;
                if (done) { break; }
                buffered += decoder.decode(value, { stream: true });
                let newlineIdx: number;
                while ((newlineIdx = buffered.indexOf('\n')) !== -1) {
                    const line = buffered.slice(0, newlineIdx);
                    buffered = buffered.slice(newlineIdx + 1);
                    onLine(line);
                }
            }
            if (buffered.trim()) { onLine(buffered); }
        } finally {
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
        // Every provider but Gemini is read as a stream even though the caller wants the whole
        // reply: that way a long generation is bounded by the stall cap (silence) rather than
        // by a fixed wall-clock budget, so a slow model that is still producing is not cut off.
        const streamed = detectProvider(model) !== 'gemini';
        const request = await this.prepare(model, systemPrompt, history, streamed, options);
        this.log(`→ ${model} (${this.describe(request, history, options)}${streamed ? ' · streamed' : ''})`);
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
        let text: string;
        let reasoning: string;
        let finishReason: string;
        let raw = '(streamed)';
        if (streamed) {
            const collected = await this.collectStream(response, options);
            text = collected.text.trim();
            reasoning = collected.reasoning.trim();
            finishReason = collected.finishReason;
        } else {
            const json = await response.json() as Record<string, unknown>;
            text = this.extractText(request.provider, json).trim();
            reasoning = this.extractReasoning(request.provider, json).trim();
            finishReason = this.finishReason(request.provider, json);
            raw = JSON.stringify(json).slice(0, 800);
        }
        if (!text) {
            this.log(`← ${model}: EMPTY content (finish: ${finishReason}); reasoning: ${reasoning.slice(0, 600).replace(/\s+/g, ' ')}${reasoning ? '' : '(none)'}; raw: ${raw}`);
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

    /**
     * One parser for every provider's streaming format (Ollama NDJSON, OpenAI-style SSE,
     * Anthropic SSE). Reasoning channels and inline <think> tags become thinking events.
     * `visibleSoFar` tells it whether visible text has already started, which decides when a
     * reasoning phase is reported as finished.
     */
    private streamLineParser(handlers: StreamHandlers, visibleSoFar: () => string): (rawLine: string) => void {
        let inThink = false;
        let sawThinking = false;
        const onThinking = (token: string) => { sawThinking = true; handlers.onThinking?.(token); };
        const onThinkingDone = () => { if (sawThinking) { handlers.onThinkingDone?.(); } };

        const emitVisible = (token: string) => {
            if (!token) { return; }
            // Inline <think>…</think> tags (DeepSeek / Qwen style) become thinking events.
            if (!token.includes('<think>') && !token.includes('</think>')) {
                if (inThink) { onThinking(token); }
                else { handlers.onToken(token); }
                return;
            }
            for (const part of token.split(/(<think>|<\/think>)/)) {
                if (part === '<think>') { inThink = true; onThinking(''); continue; }
                if (part === '</think>') { inThink = false; onThinkingDone(); continue; }
                if (!part) { continue; }
                if (inThink) { onThinking(part); }
                else { handlers.onToken(part); }
            }
        };

        return (rawLine: string) => {
            let line = rawLine.trim();
            if (!line || line === 'data: [DONE]' || line.startsWith('event:') || line.startsWith(':')) { return; }
            if (line.startsWith('data:')) { line = line.slice(5).trim(); }
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(line); } catch { return; }

            const ollamaMessage = parsed.message as { content?: string; thinking?: string } | undefined;
            const choices = parsed.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }> | undefined;
            const delta = parsed.delta as { type?: string; text?: string; thinking?: string; stop_reason?: string } | undefined;

            if (parsed.done_reason) { handlers.onFinish?.(String(parsed.done_reason)); }
            if (ollamaMessage?.thinking) { onThinking(ollamaMessage.thinking); }
            if (ollamaMessage?.content) { if (sawThinking && !visibleSoFar()) { onThinkingDone(); } emitVisible(ollamaMessage.content); return; }
            if (choices?.[0]) {
                const d = choices[0].delta ?? {};
                const reasoning = d.reasoning_content ?? d.reasoning;
                if (reasoning) { onThinking(reasoning); }
                if (d.content) { if (sawThinking && !visibleSoFar()) { onThinkingDone(); } emitVisible(d.content); }
                if (choices[0].finish_reason) { handlers.onFinish?.(choices[0].finish_reason); }
                return;
            }
            if (parsed.type === 'content_block_delta' && delta) {
                if (delta.type === 'thinking_delta') { onThinking(delta.thinking ?? ''); }
                else if (delta.text) { emitVisible(delta.text); }
                return;
            }
            if (parsed.type === 'message_delta' && delta?.stop_reason) { handlers.onFinish?.(delta.stop_reason); }
            if (parsed.type === 'content_block_stop') { onThinkingDone(); }
            if (parsed.type === 'error') {
                const err = parsed.error as { message?: string } | undefined;
                throw new Error(err?.message ?? 'Provider streaming error');
            }
        };
    }

    /** Drain a streamed response into one result; used when the caller wants the whole reply. */
    private async collectStream(response: Response, options: ModelCallOptions): Promise<CompletionResult> {
        let text = '';
        let reasoning = '';
        let finishReason = 'unknown';
        const handleLine = this.streamLineParser({
            onToken: t => { text += t; },
            onThinking: t => { reasoning += t; },
            onFinish: r => { finishReason = r; }
        }, () => text);
        await this.readStreamLines(response, options, Date.now(), handleLine);
        return { text, reasoning, finishReason };
    }

    /** Streaming completion. Calls handlers as tokens arrive and returns the full visible text. */
    async stream(
        model: string,
        systemPrompt: string,
        history: ChatMessage[],
        handlers: StreamHandlers,
        options: ModelCallOptions = {}
    ): Promise<string> {
        const startedAt = Date.now();
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

        let visible = '';
        const handleLine = this.streamLineParser({
            ...handlers,
            onToken: t => { visible += t; handlers.onToken(t); }
        }, () => visible);

        await this.readStreamLines(response, options, startedAt, handleLine);

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
    async listModels(): Promise<ModelInfo[]> {
        const models: ModelInfo[] = [];

        try {
            const res = await fetch(`${getOllamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(8000) });
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
        } catch {
            // Ollama is not running or not reachable; the cloud providers below may still answer.
        }

        const addCloud = async (
            provider: Exclude<Provider, 'ollama'>,
            secretKey: string,
            fetchModels: (key: string) => Promise<ModelInfo[]>,
            fallback: ModelInfo[]
        ) => {
            try {
                const key = await this.secrets.get(secretKey);
                if (!key) { return; }
                models.push(...await fetchModels(key));
            } catch (err) {
                this.log(`listModels: ${provider} failed (${(err as Error).message}); using a minimal entry`);
                models.push(...fallback);
            }
        };

        const cloud = (provider: Exclude<Provider, 'ollama'>, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
            id: `${provider}/${id}`,
            label: id,
            provider,
            local: false,
            ...extra
        });

        await addCloud('openai', 'openai_api_key', async key => {
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
            const json = await res.json() as { data?: Array<{ id?: string; owned_by?: string }> };
            return (json.data ?? [])
                .filter(m => !!m.id && (m.id.startsWith('gpt') || m.id.startsWith('o')))
                .sort((a, b) => a.id!.localeCompare(b.id!))
                .map(m => cloud('openai', m.id!, { detail: m.owned_by ? `by ${m.owned_by}` : undefined }));
        }, [cloud('openai', 'gpt-4o-mini', { detail: 'model list unavailable' })]);

        await addCloud('gemini', 'gemini_api_key', async key => {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
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

        await addCloud('anthropic', 'anthropic_api_key', async key => {
            const res = await fetch('https://api.anthropic.com/v1/models', {
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
            const json = await res.json() as { data?: Array<{ id?: string; display_name?: string }> };
            return (json.data ?? [])
                .filter(m => !!m.id && m.id.includes('claude'))
                .map(m => cloud('anthropic', m.id!, { label: m.display_name || m.id!, detail: m.display_name ? m.id : undefined }));
        }, [cloud('anthropic', 'claude-opus-5', { detail: 'model list unavailable' })]);

        await addCloud('blablador', 'blablador_api_key', async key => {
            const res = await fetch('https://api.blablador.fz-juelich.de/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
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
