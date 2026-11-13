import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { showProviderSelector } from './providers';
import { PluginRegistry } from './plugins/pluginRegistry';
import { SkillContext } from './plugins/types';
import { generateChatViewHTML } from '../core/ui/chatView';
import { readFileTool, writeFileTool, deleteFileTool } from './plugins/builtIn/fileTools';
import { semanticSearchTool, grepSearchTool, workspaceFilesResource } from './plugins/builtIn/searchTools';
import { runCommandTool, openFileTool } from './plugins/builtIn/terminalTools';
import { listDirectoryTool, fileInfoTool, editFileTool, appendFileTool, moveFileTool, copyFileTool, makeDirectoryTool } from './plugins/builtIn/fsTools';
import { csvPreviewTool, jsonQueryTool } from './plugins/builtIn/dataTools';
import { gitInfoTool, pythonRunTool, httpFetchTool } from './plugins/builtIn/osTools';
import { createModelTools } from './plugins/builtIn/modelTools';
import { systemInfoResource, devEnvironmentResource, openEditorsResource, gitSummaryResource, diagnosticsResource, projectInfoResource } from './plugins/builtIn/resources';
import { projectSnapshotSkill, largestFilesSkill } from './plugins/builtIn/builtInSkills';
import { LlmClient, ChatMessage, CompletionResult } from './llmClient';
import { AgentGuardrails } from './agentGuardrails';
import { HarnessDefinition, HarnessRun } from '../core/harness/types';
import { HarnessHost, runHarness, summarizeRun, validateHarness } from '../core/harness/harnessEngine';
import { builtInHarnesses } from './harness/builtInHarnesses';
import { deleteUserHarness, harnessFileUri, loadUserHarnesses, saveUserHarness, slugifyHarnessId } from './harness/harnessStore';
import { collectRequirements, exportFileName, fromPortable, toMarkdown, toPortableJson } from '../core/harness/portable';
import { cwlFileNames, toCwl } from '../core/harness/cwl';
import { ContainerEndpoint, PodmanNotFoundError, checkPodman, confirmContainerRun, installPodmanInTerminal, prepareContainerRun, runInContainer } from './harness/containerRunner';
import { detectProvider, getOllamaBaseUrl, stripProviderPrefix } from './llmClient';
import { ISkill } from './plugins/types';
import {
    AgentAction,
    actionCommandLabel,
    decodeAction,
    decodeToolResult,
    encodeAction,
    encodeToolResult,
    formatActionDescription,
    isLegacyUiLabel,
    isReadOnlyAction,
    parseAgentAction,
    sanitizeAgentDisplayResponse,
    canonicalizeAction as canonicalizeAgentAction
} from '../core/agentActions';

const execAsync = promisify(exec);

interface ChatSession {
    id: string;
    title: string;
    history: ChatMessage[];
    mode: string;
}

/** What the webview renders for one history entry. */
interface DisplayMessage {
    role: 'user' | 'assistant';
    kind: 'text' | 'action' | 'tool';
    content: string;
    command?: string;
    output?: string;
}

interface AttachedFile {
    name: string;
    type?: string;
    size?: number;
    isImage?: boolean;
    /** Set by the shared chat UI for .pdf files, whose content is then a data URL. */
    isPdf?: boolean;
    content?: string;
}

interface PendingApproval {
    action: AgentAction;
    model: string;
    mode: AgentRunMode;
}

/** One harness step waiting for the user to allow or decline it. */
interface QueuedApproval {
    action: AgentAction;
    view: vscode.WebviewView;
    /** Set when the step reads the active editor document from outside the workspace. */
    outsideDocument?: vscode.TextDocument | null;
    /** Resolve the waiting step. Safe to call more than once; only the first call counts. */
    settle(allow: boolean): void;
}

/** A file change made by the agent in this session, kept so it can be reverted from the UI. */
interface RunChange {
    relativePath: string;
    originalContent: string;
    existed: boolean;
    isDeletion: boolean;
}

type AgentRunMode = 'agent' | 'agent-auto';

/** Marks a message the user sent while an agent run was going; the model reads it as guidance mid-task. */
const STEER_PREFIX = '[USER NOTE during the run]';
function isSteeringNote(content: string): boolean { return content.startsWith(STEER_PREFIX); }

const DEDICATED_TOOL_IDS = ['read-file', 'write-file', 'delete-file', 'semantic-search', 'grep-search', 'run-command'];

/** Canonicalize against this host's dedicated tools. See `canonicalizeAction` in core. */
function canonicalizeAction(action: AgentAction): AgentAction {
    return canonicalizeAgentAction(action, DEDICATED_TOOL_IDS);
}

function isAgentMode(mode: string): mode is AgentRunMode {
    return mode === 'agent' || mode === 'agent-auto';
}

