/**
 * Backend: the browser counterpart of the VS Code sidebar provider.
 *
 * Owns sessions, the chat / agent / plan flows, approvals, the harness host, and
 * the message protocol the (unchanged) sidebar UI speaks. One Backend serves every
 * connected side panel; messages are broadcast to all of them.
 */

import { LlmClient, ChatMessage } from '../core/llmClient';
import {
    AgentAction, actionCommandLabel, decodeAction, decodeToolResult, encodeAction, encodeToolResult,
    formatActionDescription, isLegacyUiLabel, parseAgentAction, sanitizeAgentDisplayResponse
} from '../core/agentActions';
import { HarnessDefinition, HarnessRun } from '../core/harness/types';
import { HarnessHost, runHarness, summarizeRun, validateHarness } from '../core/harness/harnessEngine';
import { builtInBrowserHarnesses } from './harnesses';
import { tools, resources, activeTab, BrowserTool } from './tools';
import {
    ChatSession, Settings, ext, getLastSessionId, getPluginOverrides, getSessions, getSettings, getUserHarnesses,
    saveSessions, savePluginOverrides, saveSettings, saveUserHarnesses, setLastSessionId
} from './storage';

type Post = (message: Record<string, unknown>) => void;

interface DisplayMessage { role: 'user' | 'assistant'; kind: 'text' | 'action' | 'tool'; content: string; command?: string; output?: string }
interface AttachedFile { name: string; isImage?: boolean; content?: string }

const MAX_CORRECTIONS = 2;

function slug(name: string): string {
    const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-harness';
    return base.endsWith('-harness') ? base : `${base}-harness`;
}

export class Backend {
    private readonly llm: LlmClient;
    private readonly log: (line: string) => void;
    private sessionId: string | null = null;
    private history: ChatMessage[] = [];
    private overrides: Record<string, boolean> = {};
    private harnesses = new Map<string, HarnessDefinition>();

    private agentAbort: AbortController | null = null;
    private harnessAbort: AbortController | null = null;
    private approvalWaiter: ((allow: boolean) => void) | null = null;
    private iteration = 0;
    private task = '';
    private lastActionKey = '';
    private lastRun: HarnessRun | null = null;
    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private busyCount = 0;

