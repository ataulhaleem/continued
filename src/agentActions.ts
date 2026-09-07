/**
 * Agent action protocol.
 *
 * The agent loop asks the model for exactly one JSON action per turn. This module
 * parses model output into a typed `AgentAction` (tolerating the many ways models
 * bend the format), formats actions for display, and encodes/decodes the internal
 * history markers used to persist actions and tool results in a session.
 *
 * This module is intentionally free of `vscode` imports so it can be unit-tested
 * with plain mocha.
 */

export type AgentAction =
    | { type: 'read-file'; path: string }
    | { type: 'write-file'; path: string; content: string }
    | { type: 'delete-file'; path: string }
    | { type: 'semantic-search'; query: string }
    | { type: 'grep-search'; query: string; filePattern: string }
    | { type: 'run-command'; command: string }
    | { type: 'use-tool'; tool: string; args: Record<string, unknown> }
    | { type: 'use-resource'; resource: string }
    | { type: 'use-skill'; skill: string; input?: string }
    | { type: 'final-answer'; message: string };

export type AgentActionType = AgentAction['type'];

/** History marker for an assistant turn that was a structured action. */
export const ACTION_MARKER = '[[AGENT_ACTION]]';
/** History marker for a tool result (kept for backwards compatibility with old sessions). */
export const RESULT_MARKER = '[[COMMAND_RESULT]]';

/** Actions that only observe the workspace and never change it. */
export const READ_ONLY_ACTIONS: ReadonlySet<AgentActionType> = new Set<AgentActionType>([
    'read-file', 'semantic-search', 'grep-search', 'use-resource', 'final-answer'
]);

export function isReadOnlyAction(action: AgentAction): boolean {
    return READ_ONLY_ACTIONS.has(action.type);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Remove <think>…</think> reasoning blocks (DeepSeek/Qwen style), including an unterminated one. */
export function stripThinking(text: string): string {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '');
}

/** Remove a leading/trailing markdown code fence without touching fences inside JSON strings. */
function stripOuterCodeFence(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
    return match ? match[1] : trimmed;
}

/**
 * Find the first balanced `{ … }` span starting at or after `from`, honouring string
 * literals and escape sequences so braces inside content strings do not confuse us.
 */
function findBalancedObject(text: string, from: number): { start: number; end: number } | null {
    const start = text.indexOf('{', from);
    if (start === -1) { return null; }

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (inString) {
            if (ch === '\\') { escape = true; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0) { return { start, end: i }; }
        }
    }
    return null;
}

/**
 * Lenient JSON parse: many local models emit raw newlines/tabs inside string values,
 * which strict JSON forbids. Escape control characters inside strings and retry.
 */
export function lenientJsonParse(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        // fall through to repair
    }

    let repaired = '';
    let inString = false;
    let escape = false;
    for (const ch of text) {
        if (escape) { repaired += ch; escape = false; continue; }
        if (inString) {
            if (ch === '\\') { repaired += ch; escape = true; continue; }
            if (ch === '"') { inString = false; repaired += ch; continue; }
            if (ch === '\n') { repaired += '\\n'; continue; }
            if (ch === '\r') { repaired += '\\r'; continue; }
            if (ch === '\t') { repaired += '\\t'; continue; }
            const code = ch.charCodeAt(0);
            if (code < 0x20) { repaired += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
            repaired += ch;
            continue;
        }
        if (ch === '"') { inString = true; }
        repaired += ch;
    }

    try {
        return JSON.parse(repaired);
    } catch {
        return null;
    }
}