export class ContinuedSidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _currentSessionId: string | null = null;
    private _chatHistory: ChatMessage[] = [];
    private _pluginRegistry?: PluginRegistry;
    private readonly _llm: LlmClient;
    private readonly _log: vscode.OutputChannel;
    private _guardrails: AgentGuardrails;

    // Agent run state
    private _pendingApproval: PendingApproval | null = null;
    private _runChanges: RunChange[] = [];
    /** Files whose current content the model has seen in this run (read or written). */
    private _runKnownFiles: Set<string> = new Set();
    private _agentIteration = 0;
    /** When the current agent run started; the wall-clock budget is measured from here. */
    private _agentRunStartedAt = 0;
    /** Time this run spent waiting for the user's approval; it does not count against the budget. */
    private _agentPausedMs = 0;
    private _approvalWaitStartedAt = 0;
    private _completionChallengeSent = false;
    private _agentTask = '';
    private _pendingTask = '';
    /** The mode the run follows right now: the dropdown can change it while the run is going. */
    private _liveMode: AgentRunMode = 'agent';

    // Harness state
    private _harnesses: Map<string, HarnessDefinition> = new Map();
    private _harnessProblems: string[] = [];
    private _harnessAbort: AbortController | null = null;
    private _lastHarnessRun: HarnessRun | null = null;
    /**
     * Approvals requested by harness steps (promise-based, unlike the agent loop).
     *
     * A parallel group or a parallel foreach can raise several at once, so they queue and are
     * shown one at a time. Only the head of the queue is on screen; the rest wait their turn.
     * An earlier design kept a single slot and silently auto-declined whatever was already
     * waiting, which made parallel steps fail with an unexplained DECLINED.
     */
    private _approvalQueue: QueuedApproval[] = [];
    private _agentCurrentFile: string | null = null;
    private _agentAbort: AbortController | null = null;
    private _lastActionKey = '';
    private _cachedWorkspaceSummary = '';

    constructor(
        private readonly _context: vscode.ExtensionContext
    ) {
        this._log = vscode.window.createOutputChannel('Enclave');
        _context.subscriptions.push(this._log);
        this._llm = new LlmClient(_context.secrets, line => this._log.appendLine(`[${new Date().toISOString()}] ${line}`));
        this._guardrails = this._createGuardrails();

        // Persist model/mode preferences across VS Code restarts
        _context.globalState.setKeysForSync([
            `continued_last_model::${this._workspaceScopeId()}`,
            `continued_last_mode::${this._workspaceScopeId()}`,
            'continued_last_model',
            'continued_last_mode',
        ]);
    }

    // =====================================================================
    // Settings & workspace helpers
    // =====================================================================

    private _cfg<T>(key: string, fallback: T): T {
        return vscode.workspace.getConfiguration('continued').get<T>(key, fallback);
    }

    /** Sleep that ends early when the run is cancelled. */
    private _pause(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            if (signal.aborted) { resolve(); return; }
            const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
            const done = () => { clearTimeout(timer); resolve(); };
            signal.addEventListener('abort', done, { once: true });
        });
    }

    private _createGuardrails(): AgentGuardrails {
        return new AgentGuardrails({
            maxIterations: this._cfg<number>('agent.maxIterations', 500),
            commandTimeoutMs: this._cfg<number>('agent.commandTimeoutMs', 60000),
            maxRunMs: this._cfg<number>('agent.maxRunMinutes', 240) * 60000,
            maxConsecutiveFailures: this._cfg<number>('agent.maxConsecutiveFailures', 4),
        });
    }

    private _workspaceRoot(): string | null {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
    }

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

    // =====================================================================
    // Sessions
    // =====================================================================

    private _getAllSessions(): ChatSession[] {
        return this._getScopedState<ChatSession[]>('continued_sessions', 'continued_sessions') ?? [];
    }

    private _saveSessions(sessions: ChatSession[]) {
        this._setScopedState('continued_sessions', sessions);
    }

    private _sessionTitleFrom(text: string): string {
        const clean = (text || '').replace(/\s+/g, ' ').trim();
        if (!clean) {return 'Session';}
        return clean.length > 28 ? `${clean.substring(0, 25)}...` : clean;
    }

    /** Save the in-memory history into the current session (creating the session on first use). */
    private _persistSession(mode: string) {
        if (!this._currentSessionId) {return;}

        const sessions = this._getAllSessions();
        const idx = sessions.findIndex(s => s.id === this._currentSessionId);

        if (idx !== -1) {
            sessions[idx].history = this._chatHistory;
            sessions[idx].mode = mode;
        } else {
            const firstUser = this._chatHistory.find(m => m.role === 'user')?.content ?? '';
            sessions.unshift({
                id: this._currentSessionId,
                title: this._sessionTitleFrom(firstUser),
                history: this._chatHistory,
                mode
            });
        }

        this._saveSessions(sessions);
        this._setScopedState('continued_last_session_id', this._currentSessionId);
    }

    /** Convert the raw history into renderable entries for the webview. */
    private _historyForDisplay(): DisplayMessage[] {
        const out: DisplayMessage[] = [];
        for (const m of this._chatHistory) {
            if (m.role === 'system') {continue;}
            if (m.role === 'user') {
                out.push({ role: 'user', kind: 'text', content: m.content });
                continue;
            }
            const action = decodeAction(m.content) ?? (m.content.trim().startsWith('{') ? parseAgentAction(m.content) : null);
            if (action) {
                out.push({ role: 'assistant', kind: 'action', content: formatActionDescription(action) });
                continue;
            }
            const result = decodeToolResult(m.content);
            if (result) {
                out.push({ role: 'assistant', kind: 'tool', content: '', command: result.command, output: result.output });
                continue;
            }
            out.push({ role: 'assistant', kind: 'text', content: m.content });
        }
        return out;
    }

    private _postSessionView(view: vscode.WebviewView, mode?: string) {
        view.webview.postMessage({ type: 'loadSessionView', history: this._historyForDisplay(), mode });
        this._postPendingOps(view);
    }

    // =====================================================================
    // Model-facing history
    // =====================================================================

    /** History for Chat / Plan mode: actions become short labels, tool output is dropped. */
    private _historyForChatModel(): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (const m of this._chatHistory) {
            if (m.role === 'system') {continue;}
            if (m.role === 'user') { out.push(m); continue; }
            const action = decodeAction(m.content);
            if (action) {
                if (action.type !== 'final-answer') { out.push({ role: 'assistant', content: `(agent action) ${actionCommandLabel(action)}` }); }
                continue;
            }
            if (decodeToolResult(m.content)) {continue;}
            out.push(m);
        }
        return out;
    }

    private _toolResultNudge(command: string): string {
        if (command.startsWith('read-file ')) {
            return 'If the task requires changing this file, reply with a write-file action containing the FULL updated content. Otherwise continue with the next action, or final-answer if the task is complete. Reply with ONLY one JSON object.';
        }
        if (command.startsWith('semantic-search') || command.startsWith('grep-search')) {
            return 'Use these results to continue: read the relevant file(s) one at a time, or final-answer if you have what you need. Reply with ONLY one JSON object.';
        }
        return 'Continue with the next JSON action, or final-answer if the task is complete. Reply with ONLY one JSON object.';
    }

    /** History for the agent loop: actions are raw JSON, tool results become user observations. */
    private _historyForAgentModel(): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (const m of this._chatHistory) {
            if (m.role === 'system') {continue;}
            if (m.role === 'user') { out.push(m); continue; }

            const action = decodeAction(m.content);
            if (action) {
                out.push({ role: 'assistant', content: JSON.stringify(this._compactActionForHistory(action)) });
                continue;
            }

            const result = decodeToolResult(m.content);
            if (result) {
                out.push({
                    role: 'user',
                    content: `[TOOL RESULT]\nCommand: ${result.command}\nOutput:\n${result.output}\n\n---\n${this._toolResultNudge(result.command)}`
                });
                continue;
            }

            if (isLegacyUiLabel(m.content)) {continue;}
            out.push(m);
        }
        return out;
    }

    private _compactActionForHistory(action: AgentAction): AgentAction {
        if (action.type === 'write-file' && action.content.length > 3000) {
            return { ...action, content: `[content omitted from history: ${action.content.length} characters were written successfully; do not resend]` };
        }
        return action;
    }

    /** Keep the most recent messages within a character budget, never dropping the current task. */
    private _trimForPayload(history: ChatMessage[], task: string | null = null): ChatMessage[] {
        const maxMessages = this._cfg<number>('agent.maxHistoryMessages', 40);
        const maxChars = this._cfg<number>('agent.maxContextChars', 80000);
        const recent = history.slice(-maxMessages);
        const selected: ChatMessage[] = [];
        let charCount = 0;

        for (let i = recent.length - 1; i >= 0; i--) {
            const msg = recent[i];
            if (charCount + msg.content.length > maxChars && selected.length > 0) {break;}
            selected.unshift(msg);
            charCount += msg.content.length;
        }

        if (task && !selected.some(m => m.role === 'user' && m.content === task)) {
            selected.unshift({ role: 'user', content: task });
        }
        return selected;
    }

    private async _buildWorkspaceContextSummary(): Promise<string> {
        const maxFiles = 150;
        const files = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build,.next,target,venv,.venv,.cache,__pycache__}/**',
            maxFiles + 1
        );

        const hasMore = files.length > maxFiles;
        const visibleFiles = files.slice(0, maxFiles).map(f => vscode.workspace.asRelativePath(f)).sort();
        let summary = visibleFiles.join(', ');

        if (summary.length > 6000) {
            summary = `${summary.slice(0, 6000)} ...`;
        }

        if (!summary) {
            return 'No files detected.';
        }

        return hasMore
            ? `${summary} (and more files omitted for brevity)`
            : summary;
    }

    // =====================================================================
    // Plugins
    // =====================================================================

    private async _initializePlugins() {
        const workspaceId = this._workspaceScopeId();
        this._pluginRegistry = new PluginRegistry(this._context, workspaceId);

        this._pluginRegistry.registerTool(readFileTool);
        this._pluginRegistry.registerTool(writeFileTool);
        this._pluginRegistry.registerTool(deleteFileTool);
        this._pluginRegistry.registerTool(semanticSearchTool);
        this._pluginRegistry.registerTool(grepSearchTool);
        this._pluginRegistry.registerTool(runCommandTool);
        this._pluginRegistry.registerTool(openFileTool);
        for (const tool of [listDirectoryTool, fileInfoTool, editFileTool, appendFileTool, moveFileTool, copyFileTool, makeDirectoryTool, csvPreviewTool, jsonQueryTool, gitInfoTool, pythonRunTool, httpFetchTool]) {
            this._pluginRegistry.registerTool(tool);
        }
        for (const tool of createModelTools(this._llm)) {
            this._pluginRegistry.registerTool(tool);
        }

        this._pluginRegistry.registerResource(workspaceFilesResource);
        for (const resource of [projectInfoResource, gitSummaryResource, diagnosticsResource, openEditorsResource, devEnvironmentResource, systemInfoResource]) {
            this._pluginRegistry.registerResource(resource);
        }

        this._pluginRegistry.registerSkill(projectSnapshotSkill);
        this._pluginRegistry.registerSkill(largestFilesSkill);

        await this._loadUserPlugins();
        await this._loadHarnesses();
    }

    // =====================================================================
    // Harnesses — declarative workflows registered as skills
    // =====================================================================

    private async _loadHarnesses() {
        if (!this._pluginRegistry) { return; }
        // Drop previously registered harness skills so removed files disappear.
        for (const [id, def] of this._harnesses) {
            if (def.source === 'user') {
                const existing = this._pluginRegistry.getSkill(id);
                if (existing?.harness) { await this._pluginRegistry.removePlugin(id); }
            }
        }
        this._harnesses = new Map();
        for (const def of builtInHarnesses) { this._harnesses.set(def.id, def); }
        const loaded = await loadUserHarnesses();
        this._harnessProblems = loaded.problems;
        for (const def of loaded.harnesses) { this._harnesses.set(def.id, def); }
        for (const problem of loaded.problems) {
            this._log.appendLine(`[${new Date().toISOString()}] harness load problem: ${problem}`);
        }
        for (const def of this._harnesses.values()) {
            this._pluginRegistry.registerSkill(this._harnessAsSkill(def));
        }
    }

    private _harnessAsSkill(def: HarnessDefinition): ISkill {
        return {
            id: def.id,
            name: def.name,
            version: def.version ?? '1.0.0',
            author: def.source === 'built-in' ? 'Enclave' : 'You',
            description: `${def.description ?? ''}${def.input?.label ? ` (input: ${def.input.label})` : ''}`.trim() || def.name,
            enabled: true,
            source: def.source,
            category: 'skill',
            harness: true,
            steps: [],
            execute: async (_context, input?: string) => {
                if (!this._view) { throw new Error('Sidebar is not open.'); }
                const model = this._getScopedState<string>('continued_last_model') || 'llama3';
                const mode = this._getScopedState<string>('continued_last_mode') || 'agent';
                const run = await this._runHarness(def, input ?? '', model, mode, this._view, { fromChat: false });
                if (run.status !== 'done') {
                    return `FAILED: harness "${def.name}" ${run.status}: ${run.error ?? 'see the Harness view for details'}\n\n${summarizeRun(run)}`;
                }
                return run.output || summarizeRun(run);
            }
        };
    }

    private _harnessSummaries() {
        return [...this._harnesses.values()].map(def => ({
            id: def.id,
            name: def.name,
            description: def.description ?? '',
            source: def.source,
            input: def.input ?? null,
            stepCount: def.steps.length
        }));
    }

    private _harnessCatalog() {
        const all = this._pluginRegistry?.getAllPlugins() ?? { tools: [], resources: [], skills: [] };
        const strip = (p: { id: string; name: string; description?: string; enabled: boolean; source: string; args?: unknown; harness?: boolean }) =>
            ({ id: p.id, name: p.name, description: p.description ?? '', enabled: p.enabled, source: p.source, args: p.args ?? [], harness: !!p.harness });
        return {
            harnesses: this._harnessSummaries(),
            problems: this._harnessProblems,
            plugins: {
                tools: all.tools.filter(t => t.enabled).map(strip),
                resources: all.resources.filter(r => r.enabled).map(strip),
                skills: all.skills.filter(s => s.enabled).map(strip)
            },
            variables: ['input', 'item', 'index', 'workspace', 'activeFile', 'selection', 'steps.<id>.output', 'steps.<id>.status', 'steps.<id>.error', 'steps.<id>.lines', 'steps.<id>.json.<key>']
        };
    }

    private _postHarnessCatalog(view: vscode.WebviewView) {
        view.webview.postMessage({ type: 'harnessCatalog', catalog: { ...this._harnessCatalog(), capabilities: { container: true } } });
    }

    private _knownPluginSets() {
        const all = this._pluginRegistry?.getAllPlugins() ?? { tools: [], resources: [], skills: [] };
        return {
            tools: new Set(all.tools.filter(t => t.enabled).map(t => t.id)),
            resources: new Set(all.resources.filter(r => r.enabled).map(r => r.id)),
            skills: new Set(all.skills.filter(s => s.enabled).map(s => s.id))
        };
    }

    private async _saveHarnessFromUi(raw: unknown): Promise<HarnessDefinition> {
        const def = raw as HarnessDefinition;
        if (!def || typeof def !== 'object') { throw new Error('Nothing to save.'); }
        if (!def.id) { def.id = slugifyHarnessId(def.name || 'my-harness'); }
        def.source = 'user';
        const existing = this._harnesses.get(def.id);
        if (existing?.source === 'built-in') {
            throw new Error(`"${def.id}" is a built-in harness. Duplicate it to make an editable copy.`);
        }
        const problems = validateHarness(def, this._knownPluginSets());
        if (problems.length) { throw new Error(`Cannot save:\n- ${problems.join('\n- ')}`); }
        await saveUserHarness(def);
        await this._loadHarnesses();
        return def;
    }

    private _harnessVariables(): Record<string, string> {
        const editor = vscode.window.activeTextEditor;
        const activeFile = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';
        const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
        return {
            workspace: this._workspaceRoot() ?? '',
            activeFile,
            selection,
            date: new Date().toISOString().slice(0, 10)
        };
    }

    /** Execute a tool plugin on behalf of a harness step: guardrails + mode approval + change tracking. */
    private async _runHarnessTool(pluginId: string, args: Record<string, unknown>, mode: string, view: vscode.WebviewView, signal: AbortSignal): Promise<string> {
        const action = canonicalizeAction({ type: 'use-tool', tool: pluginId, args });
        if (action.type !== 'use-tool' && !this._isToolEnabled(pluginId)) {
            return `FAILED: tool '${pluginId}' is disabled in Plugin Manager.`;
        }
        return this._executeActionWithPolicy(action, mode, view, signal);
    }

    /** The harness engine's gate: guardrails and approval, run before the step's timeout starts. */
    private async _gateHarnessTool(pluginId: string, args: Record<string, unknown>, mode: string, view: vscode.WebviewView, signal: AbortSignal): Promise<string | null> {
        const action = canonicalizeAction({ type: 'use-tool', tool: pluginId, args });
        if (action.type !== 'use-tool' && !this._isToolEnabled(pluginId)) {
            return `FAILED: tool '${pluginId}' is disabled in Plugin Manager.`;
        }
        return this._policyGate(action, mode, view, signal);
    }

    /** The execution half: the gate has already passed. */
    private _executeHarnessTool(pluginId: string, args: Record<string, unknown>): Promise<string> {
        return this._executeAgentAction(canonicalizeAction({ type: 'use-tool', tool: pluginId, args }));
    }

    /** Promise-based counterpart of the agent loop's dispatch: guardrails, approval by mode, then execution. */
    private async _executeActionWithPolicy(rawAction: AgentAction, mode: string, view: vscode.WebviewView, signal: AbortSignal): Promise<string> {
        const action = canonicalizeAction(rawAction);
        const verdict = await this._policyGate(action, mode, view, signal);
        if (verdict) { return verdict; }
        return this._executeAgentAction(action);
    }

    /** Guardrails, then approval by mode. Resolves null to proceed, or the BLOCKED/DECLINED result. */
    private async _policyGate(action: AgentAction, mode: string, view: vscode.WebviewView, signal: AbortSignal): Promise<string | null> {
        const blocked = await this._guardrailCheck(action, false);
        if (blocked) { return `BLOCKED: ${blocked}`; }

        const outsideDocument = this._activeDocumentOutsideWorkspace(action);
        const needsApproval = outsideDocument !== null || (!this._isReadOnly(action) && (
            mode !== 'agent-auto' ||
            this._sendsDataOut(action) ||
            (action.type === 'run-command' && this._guardrails.requiresExplicitApproval(action.command))
        ));
        if (needsApproval) {
            const allowed = await this._awaitApproval(view, action, signal, outsideDocument);
            if (!allowed) { return 'DECLINED: the user did not approve this step.'; }
        }
        return null;
    }

    private _awaitApproval(view: vscode.WebviewView, action: AgentAction, signal: AbortSignal, outsideDocument: vscode.TextDocument | null = null): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            if (signal.aborted) { resolve(false); return; }
            let settled = false;
            const onAbort = () => entry.settle(false);
            const entry: QueuedApproval = {
                action,
                view,
                outsideDocument,
                settle: (allow: boolean) => {
                    if (settled) { return; }
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    const wasOnScreen = this._approvalQueue[0] === entry;
                    const index = this._approvalQueue.indexOf(entry);
                    if (index !== -1) { this._approvalQueue.splice(index, 1); }
                    resolve(allow);
                    // Only the head is displayed, so the next one moves up when it is answered.
                    if (wasOnScreen) { this._showNextApproval(); }
                }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this._approvalQueue.push(entry);
            if (this._approvalQueue.length === 1) { this._showNextApproval(); }
        });
    }

    /** Put the request at the head of the queue on screen, if there is one. */
    private _showNextApproval() {
        const head = this._approvalQueue[0];
        if (!head) { return; }
        const waiting = this._approvalQueue.length - 1;
        this._requestApproval(head.view, head.action, head.outsideDocument ?? null);
        head.view.webview.postMessage({
            type: 'agentWorking',
            step: 0,
            label: waiting > 0
                ? `harness is waiting for your approval… (${waiting} more queued)`
                : 'harness is waiting for your approval…'
        });
    }

    /** Answer the request currently on screen. Returns false when no harness step is waiting. */
    private _resolveCurrentApproval(allow: boolean): boolean {
        const head = this._approvalQueue[0];
        if (!head) { return false; }
        head.settle(allow);
        return true;
    }

    /** Decline every queued request — the run was cancelled or has finished. */
    private _drainApprovals() {
        while (this._approvalQueue.length > 0) { this._approvalQueue[0].settle(false); }
    }

    /** Application name and version recorded in exported documents, for provenance. */
    private _generatorId(): string {
        const version = (this._context.extension?.packageJSON?.version as string) || '0.0.0';
        return `enclave/${version}`;
    }

    /**
     * Write a harness to a file the user chooses.
     *
     * Two formats, because they serve different readers. The JSON document is executable and
     * re-importable here; the Markdown playbook is the same procedure written out for the
     * agents documented alongside Blablador, none of which read this schema — it drops into an
     * `AGENTS.md`, a `CLAUDE.md`, an OpenCode command or a Continue.Dev prompt file.
     */
    private async _exportHarness(def: HarnessDefinition, format: 'json' | 'markdown' | 'cwl'): Promise<void> {
        if (format === 'cwl') { return this._exportHarnessCwl(def); }
        const extension = format === 'json' ? 'json' : 'md';
        const generator = this._generatorId();
        const defaultDir = this._workspaceRoot();
        const target = await vscode.window.showSaveDialog({
            defaultUri: defaultDir
                ? vscode.Uri.joinPath(vscode.Uri.file(defaultDir), exportFileName(def, extension))
                : vscode.Uri.file(exportFileName(def, extension)),
            filters: format === 'json' ? { 'Harness document': ['json'] } : { 'Markdown': ['md'] },
            saveLabel: format === 'json' ? 'Export harness' : 'Export playbook'
        });
        if (!target) { return; }

        const contents = format === 'json'
            ? toPortableJson(def, { generator })
            : toMarkdown(def, { generator });

        try {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(contents));
            this._log.appendLine(`[${new Date().toISOString()}] exported harness ${def.id} as ${format} to ${target.fsPath}`);
            const open = await vscode.window.showInformationMessage(
                `Exported "${def.name}" to ${target.path.split('/').pop()}.`,
                'Open'
            );
            if (open === 'Open') {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not export harness: ${(error as Error).message}`);
        }
    }

    /**
     * Write the harness as a Common Workflow Language document plus a job file beside it.
     *
     * The job file takes its name from whatever the user called the workflow file, so the two
     * stay paired if the default name is changed in the dialog. Translation notes — constructs
     * CWL cannot express, such as approval prompts — are in the document header and are
     * summarised in the confirmation so nobody runs the export assuming it is the harness.
     */
    private async _exportHarnessCwl(def: HarnessDefinition): Promise<void> {
        const names = cwlFileNames(def);
        const defaultDir = this._workspaceRoot();
        const target = await vscode.window.showSaveDialog({
            defaultUri: defaultDir ? vscode.Uri.joinPath(vscode.Uri.file(defaultDir), names.workflow) : vscode.Uri.file(names.workflow),
            filters: { 'Common Workflow Language': ['cwl'] },
            saveLabel: 'Export CWL'
        });
        if (!target) { return; }

        const model = this._getScopedState<string>('continued_last_model') || 'llama3';
        const { workflow, job, notes } = toCwl(def, { generator: this._generatorId(), defaultModel: model });
        const base = target.path.split('/').pop()!.replace(/\.cwl$/i, '');
        const jobTarget = vscode.Uri.joinPath(target.with({ path: target.path.replace(/[^/]*$/, '') }), `${base}.cwl-job.yml`);

        try {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(workflow));
            await vscode.workspace.fs.writeFile(jobTarget, new TextEncoder().encode(job));
            this._log.appendLine(`[${new Date().toISOString()}] exported harness ${def.id} as CWL to ${target.fsPath} (+ job file); ${notes.length} translation note(s)`);
            const open = await vscode.window.showInformationMessage(
                `Exported "${def.name}" as ${base}.cwl and ${base}.cwl-job.yml. ${notes.length} translation note${notes.length === 1 ? '' : 's'} in the file header — read them before running.`,
                'Open'
            );
            if (open === 'Open') {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not export CWL: ${(error as Error).message}`);
        }
    }

    /**
     * Read a harness document chosen by the user into `.continued/harnesses/`.
     *
     * Importing runs no steps, but it does add a definition that can later execute tools and
     * shell commands, so the user is shown what the harness requires and confirms before it is
     * saved. An id that is already taken is reported rather than silently overwritten.
     */
    private async _importHarness(view: vscode.WebviewView): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Import harness',
            filters: { 'Harness document': ['json'] }
        });
        const file = picked?.[0];
        if (!file) { return; }

        let raw: string;
        try {
            raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        } catch (error) {
            vscode.window.showErrorMessage(`Could not read that file: ${(error as Error).message}`);
            return;
        }

        const result = fromPortable(raw, validateHarness);
        if (!result.harness) {
            view.webview.postMessage({ type: 'harnessError', message: `That file is not a usable harness:\n- ${result.problems.join('\n- ')}` });
            return;
        }

        const def = result.harness;
        const requires = collectRequirements(def);
        const registry = this._pluginRegistry;
        const missing = [
            ...requires.tools.filter(id => !registry?.getTool(id)),
            ...requires.resources.filter(id => !registry?.getResource(id)),
            ...requires.skills.filter(id => !registry?.getSkill(id) && !this._harnesses.has(id))
        ];

        const detailLines = [
            requires.tools.length ? `Tools: ${requires.tools.join(', ')}` : '',
            requires.resources.length ? `Context: ${requires.resources.join(', ')}` : '',
            requires.usesModel ? 'Calls a language model.' : 'Does not call a language model.',
            missing.length ? `Not available here: ${missing.join(', ')}` : '',
            result.warnings.join(' ')
        ].filter(Boolean);

        const replacing = this._harnesses.has(def.id);
        const confirm = await vscode.window.showWarningMessage(
            replacing
                ? `Replace the existing harness "${def.id}" with the one in this file?`
                : `Import the harness "${def.name}"?`,
            {
                modal: true,
                detail: `A harness can run tools and shell commands when you execute it. Review it before running.\n\n${detailLines.join('\n')}`
            },
            replacing ? 'Replace' : 'Import'
        );
        if (confirm !== 'Import' && confirm !== 'Replace') { return; }

        try {
            await saveUserHarness(def);
            await this._loadHarnesses();
            this._postHarnessCatalog(view);
            this._log.appendLine(`[${new Date().toISOString()}] imported harness ${def.id} from ${file.fsPath}`);
            const warn = missing.length ? ` It needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not registered here.` : '';
            vscode.window.showInformationMessage(`Imported "${def.name}".${warn}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not save the imported harness: ${(error as Error).message}`);
        }
    }

    /**
     * Only an OpenAI-compatible endpoint can be reached by the CWL runner inside the container.
     * Ollama, OpenAI and Blablador qualify; the others are refused with a clear message rather
     * than failing inside the container where the reason would be hard to see.
     */
    private async _containerEndpoint(modelId: string): Promise<ContainerEndpoint> {
        const provider = detectProvider(modelId);
        const model = stripProviderPrefix(modelId);
        switch (provider) {
            case 'ollama':
                return { baseUrl: `${getOllamaBaseUrl()}/v1`, model, apiKey: null };
            case 'openai':
                return { baseUrl: 'https://api.openai.com/v1', model, apiKey: (await this._context.secrets.get('openai_api_key')) ?? null };
            case 'blablador':
                return { baseUrl: 'https://api.blablador.fz-juelich.de/v1', model, apiKey: (await this._context.secrets.get('blablador_api_key')) ?? null };
            default:
                throw new Error(`Container runs need an OpenAI-compatible endpoint. "${modelId}" is a ${provider} model; choose an Ollama, OpenAI or Blablador model in the picker and run again.`);
        }
    }

    /**
     * Podman is missing: say so in the Run tab, install it in a terminal the user can watch,
     * and resume the run the moment it is found. The terminal asks for the root password
     * itself; the extension only runs the package manager's install command.
     */
    private async _handleMissingPodman(def: HarnessDefinition, input: string, model: string, mode: string, view: vscode.WebviewView, podman: string): Promise<void> {
        const now = Date.now();
        view.webview.postMessage({
            type: 'harnessRunDone',
            run: {
                harnessId: def.id, harnessName: def.name, input, status: 'cancelled', steps: [], output: '',
                error: `Waiting for Podman: it is not installed, so Enclave is installing it in the terminal "Enclave: install Podman". The run resumes automatically once Podman is available.`,
                startedAt: now, endedAt: now
            } as HarnessRun
        });
        view.webview.postMessage({ type: 'agentDone' });

        const outcome = await installPodmanInTerminal(podman);
        if (outcome === 'installed') {
            const version = await checkPodman(podman).catch(() => 'unknown version');
            void vscode.window.showInformationMessage(`Podman is installed (${version}). Resuming "${def.name}" in a container.`);
            this._log.appendLine(`[${new Date().toISOString()}] podman installed (${version}); resuming container run of ${def.id}`);
            await this._runHarnessInContainer(def, input, model, mode, view);
            return;
        }
        if (outcome === 'not-found-after-install') {
            vscode.window.showWarningMessage(
                `Podman is still not found after the install command. Check the "Enclave: install Podman" terminal for errors. If it did install, restart VS Code so PATH is refreshed, or set continued.container.podmanPath to its location, then run the harness again.`
            );
        }
    }

    /**
     * Run a harness inside a Podman container via its CWL export: plan, confirm, build, run.
     * Shares the harness abort controller so the Stop button works for both kinds of run.
     */
    private async _runHarnessInContainer(def: HarnessDefinition, input: string, model: string, mode: string, view: vscode.WebviewView): Promise<void> {
        if (this._harnessAbort && !this._harnessAbort.signal.aborted) {
            throw new Error('Another harness is still running. Stop it first.');
        }
        const root = this._workspaceRoot();
        if (!root) { throw new Error('Open a workspace folder before running a harness in a container.'); }

        const cfg = vscode.workspace.getConfiguration('continued');
        const podman = cfg.get<string>('container.podmanPath', 'podman') || 'podman';
        const outputBase = cfg.get<string>('container.outputDir', '.continued/harness-runs') || '.continued/harness-runs';
        const extraPackages = cfg.get<string[]>('container.extraPackages', []) ?? [];

        let version: string;
        try {
            version = await checkPodman(podman);
        } catch (error) {
            if (!(error instanceof PodmanNotFoundError)) { throw error; }
            await this._handleMissingPodman(def, input, model, mode, view, podman);
            return;
        }
        const endpoint = await this._containerEndpoint(model);

        // Editor state travels with the run as plain values; the container itself never sees the editor.
        const active = vscode.window.activeTextEditor;
        const activeFile = active && active.document.uri.scheme === 'file' && !active.document.isUntitled ? active.document.uri.fsPath : '';
        if (activeFile && !this._guardrails.isForbiddenPath(activeFile).safe) {
            throw new Error(`The active editor file (${activeFile}) is on the forbidden-paths list and cannot be handed to a harness.`);
        }
        const editor = { activeFile, selection: this._harnessVariables().selection };

        const abort = new AbortController();
        const request = {
            def, input, workspaceRoot: root, editor, endpoint, podman, outputBase, extraPackages,
            generator: this._generatorId(),
            log: (line: string) => this._log.appendLine(`[${new Date().toISOString()}] podman ${def.id}: ${line}`),
            onUpdate: (run: HarnessRun) => { this._lastHarnessRun = run; view.webview.postMessage({ type: 'harnessRunUpdate', run }); },
            signal: abort.signal
        };
        const prepared = prepareContainerRun(request);
        const network = await confirmContainerRun(def, prepared, root);
        if (!network) {
            // The Run tab is already showing "Starting…"; tell it the run was cancelled before it began.
            const now = Date.now();
            view.webview.postMessage({
                type: 'harnessRunDone',
                run: { harnessId: def.id, harnessName: def.name, input, status: 'cancelled', steps: [], output: '', error: 'Cancelled: the container confirmation was dismissed. Nothing was built or run.', startedAt: now, endedAt: now } as HarnessRun
            });
            view.webview.postMessage({ type: 'agentDone' });
            return;
        }

        this._harnessAbort = abort;
        this._log.appendLine(`[${new Date().toISOString()}] ▶ container harness ${def.id} (${version}, network ${network}, image ${prepared.tag})`);
        view.webview.postMessage({ type: 'agentWorking', step: 0, label: `harness "${def.name}" running in a container…` });
        let run: HarnessRun;
        try {
            run = await runInContainer(request, prepared, network);
        } finally {
            if (this._harnessAbort === abort) { this._harnessAbort = null; }
        }
        this._lastHarnessRun = run;
        this._log.appendLine(`[${new Date().toISOString()}] ■ container harness ${def.id} ${run.status}${run.error ? `: ${run.error.slice(0, 200)}` : ''}`);
        view.webview.postMessage({ type: 'harnessRunDone', run });

        if (!this._currentSessionId) { this._currentSessionId = 'session_' + Date.now(); }
        const summary = summarizeRun(run);
        this._chatHistory.push({ role: 'user', content: `Run harness "${def.name}" in a container${input ? ` with input: ${input}` : ''}` });
        this._chatHistory.push({ role: 'assistant', content: summary });
        view.webview.postMessage({ type: 'harnessChatRecord', user: `▶ Harness (container): ${def.name}${input ? ` — ${input}` : ''}`, assistant: summary });
        this._persistSession(mode);
        view.webview.postMessage({ type: 'agentDone' });
    }

    private async _runHarness(
        def: HarnessDefinition,
        input: string,
        model: string,
        mode: string,
        view: vscode.WebviewView,
        options: { fromChat: boolean }
    ): Promise<HarnessRun> {
        if (this._harnessAbort && !this._harnessAbort.signal.aborted) {
            throw new Error('Another harness is still running. Stop it first.');
        }
        const abort = new AbortController();
        this._harnessAbort = abort;
        this._log.appendLine(`[${new Date().toISOString()}] ▶ harness ${def.id} (${mode}, ${model}) input: ${input.slice(0, 200).replace(/\s+/g, ' ')}`);
        view.webview.postMessage({ type: 'agentWorking', step: 0, label: `harness "${def.name}" running…` });

        const host: HarnessHost = {
            gateTool: (pluginId, args, signal) => this._gateHarnessTool(pluginId, args, mode, view, signal),
            runTool: (pluginId, args) => this._executeHarnessTool(pluginId, args),
            runResource: async (pluginId) => {
                const resource = this._pluginRegistry?.getResource(pluginId);
                if (!resource) { throw new Error(`Resource '${pluginId}' is not registered.`); }
                if (!resource.enabled) { throw new Error(`Resource '${pluginId}' is disabled in Plugin Manager.`); }
                return this._formatPluginExecutionResult(await resource.fetch());
            },
            runSkill: async (pluginId, skillInput) => {
                const skill = this._pluginRegistry?.getSkill(pluginId);
                if (!skill) { throw new Error(`Skill '${pluginId}' is not registered.`); }
                if (!skill.enabled) { throw new Error(`Skill '${pluginId}' is disabled in Plugin Manager.`); }
                if (skill.harness && pluginId === def.id) { throw new Error('A harness cannot call itself.'); }
                if (skill.harness) {
                    const nested = this._harnesses.get(pluginId);
                    if (!nested) { throw new Error(`Harness '${pluginId}' not found.`); }
                    // Nested harness: run inline with the same host but its own run record.
                    const child = await runHarness(nested, { ...host, onUpdate: () => { /* nested updates are folded into the parent step */ } }, { input: skillInput, signal: abort.signal, defaultModel: model });
                    if (child.status !== 'done') { throw new Error(`Nested harness "${nested.name}" ${child.status}: ${child.error ?? ''}`); }
                    return child.output;
                }
                return this._formatPluginExecutionResult(await skill.execute(this._buildSkillContext(), skillInput));
            },
            callModel: async (request) => {
                const result = await this._llm.completeDetailed(request.model || model, request.system, [{ role: 'user', content: request.prompt }], {
                    jsonMode: request.jsonMode,
                    signal: request.signal,
                    timeoutMs: request.timeoutMs
                });
                return result.text || result.reasoning;
            },
            variables: () => this._harnessVariables(),
            onUpdate: (run) => {
                this._lastHarnessRun = run;
                view.webview.postMessage({ type: 'harnessRunUpdate', run });
            },
            log: (line) => this._log.appendLine(`[${new Date().toISOString()}] harness ${def.id}: ${line}`)
        };

        let run: HarnessRun;
        try {
            run = await runHarness(def, host, { input, signal: abort.signal, defaultModel: model, modelTimeoutMs: Math.max(600000, this._cfg<number>('agent.modelTimeoutMs', 600000)) });
        } catch (error) {
            run = {
                harnessId: def.id, harnessName: def.name, input, status: 'failed', steps: [], output: '',
                error: (error as Error).message, startedAt: Date.now(), endedAt: Date.now()
            };
        } finally {
            if (this._harnessAbort === abort) { this._harnessAbort = null; }
            this._drainApprovals();
        }
        this._lastHarnessRun = run;
        this._log.appendLine(`[${new Date().toISOString()}] ■ harness ${def.id} ${run.status}${run.error ? `: ${run.error.slice(0, 200)}` : ''}`);
        view.webview.postMessage({ type: 'harnessRunDone', run });

        if (options.fromChat) {
            // Keep a record in the conversation so the model and the user can refer to it later.
            if (!this._currentSessionId) { this._currentSessionId = 'session_' + Date.now(); }
            const summary = summarizeRun(run);
            this._chatHistory.push({ role: 'user', content: `Run harness "${def.name}"${input ? ` with input: ${input}` : ''}` });
            this._chatHistory.push({ role: 'assistant', content: summary });
            view.webview.postMessage({ type: 'harnessChatRecord', user: `▶ Harness: ${def.name}${input ? ` — ${input}` : ''}`, assistant: summary });
            this._persistSession(mode);
            // Runs started by the agent loop (use-skill) leave the working state to the loop.
            view.webview.postMessage({ type: 'agentDone' });
        }
        return run;
    }

    /**
     * Ask once before running a plugin file's code.
     *
     * Loading a user plugin `require()`s it into the extension host, where it has the same
     * access as the extension itself — the filesystem, the network, child processes. Opening a
     * workspace must never be enough to make that happen, so each file is approved by its
     * content hash: an edited plugin is a new file as far as this check is concerned and is
     * asked about again.
     */
    private async _confirmPluginLoad(name: string, uri: vscode.Uri, contents: Uint8Array): Promise<boolean> {
        const digest = crypto.createHash('sha256').update(contents).digest('hex');
        const key = `plugin_trusted::${this._workspaceScopeId()}::${name}::${digest}`;
        const remembered = this._context.globalState.get<boolean>(key);
        if (remembered !== undefined) { return remembered; }

        const choice = await vscode.window.showWarningMessage(
            `Enclave found the plugin "${name}" in this workspace's .continued/plugins/ folder.`,
            {
                modal: true,
                detail: 'Loading it runs its JavaScript with the same access this extension has: your files, '
                    + 'your network and your shell. Only load plugins from a source you trust.\n\n'
                    + 'Your answer is remembered until the file changes.'
            },
            'Load plugin',
            'Show me the file'
        );

        if (choice === 'Show me the file') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
            return false;   // Not remembered: decide next time, having seen the code.
        }

        const allow = choice === 'Load plugin';
        await this._context.globalState.update(key, allow);
        return allow;
    }

    private async _loadUserPlugins() {
        if (!this._pluginRegistry) { return; }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }

        // Restricted Mode means "I have not vouched for the code in this folder", and a plugin
        // here is exactly that: code from the folder.
        if (!vscode.workspace.isTrusted) {
            this._log.appendLine(`[${new Date().toISOString()}] workspace is not trusted — user plugins were not loaded`);
            return;
        }

        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');

        try {
            const files = await vscode.workspace.fs.readDirectory(pluginDir);
            for (const [name, fileType] of files) {
                if (fileType !== vscode.FileType.File) {continue;}
                if (name.endsWith('.ts')) {
                    console.warn(`Enclave: skipping ${name} — user plugins must be plain JavaScript (.js) files.`);
                    continue;
                }
                if (!name.endsWith('.js') && !name.endsWith('.cjs')) {continue;}
                try {
                    const uri = vscode.Uri.joinPath(pluginDir, name);
                    const contents = await vscode.workspace.fs.readFile(uri);
                    if (!await this._confirmPluginLoad(name, uri, contents)) {
                        this._log.appendLine(`[${new Date().toISOString()}] plugin ${name} was not loaded (not approved)`);
                        continue;
                    }

                    const moduleUrl = require.resolve(uri.fsPath);
                    delete require.cache[moduleUrl];
                    const module = require(moduleUrl);

                    if (module.tool) { this._pluginRegistry.registerTool({ ...module.tool, source: 'user' }); }
                    if (module.resource) { this._pluginRegistry.registerResource({ ...module.resource, source: 'user' }); }
                    if (module.skill) { this._pluginRegistry.registerSkill({ ...module.skill, source: 'user' }); }
                } catch (e) {
                    console.warn(`Failed to load user plugin ${name}:`, (e as Error).message);
                    vscode.window.showWarningMessage(`Enclave: could not load plugin ${name}: ${(e as Error).message}`);
                }
            }
        } catch {
            // No user plugins directory — nothing to load.
        }
    }

    private _postPlugins(view: vscode.WebviewView) {
        view.webview.postMessage({
            type: 'setPlugins',
            plugins: this._pluginRegistry?.getAllPlugins() ?? { tools: [], resources: [], skills: [] },
            enabledCount: this._pluginRegistry?.getEnabledCount() ?? 0
        });
    }

    private _pluginTypeTemplate(pluginType: 'tool' | 'resource' | 'skill', pluginId: string, displayName: string, description: string): string {
        const safeDescription = (description || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
        if (pluginType === 'resource') {
            return `/**
 * Enclave user plugin
 * Type: resource
 * File: ${pluginId}.js
 *
 * A resource provides context data. The agent can fetch it with:
 *   {"action":"use-resource","resource":"${pluginId}"}
 * and you can fetch it in chat with:  /resource ${pluginId}
 */

module.exports.resource = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: '${safeDescription || 'Describe the context this resource provides'}',
    enabled: false,
    source: 'user',
    async fetch() {
        return {
            success: true,
            message: 'Replace this with resource data.',
        };
    },
};
`;
        }

        if (pluginType === 'skill') {
            return `/**
 * Enclave user plugin
 * Type: skill
 * File: ${pluginId}.js
 *
 * A skill orchestrates a multi-step workflow. It receives a context with helpers:
 *   readFile(path), getActiveEditorContent(), getActiveEditorPath(),
 *   searchFiles(glob), getWorkspaceFolder(), getGitDiff()
 * The agent can run it with:  {"action":"use-skill","skill":"${pluginId}"}
 * and you can run it in chat with:  /skill ${pluginId}
 */

module.exports.skill = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: '${safeDescription || 'Describe the workflow this skill orchestrates'}',
    enabled: false,
    source: 'user',
    steps: [],
    async execute(context) {
        const files = await context.searchFiles('**/*.md');
        return {
            success: true,
            message: 'Replace this with skill orchestration logic.',
            markdownFiles: files.length,
        };
    },
};
`;
        }

        return `/**
 * Enclave user plugin
 * Type: tool
 * File: ${pluginId}.js
 *
 * A tool performs one operation with arguments. The agent can call it with:
 *   {"action":"use-tool","tool":"${pluginId}","args":{"example":"value"}}
 * and you can call it in chat with:  /tool ${pluginId} {"example":"value"}
 *
 * Node built-ins are available (fs, path, child_process, ...). Return a string or
 * a JSON-serialisable object; throw an Error to report failure.
 */

module.exports.tool = {
    id: '${pluginId}',
    name: '${displayName}',
    version: '1.0.0',
    author: 'Your Name',
    description: '${safeDescription || 'Describe what this tool does and which args it accepts'}',
    enabled: false,
    source: 'user',
    async execute(args) {
        return {
            success: true,
            args,
            message: 'Replace this with your tool logic.',
        };
    },
};
`;
    }

    private async _createUserPlugin(pluginType: 'tool' | 'resource' | 'skill', pluginName: string, description: string, initialCode: string): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Open a workspace folder before creating a plugin.');
        }

        const safeName = pluginName
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'my-plugin';

        const pluginId = safeName.endsWith(`-${pluginType}`) ? safeName : `${safeName}-${pluginType}`;
        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        await vscode.workspace.fs.createDirectory(pluginDir);

        const pluginFile = vscode.Uri.joinPath(pluginDir, `${pluginId}.js`);
        try {
            await vscode.workspace.fs.stat(pluginFile);
            throw new Error(`A plugin file named '${pluginId}.js' already exists.`);
        } catch (e: unknown) {
            if ((e as { code?: string }).code !== 'FileNotFound') {throw e;}
        }

        const code = initialCode.trim()
            ? initialCode
            : this._pluginTypeTemplate(pluginType, pluginId, pluginName.trim() || 'My Plugin', description);

        await vscode.workspace.fs.writeFile(pluginFile, new TextEncoder().encode(code));

        const doc = await vscode.workspace.openTextDocument(pluginFile);
        await vscode.window.showTextDocument(doc, { preview: false });

        await this._loadUserPlugins();
        if (this._view) { this._postPlugins(this._view); }

        return pluginFile.fsPath;
    }

    private async _findUserPluginFileById(pluginId: string): Promise<vscode.Uri> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Open a workspace folder before managing plugins.');
        }

        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        const entries = await vscode.workspace.fs.readDirectory(pluginDir);
        const pluginFiles = entries.filter(([name, fileType]) => {
            return fileType === vscode.FileType.File && (name.endsWith('.js') || name.endsWith('.cjs') || name.endsWith('.ts'));
        });

        let targetName = pluginFiles.find(([name]) => {
            const base = name.replace(/\.(js|cjs|ts)$/i, '');
            return base === pluginId;
        })?.[0];

        if (!targetName) {
            for (const [name] of pluginFiles) {
                try {
                    const fileUri = vscode.Uri.joinPath(pluginDir, name);
                    const raw = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder().decode(raw);
                    const idRegex = /\bid\s*:\s*['"]([^'"]+)['"]/;
                    const match = content.match(idRegex);
                    if (match && match[1] === pluginId) {
                        targetName = name;
                        break;
                    }
                } catch {
                    // Skip unreadable plugin files.
                }
            }
        }

        if (!targetName) {
            throw new Error(`Could not find plugin file for '${pluginId}' in .continued/plugins/.`);
        }

        return vscode.Uri.joinPath(pluginDir, targetName);
    }

    private async _openUserPluginForEdit(pluginId: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private _sanitizePluginId(rawValue: string): string {
        const value = String(rawValue || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return value || 'my-plugin';
    }

    private _replacePluginMeta(content: string, nextId: string, nextName: string): string {
        let updated = content;
        updated = updated.replace(/(\bid\s*:\s*['"])[^'"]+(['"])/, `$1${nextId}$2`);
        updated = updated.replace(/(\bname\s*:\s*['"])[^'"]+(['"])/, `$1${nextName}$2`);
        return updated;
    }

    private async _openPluginsFolder() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('Open a workspace folder before managing plugins.');
        }

        const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.continued', 'plugins');
        await vscode.workspace.fs.createDirectory(pluginDir);

        try {
            await vscode.commands.executeCommand('revealInExplorer', pluginDir);
        } catch {
            await vscode.commands.executeCommand('revealFileInOS', pluginDir);
        }
    }

    private async _duplicateUserPlugin(pluginId: string, duplicateName?: string, duplicateId?: string) {
        const sourceUri = await this._findUserPluginFileById(pluginId);
        const raw = await vscode.workspace.fs.readFile(sourceUri);
        const sourceContent = new TextDecoder().decode(raw);

        const ext = path.extname(sourceUri.fsPath) || '.js';
        const baseType = pluginId.endsWith('-resource') ? 'resource' : pluginId.endsWith('-skill') ? 'skill' : 'tool';
        const targetName = (duplicateName || `${pluginId} copy`).trim();
        let targetId = this._sanitizePluginId(duplicateId || `${pluginId}-copy`);
        if (!targetId.endsWith(`-${baseType}`)) {
            targetId = `${targetId}-${baseType}`;
        }

        const pluginDir = sourceUri.with({ path: sourceUri.path.replace(/\/[^/]+$/, '') });
        let targetUri = vscode.Uri.joinPath(pluginDir, `${targetId}${ext}`);
        let suffix = 1;
        while (true) {
            try {
                await vscode.workspace.fs.stat(targetUri);
                targetUri = vscode.Uri.joinPath(pluginDir, `${targetId}-${suffix}${ext}`);
                suffix += 1;
            } catch {
                break;
            }
        }

        const finalId = path.basename(targetUri.fsPath, ext);
        const duplicatedContent = this._replacePluginMeta(sourceContent, finalId, targetName);
        await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(duplicatedContent));

        await this._loadUserPlugins();
        if (this._view) { this._postPlugins(this._view); }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _renameUserPlugin(pluginId: string, nextPluginId: string, nextPluginName: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        const oldTool = this._pluginRegistry?.getTool(pluginId);
        const oldResource = this._pluginRegistry?.getResource(pluginId);
        const oldSkill = this._pluginRegistry?.getSkill(pluginId);
        const wasEnabled = Boolean(oldTool?.enabled || oldResource?.enabled || oldSkill?.enabled);

        const raw = await vscode.workspace.fs.readFile(targetUri);
        const sourceContent = new TextDecoder().decode(raw);

        const ext = path.extname(targetUri.fsPath) || '.js';
        const normalizedId = this._sanitizePluginId(nextPluginId || pluginId);
        const normalizedName = (nextPluginName || '').trim() || nextPluginId || pluginId;
        const updatedContent = this._replacePluginMeta(sourceContent, normalizedId, normalizedName);

        let destinationUri = targetUri;
        const currentBase = path.basename(targetUri.fsPath, ext);
        if (currentBase !== normalizedId) {
            destinationUri = vscode.Uri.joinPath(targetUri.with({ path: targetUri.path.replace(/\/[^/]+$/, '') }), `${normalizedId}${ext}`);
            try {
                await vscode.workspace.fs.stat(destinationUri);
                throw new Error(`A plugin file named '${normalizedId}${ext}' already exists.`);
            } catch (e: unknown) {
                if (e && (e as { code?: string }).code !== 'FileNotFound') {
                    throw e;
                }
            }
        }

        await vscode.workspace.fs.writeFile(destinationUri, new TextEncoder().encode(updatedContent));
        if (destinationUri.toString() !== targetUri.toString()) {
            try {
                await vscode.workspace.fs.delete(targetUri, { useTrash: true });
            } catch {
                await vscode.workspace.fs.delete(targetUri, { useTrash: false });
            }
        }

        if (this._pluginRegistry) {
            await this._pluginRegistry.removePlugin(pluginId);
        }

        await this._loadUserPlugins();

        if (wasEnabled && this._pluginRegistry) {
            await this._pluginRegistry.togglePlugin(normalizedId, true);
        }

        if (this._view) { this._postPlugins(this._view); }

        const doc = await vscode.workspace.openTextDocument(destinationUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _deleteUserPlugin(pluginId: string) {
        const targetUri = await this._findUserPluginFileById(pluginId);
        try {
            await vscode.workspace.fs.delete(targetUri, { useTrash: true });
        } catch {
            // Fallback for environments where trash is unavailable.
            await vscode.workspace.fs.delete(targetUri, { useTrash: false });
        }

        if (this._pluginRegistry) {
            await this._pluginRegistry.removePlugin(pluginId);
        }

        await this._loadUserPlugins();
        if (this._view) { this._postPlugins(this._view); }

        vscode.window.showInformationMessage(`Plugin '${pluginId}' deleted successfully.`);
    }

    private _formatPluginExecutionResult(result: unknown): string {
        if (result === undefined || result === null) {
            return 'Done.';
        }

        if (typeof result === 'string') {
            return result;
        }

        try {
            return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
        } catch {
            return String(result);
        }
    }

    private _buildSkillContext(): SkillContext {
        const root = this._workspaceRoot() ?? '';
        return {
            readFile: async (filePath: string) => fs.promises.readFile(path.resolve(root, filePath), 'utf-8'),
            getActiveEditorContent: async () => vscode.window.activeTextEditor?.document.getText() ?? '',
            getActiveEditorPath: async () => vscode.window.activeTextEditor?.document.uri.fsPath ?? '',
            searchFiles: async (pattern: string) => {
                const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 500);
                return files.map(f => f.fsPath);
            },
            getWorkspaceFolder: () => root,
            getGitDiff: async () => {
                try {
                    const { stdout } = await execAsync('git diff', { cwd: root, maxBuffer: 4 * 1024 * 1024 });
                    return stdout;
                } catch {
                    return '';
                }
            }
        };
    }

    /** Post a locally generated assistant reply (no model call) and persist it. */
    private _replyLocally(view: vscode.WebviewView, mode: string, message: string) {
        view.webview.postMessage({ type: 'assistantResponse', content: message });
        view.webview.postMessage({ type: 'agentDone' });
        this._chatHistory.push({ role: 'assistant', content: message });
        this._persistSession(mode);
    }

    /** Handle `/plugins`, `/tool`, `/resource`, `/skill` chat commands. Returns true if handled. */
    private async _tryHandlePluginChatCommand(userPrompt: string, mode: string, view: vscode.WebviewView): Promise<boolean> {
        const trimmed = String(userPrompt || '').trim();
        if (!trimmed.startsWith('/')) {
            return false;
        }

        if (!this._pluginRegistry) {
            this._replyLocally(view, mode, 'Plugin system is not ready yet. Please try again.');
            return true;
        }

        if (/^\/plugins$/i.test(trimmed)) {
            const enabledTools = this._pluginRegistry.getEnabledTools().map(t => `- tool: \`${t.id}\` — ${t.description || t.name}`);
            const enabledResources = this._pluginRegistry.getEnabledResources().map(r => `- resource: \`${r.id}\` — ${r.description || r.name}`);
            const enabledSkills = this._pluginRegistry.getEnabledSkills().map(s => `- skill: \`${s.id}\` — ${s.description || s.name}`);
            const lines = [
                '**Enabled plugins**',
                ...(enabledTools.length ? enabledTools : ['- tool: (none)']),
                ...(enabledResources.length ? enabledResources : ['- resource: (none)']),
                ...(enabledSkills.length ? enabledSkills : ['- skill: (none)']),
                '',
                '**Usage**',
                '- `/tool <plugin-id> {"arg":"value"}`',
                '- `/resource <plugin-id>`',
                '- `/skill <plugin-id>`'
            ];
            this._replyLocally(view, mode, lines.join('\n'));
            return true;
        }

        const match = trimmed.match(/^\/(tool|resource|skill|harness)\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]+))?$/i);
        if (!match) {
            return false;
        }

        const kind = match[1].toLowerCase() === 'harness' ? 'skill' : match[1].toLowerCase();
        const pluginId = match[2];
        const rawArgs = (match[3] || '').trim();

        let parsedArgs: Record<string, unknown> = {};
        if (rawArgs) {
            try {
                parsedArgs = JSON.parse(rawArgs);
            } catch {
                parsedArgs = { input: rawArgs };
            }
        }

        try {
            if (kind === 'tool') {
                const tool = this._pluginRegistry.getTool(pluginId);
                if (!tool) {
                    throw new Error(`Tool not found: ${pluginId}`);
                }
                if (!tool.enabled) {
                    throw new Error(`Tool '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
                }
                const result = await tool.execute(parsedArgs);
                this._replyLocally(view, mode, `Tool \`${pluginId}\` executed.\n\n${this._formatPluginExecutionResult(result)}`);
                return true;
            }

            if (kind === 'resource') {
                const resource = this._pluginRegistry.getResource(pluginId);
                if (!resource) {
                    throw new Error(`Resource not found: ${pluginId}`);
                }
                if (!resource.enabled) {
                    throw new Error(`Resource '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
                }
                const result = await resource.fetch();
                this._replyLocally(view, mode, `Resource \`${pluginId}\` fetched.\n\n${this._formatPluginExecutionResult(result)}`);
                return true;
            }

            const skill = this._pluginRegistry.getSkill(pluginId);
            if (!skill) {
                throw new Error(`Skill not found: ${pluginId}`);
            }
            if (!skill.enabled) {
                throw new Error(`Skill '${pluginId}' is disabled. Enable it in Plugin Manager first.`);
            }

            if (skill.harness) {
                const def = this._harnesses.get(pluginId);
                if (!def) { throw new Error(`Harness not found: ${pluginId}`); }
                const model = this._getScopedState<string>('continued_last_model') || 'llama3';
                await this._runHarness(def, rawArgs, model, mode, view, { fromChat: true });
                return true;
            }
            const result = await skill.execute(this._buildSkillContext(), rawArgs || undefined);
            this._replyLocally(view, mode, `Skill \`${pluginId}\` executed.\n\n${this._formatPluginExecutionResult(result)}`);
            return true;
        } catch (error) {
            this._replyLocally(view, mode, `Plugin command failed: ${(error as Error).message}`);
            return true;
        }
    }

    // =====================================================================
    // Agent system — prompt · loop · dispatch · execution
    // =====================================================================

    private _isToolEnabled(id: string): boolean {
        return this._pluginRegistry?.getTool(id)?.enabled ?? false;
    }

    /** Read-only actions never need approval: built-in observers plus plugin tools flagged `readOnly`. */
    private _isReadOnly(action: AgentAction): boolean {
        if (isReadOnlyAction(action)) { return true; }
        if (action.type === 'use-tool') {
            const tool = this._pluginRegistry?.getTool(action.tool);
            // A tool that sends data out is never read-only, even if it also declares readOnly.
            return !!tool?.readOnly && !tool?.egress;
        }
        return false;
    }

    /** True when the action can carry workspace content off the machine. */
    private _sendsDataOut(action: AgentAction): boolean {
        return action.type === 'use-tool' && !!this._pluginRegistry?.getTool(action.tool)?.egress;
    }

    /** Snapshot files a plugin tool declares it will touch, so the change can be reverted. */
    private _snapshotTouched(paths: string[]): Array<{ relativePath: string; existed: boolean; content: string }> {
        const root = this._workspaceRoot();
        if (!root) { return []; }
        const out: Array<{ relativePath: string; existed: boolean; content: string }> = [];
        for (const raw of paths) {
            const relativePath = this._normalizeRelativePath(raw);
            if (!relativePath) { continue; }
            const abs = path.resolve(root, relativePath);
            try {
                const stat = fs.statSync(abs);
                if (stat.isFile()) { out.push({ relativePath, existed: true, content: fs.readFileSync(abs, 'utf-8') }); continue; }
            } catch { /* does not exist */ }
            out.push({ relativePath, existed: false, content: '' });
        }
        return out;
    }

    private _recordTouchedChanges(before: Array<{ relativePath: string; existed: boolean; content: string }>) {
        const root = this._workspaceRoot();
        if (!root) { return; }
        for (const snap of before) {
            const abs = path.resolve(root, snap.relativePath);
            let existsNow = false;
            let contentNow = '';
            try {
                const stat = fs.statSync(abs);
                if (stat.isFile()) { existsNow = true; contentNow = fs.readFileSync(abs, 'utf-8'); }
            } catch { /* gone */ }
            if (existsNow === snap.existed && contentNow === snap.content) { continue; }
            this._recordChange({ relativePath: snap.relativePath, originalContent: snap.content, existed: snap.existed, isDeletion: !existsNow });
        }
    }

    private _normalizeRelativePath(p: string): string {
        return path.posix.normalize(p.replace(/\\/g, '/').trim()).replace(/^\.\//, '').replace(/^\//, '');
    }

    private _fileExistsInWorkspace(relativePath: string): boolean {
        const root = this._workspaceRoot();
        if (!root) { return false; }
        try {
            return fs.statSync(path.resolve(root, relativePath)).isFile();
        } catch {
            return false;
        }
    }

    /** Actions taken since the current task started, paired with whether their tool result succeeded. */
    private _runActionsWithOutcome(): Array<{ action: AgentAction; ok: boolean; output: string }> {
        let lastUserIdx = -1;
        for (let i = this._chatHistory.length - 1; i >= 0; i--) {
            // A note sent during the run is part of the run, not the start of a new one.
            if (this._chatHistory[i].role === 'user' && !isSteeringNote(this._chatHistory[i].content)) { lastUserIdx = i; break; }
        }
        const entries = this._chatHistory.slice(lastUserIdx + 1);
        const out: Array<{ action: AgentAction; ok: boolean; output: string }> = [];
        for (let i = 0; i < entries.length; i++) {
            const action = decodeAction(entries[i].content);
            if (!action) { continue; }
            const result = i + 1 < entries.length ? decodeToolResult(entries[i + 1].content) : null;
            const output = result?.output ?? '';
            const ok = !!result && !/^(BLOCKED|FAILED|DECLINED)\b/.test(output);
            out.push({ action, ok, output });
        }
        return out;
    }

    /** Summarise what the agent has done since the current task started, so the model can track multi-file work. */
    private _buildRunProgress(): string {
        const read: string[] = [];
        const written: string[] = [];
        const deleted: string[] = [];
        const other: string[] = [];
        const failed: string[] = [];
        for (const { action, ok, output } of this._runActionsWithOutcome()) {
            if (action.type === 'final-answer') { continue; }
            if (!ok) {
                failed.push(`${actionCommandLabel(action).slice(0, 80)} → ${output.slice(0, 120).replace(/\s+/g, ' ')}`);
                continue;
            }
            switch (action.type) {
                case 'read-file': if (!read.includes(action.path)) { read.push(action.path); } break;
                case 'write-file': if (!written.includes(action.path)) { written.push(action.path); } break;
                case 'delete-file': if (!deleted.includes(action.path)) { deleted.push(action.path); } break;
                default: other.push(actionCommandLabel(action).slice(0, 80));
            }
        }
        if (!read.length && !written.length && !deleted.length && !other.length && !failed.length) {
            return '(nothing yet — this is the first step)';
        }
        const lines: string[] = [];
        lines.push(`Read successfully: ${read.length ? read.join(', ') : '(none)'}`);
        lines.push(`Written successfully: ${written.length ? written.join(', ') : '(none)'}`);
        if (deleted.length) { lines.push(`Deleted successfully: ${deleted.join(', ')}`); }
        if (other.length) { lines.push(`Other: ${other.join(' | ')}`); }
        if (failed.length) { lines.push(`NOT done (blocked/failed — still to do): ${failed.join(' | ')}`); }
        return lines.join('\n');
    }

    /** Build the agent system prompt from the enabled tools, the task and the workspace. */
    private _buildAgentSystemPrompt(): string {
        const registry = this._pluginRegistry;
        const actionLines: string[] = [];
        if (this._isToolEnabled('read-file'))        { actionLines.push('{"action":"read-file","path":"relative/path/to/file"}'); }
        if (this._isToolEnabled('write-file'))       { actionLines.push('{"action":"write-file","path":"relative/path/to/file","content":"COMPLETE new file content"}'); }
        if (this._isToolEnabled('delete-file'))      { actionLines.push('{"action":"delete-file","path":"relative/path/to/file"}'); }
        if (this._isToolEnabled('semantic-search'))  { actionLines.push('{"action":"semantic-search","query":"glob such as src/**/*.ts"}   ← find files by name/glob'); }
        if (this._isToolEnabled('grep-search'))      { actionLines.push('{"action":"grep-search","query":"regex or text","filePattern":"**/*.ts"}   ← find text inside files'); }
        if (this._isToolEnabled('run-command'))      { actionLines.push('{"action":"run-command","command":"npm test"}   ← shell command in the workspace root'); }
        actionLines.push('{"action":"final-answer","message":"Markdown summary for the user"}');

        const extraTools = registry?.getEnabledTools().filter(t => !DEDICATED_TOOL_IDS.includes(t.id)) ?? [];
        const resources = registry?.getEnabledResources() ?? [];
        const skills = registry?.getEnabledSkills() ?? [];

        let pluginSection = '';
        if (extraTools.length || resources.length || skills.length) {
            pluginSection += '\n## PLUGIN ACTIONS\n';
            if (extraTools.length) {
                pluginSection += 'Tools — call with {"action":"use-tool","tool":"<id>","args":{...}}\n';
                pluginSection += extraTools.map(t => {
                    const argsHint = t.args?.length && !/args:/i.test(t.description ?? '') ? ` (args: ${t.args.map(a => a.name + (a.required ? '*' : '')).join(', ')})` : '';
                    return `  • ${t.id}${t.readOnly ? ' [read-only]' : ''}: ${t.description || t.name}${argsHint}`;
                }).join('\n') + '\n';
            }
            if (resources.length) {
                pluginSection += 'Resources — fetch with {"action":"use-resource","resource":"<id>"}\n';
                pluginSection += resources.map(r => `  • ${r.id}: ${r.description || r.name}`).join('\n') + '\n';
            }
            if (skills.length) {
                pluginSection += 'Skills — run with {"action":"use-skill","skill":"<id>"}\n';
                pluginSection += skills.map(s => `  • ${s.id}: ${s.description || s.name}`).join('\n') + '\n';
            }
        }

        const root = this._workspaceRoot() ?? '(no workspace folder open)';
        const activeFile = this._agentCurrentFile ? `\nActive editor file: ${this._agentCurrentFile}` : '';

        return `You are Enclave, an AI coding agent running inside VS Code.

## HOW YOU WORK
You operate in an agentic loop. Each reply is exactly ONE action expressed as a single JSON object.
The action is executed and its result is sent back to you as a [TOOL RESULT]. You then reply with the
next action. Repeat until the task is complete, then reply with a final-answer.

## ACTIONS
${actionLines.join('\n')}
${pluginSection}
## RULES
1. Reply with ONLY one JSON object. No prose, no markdown fences, nothing before or after it.
2. Paths are relative to the workspace root. write-file must contain the COMPLETE file content (not a diff or a snippet), with newlines escaped as \\n inside the JSON string.
3. NEVER guess what a file contains. Before overwriting an existing file you MUST read-file it in this run; writes to unread existing files are rejected. Search before guessing a path.
4. Never repeat an action that already has a result; use the results you already received.
5. For tasks covering several files, handle them one at a time: read-file → write-file → next file. Check PROGRESS IN THIS RUN to see which files are already done, and continue until every file is processed.
6. Use final-answer only when the whole task is done (every file processed), or when you are blocked. In the message, explain in Markdown what you did or what is missing.
7. If a tool result starts with BLOCKED, FAILED or DECLINED, that action was NOT done. Fix it (for a blocked write: use the file content in the result and write-file again) or report the problem in final-answer. Never claim in final-answer that something was done unless a tool result confirmed it.
8. Keep run-command usage to build/test/inspection commands; use write-file and delete-file for file changes.
9. A message starting with "[USER NOTE during the run]" was sent by the user while you were working: follow it from now on, even if it changes or narrows the task.

## EXAMPLE
User: Add a comment to the top of src/foo.ts
You: {"action":"read-file","path":"src/foo.ts"}
[TOOL RESULT] const x = 1;
You: {"action":"write-file","path":"src/foo.ts","content":"// comment\\nconst x = 1;"}
[TOOL RESULT] File updated: src/foo.ts
You: {"action":"final-answer","message":"Added the comment to the top of \`src/foo.ts\`."}

## CURRENT TASK
${this._agentTask || '(see the latest user message)'}

## PROGRESS IN THIS RUN
${this._buildRunProgress()}

## WORKSPACE
Root: ${root}${activeFile}
Files (partial): ${this._cachedWorkspaceSummary || '(not scanned)'}`;
    }

    private async _callAgentModel(model: string, signal: AbortSignal, extra: ChatMessage[] = []): Promise<CompletionResult> {
        const history = this._trimForPayload([...this._historyForAgentModel(), ...extra], this._agentTask || null);
        return this._llm.completeDetailed(model, this._buildAgentSystemPrompt(), history, {
            jsonMode: true,
            signal,
            timeoutMs: this._cfg<number>('agent.modelTimeoutMs', 600000),
            stallTimeoutMs: this._cfg<number>('agent.modelStallTimeoutMs', 90000)
        });
    }

    /** Does the task text ask for changes (as opposed to questions / summaries)? */
    private _taskLooksMutating(task: string): boolean {
        return /\b(add|append|insert|write|create|make|generate|modify|change|update|edit|fix|refactor|rename|replace|remove|delete|implement|convert|move|prepend|apply|execute|run|install)\b/i.test(task);
    }

    /** Has the current run successfully performed any action that changes the workspace? */
    private _runHasSuccessfulMutations(): boolean {
        return this._runActionsWithOutcome().some(({ action, ok }) => ok && !this._isReadOnly(action));
    }

    /** Did the most recent action of this run fail, get blocked, or get declined? */
    private _runLastActionFailed(): boolean {
        const all = this._runActionsWithOutcome();
        const last = all[all.length - 1];
        return !!last && !last.ok;
    }

    /** How many of the most recent actions in this run failed, were blocked or were declined, without a success in between. */
    private _runConsecutiveFailures(): number {
        const all = this._runActionsWithOutcome();
        let count = 0;
        for (let i = all.length - 1; i >= 0 && !all[i].ok; i--) { count++; }
        return count;
    }

    /** Files the model read in this run but never successfully wrote. */
    private _runReadButUnwritten(): string[] {
        const read = new Set<string>();
        const written = new Set<string>();
        for (const { action, ok } of this._runActionsWithOutcome()) {
            if (!ok) { continue; }
            if (action.type === 'read-file') { read.add(action.path); }
            if (action.type === 'write-file') { written.add(action.path); }
        }
        return [...read].filter(p => !written.has(p));
    }

    /** Appended to a completion claim that no tool result backs up, so neither the user nor the model's future turns trust it. */
    private _unverifiedFinishNote(): string {
        const progress = this._runActionsWithOutcome();
        const read = progress.flatMap(p => p.ok && p.action.type === 'read-file' ? [p.action.path] : []);
        const failed = progress.filter(p => !p.ok).map(p => actionCommandLabel(p.action));
        const lines = [
            '',
            '---',
            '⚠️ **Not verified:** no file was written or deleted and no command ran in this run, so the tool results do not confirm the claim above. The workspace is unchanged.',
        ];
        if (read.length) { lines.push(`Files read: ${read.map(p => `\`${p}\``).join(', ')}`); }
        if (failed.length) { lines.push(`Actions that failed or were blocked: ${failed.map(p => `\`${p}\``).join(', ')}`); }
        lines.push('Send the task again, or try a stronger model (for Blablador, `alias-large` or `alias-code`).');
        return lines.join('\n');
    }

    /** Begin a new agent run for the latest user prompt. */
    private async _startAgentRun(prompt: string, model: string, mode: AgentRunMode, currentFile: string | null, view: vscode.WebviewView) {
        if (this._agentAbort) { this._agentAbort.abort(); }
        this._agentAbort = new AbortController();
        this._agentIteration = 0;
        this._agentRunStartedAt = Date.now();
        this._agentPausedMs = 0;
        this._approvalWaitStartedAt = 0;
        this._lastActionKey = '';
        this._pendingApproval = null;
        this._runKnownFiles = new Set();
        this._completionChallengeSent = false;
        this._agentTask = this._pendingTask || prompt;
        this._pendingTask = '';
        this._liveMode = mode;
        this._agentCurrentFile = currentFile;
        this._guardrails = this._createGuardrails();
        this._log.appendLine(`[${new Date().toISOString()}] ▶ agent run (${mode}, ${model}): ${prompt.slice(0, 200).replace(/\s+/g, ' ')}`);

        view.webview.postMessage({
            type: 'agentWorking',
            step: 1,
            label: mode === 'agent'
                ? 'starting — writes, deletes and commands will ask for approval…'
                : 'starting — changes are applied directly; review them in Agent Changes…'
        });
        try {
            const summary = await this._buildWorkspaceContextSummary();
            this._cachedWorkspaceSummary = summary.length > 2500 ? `${summary.slice(0, 2500)} ...` : summary;
        } catch {
            this._cachedWorkspaceSummary = '';
        }
        this._persistSession(mode);

        await this._runAgentStep(model, mode, view);
    }

    /** End the current run: show an optional closing message and unlock the UI. */
    private _finishAgentRun(view: vscode.WebviewView, mode: string, message: string | null) {
        if (message) {
            view.webview.postMessage({ type: 'assistantResponse', content: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._persistSession(mode);
        }
        view.webview.postMessage({ type: 'agentDone' });
        this._agentIteration = 0;
        this._lastActionKey = '';
        this._pendingApproval = null;
    }

    /** One iteration: ask the model for the next action, record it and dispatch it. */
    private async _runAgentStep(model: string, mode: AgentRunMode, view: vscode.WebviewView): Promise<void> {
        const run = this._agentAbort;
        if (!run || run.signal.aborted) {
            this._finishAgentRun(view, mode, null);
            return;
        }

        this._agentIteration++;
        const limit = this._guardrails.canExecuteOperation(this._agentIteration, Date.now() - this._agentRunStartedAt - this._agentPausedMs);
        if (!limit.allowed) {
            const timeBudget = /time budget/.test(limit.reason ?? '');
            const setting = timeBudget ? 'continued.agent.maxRunMinutes' : 'continued.agent.maxIterations';
            this._finishAgentRun(view, mode, `⚠️ ${limit.reason} Send another message to continue where it left off, or raise \`${setting}\` in Settings (0 removes the ${timeBudget ? 'time' : 'step'} limit).`);
            return;
        }
        const thrashing = this._guardrails.canContinueAfterFailures(this._runConsecutiveFailures());
        if (!thrashing.allowed) {
            this._finishAgentRun(view, mode, `⚠️ ${thrashing.reason} Check the failed actions above, then send another message with guidance (or raise \`continued.agent.maxConsecutiveFailures\` in Settings).`);
            return;
        }

        view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: 'thinking…' });

        // Ask the model for an action; correct it up to twice when it replies with
        // nothing, with reasoning only, or with prose instead of JSON.
        const MAX_CORRECTIONS = 2;
        const correction: ChatMessage[] = [];
        let action: AgentAction | null = null;
        let lastText = '';
        let lastReasoning = '';
        let lastError = '';

        // A timeout, stall or dropped connection is retried once per attempt before the run
        // is given up: on a shared gateway or a busy local machine these are usually one-offs.
        const MAX_TRANSIENT_RETRIES = 1;
        const TRANSIENT = /timed out|stopped sending|exceeded the .* cap|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|terminated|\((?:429|500|502|503|504)\)/i;
        let transientRetries = 0;

        for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
            if (attempt > 0 && correction.length < attempt * 2) {
                const stoppedAfterThinking = !lastText && !!lastReasoning;
                view.webview.postMessage({
                    type: 'agentWorking',
                    step: this._agentIteration,
                    label: stoppedAfterThinking ? 'model stopped after thinking, asking for the action…' : (lastText ? 'asking model to fix its reply…' : 'model returned nothing, retrying…')
                });
                correction.push({ role: 'assistant', content: lastText || (lastReasoning ? `(thinking) ${lastReasoning.slice(0, 2000)}` : '(empty reply)') });
                correction.push({
                    role: 'user',
                    content: stoppedAfterThinking
                        ? 'You stopped after thinking and did not output an action. Now output the JSON action you decided on — ONLY the JSON object, e.g. {"action":"read-file","path":"..."}. Do not write [TOOL RESULT] yourself; results are provided to you.'
                        : lastText
                            ? 'Your last reply was not a valid JSON action. Reply with ONLY one JSON object such as {"action":"read-file","path":"..."} or {"action":"final-answer","message":"..."}. No explanation, no markdown, and never write [TOOL RESULT] blocks yourself.'
                            : 'Your last reply was empty. Look at PROGRESS IN THIS RUN and the CURRENT TASK, then reply with ONLY the next JSON action, or {"action":"final-answer","message":"..."} if everything is done.'
                });
                this._log.appendLine(`[${new Date().toISOString()}] correction ${attempt}/${MAX_CORRECTIONS} at step ${this._agentIteration}`);
            }

            try {
                const result = await this._callAgentModel(model, run.signal, correction);
                lastText = result.text;
                lastReasoning = result.reasoning;
                lastError = '';
            } catch (err: unknown) {
                if (run.signal.aborted) { this._finishAgentRun(view, mode, null); return; }
                lastError = (err as Error).message ?? String(err);
                lastText = '';
                lastReasoning = '';
                if (TRANSIENT.test(lastError) && transientRetries < MAX_TRANSIENT_RETRIES) {
                    transientRetries++;
                    this._log.appendLine(`[${new Date().toISOString()}] transient model error at step ${this._agentIteration} (retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}): ${lastError.slice(0, 200)}`);
                    view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: `model call failed (${lastError.slice(0, 60)}…), retrying once…` });
                    await this._pause(3000, run.signal);
                    if (run.signal.aborted) { this._finishAgentRun(view, mode, null); return; }
                    attempt--;   // repeat this attempt; no correction message is added for it
                    continue;
                }
                // Auth, quota and repeated network problems will not be fixed by a correction message.
                if (!/empty response/i.test(lastError)) {
                    this._finishAgentRun(view, mode, `Agent error: ${lastError}`);
                    return;
                }
            }
            if (run.signal.aborted) { this._finishAgentRun(view, mode, null); return; }

            action = lastText ? parseAgentAction(lastText) : null;
            if (action) { break; }
        }

        if (!action) {
            const displayText = sanitizeAgentDisplayResponse(lastText || lastReasoning);
            const fallback = lastText
                ? `⚠️ The agent kept replying with text instead of an action, so the run was stopped. Last reply:\n\n${displayText.slice(0, 1500) || '(unprintable)'}`
                : `⚠️ The model stopped without producing an action ${MAX_CORRECTIONS + 1} times in a row${lastError ? ` (${lastError})` : ''}.${displayText ? `\n\nIts last reasoning was:\n\n> ${displayText.slice(0, 800).replace(/\n/g, '\n> ')}` : ''}\n\nTry again, use a different model, or lower \`continued.agent.maxContextChars\` if the model's context is small. The "Enclave" output channel has the raw replies.`;
            this._finishAgentRun(view, mode, fallback);
            return;
        }
        const response = lastText;

        // Challenge a completion claim that did not change anything, once per run.
        const suspiciousFinish = action.type === 'final-answer' && !this._completionChallengeSent && (
            (this._taskLooksMutating(this._agentTask) && !this._runHasSuccessfulMutations()) ||
            this._runLastActionFailed()
        );
        if (suspiciousFinish) {
            this._completionChallengeSent = true;
            this._log.appendLine(`[${new Date().toISOString()}] final-answer looks premature (no successful changes or last action failed); challenging once`);
            view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: 'verifying the agent really finished…' });
            const challenge: ChatMessage[] = [
                { role: 'assistant', content: response },
                {
                    role: 'user',
                    content: (this._runLastActionFailed()
                        ? 'STOP. Your last action was BLOCKED or FAILED, so it was NOT done — do not claim it was. Look at the "NOT done" list in PROGRESS IN THIS RUN and continue with the next JSON action to actually complete the task (for a blocked write, use the file content you were given and reply with write-file for that file). Only reply with final-answer once every file is written successfully, and describe only what the tool results confirm.'
                        : 'STOP. Your claim is not true: in THIS run no write-file, delete-file or run-command has succeeded (see PROGRESS IN THIS RUN), so nothing has been changed yet. Earlier assistant messages in this conversation that claimed success were also wrong. The workspace still needs the change the task asks for.')
                        + (this._runReadButUnwritten().length
                            ? ` You have read but not yet written: ${this._runReadButUnwritten().join(', ')}. Reply now with {"action":"write-file","path":"${this._runReadButUnwritten()[0]}","content":"<FULL updated content>"} for that file, then continue with the others.`
                            : ' Reply now with the next JSON action (read-file the first file the task mentions), not with final-answer.')
                }
            ];
            try {
                const verify = await this._callAgentModel(model, run.signal, challenge);
                if (run.signal.aborted) { this._finishAgentRun(view, mode, null); return; }
                const verified = verify.text ? parseAgentAction(verify.text) : null;
                if (verified) { action = verified; }
            } catch {
                // Keep the original final-answer if the verification call fails.
            }
        }

        // A `use-tool` aimed at a dedicated tool becomes its native action, so the guardrail and
        // approval checks below (which key on the action type) cannot be stepped around.
        action = canonicalizeAction(action);

        // Stop if the model is stuck repeating itself.
        const actionKey = JSON.stringify(action);
        if (action.type !== 'final-answer' && actionKey === this._lastActionKey) {
            this._finishAgentRun(view, mode, `⚠️ The agent repeated the same action twice in a row (\`${actionCommandLabel(action)}\`), so the run was stopped. Send another message to continue.`);
            return;
        }
        this._lastActionKey = actionKey;

        if (action.type === 'final-answer') {
            let message = action.message || 'Task completed.';
            // A completion claim for a change request with no successful change behind it gets a visible caveat,
            // which also lands in the history so later turns do not inherit the false claim.
            if (this._taskLooksMutating(this._agentTask) && !this._runHasSuccessfulMutations()) {
                this._log.appendLine(`[${new Date().toISOString()}] final-answer accepted without any successful change; marking as unverified`);
                message += `\n${this._unverifiedFinishNote()}`;
            }
            this._finishAgentRun(view, mode, message);
            return;
        }

        this._chatHistory.push({ role: 'assistant', content: encodeAction(action) });
        this._persistSession(mode);
        view.webview.postMessage({ type: 'agentAction', content: formatActionDescription(action) });

        await this._dispatchAgentAction(action, model, mode, view);
    }

    /** Run guardrails, then execute directly or ask the user for approval. */
    private async _dispatchAgentAction(rawAction: AgentAction, model: string, mode: AgentRunMode, view: vscode.WebviewView): Promise<void> {
        const action = canonicalizeAction(rawAction);
        const blockedReason = await this._guardrailCheck(action);
        if (blockedReason) {
            await this._completeAgentAction(action, `BLOCKED: ${blockedReason}`, model, mode, view);
            return;
        }

        const outsideDocument = this._activeDocumentOutsideWorkspace(action);
        mode = this._liveMode;
        const needsApproval = this._needsApproval(action, mode, outsideDocument);

        if (needsApproval) {
            this._pendingApproval = { action, model, mode };
            this._approvalWaitStartedAt = Date.now();
            this._requestApproval(view, action, outsideDocument);
            view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: 'waiting for your approval…' });
            return;
        }

        view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: `running ${action.type}…` });
        const output = await this._executeAgentAction(action);
        await this._completeAgentAction(action, output, model, mode, view);
    }

    /** Record a tool result, show it, and continue the loop. */
    private async _completeAgentAction(action: AgentAction, output: string, model: string, mode: AgentRunMode, view: vscode.WebviewView): Promise<void> {
        const label = actionCommandLabel(action);
        const cap = action.type === 'read-file' ? this._cfg<number>('agent.maxToolOutputChars', 40000) : 12000;
        const entry = encodeToolResult(label, output, cap);
        this._log.appendLine(`[${new Date().toISOString()}] tool ${label.slice(0, 120)} → ${output.slice(0, 300).replace(/\s+/g, ' ')}${output.length > 300 ? ' …' : ''}`);

        view.webview.postMessage({ type: 'commandResult', command: label, output: decodeToolResult(entry)?.output ?? output });
        this._chatHistory.push({ role: 'assistant', content: entry });
        this._persistSession(mode);

        if (this._agentAbort?.signal.aborted) {
            this._finishAgentRun(view, mode, null);
            return;
        }
        await this._runAgentStep(model, mode, view);
    }

    /**
     * The one read permitted outside the workspace: the document currently open in the editor.
     *
     * The containment rule exists to stop the *model* choosing to read a path such as
     * `~/.ssh/id_rsa`. When a harness step reads `{{activeFile}}` the path did not come from the
     * model — the author wrote the template and the user chose the file by opening it — so
     * blocking it protects against nothing while defeating "Explain the active file". The read
     * is therefore allowed for exactly that document, never silently: it is approval-gated so
     * the boundary crossing is seen and recorded, and the hard forbidden list still applies.
     */
    /** Agent mode asks for every change; Auto-Edit asks only for actions that send data out or run a risky command. */
    private _needsApproval(action: AgentAction, mode: AgentRunMode, outsideDocument: vscode.TextDocument | null): boolean {
        return outsideDocument !== null || (!this._isReadOnly(action) && (
            mode === 'agent' ||
            this._sendsDataOut(action) ||
            (action.type === 'run-command' && this._guardrails.requiresExplicitApproval(action.command))
        ));
    }

    /** Continue the run after an approval answer; `allow` false records a DECLINED result. */
    private async _resumeAfterApproval(allow: boolean, view: vscode.WebviewView): Promise<void> {
        const pending = this._pendingApproval;
        this._pendingApproval = null;
        if (this._approvalWaitStartedAt) {
            this._agentPausedMs += Date.now() - this._approvalWaitStartedAt;
            this._approvalWaitStartedAt = 0;
        }
        if (!pending) { return; }
        if (this._agentAbort?.signal.aborted) {
            this._finishAgentRun(view, pending.mode, null);
            return;
        }
        if (allow) {
            view.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: `running ${pending.action.type}…` });
            const output = await this._executeAgentAction(pending.action);
            await this._completeAgentAction(pending.action, output, pending.model, this._liveMode, view);
        } else {
            await this._completeAgentAction(
                pending.action,
                'DECLINED: the user did not approve this action. Choose a different approach, or reply with final-answer explaining what remains to be done.',
                pending.model,
                this._liveMode,
                view
            );
        }
    }

    private _activeDocumentOutsideWorkspace(action: AgentAction): vscode.TextDocument | null {
        if (action.type !== 'read-file') { return null; }
        const editor = vscode.window.activeTextEditor;
        const root = this._workspaceRoot();
        if (!editor || !root || editor.document.isUntitled || editor.document.uri.scheme !== 'file') { return null; }
        const target = path.resolve(root, action.path);
        if (path.resolve(editor.document.uri.fsPath) !== target) { return null; }
        const relative = path.relative(root, target);
        if (!(relative.startsWith('..') || path.isAbsolute(relative))) { return null; }   // inside: ordinary read
        if (!this._guardrails.isForbiddenPath(target).safe) { return null; }
        return editor.document;
    }

    private _outsideReadDetail(document: vscode.TextDocument): string {
        const model = this._getScopedState<string>('continued_last_model') || 'the selected model';
        return `The active file is outside the open workspace. Its contents will be read from the editor and sent to ${model}.`;
    }

    private async _guardrailCheck(action: AgentAction, enforceReadBeforeWrite = true): Promise<string | null> {
        const root = this._workspaceRoot();
        if (!root) { return 'No workspace folder is open.'; }

        switch (action.type) {
            case 'read-file':
            case 'write-file':
            case 'delete-file': {
                if (this._activeDocumentOutsideWorkspace(action)) { return null; }
                const verdict = this._guardrails.isSafeFilePath(action.path, root);
                if (!verdict.safe) { return verdict.reason ?? 'Path rejected.'; }
                // Never let the model overwrite a file it has not looked at in this run. Instead of
                // just refusing, hand it the current content so the next step can be the real write.
                if (action.type === 'write-file' && enforceReadBeforeWrite) {
                    const key = this._normalizeRelativePath(action.path);
                    if (!this._runKnownFiles.has(key) && this._fileExistsInWorkspace(key)) {
                        let current = '';
                        try {
                            current = await this._runRegistryTool('read-file', { filePath: action.path });
                            this._runKnownFiles.add(key);
                        } catch (error) {
                            return `${action.path} already exists and you have not read it in this run, so this write was rejected to avoid losing its content. Reading it also failed: ${(error as Error).message}`;
                        }
                        const cap = this._cfg<number>('agent.maxToolOutputChars', 40000);
                        const shown = current.length > cap ? `${current.slice(0, cap)}\n...[truncated]` : current;
                        return `${action.path} already exists and you had not read it in this run, so this write was rejected to avoid losing its content. The file was NOT changed. Its CURRENT content (${current.split('\n').length} lines) is:\n----- BEGIN ${action.path} -----\n${shown}\n----- END ${action.path} -----\nNow reply with {"action":"write-file","path":"${action.path}","content":"<the FULL updated content based on the text above>"}.`;
                    }
                }
                return null;
            }
            case 'run-command': {
                const verdict = this._guardrails.isSafeCommand(action.command);
                return verdict.safe ? null : (verdict.reason ?? 'Command rejected.');
            }
            default:
                return null;
        }
    }

    private _requestApproval(view: vscode.WebviewView, action: AgentAction, outsideDocument: vscode.TextDocument | null = null) {
        if (outsideDocument) {
            view.webview.postMessage({
                type: 'requestCommandApproval',
                kind: 'read-outside',
                command: outsideDocument.uri.fsPath,
                detail: this._outsideReadDetail(outsideDocument)
            });
            return;
        }
        switch (action.type) {
            case 'write-file':
                view.webview.postMessage({ type: 'requestEditApproval', filename: action.path, lines: action.content.split('\n').length, preview: action.content.slice(0, 1500) });
                break;
            case 'delete-file':
                view.webview.postMessage({ type: 'requestDeleteApproval', filename: action.path });
                break;
            default:
                view.webview.postMessage({
                    type: 'requestCommandApproval',
                    command: actionCommandLabel(action),
                    kind: action.type === 'run-command' ? 'shell' : 'plugin'
                });
        }
    }

    private async _runRegistryTool(id: string, args: Record<string, unknown>): Promise<string> {
        const tool = this._pluginRegistry?.getTool(id);
        if (!tool) { throw new Error(`Tool '${id}' is not registered.`); }
        if (!tool.enabled) { throw new Error(`Tool '${id}' is disabled in Plugin Manager.`); }
        const result = await tool.execute(args);
        return typeof result === 'string' ? result : this._formatPluginExecutionResult(result);
    }

    /** Execute an action and return the observation for the model. Never throws. */
    private async _executeAgentAction(action: AgentAction): Promise<string> {
        try {
            switch (action.type) {
                case 'read-file': {
                    const outsideDocument = this._activeDocumentOutsideWorkspace(action);
                    if (outsideDocument) {
                        // Approved above. Read the editor buffer itself, unsaved edits included; the
                        // file tool would refuse the path, correctly, since it is outside the workspace.
                        this._log.appendLine(`[${new Date().toISOString()}] read of active document outside the workspace approved: ${outsideDocument.uri.fsPath}`);
                        this._runKnownFiles.add(this._normalizeRelativePath(action.path));
                        return outsideDocument.getText();
                    }
                    const content = await this._runRegistryTool('read-file', { filePath: action.path });
                    this._runKnownFiles.add(this._normalizeRelativePath(action.path));
                    return content;
                }
                case 'write-file': {
                    if (!this._isToolEnabled('write-file')) { return 'FAILED: The write-file tool is disabled in Plugin Manager.'; }
                    const result = await this._applyWorkspaceEdit(action.path, action.content);
                    this._runKnownFiles.add(this._normalizeRelativePath(action.path));
                    return result;
                }
                case 'delete-file':
                    if (!this._isToolEnabled('delete-file')) { return 'FAILED: The delete-file tool is disabled in Plugin Manager.'; }
                    return await this._executeFileDeletion(action.path);
                case 'semantic-search':
                    return await this._runRegistryTool('semantic-search', { pattern: action.query });
                case 'grep-search':
                    return await this._runRegistryTool('grep-search', { query: action.query, filePattern: action.filePattern });
                case 'run-command':
                    if (!this._isToolEnabled('run-command')) { return 'FAILED: The run-command tool is disabled in Plugin Manager.'; }
                    return await this._executeShellCommand(action.command);
                case 'use-tool': {
                    const tool = this._pluginRegistry?.getTool(action.tool);
                    if (!tool) {
                        const available = this._pluginRegistry?.getEnabledTools().map(t => t.id).join(', ') || '(none)';
                        return `FAILED: tool '${action.tool}' does not exist. Available tools: ${available}`;
                    }
                    if (!tool.enabled) { return `FAILED: tool '${action.tool}' is disabled in Plugin Manager.`; }
                    const touched = typeof tool.touches === 'function' ? tool.touches(action.args ?? {}).filter(Boolean) : [];
                    const root = this._workspaceRoot();
                    for (const p of touched) {
                        const verdict = root ? this._guardrails.isSafeFilePath(p, root) : { safe: false, reason: 'No workspace folder is open.' };
                        if (!verdict.safe) { return `BLOCKED: ${verdict.reason}`; }
                    }
                    const before = this._snapshotTouched(touched);
                    try {
                        return this._formatPluginExecutionResult(await tool.execute(action.args ?? {}));
                    } finally {
                        if (before.length) { this._recordTouchedChanges(before); }
                    }
                }
                case 'use-resource': {
                    const resource = this._pluginRegistry?.getResource(action.resource);
                    if (!resource) {
                        const available = this._pluginRegistry?.getEnabledResources().map(r => r.id).join(', ') || '(none)';
                        return `FAILED: resource '${action.resource}' does not exist. Available resources: ${available}`;
                    }
                    if (!resource.enabled) { return `FAILED: resource '${action.resource}' is disabled in Plugin Manager.`; }
                    return this._formatPluginExecutionResult(await resource.fetch());
                }
                case 'use-skill': {
                    const skill = this._pluginRegistry?.getSkill(action.skill);
                    if (!skill) {
                        const available = this._pluginRegistry?.getEnabledSkills().map(s => s.id).join(', ') || '(none)';
                        return `FAILED: skill '${action.skill}' does not exist. Available skills: ${available}`;
                    }
                    if (!skill.enabled) { return `FAILED: skill '${action.skill}' is disabled in Plugin Manager.`; }
                    return this._formatPluginExecutionResult(await skill.execute(this._buildSkillContext(), action.input));
                }
                case 'final-answer':
                    return '';
            }
        } catch (error) {
            return `FAILED: ${(error as Error).message}`;
        }
    }

    // ---------------------------------------------------------------------
    // File changes with revert support
    // ---------------------------------------------------------------------

    private _resolveInWorkspace(relativePath: string): vscode.Uri {
        const ws = vscode.workspace.workspaceFolders;
        if (!ws || ws.length === 0) { throw new Error('No workspace folder open.'); }
        const root = ws[0].uri.fsPath;
        const absolute = path.resolve(root, relativePath);
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Path is outside the workspace: ${relativePath}`);
        }
        return vscode.Uri.file(absolute);
    }

    private _recordChange(change: RunChange) {
        const existing = this._runChanges.find(c => c.relativePath === change.relativePath);
        if (existing) {
            // Keep the earliest snapshot so a revert restores the pre-agent state.
            existing.isDeletion = change.isDeletion;
        } else {
            this._runChanges.push(change);
        }
        if (this._view) { this._postPendingOps(this._view); }
    }

    private _postPendingOps(view: vscode.WebviewView) {
        view.webview.postMessage({
            type: 'updatePendingOps',
            edits: this._runChanges.filter(c => !c.isDeletion).map(c => ({ relativePath: c.relativePath, created: !c.existed })),
            deletes: this._runChanges.filter(c => c.isDeletion).map(c => c.relativePath)
        });
    }

    private _findChange(opType: string, index: number): RunChange | undefined {
        const list = this._runChanges.filter(c => c.isDeletion === (opType === 'delete'));
        return list[index];
    }

    private async _revertChange(change: RunChange): Promise<void> {
        const fileUri = this._resolveInWorkspace(change.relativePath);
        if (change.isDeletion || change.existed) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(change.originalContent));
        } else {
            try {
                await vscode.workspace.fs.delete(fileUri, { useTrash: false });
            } catch {
                // Already gone.
            }
        }
    }

    private async _applyWorkspaceEdit(relativePath: string, newContent: string): Promise<string> {
        const fileUri = this._resolveInWorkspace(relativePath);
        let original = '';
        let existed = false;

        try {
            original = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
            existed = true;
        } catch {
            existed = false;
        }

        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(newContent));
        this._recordChange({ relativePath, originalContent: original, existed, isDeletion: false });

        try {
            await vscode.window.showTextDocument(fileUri, { preview: true, preserveFocus: true });
        } catch {
            // Binary or otherwise un-openable file — the write still succeeded.
        }

        const lines = newContent.split('\n').length;
        return `${existed ? 'File updated' : 'File created'}: ${relativePath} (${lines} lines)`;
    }

    private async _executeFileDeletion(relativePath: string): Promise<string> {
        const fileUri = this._resolveInWorkspace(relativePath);
        let original = '';

        try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            if (stat.type === vscode.FileType.Directory) {
                return `FAILED: ${relativePath} is a directory. Only files can be deleted.`;
            }
            original = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
        } catch {
            return `FAILED: file not found: ${relativePath}`;
        }

        try {
            await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: true });
        } catch {
            await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
        }
        this._recordChange({ relativePath, originalContent: original, existed: true, isDeletion: true });
        return `File deleted: ${relativePath}`;
    }

    private async _executeShellCommand(command: string): Promise<string> {
        const root = this._workspaceRoot();
        if (!root) {
            return 'FAILED: No workspace folder open. Cannot run command.';
        }

        const timeout = this._guardrails.COMMAND_TIMEOUT;
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: root,
                maxBuffer: 4 * 1024 * 1024,
                timeout,
                shell: process.platform === 'win32' ? undefined : '/bin/bash',
                env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat' }
            });

            const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');
            return this._guardrails.sanitizeCommandOutput(combined || 'Command executed successfully (no output).');
        } catch (error: unknown) {
            const err = error as { killed?: boolean; code?: number | string; stdout?: string; stderr?: string; message?: string };
            const stdout = err.stdout ? String(err.stdout).trim() : '';
            const stderr = err.stderr ? String(err.stderr).trim() : '';
            const status = err.killed
                ? `FAILED: command timed out after ${Math.round(timeout / 1000)}s.`
                : `FAILED: exit code ${err.code ?? 'unknown'}.`;
            return this._guardrails.sanitizeCommandOutput([stdout, stderr, status].filter(Boolean).join('\n'));
        }
    }

    // =====================================================================
    // Chat / Plan mode
    // =====================================================================

    private _composePrompt(text: string, files: AttachedFile[]): string {
        if (!files.length) {return text;}
        const parts = [text.trim()];
        for (const file of files.slice(0, 10)) {
            if (file.isImage) {
                parts.push(`[Attached image "${file.name}" — image input is not supported yet, so it was not included.]`);
                continue;
            }
            if (file.isPdf) {
                parts.push(`[Attached PDF "${file.name}" — PDF text extraction is not available in VS Code yet, so it was not included. Convert it to text first (e.g. pdftotext) and attach that.]`);
                continue;
            }
            const content = String(file.content ?? '');
            const capped = content.length > 60000 ? `${content.slice(0, 60000)}\n...[truncated]` : content;
            parts.push(`[Attached file: ${file.name}]\n\`\`\`\n${capped}\n\`\`\``);
        }
        return parts.filter(Boolean).join('\n\n');
    }

    private async _runChatTurn(model: string, mode: string, currentFile: string | null, view: vscode.WebviewView) {
        let system = mode === 'plan'
            ? `You are Enclave, an AI coding assistant running inside VS Code, in PLAN mode.
Do NOT make changes. Produce a concise, numbered implementation plan for the user's request that another agent can execute step by step.
For each step name the file(s) to read or modify and describe the change precisely. Mention any commands to run and finish with a short verification step.
Write plain Markdown. Do not output JSON actions or tool tags.`
            : "You are Enclave, an AI coding assistant running inside VS Code. Answer the user's latest query directly and concisely, using Markdown and fenced code blocks where helpful.";
        if (currentFile) {
            system += `\n\nThe user currently has this file open in the editor: ${currentFile}`;
        }
        const root = this._workspaceRoot();
        if (root) {
            system += `\nWorkspace root: ${root}`;
        }

        view.webview.postMessage({ type: 'startStream' });

        let full = '';
        try {
            full = await this._llm.stream(model, system, this._trimForPayload(this._historyForChatModel()), {
                onToken: token => view.webview.postMessage({ type: 'streamToken', value: token }),
                onThinking: token => view.webview.postMessage({ type: 'thinkingToken', value: token }),
                onThinkingDone: () => view.webview.postMessage({ type: 'thinkingDone' })
            }, { timeoutMs: 600000 });
        } catch (err: unknown) {
            const message = `Error connecting to server: ${(err as Error).message}`;
            const content = full ? `${full}\n\n${message}` : message;
            view.webview.postMessage({ type: 'assistantResponse', content });
            this._chatHistory.push({ role: 'assistant', content });
            this._persistSession(mode);
            return;
        }

        view.webview.postMessage({ type: 'assistantResponse', content: full });
        if (full.trim()) {
            this._chatHistory.push({ role: 'assistant', content: full });
        }
        this._persistSession(mode);

        if (mode === 'plan' && full.trim()) {
            view.webview.postMessage({ type: 'showPlan', plan: full });
        }
    }

    private async _handleSendPrompt(
        userPrompt: string,
        model: string,
        mode: string,
        currentFile: string | null,
        attachedFiles: AttachedFile[],
        view: vscode.WebviewView
    ) {
        if (!this._currentSessionId) {
            this._currentSessionId = 'session_' + Date.now();
        }

        const prompt = this._composePrompt(userPrompt, attachedFiles);
        // The run's task line names the attachments; their bodies stay in the user message only.
        this._pendingTask = attachedFiles.length
            ? `${userPrompt.trim() || 'The user attached file(s) without further instructions: use their contents to do what the conversation asked for.'} [attached: ${attachedFiles.slice(0, 10).map(f => f.name).join(', ')} — contents are in the user message]`
            : userPrompt;
        this._chatHistory.push({ role: 'user', content: prompt });

        if (await this._tryHandlePluginChatCommand(prompt, mode, view)) {
            return;
        }

        if (isAgentMode(mode)) {
            await this._startAgentRun(prompt, model, mode, currentFile, view);
            return;
        }

        await this._runChatTurn(model, mode, currentFile, view);
    }

    // =====================================================================
    // Webview wiring
    // =====================================================================

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

        // A fresh nonce per render; the policy in the document only admits scripts carrying it.
        webviewView.webview.html = generateChatViewHTML({
            nonce: crypto.randomBytes(16).toString('base64'),
            cspSource: webviewView.webview.cspSource
        });

        // Keep the "current file" indicator in sync with the active editor
        const sendCurrentFile = () => {
            const editor = vscode.window.activeTextEditor;
            const filePath = editor?.document.uri.fsPath ?? null;
            const relativePath = filePath
                ? vscode.workspace.asRelativePath(filePath, false)
                : null;
            webviewView.webview.postMessage({ type: 'setCurrentFile', filePath: relativePath });
        };
        sendCurrentFile();
        this._context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => sendCurrentFile())
        );

        await this._initializePlugins();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const sessions = this._getAllSessions();

            switch (data.type) {
                case 'openSettings': {
                    await showProviderSelector(this._context);
                    break;
                }
                case 'getModels': {
                    const models = await this._llm.listModels();

                    const savedModel = this._getScopedState<string>('continued_last_model') || 'llama3';
                    const savedMode = this._getScopedState<string>('continued_last_mode') || 'agent';
                    webviewView.webview.postMessage({ type: 'setModels', models, savedModel, savedMode });
                    webviewView.webview.postMessage({ type: 'renderSessions', sessions });

                    // Auto-restore last active session on startup
                    const lastSessionId = this._getScopedState<string>('continued_last_session_id');
                    if (lastSessionId) {
                        const lastSession = sessions.find(s => s.id === lastSessionId);
                        if (lastSession) {
                            this._currentSessionId = lastSession.id;
                            this._chatHistory = [...lastSession.history];
                            this._postSessionView(webviewView, lastSession.mode);
                        }
                    }
                    break;
                }

                case 'startNewChat': {
                    this._agentAbort?.abort();
                    this._currentSessionId = 'session_' + Date.now();
                    this._chatHistory = [];
                    this._pendingApproval = null;
                    this._setScopedState('continued_last_session_id', this._currentSessionId);
                    this._postSessionView(webviewView);
                    break;
                }
                case 'selectSession': {
                    const found = sessions.find(s => s.id === data.sessionId);
                    if (found) {
                        this._agentAbort?.abort();
                        this._currentSessionId = found.id;
                        this._chatHistory = [...found.history];
                        this._pendingApproval = null;
                        this._setScopedState('continued_last_session_id', this._currentSessionId);
                        this._postSessionView(webviewView, found.mode);
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
                    const model = String(data.model || '').trim();
                    if (model) {
                        this._setScopedState('continued_last_model', model);
                    }
                    break;
                }
                case 'saveModePreference': {
                    const mode = String(data.mode || '').trim();
                    if (mode && ['chat', 'agent', 'agent-auto', 'plan'].includes(mode)) {
                        this._setScopedState('continued_last_mode', mode);
                    }
                    // A running agent follows the dropdown from the next action on. A prompt already on
                    // screen is answered for the user when the new mode would not have asked at all.
                    const runActive = !!this._agentAbort && !this._agentAbort.signal.aborted;
                    if (runActive && (mode === 'agent' || mode === 'agent-auto') && mode !== this._liveMode) {
                        this._liveMode = mode;
                        this._log.appendLine(`[${new Date().toISOString()}] mode switched to ${mode} during the run`);
                        const pending = this._pendingApproval;
                        if (pending && !this._needsApproval(pending.action, mode, this._activeDocumentOutsideWorkspace(pending.action))) {
                            webviewView.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: `switched to Auto-Edit — running ${pending.action.type}…` });
                            await this._resumeAfterApproval(true, webviewView);
                        }
                    }
                    break;
                }
                case 'clearHistory': {
                    this._agentAbort?.abort();
                    this._chatHistory = [];
                    this._pendingApproval = null;
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

                case 'getPlugins': {
                    this._postPlugins(webviewView);
                    break;
                }

                case 'togglePlugin': {
                    if (this._pluginRegistry) {
                        await this._pluginRegistry.togglePlugin(String(data.pluginId), Boolean(data.enabled));
                        this._postPlugins(webviewView);
                    }
                    break;
                }

                case 'createPlugin': {
                    try {
                        const rawName = String(data.pluginName || '').trim();
                        const rawType = String(data.pluginType || 'tool').trim().toLowerCase();
                        const pluginType = rawType === 'resource' || rawType === 'skill' ? rawType : 'tool';
                        const pluginName = rawName || 'My Plugin';
                        await this._createUserPlugin(pluginType, pluginName, String(data.description || ''), String(data.code || ''));
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not create plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'editPlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        await this._openUserPluginForEdit(pluginId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not open plugin for editing: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'reloadPlugins': {
                    await this._loadUserPlugins();
                    this._postPlugins(webviewView);
                    break;
                }

                case 'openPluginsFolder': {
                    try {
                        await this._openPluginsFolder();
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not open plugins folder: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'duplicatePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const duplicateName = String(data.duplicateName || '').trim();
                        const duplicateId = String(data.duplicateId || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        await this._duplicateUserPlugin(pluginId, duplicateName, duplicateId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not duplicate plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'renamePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const nextPluginId = String(data.nextPluginId || '').trim();
                        const nextPluginName = String(data.nextPluginName || '').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }
                        if (!nextPluginId) {
                            throw new Error('New plugin ID is required.');
                        }
                        await this._renameUserPlugin(pluginId, nextPluginId, nextPluginName);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not rename plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                case 'deletePlugin': {
                    try {
                        const pluginId = String(data.pluginId || '').trim();
                        const pluginName = String(data.pluginName || pluginId || 'this plugin').trim();
                        if (!pluginId) {
                            throw new Error('Plugin ID is required.');
                        }

                        const choice = await vscode.window.showWarningMessage(
                            `Delete plugin '${pluginName}'? This will remove its file from .continued/plugins/.`,
                            { modal: true },
                            'Delete'
                        );
                        if (choice !== 'Delete') {
                            break;
                        }

                        await this._deleteUserPlugin(pluginId);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Could not delete plugin: ${(error as Error).message}`);
                    }
                    break;
                }

                // ── Approval responses (edit / delete / command share one pending slot) ──
                case 'respondToEdit':
                case 'respondToDelete':
                case 'respondToCommand': {
                    // A harness step waiting on this answer takes precedence over the agent loop.
                    if (this._resolveCurrentApproval(data.action === 'Allow')) { break; }
                    await this._resumeAfterApproval(data.action === 'Allow', webviewView);
                    break;
                }

                // ── Change review panel ──
                case 'approveOp': {
                    const change = this._findChange(String(data.opType), Number(data.index));
                    if (change) { this._runChanges = this._runChanges.filter(c => c !== change); }
                    this._postPendingOps(webviewView);
                    break;
                }
                case 'rejectOp': {
                    const change = this._findChange(String(data.opType), Number(data.index));
                    if (change) {
                        try {
                            await this._revertChange(change);
                            this._runChanges = this._runChanges.filter(c => c !== change);
                            vscode.window.showInformationMessage(`Reverted ${change.relativePath}`);
                        } catch (error) {
                            vscode.window.showErrorMessage(`Could not revert ${change.relativePath}: ${(error as Error).message}`);
                        }
                    }
                    this._postPendingOps(webviewView);
                    break;
                }
                case 'approveAllOps': {
                    this._runChanges = [];
                    this._postPendingOps(webviewView);
                    break;
                }
                case 'rejectAllOps': {
                    const failures: string[] = [];
                    for (const change of [...this._runChanges].reverse()) {
                        try {
                            await this._revertChange(change);
                        } catch (error) {
                            failures.push(`${change.relativePath}: ${(error as Error).message}`);
                        }
                    }
                    this._runChanges = [];
                    this._postPendingOps(webviewView);
                    if (failures.length) {
                        vscode.window.showErrorMessage(`Some changes could not be reverted:\n${failures.join('\n')}`);
                    } else {
                        vscode.window.showInformationMessage('All agent changes were reverted.');
                    }
                    break;
                }

                // ── Harness dashboard ──
                case 'harnessCatalog': {
                    this._postHarnessCatalog(webviewView);
                    if (this._lastHarnessRun) { webviewView.webview.postMessage({ type: 'harnessRunUpdate', run: this._lastHarnessRun }); }
                    break;
                }
                case 'harnessReload': {
                    await this._loadUserPlugins();
                    await this._loadHarnesses();
                    this._postHarnessCatalog(webviewView);
                    this._postPlugins(webviewView);
                    break;
                }
                case 'harnessGet': {
                    const def = this._harnesses.get(String(data.id || ''));
                    if (def) { webviewView.webview.postMessage({ type: 'harnessDefinition', definition: def }); }
                    else { webviewView.webview.postMessage({ type: 'harnessError', message: `Harness "${data.id}" not found.` }); }
                    break;
                }
                case 'harnessSave': {
                    try {
                        const def = await this._saveHarnessFromUi(data.definition);
                        this._postHarnessCatalog(webviewView);
                        this._postPlugins(webviewView);
                        webviewView.webview.postMessage({ type: 'harnessSaved', id: def.id });
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: (error as Error).message });
                    }
                    break;
                }
                case 'harnessDuplicate': {
                    try {
                        const source = this._harnesses.get(String(data.id || ''));
                        if (!source) { throw new Error(`Harness "${data.id}" not found.`); }
                        const copy: HarnessDefinition = JSON.parse(JSON.stringify(source));
                        let base = slugifyHarnessId(`${source.name} copy`);
                        let n = 1;
                        while (this._harnesses.has(base)) { base = slugifyHarnessId(`${source.name} copy ${++n}`); }
                        copy.id = base;
                        copy.name = `${source.name} (copy)`;
                        copy.source = 'user';
                        await saveUserHarness(copy);
                        await this._loadHarnesses();
                        this._postHarnessCatalog(webviewView);
                        this._postPlugins(webviewView);
                        webviewView.webview.postMessage({ type: 'harnessDefinition', definition: copy, openBuilder: true });
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: (error as Error).message });
                    }
                    break;
                }
                case 'harnessDelete': {
                    try {
                        const id = String(data.id || '');
                        const def = this._harnesses.get(id);
                        if (!def) { throw new Error(`Harness "${id}" not found.`); }
                        if (def.source === 'built-in') { throw new Error('Built-in harnesses cannot be deleted.'); }
                        const choice = await vscode.window.showWarningMessage(`Delete harness "${def.name}"?`, { modal: true }, 'Delete');
                        if (choice !== 'Delete') { break; }
                        await deleteUserHarness(id);
                        if (this._pluginRegistry) { await this._pluginRegistry.removePlugin(id); }
                        await this._loadHarnesses();
                        this._postHarnessCatalog(webviewView);
                        this._postPlugins(webviewView);
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: (error as Error).message });
                    }
                    break;
                }
                case 'harnessExport': {
                    const id = String(data.id || '');
                    const def = this._harnesses.get(id);
                    if (!def) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: `Harness "${id}" not found.` });
                        break;
                    }
                    await this._exportHarness(def, data.format === 'markdown' ? 'markdown' : data.format === 'cwl' ? 'cwl' : 'json');
                    break;
                }
                case 'harnessImport': {
                    await this._importHarness(webviewView);
                    break;
                }
                case 'harnessRun': {
                    const def = this._harnesses.get(String(data.id || ''));
                    if (!def) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: `Harness "${data.id}" not found.` });
                        break;
                    }
                    const input = String(data.input ?? '').trim();
                    if (def.input?.required && !input) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: `"${def.name}" needs an input: ${def.input.label ?? 'input'}.` });
                        break;
                    }
                    const model = String(data.model || this._getScopedState<string>('continued_last_model') || 'llama3');
                    const mode = String(data.mode || this._getScopedState<string>('continued_last_mode') || 'agent');
                    try {
                        if (data.container) {
                            await this._runHarnessInContainer(def, input, model, mode, webviewView);
                            break;
                        }
                        await this._runHarness(def, input, model, mode, webviewView, { fromChat: true });
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'harnessError', message: (error as Error).message });
                        webviewView.webview.postMessage({ type: 'agentDone' });
                    }
                    break;
                }
                case 'harnessStop': {
                    this._harnessAbort?.abort();
                    this._drainApprovals();
                    break;
                }

                case 'cancelAgent': {
                    const hadRun = Boolean(this._agentAbort && !this._agentAbort.signal.aborted);
                    this._agentAbort?.abort();
                    this._harnessAbort?.abort();
                    this._drainApprovals();
                    this._pendingApproval = null;
                    this._agentIteration = 0;
                    this._lastActionKey = '';
                    if (hadRun) {
                        this._chatHistory.push({ role: 'assistant', content: '⛔ Agent cancelled by user.' });
                        this._persistSession(this._getScopedState<string>('continued_last_mode') || 'agent');
                    }
                    webviewView.webview.postMessage({ type: 'agentDone' });
                    break;
                }

                case 'executePlan': {
                    const plan = String(data.plan || '').trim();
                    if (!plan) { break; }
                    const model = String(data.model || this._getScopedState<string>('continued_last_model') || 'llama3');
                    await this._handleSendPrompt(
                        `Execute the following plan step by step. Read files before changing them and stop with a final-answer when every step is done.\n\n${plan}`,
                        model,
                        'agent',
                        data.currentFile || null,
                        [],
                        webviewView
                    );
                    break;
                }

                case 'steerAgent': {
                    const note = String(data.value || '').trim();
                    const runActive = !!this._agentAbort && !this._agentAbort.signal.aborted;
                    if (!note) { break; }
                    if (!runActive) {
                        webviewView.webview.postMessage({ type: 'assistantResponse', content: 'No agent run is in progress, so this note was not delivered. Send it as a normal message.' });
                        break;
                    }
                    this._chatHistory.push({ role: 'user', content: `${STEER_PREFIX} ${note}` });
                    this._persistSession(this._liveMode);
                    this._log.appendLine(`[${new Date().toISOString()}] user note during run: ${note.slice(0, 200).replace(/\s+/g, ' ')}`);
                    webviewView.webview.postMessage({ type: 'agentWorking', step: this._agentIteration, label: 'note received — the agent sees it at its next step…' });
                    break;
                }
                case 'sendPrompt': {
                    await this._handleSendPrompt(
                        String(data.value ?? ''),
                        String(data.model || 'llama3'),
                        String(data.mode || 'chat'),
                        data.currentFile ? String(data.currentFile) : null,
                        Array.isArray(data.attachedFiles) ? data.attachedFiles as AttachedFile[] : [],
                        webviewView
                    );
                    break;
                }
            }
        });
    }

    public async triggerModelRefresh() {
        if (!this._view) {return;}

        const models = await this._llm.listModels();

        this._view.webview.postMessage({ type: 'setModels', models });
    }
}