    /** Chrome suspends idle service workers after ~30 s; an extension API call resets that clock. */
    private busy(on: boolean): void {
        this.busyCount = Math.max(0, this.busyCount + (on ? 1 : -1));
        if (this.busyCount > 0 && !this.keepAliveTimer) {
            this.keepAliveTimer = setInterval(() => { ext.runtime.getPlatformInfo().catch(() => undefined); }, 20000);
        } else if (this.busyCount === 0 && this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    constructor(private readonly post: Post, log: (line: string) => void) {
        this.log = log;
        this.llm = new LlmClient(
            async name => (await getSettings()).keys[name] || undefined,
            async () => (await getSettings()).ollamaBaseUrl,
            log
        );
    }

    async init(): Promise<void> {
        this.overrides = await getPluginOverrides();
        await this.loadHarnesses();
    }

    // ------------------------------------------------------------------ plugins
    private enabledTools(): BrowserTool[] { return tools.filter(t => this.overrides[t.id] ?? t.enabled); }
    private isEnabled(id: string, fallback: boolean): boolean { return this.overrides[id] ?? fallback; }

    private pluginsPayload() {
        return {
            tools: tools.map(t => ({ id: t.id, name: t.name, version: '1.0.0', description: t.description, enabled: this.isEnabled(t.id, t.enabled), source: 'built-in', args: t.args, readOnly: !!t.readOnly })),
            resources: resources.map(r => ({ id: r.id, name: r.name, version: '1.0.0', description: r.description, enabled: this.isEnabled(r.id, r.enabled), source: 'built-in' })),
            skills: [...this.harnesses.values()].map(h => ({ id: h.id, name: h.name, version: h.version ?? '1.0.0', description: h.description ?? '', enabled: this.isEnabled(h.id, true), source: h.source, harness: true }))
        };
    }

    private postPlugins(): void {
        const p = this.pluginsPayload();
        this.post({ type: 'setPlugins', plugins: p, enabledCount: [...p.tools, ...p.resources, ...p.skills].filter(x => x.enabled).length });
    }

    // ------------------------------------------------------------------ harness registry
    private async loadHarnesses(): Promise<void> {
        this.harnesses = new Map();
        for (const def of builtInBrowserHarnesses) { this.harnesses.set(def.id, def); }
        for (const def of Object.values(await getUserHarnesses())) { this.harnesses.set(def.id, { ...def, source: 'user' }); }
    }

    private knownPlugins() {
        return {
            tools: new Set(this.enabledTools().map(t => t.id)),
            resources: new Set(resources.filter(r => this.isEnabled(r.id, r.enabled)).map(r => r.id)),
            skills: new Set([...this.harnesses.keys()].filter(id => this.isEnabled(id, true)))
        };
    }

    private harnessCatalog() {
        const p = this.pluginsPayload();
        return {
            harnesses: [...this.harnesses.values()].map(h => ({ id: h.id, name: h.name, description: h.description ?? '', source: h.source, input: h.input ?? null, stepCount: h.steps.length })),
            problems: [],
            plugins: { tools: p.tools.filter(t => t.enabled), resources: p.resources.filter(r => r.enabled), skills: p.skills.filter(s => s.enabled) },
            variables: ['input', 'item', 'index', 'activeUrl', 'activeTitle', 'selection', 'date', 'steps.<id>.output', 'steps.<id>.status', 'steps.<id>.error', 'steps.<id>.lines', 'steps.<id>.json']
        };
    }

    // ------------------------------------------------------------------ sessions
    private sessionTitle(text: string): string {
        const clean = text.replace(/\s+/g, ' ').trim();
        return clean.length > 28 ? `${clean.slice(0, 25)}...` : (clean || 'Session');
    }

    private async persist(mode: string): Promise<void> {
        if (!this.sessionId) { return; }
        const sessions = await getSessions();
        const idx = sessions.findIndex(s => s.id === this.sessionId);
        if (idx !== -1) { sessions[idx].history = this.history; sessions[idx].mode = mode; }
        else {
            const first = this.history.find(m => m.role === 'user')?.content ?? '';
            sessions.unshift({ id: this.sessionId, title: this.sessionTitle(first), history: this.history, mode });
        }
        await saveSessions(sessions);
        await setLastSessionId(this.sessionId);
    }

    private displayHistory(): DisplayMessage[] {
        const out: DisplayMessage[] = [];
        for (const m of this.history) {
            if (m.role === 'system') { continue; }
            if (m.role === 'user') { out.push({ role: 'user', kind: 'text', content: m.content }); continue; }
            const action = decodeAction(m.content);
            if (action) { out.push({ role: 'assistant', kind: 'action', content: formatActionDescription(action) }); continue; }
            const result = decodeToolResult(m.content);
            if (result) { out.push({ role: 'assistant', kind: 'tool', content: '', command: result.command, output: result.output }); continue; }
            out.push({ role: 'assistant', kind: 'text', content: m.content });
        }
        return out;
    }

    private postSessionView(mode?: string): void {
        this.post({ type: 'loadSessionView', history: this.displayHistory(), mode });
    }

    private async postSessions(): Promise<void> {
        this.post({ type: 'renderSessions', sessions: await getSessions() });
    }

    private replyLocally(mode: string, message: string): void {
        this.post({ type: 'assistantResponse', content: message });
        this.post({ type: 'agentDone' });
        this.history.push({ role: 'assistant', content: message });
        void this.persist(mode);
    }

    // ------------------------------------------------------------------ active tab indicator
    async postActiveTab(): Promise<void> {
        try {
            const tab = await activeTab();
            const host = tab.url ? new URL(tab.url).host : '';
            this.post({ type: 'setCurrentFile', filePath: tab.title ? `${tab.title}${host ? ` — ${host}` : ''}` : (tab.url ?? null) });
        } catch {
            this.post({ type: 'setCurrentFile', filePath: null });
        }
    }

    // ------------------------------------------------------------------ model-facing history
    private historyForChat(): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (const m of this.history) {
            if (m.role === 'system') { continue; }
            if (m.role === 'user') { out.push(m); continue; }
            const action = decodeAction(m.content);
            if (action) { if (action.type !== 'final-answer') { out.push({ role: 'assistant', content: `(agent action) ${actionCommandLabel(action)}` }); } continue; }
            if (decodeToolResult(m.content)) { continue; }
            out.push(m);
        }
        return out;
    }

    private historyForAgent(): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (const m of this.history) {
            if (m.role === 'system') { continue; }
            if (m.role === 'user') { out.push(m); continue; }
            const action = decodeAction(m.content);
            if (action) { out.push({ role: 'assistant', content: JSON.stringify(action) }); continue; }
            const result = decodeToolResult(m.content);
            if (result) {
                out.push({ role: 'user', content: `[TOOL RESULT]\nAction: ${result.command}\nOutput:\n${result.output}\n\n---\nContinue with the next JSON action, or final-answer if the task is complete. Reply with ONLY one JSON object.` });
                continue;
            }
            if (isLegacyUiLabel(m.content)) { continue; }
            out.push(m);
        }
        return out;
    }