const TYPE_ALIASES: Record<string, AgentActionType> = {
    'read-file': 'read-file', 'read_file': 'read-file', 'readfile': 'read-file', 'read': 'read-file', 'cat': 'read-file', 'open-file': 'read-file', 'view-file': 'read-file',
    'write-file': 'write-file', 'write_file': 'write-file', 'writefile': 'write-file', 'write': 'write-file', 'create-file': 'write-file', 'create_file': 'write-file', 'edit-file': 'write-file', 'edit_file': 'write-file', 'update-file': 'write-file', 'save-file': 'write-file',
    'delete-file': 'delete-file', 'delete_file': 'delete-file', 'deletefile': 'delete-file', 'delete': 'delete-file', 'remove-file': 'delete-file', 'remove_file': 'delete-file', 'rm': 'delete-file',
    'semantic-search': 'semantic-search', 'semantic_search': 'semantic-search', 'find-files': 'semantic-search', 'find_files': 'semantic-search', 'list-files': 'semantic-search', 'list_files': 'semantic-search', 'glob': 'semantic-search', 'search-files': 'semantic-search', 'search_files': 'semantic-search', 'find': 'semantic-search',
    'grep-search': 'grep-search', 'grep_search': 'grep-search', 'grep': 'grep-search', 'search-text': 'grep-search', 'search_text': 'grep-search', 'search': 'grep-search',
    'run-command': 'run-command', 'run_command': 'run-command', 'runcommand': 'run-command', 'run-shell': 'run-command', 'run_shell': 'run-command', 'shell': 'run-command', 'bash': 'run-command', 'exec': 'run-command', 'execute': 'run-command', 'execute-command': 'run-command', 'execute_command': 'run-command', 'terminal': 'run-command', 'command': 'run-command',
    'use-tool': 'use-tool', 'use_tool': 'use-tool', 'tool': 'use-tool', 'call-tool': 'use-tool', 'call_tool': 'use-tool', 'plugin': 'use-tool',
    'use-resource': 'use-resource', 'use_resource': 'use-resource', 'resource': 'use-resource', 'fetch-resource': 'use-resource', 'fetch_resource': 'use-resource',
    'use-skill': 'use-skill', 'use_skill': 'use-skill', 'skill': 'use-skill', 'run-skill': 'use-skill', 'run_skill': 'use-skill',
    'final-answer': 'final-answer', 'final_answer': 'final-answer', 'finalanswer': 'final-answer', 'final': 'final-answer', 'answer': 'final-answer', 'finish': 'final-answer', 'done': 'final-answer', 'complete': 'final-answer', 'respond': 'final-answer', 'reply': 'final-answer', 'message': 'final-answer',
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string' && value.length > 0) { return value; }
    }
    return undefined;
}

function firstObject(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) { return value as Record<string, unknown>; }
    }
    return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turn a parsed JSON object into a typed action if it looks like one.
 * Accepts the primary `{"action": "..."}` format plus common function-call-style
 * shapes (`{"name": ..., "arguments": {...}}`, `{"tool": ..., "parameters": {...}}`)
 * and the legacy formats used by earlier releases.
 */
export function normalizeAction(raw: unknown): AgentAction | null {
    if (!isPlainObject(raw)) { return null; }

    // Legacy format 2: {"cmd": ["read-file", "path", ...]}
    if (Array.isArray(raw.cmd) && typeof raw.cmd[0] === 'string') {
        const [name, a, b] = raw.cmd as unknown[];
        const type = TYPE_ALIASES[String(name).toLowerCase()];
        if (type === 'read-file' && typeof a === 'string') { return { type, path: a }; }
        if (type === 'write-file' && typeof a === 'string' && typeof b === 'string') { return { type, path: a, content: b }; }
        if (type === 'delete-file' && typeof a === 'string') { return { type, path: a }; }
        if (type === 'run-command' && typeof a === 'string') { return { type, command: a }; }
        return null;
    }

    const typeName = firstString(raw, ['action', 'type', 'tool', 'name', 'function', 'command', 'cmd', 'op', 'operation']);
    if (!typeName) { return null; }

    let type = TYPE_ALIASES[typeName.trim().toLowerCase()];
    // `{"command": "readFile", ...}` legacy — `command` may also be a real shell command when action is run-command.
    if (!type && typeof raw.action !== 'string' && typeof raw.command === 'string' && !raw.tool && !raw.name) {
        return null;
    }

    // Function-call style: the tool id is a plugin id we do not know about → treat as use-tool
    const nested = firstObject(raw, ['args', 'arguments', 'parameters', 'params', 'input', 'inputs', 'payload']);
    const fields: Record<string, unknown> = { ...(nested ?? {}), ...raw };
    // When arguments are nested, prefer nested values for the well-known fields.
    if (nested) {
        for (const key of Object.keys(nested)) { fields[key] = nested[key]; }
    }

    if (!type) {
        // Unknown action name: if it came from a tool/name field, assume a plugin tool id.
        if (typeof raw.action === 'string' && !raw.tool && !raw.name) {
            return { type: 'use-tool', tool: raw.action, args: nested ?? stripKnownKeys(raw) };
        }
        if (typeof raw.tool === 'string' || typeof raw.name === 'string') {
            return { type: 'use-tool', tool: String(raw.tool ?? raw.name), args: nested ?? stripKnownKeys(raw) };
        }
        return null;
    }

    const pathValue = firstString(fields, ['path', 'filePath', 'file_path', 'file', 'filename', 'fileName', 'target']);
    switch (type) {
        case 'read-file':
            return pathValue ? { type, path: pathValue } : null;
        case 'delete-file':
            return pathValue ? { type, path: pathValue } : null;
        case 'write-file': {
            const content = firstString(fields, ['content', 'contents', 'text', 'data', 'body', 'newContent', 'new_content']);
            if (!pathValue || content === undefined) {
                // Allow explicit empty file creation
                if (pathValue && typeof fields.content === 'string') { return { type, path: pathValue, content: '' }; }
                return null;
            }
            return { type, path: pathValue, content };
        }
        case 'semantic-search': {
            const query = firstString(fields, ['query', 'pattern', 'glob', 'search', 'q', 'path']);
            return query ? { type, query } : null;
        }
        case 'grep-search': {
            const query = firstString(fields, ['query', 'pattern', 'regex', 'search', 'text', 'q']);
            if (!query) { return null; }
            const filePattern = firstString(fields, ['filePattern', 'file_pattern', 'include', 'glob', 'files']) ?? '**/*';
            return { type, query, filePattern };
        }
        case 'run-command': {
            const command = typeof fields.command === 'string' && fields.command.toLowerCase() !== typeName.toLowerCase()
                ? fields.command
                : firstString(fields, ['cmd', 'shell', 'script', 'commandLine', 'command_line', 'input', 'value']);
            return command ? { type, command } : null;
        }
        case 'use-tool': {
            const tool = firstString(fields, ['tool', 'id', 'toolId', 'tool_id', 'pluginId', 'plugin', 'name']);
            if (!tool || TYPE_ALIASES[tool.toLowerCase()] === 'use-tool') { return null; }
            const args = nested ?? firstObject(raw, ['args']) ?? stripKnownKeys(raw);
            return { type, tool, args };
        }
        case 'use-resource': {
            const resource = firstString(fields, ['resource', 'id', 'resourceId', 'resource_id', 'pluginId', 'plugin', 'name']);
            if (!resource || TYPE_ALIASES[resource.toLowerCase()] === 'use-resource') { return null; }
            return { type, resource };
        }
        case 'use-skill': {
            const skill = firstString(fields, ['skill', 'id', 'skillId', 'skill_id', 'pluginId', 'plugin', 'name']);
            if (!skill || TYPE_ALIASES[skill.toLowerCase()] === 'use-skill') { return null; }
            const input = firstString(fields, ['input', 'prompt', 'task', 'query', 'text']);
            return input ? { type, skill, input } : { type, skill };
        }
        case 'final-answer': {
            const message = firstString(fields, ['message', 'answer', 'summary', 'text', 'content', 'response', 'result', 'value']) ?? '';
            return { type, message };
        }
    }
    return null;
}

