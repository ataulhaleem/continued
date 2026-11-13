/**
 * The terminal host: implements `HarnessHost` over the Node tools, the editor-free LLM client
 * and a readline approval prompt. The approval contract is the editor's: read-only tools never
 * ask; anything else asks unless the run was started with `--yes`; a forbidden command is
 * blocked whatever the answer would have been; a declined step is terminal.
 */

import * as readline from 'readline';
import { HarnessHost, LlmStepRequest, runHarness } from '../../core/harness/harnessEngine';
import { HarnessDefinition, HarnessRun } from '../../core/harness/types';
import { LlmClient, ModelInfo } from '../../browser-plugin/src/core/llmClient';
import { AgentGuardrails } from '../../src/agentGuardrails';
import { tools, resources } from './tools';

export type ApprovalMode = 'ask' | 'all' | 'none';

export interface HostOptions {
    workspaceRoot: string;
    approvals: ApprovalMode;
    /** Workspace-relative path for `{{activeFile}}`. */
    activeFile?: string;
    selection?: string;
    /** Other harnesses reachable as skills, by id. */
    harnesses: Map<string, HarnessDefinition>;
    log?: (line: string) => void;
    onUpdate?: (run: HarnessRun) => void;
    /** Called for each approval request, before the answer. */
    onApprovalRequest?: (description: string) => void;
    /** Called when a terminal prompt opens and closes, so progress output can be held back. */
    onPrompt?: (open: boolean) => void;
    quiet?: boolean;
}

export function envSecrets(): (name: 'openai' | 'gemini' | 'anthropic' | 'blablador') => Promise<string | undefined> {
    const names: Record<string, string[]> = {
        blablador: ['ENCLAVE_BLABLADOR_KEY', 'BLABLADOR_API_KEY'],
        openai: ['ENCLAVE_OPENAI_KEY', 'OPENAI_API_KEY'],
        anthropic: ['ENCLAVE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'],
        gemini: ['ENCLAVE_GEMINI_KEY', 'GEMINI_API_KEY']
    };
    return async name => { for (const v of names[name] ?? []) { if (process.env[v]) { return process.env[v]; } } return undefined; };
}

export function ollamaUrl(): string {
    return (process.env.ENCLAVE_OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
}

export function makeLlm(log?: (line: string) => void): LlmClient {
    return new LlmClient(envSecrets(), async () => ollamaUrl(), log ?? (() => undefined));
}

export async function listModels(llm: LlmClient): Promise<ModelInfo[]> { return llm.listModels(); }

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

export class CliHost implements HarnessHost {
    approvalsRequested = 0;
    approvalsDeclined = 0;
    /** Time spent waiting for a human at approval prompts; step durations include it. */
    approvalWaitMs = 0;
    private approveAll: boolean;
    private readonly guardrails = new AgentGuardrails();
    readonly llm: LlmClient;

    constructor(private readonly o: HostOptions) {
        this.approveAll = o.approvals === 'all';
        this.llm = makeLlm(o.log);
    }

    variables(): Record<string, string> {
        return { workspace: this.o.workspaceRoot, activeFile: this.o.activeFile ?? '', selection: this.o.selection ?? '', date: new Date().toISOString().slice(0, 10) };
    }

    onUpdate(run: HarnessRun): void { this.o.onUpdate?.(run); }
    log(line: string): void { this.o.log?.(line); }

    private async approve(kind: string, detail: string): Promise<boolean> {
        this.approvalsRequested++;
        this.o.onApprovalRequest?.(`${kind}: ${detail}`);
        if (this.approveAll) { return true; }
        if (this.o.approvals === 'none' || !process.stdin.isTTY) { this.approvalsDeclined++; return false; }
        this.o.onPrompt?.(true);
        const started = Date.now();
        let answer: string;
        try {
            answer = (await ask(`\n  ▶ ${kind}\n    ${detail}\n  Allow? [y]es / [N]o / [a]ll for this run: `)).toLowerCase();
        } finally {
            this.approvalWaitMs += Date.now() - started;
            this.o.onPrompt?.(false);
        }
        if (/^a/.test(answer)) { this.approveAll = true; return true; }
        if (/^y/.test(answer)) { return true; }
        this.approvalsDeclined++;
        return false;
    }

    /** Guardrails and approval, before the step's clock starts. */
    async gateTool(pluginId: string, args: Record<string, unknown>): Promise<string | null> {
        const tool = tools.find(t => t.id === pluginId);
        if (!tool) { return `FAILED: tool '${pluginId}' is not available in the CLI. Available: ${tools.map(t => t.id).join(', ')}.`; }
        if (pluginId === 'run-command') {
            const command = String(args.command ?? '');
            const verdict = this.guardrails.isSafeCommand(command);
            if (!verdict.safe) { return `BLOCKED: ${verdict.reason ?? 'forbidden command'}`; }
        }
        if (!tool.readOnly) {
            const allowed = await this.approve(pluginId, pluginId === 'run-command' ? String(args.command ?? '') : JSON.stringify(args));
            if (!allowed) { return 'DECLINED: the user did not approve this step.'; }
        }
        return null;
    }

    async runTool(pluginId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
        const tool = tools.find(t => t.id === pluginId)!;
        return tool.execute(this.o.workspaceRoot, args, 120000, signal);
    }

    async runResource(pluginId: string): Promise<string> {
        const r = resources.find(x => x.id === pluginId);
        if (!r) { return `FAILED: resource '${pluginId}' is not available in the CLI. Available: ${resources.map(x => x.id).join(', ')}.`; }
        return r.fetch(this.o.workspaceRoot);
    }

    async runSkill(pluginId: string, input: string, signal: AbortSignal): Promise<string> {
        const def = this.o.harnesses.get(pluginId);
        if (!def) { return `FAILED: skill '${pluginId}' is not a known harness.`; }
        const nested = new CliHost({ ...this.o, onUpdate: undefined });
        nested.approveAll = this.approveAll;
        const run = await runHarness(def, nested, { input, signal, defaultModel: this.defaultModel });
        this.approvalsRequested += nested.approvalsRequested;
        if (run.status !== 'done') { return `FAILED: nested harness ${pluginId} ${run.status}: ${run.error ?? ''}`; }
        return run.output;
    }

    defaultModel = 'llama3';

    async callModel(request: LlmStepRequest): Promise<string> {
        const model = request.model || this.defaultModel;
        try {
            const result = await this.llm.completeDetailed(model, request.system, [{ role: 'user', content: request.prompt }], {
                jsonMode: request.jsonMode, signal: request.signal, timeoutMs: request.timeoutMs
            });
            return result.text;
        } catch (error) {
            const message = (error as Error).message ?? String(error);
            if (/ollama/i.test(message) && /404|not found/i.test(message)) {
                throw new Error(`Model '${model}' is not available on Ollama at ${ollamaUrl()}. Pull it first:  ollama pull ${model}`);
            }
            if (/ECONNREFUSED|fetch failed/i.test(message) && !model.includes('/')) {
                throw new Error(`Ollama is not reachable at ${ollamaUrl()}. Start it (\`ollama serve\`) or set ENCLAVE_OLLAMA_URL.`);
            }
            throw error;
        }
    }
}