    private trim(history: ChatMessage[], maxChars: number, task: string | null): ChatMessage[] {
        const recent = history.slice(-40);
        const selected: ChatMessage[] = [];
        let count = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (count + recent[i].content.length > maxChars && selected.length > 0) { break; }
            selected.unshift(recent[i]);
            count += recent[i].content.length;
        }
        if (task && !selected.some(m => m.role === 'user' && m.content === task)) { selected.unshift({ role: 'user', content: task }); }
        return selected;
    }

    private runActions(): Array<{ action: AgentAction; ok: boolean; output: string }> {
        let lastUser = -1;
        for (let i = this.history.length - 1; i >= 0; i--) { if (this.history[i].role === 'user') { lastUser = i; break; } }
        const entries = this.history.slice(lastUser + 1);
        const out: Array<{ action: AgentAction; ok: boolean; output: string }> = [];
        for (let i = 0; i < entries.length; i++) {
            const action = decodeAction(entries[i].content);
            if (!action) { continue; }
            const result = i + 1 < entries.length ? decodeToolResult(entries[i + 1].content) : null;
            const output = result?.output ?? '';
            out.push({ action, ok: !!result && !/^(BLOCKED|FAILED|DECLINED)\b/.test(output), output });
        }
        return out;
    }

    private progress(): string {
        const done: string[] = [];
        const failed: string[] = [];
        for (const { action, ok, output } of this.runActions()) {
            if (action.type === 'final-answer') { continue; }
            (ok ? done : failed).push(`${actionCommandLabel(action).slice(0, 80)}${ok ? '' : ` → ${output.slice(0, 100).replace(/\s+/g, ' ')}`}`);
        }
        if (!done.length && !failed.length) { return '(nothing yet — this is the first step)'; }
        return [`Done: ${done.join(' | ') || '(none)'}`, failed.length ? `NOT done (failed/blocked): ${failed.join(' | ')}` : ''].filter(Boolean).join('\n');
    }

    private async systemPrompt(): Promise<string> {
        const toolLines = this.enabledTools().map(t => {
            const args = t.args.length ? ` args: {${t.args.map(a => `"${a.name}"${a.required ? '*' : ''}`).join(', ')}}` : '';
            return `  • {"action":"${t.id}"${t.args.length ? ', …' : ''}}${t.readOnly ? ' [read-only]' : ''}${t.risky ? ' [asks for approval]' : ''}: ${t.description}${args}`;
        }).join('\n');
        const resLines = resources.filter(r => this.isEnabled(r.id, r.enabled)).map(r => `  • ${r.id}: ${r.description}`).join('\n');
        const skillLines = [...this.harnesses.values()].filter(h => this.isEnabled(h.id, true)).map(h => `  • ${h.id}: ${h.description ?? h.name}`).join('\n');
        let tabInfo = '(no active tab)';
        try {
            const tab = await activeTab();
            const all = await ext.tabs.query({ lastFocusedWindow: true });
            tabInfo = `Active tab: [${tab.id}] ${tab.title ?? ''} — ${tab.url ?? ''}\nOpen tabs in this window: ${all.length}`;
        } catch { /* keep placeholder */ }

        return `You are Continued, an AI browsing agent running in the user's browser side panel.

## HOW YOU WORK
You operate in a loop. Each reply is exactly ONE action as a single JSON object. The action is executed and its result is sent back to you as a [TOOL RESULT]. Repeat until the task is complete, then reply with a final-answer.

## ACTIONS (reply with exactly one JSON object)
${toolLines}
  • {"action":"use-resource","resource":"<id>"} — resources:
${resLines}
  • {"action":"use-skill","skill":"<id>","input":"..."} — harnesses (fixed workflows):
${skillLines || '  (none)'}
  • {"action":"final-answer","message":"Markdown reply for the user"}

## RULES
1. Reply with ONLY one JSON object. No prose, no markdown fences.
2. Read before you conclude: use read-page / find-in-page / fetch-url to get facts; never guess page contents.
3. Prefer fetch-url for pages you only need to read; use open-tab when the user should see the page.
4. Actions that change the page (click, fill, navigate, open-tab) may ask the user for approval. If a result starts with BLOCKED, FAILED or DECLINED, choose another approach or explain in final-answer.
5. Never enter passwords, payment details or personal data unless the user explicitly asked for exactly that.
6. Use final-answer only when the task is done or you are blocked; write the message in Markdown with the sources (URLs) you used.

## EXAMPLE
User: What does this page say about pricing?
You: {"action":"find-in-page","query":"pric","context":2}
[TOOL RESULT] 3 hit(s) …
You: {"action":"final-answer","message":"The page lists three plans: …"}

## CURRENT TASK
${this.task || '(see the latest user message)'}

## PROGRESS IN THIS RUN
${this.progress()}

## BROWSER
${tabInfo}`;
    }

    // ------------------------------------------------------------------ approvals & policy
    private toolById(id: string): BrowserTool | undefined { return tools.find(t => t.id === id); }

    private isReadOnly(action: AgentAction): boolean {
        if (action.type === 'final-answer' || action.type === 'use-resource') { return true; }
        if (action.type === 'use-tool') { return !!this.toolById(action.tool)?.readOnly; }
        return false;
    }

    private isRisky(action: AgentAction): boolean {
        return action.type === 'use-tool' && !!this.toolById(action.tool)?.risky;
    }

    private awaitApproval(action: AgentAction, signal: AbortSignal): Promise<boolean> {
        return new Promise(resolve => {
            if (signal.aborted) { resolve(false); return; }
            this.approvalWaiter?.(false);
            const finish = (allow: boolean) => {
                if (this.approvalWaiter === finish) { this.approvalWaiter = null; }
                signal.removeEventListener('abort', onAbort);
                resolve(allow);
            };
            const onAbort = () => finish(false);
            this.approvalWaiter = finish;
            signal.addEventListener('abort', onAbort, { once: true });
            this.post({ type: 'requestCommandApproval', command: actionCommandLabel(action), kind: 'plugin' });
            this.post({ type: 'agentWorking', step: this.iteration, label: 'waiting for your approval…' });
        });
    }

    resolveApproval(allow: boolean): void {
        const waiter = this.approvalWaiter;
        this.approvalWaiter = null;
        waiter?.(allow);
    }

    private async executeWithPolicy(action: AgentAction, mode: string, signal: AbortSignal): Promise<string> {
        const needsApproval = !this.isReadOnly(action) && (mode !== 'agent-auto' || this.isRisky(action));
        if (needsApproval) {
            const allowed = await this.awaitApproval(action, signal);
            if (!allowed) { return 'DECLINED: the user did not approve this action.'; }
        }
        return this.execute(action, mode, signal);
    }

    private async execute(action: AgentAction, mode: string, signal: AbortSignal): Promise<string> {
        try {
            switch (action.type) {
                case 'use-tool': {
                    const tool = this.toolById(action.tool);
                    if (!tool) { return `FAILED: unknown action '${action.tool}'. Available: ${this.enabledTools().map(t => t.id).join(', ')}`; }
                    if (!this.isEnabled(tool.id, tool.enabled)) { return `FAILED: '${tool.id}' is disabled in the Plugins screen.`; }
                    return await tool.execute(action.args ?? {});
                }
                case 'use-resource': {
                    const resource = resources.find(r => r.id === action.resource);
                    if (!resource) { return `FAILED: unknown resource '${action.resource}'. Available: ${resources.map(r => r.id).join(', ')}`; }
                    return await resource.fetch();
                }
                case 'use-skill': {
                    const def = this.harnesses.get(action.skill);
                    if (!def) { return `FAILED: unknown harness '${action.skill}'. Available: ${[...this.harnesses.keys()].join(', ')}`; }
                    const settings = await getSettings();
                    const run = await this.runHarness(def, action.input ?? '', settings.lastModel || 'llama3', mode, false);
                    return run.status === 'done' ? (run.output || summarizeRun(run)) : `FAILED: harness ${run.status}: ${run.error ?? ''}\n${summarizeRun(run)}`;
                }
                case 'final-answer':
                    return '';
                default:
                    return `FAILED: '${action.type}' works on files and is not available in the browser. Use read-page, find-in-page, fetch-url, extract-links, open-tab, navigate, click or fill.`;
            }
        } catch (error) {
            return `FAILED: ${(error as Error).message}`;
        } finally {
            void signal;
        }
    }

    // ------------------------------------------------------------------ prompts
    private composePrompt(text: string, files: AttachedFile[]): string {
        if (!files.length) { return text; }
        const parts = [text.trim()];
        for (const f of files.slice(0, 10)) {
            if (f.isImage) { parts.push(`[Attached image "${f.name}" — images are not supported yet]`); continue; }
            const content = String(f.content ?? '');
            parts.push(`[Attached file: ${f.name}]\n\`\`\`\n${content.length > 60000 ? `${content.slice(0, 60000)}\n…[truncated]` : content}\n\`\`\``);
        }
        return parts.filter(Boolean).join('\n\n');
    }

    async sendPrompt(text: string, model: string, mode: string, files: AttachedFile[]): Promise<void> {
        if (!this.sessionId) { this.sessionId = `session_${Date.now()}`; }
        const prompt = this.composePrompt(text, files);
        this.history.push({ role: 'user', content: prompt });

        const trimmed = prompt.trim();
        if (/^\/plugins$/i.test(trimmed)) {
            const p = this.pluginsPayload();
            this.replyLocally(mode, ['**Enabled**', ...p.tools.filter(t => t.enabled).map(t => `- tool: \`${t.id}\``), ...p.resources.filter(r => r.enabled).map(r => `- resource: \`${r.id}\``), ...p.skills.filter(s => s.enabled).map(s => `- harness: \`${s.id}\``), '', 'Use `/tool <id> {"arg":"value"}`, `/resource <id>`, `/harness <id> <input>`'].join('\n'));
            return;
        }
        const cmd = trimmed.match(/^\/(tool|resource|skill|harness)\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]+))?$/i);
        if (cmd) {
            const kind = cmd[1].toLowerCase();
            const id = cmd[2];
            const raw = (cmd[3] ?? '').trim();
            try {
                if (kind === 'tool') {
                    let args: Record<string, unknown> = {};
                    if (raw) { try { args = JSON.parse(raw); } catch { args = { input: raw }; } }
                    const out = await this.executeWithPolicy({ type: 'use-tool', tool: id, args }, mode, new AbortController().signal);
                    this.replyLocally(mode, `Tool \`${id}\`:\n\n\`\`\`\n${out}\n\`\`\``);
                } else if (kind === 'resource') {
                    const out = await this.execute({ type: 'use-resource', resource: id }, mode, new AbortController().signal);
                    this.replyLocally(mode, `Resource \`${id}\`:\n\n\`\`\`\n${out}\n\`\`\``);
                } else {
                    const def = this.harnesses.get(id);
                    if (!def) { throw new Error(`Harness not found: ${id}`); }
                    await this.runHarness(def, raw, model, mode, true);
                }
            } catch (error) {
                this.replyLocally(mode, `Command failed: ${(error as Error).message}`);
            }
            return;
        }

        if (mode === 'agent' || mode === 'agent-auto') { await this.startAgent(prompt, model, mode); return; }
        await this.chatTurn(model, mode);
    }

    private async chatTurn(model: string, mode: string): Promise<void> {
        const settings = await getSettings();
        let system = mode === 'plan'
            ? 'You are Continued, an AI browsing assistant in PLAN mode. Do NOT act. Write a concise numbered plan another agent can execute with these tools: read-page, find-in-page, fetch-url, extract-links, list-tabs, open-tab, navigate, click, fill. Name the pages/URLs to visit and what to extract. End with a verification step. Plain Markdown, no JSON.'
            : 'You are Continued, an AI assistant in the browser side panel. Answer directly and concisely in Markdown.';
        try {
            const tab = await activeTab();
            system += `\n\nThe user is looking at: ${tab.title ?? ''} — ${tab.url ?? ''}`;
        } catch { /* no tab */ }

        this.post({ type: 'startStream' });
        let full = '';
        this.busy(true);
        try {
            full = await this.llm.stream(model, system, this.trim(this.historyForChat(), settings.maxContextChars, null), {
                onToken: t => this.post({ type: 'streamToken', value: t }),
                onThinking: t => this.post({ type: 'thinkingToken', value: t }),
                onThinkingDone: () => this.post({ type: 'thinkingDone' })
            }, { timeoutMs: 600000 });
        } catch (error) {
            const content = `Error: ${(error as Error).message}`;
            this.post({ type: 'assistantResponse', content });
            this.history.push({ role: 'assistant', content });
            await this.persist(mode);
            return;
        } finally {
            this.busy(false);
        }
        this.post({ type: 'assistantResponse', content: full });
        if (full.trim()) { this.history.push({ role: 'assistant', content: full }); }
        await this.persist(mode);
        if (mode === 'plan' && full.trim()) { this.post({ type: 'showPlan', plan: full }); }
    }

    // ------------------------------------------------------------------ agent loop
    private async startAgent(prompt: string, model: string, mode: string): Promise<void> {
        this.agentAbort?.abort();
        const abort = new AbortController();
        this.agentAbort = abort;
        this.iteration = 0;
        this.lastActionKey = '';
        this.task = prompt;
        this.log(`▶ agent (${mode}, ${model}): ${prompt.slice(0, 200)}`);
        this.post({ type: 'agentWorking', step: 1, label: mode === 'agent' ? 'starting — page changes will ask for approval…' : 'starting — only clicks and form fills will ask…' });
        await this.persist(mode);
        this.busy(true);
        try {
            await this.agentLoop(model, mode, abort);
        } finally {
            this.busy(false);
        }
    }

    private finish(mode: string, message: string | null): void {
        if (message) {
            this.post({ type: 'assistantResponse', content: message });
            this.history.push({ role: 'assistant', content: message });
            void this.persist(mode);
        }
        this.post({ type: 'agentDone' });
        this.iteration = 0;
        this.lastActionKey = '';
    }

    private async agentLoop(model: string, mode: string, abort: AbortController): Promise<void> {
        const settings = await getSettings();
        while (true) {
            if (abort.signal.aborted) { this.finish(mode, null); return; }
            this.iteration++;
            if (this.iteration > settings.maxIterations) {
                this.finish(mode, `⚠️ Stopped after ${settings.maxIterations} steps to avoid a runaway loop. Send another message to continue.`);
                return;
            }
            this.post({ type: 'agentWorking', step: this.iteration, label: 'thinking…' });

            const correction: ChatMessage[] = [];
            let action: AgentAction | null = null;
            let lastText = '';
            let lastReasoning = '';
            for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
                if (attempt > 0) {
                    correction.push({ role: 'assistant', content: lastText || (lastReasoning ? `(thinking) ${lastReasoning.slice(0, 2000)}` : '(empty reply)') });
                    correction.push({ role: 'user', content: lastText
                        ? 'Your last reply was not a valid JSON action. Reply with ONLY one JSON object such as {"action":"read-page"} or {"action":"final-answer","message":"..."}.'
                        : 'You stopped without an action. Reply with ONLY the next JSON action, or final-answer if done.' });
                }
                try {
                    const system = await this.systemPrompt();
                    const history = this.trim([...this.historyForAgent(), ...correction], settings.maxContextChars, this.task);
                    const result = await this.llm.completeDetailed(model, system, history, { jsonMode: true, signal: abort.signal, timeoutMs: settings.modelTimeoutMs });
                    lastText = result.text; lastReasoning = result.reasoning;
                } catch (error) {
                    if (abort.signal.aborted) { this.finish(mode, null); return; }
                    this.finish(mode, `Agent error: ${(error as Error).message}`);
                    return;
                }
                action = lastText ? parseAgentAction(lastText) : null;
                if (action) { break; }
            }
            if (!action) {
                const shown = sanitizeAgentDisplayResponse(lastText || lastReasoning);
                this.finish(mode, shown ? `⚠️ The model kept replying with text instead of an action:\n\n${shown.slice(0, 1500)}` : '⚠️ The model returned no usable action three times. Try another model.');
                return;
            }

            const key = JSON.stringify(action);
            if (action.type !== 'final-answer' && key === this.lastActionKey) {
                this.finish(mode, `⚠️ The agent repeated the same action twice (\`${actionCommandLabel(action)}\`), so it was stopped.`);
                return;
            }
            this.lastActionKey = key;

            if (action.type === 'final-answer') {
                this.finish(mode, action.message || 'Done.');
                return;
            }

            this.history.push({ role: 'assistant', content: encodeAction(action) });
            await this.persist(mode);
            this.post({ type: 'agentAction', content: formatActionDescription(action) });
            this.post({ type: 'agentWorking', step: this.iteration, label: `running ${actionCommandLabel(action).slice(0, 40)}…` });

            const output = await this.executeWithPolicy(action, mode, abort.signal);
            const label = actionCommandLabel(action);
            const entry = encodeToolResult(label, output, 20000);
            this.post({ type: 'commandResult', command: label, output: decodeToolResult(entry)?.output ?? output });
            this.history.push({ role: 'assistant', content: entry });
            this.log(`tool ${label.slice(0, 80)} → ${output.slice(0, 200).replace(/\s+/g, ' ')}`);
            await this.persist(mode);
        }
    }

    cancel(): void {
        const had = !!this.agentAbort && !this.agentAbort.signal.aborted;
        this.agentAbort?.abort();
        this.harnessAbort?.abort();
        this.resolveApproval(false);
        if (had) { this.history.push({ role: 'assistant', content: '⛔ Agent cancelled by user.' }); void this.persist('agent'); }
        this.post({ type: 'agentDone' });
    }

    // ------------------------------------------------------------------ harness host
    async runHarness(def: HarnessDefinition, input: string, model: string, mode: string, fromChat: boolean): Promise<HarnessRun> {
        if (this.harnessAbort && !this.harnessAbort.signal.aborted) { throw new Error('Another harness is still running. Stop it first.'); }
        const abort = new AbortController();
        this.harnessAbort = abort;
        this.log(`▶ harness ${def.id} (${mode}, ${model}) input: ${input.slice(0, 120)}`);
        this.post({ type: 'agentWorking', step: 0, label: `harness "${def.name}" running…` });

        const host: HarnessHost = {
            runTool: (pluginId, args, signal) => this.executeWithPolicy({ type: 'use-tool', tool: pluginId, args }, mode, signal),
            runResource: (pluginId, signal) => this.execute({ type: 'use-resource', resource: pluginId }, mode, signal),
            runSkill: async (pluginId, skillInput) => {
                const nested = this.harnesses.get(pluginId);
                if (!nested) { throw new Error(`Harness '${pluginId}' not found.`); }
                if (nested.id === def.id) { throw new Error('A harness cannot call itself.'); }
                const child = await runHarness(nested, { ...host, onUpdate: () => undefined }, { input: skillInput, signal: abort.signal, defaultModel: model });
                if (child.status !== 'done') { throw new Error(`Nested harness "${nested.name}" ${child.status}: ${child.error ?? ''}`); }
                return child.output;
            },
            callModel: async request => {
                const result = await this.llm.completeDetailed(request.model || model, request.system, [{ role: 'user', content: request.prompt }], { jsonMode: request.jsonMode, signal: request.signal, timeoutMs: request.timeoutMs });
                return result.text || result.reasoning;
            },
            variables: () => this.harnessVariables,
            onUpdate: run => { this.lastRun = run; this.post({ type: 'harnessRunUpdate', run }); },
            log: line => this.log(`harness ${def.id}: ${line}`)
        };

        try {
            const tab = await activeTab();
            let selection = '';
            try { selection = (await resources.find(r => r.id === 'selection')!.fetch()).replace(/^selection on .*?:\n/, '').replace('(nothing selected)', ''); } catch { /* ignore */ }
            this.harnessVariables = { activeUrl: tab.url ?? '', activeTitle: tab.title ?? '', selection, date: new Date().toISOString().slice(0, 10) };
        } catch {
            this.harnessVariables = { activeUrl: '', activeTitle: '', selection: '', date: new Date().toISOString().slice(0, 10) };
        }

        let run: HarnessRun;
        this.busy(true);
        try {
            run = await runHarness(def, host, { input, signal: abort.signal, defaultModel: model });
        } catch (error) {
            run = { harnessId: def.id, harnessName: def.name, input, status: 'failed', steps: [], output: '', error: (error as Error).message, startedAt: Date.now(), endedAt: Date.now() };
        } finally {
            this.busy(false);
            if (this.harnessAbort === abort) { this.harnessAbort = null; }
            this.resolveApproval(false);
        }
        this.lastRun = run;
        this.post({ type: 'harnessRunDone', run });
        if (fromChat) {
            if (!this.sessionId) { this.sessionId = `session_${Date.now()}`; }
            const summary = summarizeRun(run);
            this.history.push({ role: 'user', content: `Run harness "${def.name}"${input ? ` with input: ${input}` : ''}` });
            this.history.push({ role: 'assistant', content: summary });
            this.post({ type: 'harnessChatRecord', user: `▶ Harness: ${def.name}${input ? ` — ${input}` : ''}`, assistant: summary });
            await this.persist(mode);
            this.post({ type: 'agentDone' });
        }
        return run;
    }
    private harnessVariables: Record<string, string> = {};

    // ------------------------------------------------------------------ message protocol
    async handle(data: Record<string, unknown>): Promise<void> {
        const str = (k: string, fallback = '') => (data[k] === undefined || data[k] === null ? fallback : String(data[k]));
        switch (data.type) {
            case 'ping': this.post({ type: 'pong' }); break;
            case 'openSettings': await ext.runtime.openOptionsPage(); break;

            case 'getModels': {
                const settings = await getSettings();
                const models = await this.llm.listModels();
                this.post({ type: 'setModels', models, savedModel: settings.lastModel || models[0], savedMode: settings.lastMode });
                await this.postSessions();
                const lastId = await getLastSessionId();
                if (lastId) {
                    const found = (await getSessions()).find(s => s.id === lastId);
                    if (found) { this.sessionId = found.id; this.history = [...found.history]; this.postSessionView(found.mode); }
                }
                await this.postActiveTab();
                break;
            }
            case 'startNewChat': {
                this.agentAbort?.abort();
                this.sessionId = `session_${Date.now()}`;
                this.history = [];
                await setLastSessionId(this.sessionId);
                this.postSessionView();
                break;
            }
            case 'selectSession': {
                const found = (await getSessions()).find(s => s.id === str('sessionId'));
                if (found) { this.agentAbort?.abort(); this.sessionId = found.id; this.history = [...found.history]; await setLastSessionId(found.id); this.postSessionView(found.mode); }
                break;
            }
            case 'showHistoryList': await this.postSessions(); break;
            case 'deleteSession': {
                const filtered = (await getSessions()).filter(s => s.id !== str('sessionId'));
                await saveSessions(filtered);
                if (this.sessionId === str('sessionId')) { this.sessionId = null; this.history = []; await setLastSessionId(null); }
                this.post({ type: 'renderSessions', sessions: filtered });
                break;
            }
            case 'saveModelPreference': if (str('model')) { await saveSettings({ lastModel: str('model') }); } break;
            case 'saveModePreference': if (['chat', 'agent', 'agent-auto', 'plan'].includes(str('mode'))) { await saveSettings({ lastMode: str('mode') }); } break;
            case 'clearHistory': {
                this.agentAbort?.abort();
                this.history = [];
                if (this.sessionId) { const sessions = await getSessions(); const idx = sessions.findIndex(s => s.id === this.sessionId); if (idx !== -1) { sessions[idx].history = []; await saveSessions(sessions); } }
                break;
            }

            case 'getPlugins': case 'reloadPlugins': this.postPlugins(); break;
            case 'togglePlugin': {
                this.overrides[str('pluginId')] = data.enabled === true;
                await savePluginOverrides(this.overrides);
                this.postPlugins();
                break;
            }
            case 'createPlugin': case 'editPlugin': case 'openPluginsFolder': case 'duplicatePlugin': case 'renamePlugin': case 'deletePlugin':
                this.post({ type: 'harnessError', message: 'Custom plugins are not available in the browser build. Build workflows in the 🧩 Harness view instead.' });
                break;

            case 'respondToEdit': case 'respondToDelete': case 'respondToCommand':
                this.resolveApproval(str('action') === 'Allow');
                break;
            case 'approveOp': case 'rejectOp': case 'approveAllOps': case 'rejectAllOps': break;
            case 'cancelAgent': this.cancel(); break;

            case 'executePlan': {
                const plan = str('plan').trim();
                if (!plan) { break; }
                await this.sendPrompt(`Execute the following plan step by step and stop with a final-answer when every step is done.\n\n${plan}`, str('model', (await getSettings()).lastModel || 'llama3'), 'agent', []);
                break;
            }
            case 'sendPrompt': {
                await this.sendPrompt(str('value'), str('model', 'llama3'), str('mode', 'chat'), Array.isArray(data.attachedFiles) ? data.attachedFiles as AttachedFile[] : []);
                break;
            }

            // ---- harness dashboard ----
            case 'harnessCatalog': {
                this.post({ type: 'harnessCatalog', catalog: this.harnessCatalog() });
                if (this.lastRun) { this.post({ type: 'harnessRunUpdate', run: this.lastRun }); }
                break;
            }
            case 'harnessReload': await this.loadHarnesses(); this.post({ type: 'harnessCatalog', catalog: this.harnessCatalog() }); this.postPlugins(); break;
            case 'harnessGet': {
                const def = this.harnesses.get(str('id'));
                if (def) { this.post({ type: 'harnessDefinition', definition: def }); } else { this.post({ type: 'harnessError', message: `Harness "${str('id')}" not found.` }); }
                break;
            }
            case 'harnessSave': {
                try {
                    const def = data.definition as HarnessDefinition;
                    if (!def || typeof def !== 'object') { throw new Error('Nothing to save.'); }
                    if (!def.id) { def.id = slug(def.name || 'my-harness'); }
                    def.source = 'user';
                    if (this.harnesses.get(def.id)?.source === 'built-in') { throw new Error(`"${def.id}" is built-in. Duplicate it to get an editable copy.`); }
                    const problems = validateHarness(def, this.knownPlugins());
                    if (problems.length) { throw new Error(`Cannot save:\n- ${problems.join('\n- ')}`); }
                    const map = await getUserHarnesses();
                    map[def.id] = def;
                    await saveUserHarnesses(map);
                    await this.loadHarnesses();
                    this.post({ type: 'harnessCatalog', catalog: this.harnessCatalog() });
                    this.postPlugins();
                    this.post({ type: 'harnessSaved', id: def.id });
                } catch (error) {
                    this.post({ type: 'harnessError', message: (error as Error).message });
                }
                break;
            }
            case 'harnessDuplicate': {
                const source = this.harnesses.get(str('id'));
                if (!source) { this.post({ type: 'harnessError', message: `Harness "${str('id')}" not found.` }); break; }
                const copy: HarnessDefinition = JSON.parse(JSON.stringify(source));
                let id = slug(`${source.name} copy`);
                let n = 1;
                while (this.harnesses.has(id)) { id = slug(`${source.name} copy ${++n}`); }
                copy.id = id; copy.name = `${source.name} (copy)`; copy.source = 'user';
                const map = await getUserHarnesses();
                map[id] = copy;
                await saveUserHarnesses(map);
                await this.loadHarnesses();
                this.post({ type: 'harnessCatalog', catalog: this.harnessCatalog() });
                this.postPlugins();
                this.post({ type: 'harnessDefinition', definition: copy, openBuilder: true });
                break;
            }
            case 'harnessDelete': {
                const def = this.harnesses.get(str('id'));
                if (!def) { break; }
                if (def.source === 'built-in') { this.post({ type: 'harnessError', message: 'Built-in harnesses cannot be deleted.' }); break; }
                const map = await getUserHarnesses();
                delete map[def.id];
                await saveUserHarnesses(map);
                await this.loadHarnesses();
                this.post({ type: 'harnessCatalog', catalog: this.harnessCatalog() });
                this.postPlugins();
                break;
            }
            case 'harnessOpenFile': {
                const def = this.harnesses.get(str('id'));
                if (def) { this.post({ type: 'harnessError', message: `JSON for "${def.id}":\n${JSON.stringify(def, null, 2).slice(0, 4000)}` }); }
                break;
            }
            case 'harnessRun': {
                const def = this.harnesses.get(str('id'));
                if (!def) { this.post({ type: 'harnessError', message: `Harness "${str('id')}" not found.` }); break; }
                const input = str('input').trim();
                if (def.input?.required && !input) { this.post({ type: 'harnessError', message: `"${def.name}" needs an input: ${def.input.label ?? 'input'}.` }); break; }
                const settings = await getSettings();
                try {
                    await this.runHarness(def, input, str('model', settings.lastModel || 'llama3'), str('mode', settings.lastMode), true);
                } catch (error) {
                    this.post({ type: 'harnessError', message: (error as Error).message });
                    this.post({ type: 'agentDone' });
                }
                break;
            }
            case 'harnessStop': this.harnessAbort?.abort(); this.resolveApproval(false); break;
        }
    }

    settingsSnapshot(): Promise<Settings> { return getSettings(); }
    sessionsSnapshot(): Promise<ChatSession[]> { return getSessions(); }
}