function stripKnownKeys(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (['action', 'type', 'tool', 'name', 'function', 'op', 'operation'].includes(key)) { continue; }
        out[key] = value;
    }
    return out;
}

/** Extract the first JSON action from a model response, or null. */
export function extractJsonAction(response: string): AgentAction | null {
    const cleaned = stripThinking(response ?? '');
    const candidates = [cleaned, stripOuterCodeFence(cleaned)];

    for (const text of candidates) {
        let from = 0;
        let guard = 0;
        while (guard++ < 200) {
            const span = findBalancedObject(text, from);
            if (!span) { break; }
            const parsed = lenientJsonParse(text.slice(span.start, span.end + 1));
            const action = normalizeAction(parsed);
            if (action) { return action; }
            from = span.start + 1;
        }
    }
    return null;
}

/** Fallback for the XML/bracket tag formats used by older Continued releases. */
export function extractLegacyAction(response: string): AgentAction | null {
    const text = stripThinking(response ?? '');

    const write = text.match(/<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/i);
    if (write) { return { type: 'write-file', path: write[1].trim(), content: write[2].replace(/^\n/, '').replace(/\n$/, '') }; }

    const del = text.match(/<delete_file\s+path=["']([^"']+)["']\s*\/?>/i);
    if (del) { return { type: 'delete-file', path: del[1].trim() }; }

    const xmlShell = text.match(/<run_shell\s+command=["']([\s\S]*?)["']\s*\/?>/i);
    if (xmlShell?.[1]) { return { type: 'run-command', command: xmlShell[1].trim() }; }

    const bracketShell = text.match(/\[\[run_shell\s+command=["']([\s\S]*?)["']\s*\]\]/i);
    if (bracketShell?.[1]) { return { type: 'run-command', command: bracketShell[1].trim() }; }

    return null;
}

/** Parse a model response into an action using every supported format. */
export function parseAgentAction(response: string): AgentAction | null {
    return extractJsonAction(response) ?? extractLegacyAction(response);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Human-readable label shown in the chat while the agent works. */
export function formatActionDescription(action: AgentAction): string {
    switch (action.type) {
        case 'read-file':       return `🔍 **Reading** \`${action.path}\``;
        case 'write-file':      return `✏️ **Writing** \`${action.path}\` (${countLines(action.content)} lines)`;
        case 'delete-file':     return `🗑️ **Deleting** \`${action.path}\``;
        case 'semantic-search': return `🔎 **Finding files** matching \`${action.query}\``;
        case 'grep-search':     return `🔎 **Searching** for \`${action.query}\` in \`${action.filePattern}\``;
        case 'run-command':     return `⚙️ **Running command:** \`${action.command}\``;
        case 'use-tool':        return `🔌 **Using tool** \`${action.tool}\``;
        case 'use-resource':    return `📦 **Fetching resource** \`${action.resource}\``;
        case 'use-skill':       return `🧩 **Running skill** \`${action.skill}\``;
        case 'final-answer':    return action.message || 'Task completed.';
    }
}

/** Compact command-like label used for tool-result entries. */
export function actionCommandLabel(action: AgentAction): string {
    switch (action.type) {
        case 'read-file':       return `read-file ${action.path}`;
        case 'write-file':      return `write-file ${action.path}`;
        case 'delete-file':     return `delete-file ${action.path}`;
        case 'semantic-search': return `semantic-search ${action.query}`;
        case 'grep-search':     return `grep-search ${action.query} in ${action.filePattern}`;
        case 'run-command':     return action.command;
        case 'use-tool':        return `use-tool ${action.tool} ${safeStringify(action.args)}`;
        case 'use-resource':    return `use-resource ${action.resource}`;
        case 'use-skill':       return `use-skill ${action.skill}${action.input ? ` ${JSON.stringify(action.input)}` : ''}`;
        case 'final-answer':    return 'final-answer';
    }
}

function countLines(text: string): number {
    if (!text) { return 0; }
    return text.split('\n').length;
}

function safeStringify(value: unknown): string {
    try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

/** Strip tool tags / JSON blobs from a response so it can be displayed as prose. */
export function sanitizeAgentDisplayResponse(response: string): string {
    return stripThinking(response ?? '')
        .replace(/<write_file\s+path=["'][^"']+["']\s*>[\s\S]*?<\/write_file>/gi, '')
        .replace(/<delete_file\s+path=["'][^"']+["']\s*\/?>/gi, '')
        .replace(/<run_shell\s+command=["'][\s\S]*?["']\s*\/?>/gi, '')
        .replace(/\[\[run_shell\s+command=["'][\s\S]*?["']\s*\]\]/gi, '')
        .replace(/\[\[\/?COMMAND_RESULT\]\]/g, '')
        .replace(/\[\[AGENT_ACTION\]\]/g, '')
        .replace(/```[\s\S]*?\{[\s\S]*?"(action|command)"[\s\S]*?\}[\s\S]*?```/gi, '')
        .replace(/^\s*\{[\s\S]*?"(action|command)"[\s\S]*?\}\s*$/gm, '')
        .trim();
}

// ---------------------------------------------------------------------------
// History encoding
// ---------------------------------------------------------------------------

export function encodeAction(action: AgentAction): string {
    return `${ACTION_MARKER}${JSON.stringify(action)}`;
}

export function decodeAction(content: string): AgentAction | null {
    if (!content.startsWith(ACTION_MARKER)) { return null; }
    try {
        return normalizeAction(JSON.parse(content.slice(ACTION_MARKER.length)));
    } catch {
        return null;
    }
}

export interface ToolResultEntry {
    command: string;
    output: string;
}

export function encodeToolResult(command: string, output: string, maxChars = 12000): string {
    const text = output ?? '';
    const capped = text.length > maxChars
        ? `${text.slice(0, maxChars)}\n\n...[output truncated: ${text.length - maxChars} more characters]...`
        : text;
    return `${RESULT_MARKER}${JSON.stringify({ command, output: capped })}`;
}

export function decodeToolResult(content: string): ToolResultEntry | null {
    if (!content.startsWith(RESULT_MARKER)) { return null; }
    try {
        const payload = JSON.parse(content.slice(RESULT_MARKER.length)) as Partial<ToolResultEntry>;
        return { command: String(payload.command ?? ''), output: String(payload.output ?? '') };
    } catch {
        return null;
    }
}

/**
 * Legacy display-only labels that older releases pushed into history
 * ("🔍 **Reading** …", "✅ Done."). They must not be sent to the model.
 */
export function isLegacyUiLabel(content: string): boolean {
    return /^(🔍|✏️|🗑️|⚙️|🔎|🔌|📦|🧩)\s\*\*/u.test(content) || content.startsWith('✅') || content.startsWith('⛔');
}
