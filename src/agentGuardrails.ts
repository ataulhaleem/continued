/**
 * AgentGuardrails: safety constraints and execution limits for Agent Mode.
 *
 * Free of `vscode` imports so it can be unit-tested with plain mocha.
 */

import * as path from 'path';

export interface GuardrailOptions {
    /** Maximum model/tool iterations in one agent run. */
    maxIterations?: number;
    /** Maximum retries for a single failing operation. */
    maxRetries?: number;
    /** Shell command timeout in milliseconds. */
    commandTimeoutMs?: number;
}

export interface SafetyVerdict {
    safe: boolean;
    reason?: string;
}

export class AgentGuardrails {
    /** Commands that are never executed, whatever the mode. Each pattern is tested per pipeline segment. */
    private readonly FORBIDDEN_COMMANDS: RegExp[] = [
        /^rm\s+(-[a-z]*r[a-z]*f?[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive)\s+(--\s+)?(\/|\/\*|~|~\/|\$HOME|\$HOME\/|\*|\.\.)\s*$/i, // rm -rf / ~ * ..
        /^rm\s+(-[a-z]*r[a-z]*f?[a-z]*)\s+\/[a-z]+\s*$/i,   // rm -rf /usr, /etc, ...
        /^sudo(\s|$)/,
        /^su(\s|$)/,
        /^doas(\s|$)/,
        /^kill\s+-9\s+(1|-1)\s*$/,
        /^(shutdown|reboot|halt|poweroff|init\s+[06])(\s|$)/,
        /^mkfs(\.|\s|$)/,
        /^dd\s+/,
        /^fdisk(\s|$)/,
        /^parted(\s|$)/,
        /(^|\s)>\s*\/dev\/(sd|nvme|hd|mmcblk)/,   // writing to block devices
        /^format\s+[a-z]:/i,
        /^:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,     // fork bomb
        /^chmod\s+(-[a-z]+\s+)?[0-7]*777\s+\/\s*$/,
        /^chown\s+(-[a-z]+\s+)?\S+\s+\/\s*$/,
        /^history\s+-c/,
    ];

    /** Patterns that span a pipeline, tested against the whole command line. */
    private readonly FORBIDDEN_PIPELINES: RegExp[] = [
        /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,   // curl … | sh
        /\|\s*(sudo|su)\b/,                                       // … | sudo
        /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,               // fork bomb
    ];

    /** Commands that must be confirmed by the user even in Agent Auto-Edit mode. */
    private readonly CAUTION_COMMANDS: RegExp[] = [
        /^rm\s+(-[a-z]*r|--recursive)/i,
        /^rm\s+-[a-z]*f/i,
        /^rmdir(\s|$)/,
        /^chmod(\s|$)/,
        /^chown(\s|$)/,
        /^find\b.*(-delete|-exec\s+rm)/,
        /^xargs\b.*\b(rm|rmdir|mv|chmod|chown)\b/,
        /^sed\b.*\s-i/,
        /^git\s+(push|reset\s+--hard|clean|checkout\s+--\s|branch\s+-D|rebase|filter-branch|stash\s+drop)/,
        /^(npm|pnpm|yarn)\s+(publish|unpublish)/,
        /^(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall)\b.*(-g|--global)/,
        /^pip\d?\s+(install|uninstall)/,
        /^(docker|podman)\s+(rm|rmi|system\s+prune|volume\s+rm)/,
        /^(kill|pkill|killall)(\s|$)/,
        /^nc\s+-l/,
        /^(curl|wget)\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)/i,
        /^ssh(\s|$)/,
        /^scp(\s|$)/,
        /^rsync\b.*--delete/,
        /^mv\s+\S+\s+\/\S*/,
        /\b(truncate|shred)\b/,
        /(^|\s)>\s*\S/,   // any redirect that overwrites a file
    ];

    /** Path fragments the agent may never read or write. */
    private readonly FORBIDDEN_PATHS = [
        '/etc/passwd',
        '/etc/shadow',
        '/etc/sudoers',
        '/root/',
        '/.ssh/',
        '/.gnupg/',
        '/.aws/credentials',
        '/var/log/auth',
        '/proc/',
        '/sys/',
        '/dev/',
    ];

    readonly MAX_RETRIES: number;
    readonly MAX_ITERATIONS: number;
    readonly COMMAND_TIMEOUT: number;

    constructor(options: GuardrailOptions = {}) {
        this.MAX_ITERATIONS = Math.max(1, options.maxIterations ?? 20);
        this.MAX_RETRIES = Math.max(1, options.maxRetries ?? 3);
        this.COMMAND_TIMEOUT = Math.max(1000, options.commandTimeoutMs ?? 60000);
    }

    /** Split a shell line into the individual commands of a pipeline / list. */
    private splitSegments(command: string): string[] {
        return command
            .replace(/\r/g, '')
            .split(/\n|;|&&|\|\||\|/)
            .map(s => s.trim().replace(/^\(+/, '').replace(/^\$\(/, ''))
            .filter(Boolean);
    }

    /** Validate whether a shell command may be executed at all. */
    isSafeCommand(command: string): SafetyVerdict {
        const trimmed = (command ?? '').trim();
        if (!trimmed) { return { safe: false, reason: 'Empty command.' }; }

        for (const pattern of this.FORBIDDEN_PIPELINES) {
            if (pattern.test(trimmed)) {
                return { safe: false, reason: `Command is forbidden for safety reasons: "${trimmed.substring(0, 80)}"` };
            }
        }

        for (const segment of this.splitSegments(trimmed)) {
            // Also strip environment assignments, e.g. `FOO=1 sudo …`
            const stripped = segment.replace(/^(\w+=\S*\s+)+/, '');
            for (const pattern of this.FORBIDDEN_COMMANDS) {
                if (pattern.test(stripped) || pattern.test(segment)) {
                    return {
                        safe: false,
                        reason: `Command is forbidden for safety reasons: "${segment.substring(0, 80)}"`
                    };
                }
            }
        }
        return { safe: true };
    }

    /** Validate whether a file path may be accessed. Paths are resolved relative to the workspace root. */
    isSafeFilePath(filePath: string, workspaceRoot: string): SafetyVerdict {
        const raw = String(filePath ?? '').trim();
        if (!raw) { return { safe: false, reason: 'Empty file path.' }; }

        const normalized = raw.replace(/\\/g, '/');
        const lower = normalized.toLowerCase();
        for (const forbidden of this.FORBIDDEN_PATHS) {
            if (lower.includes(forbidden.toLowerCase()) || lower.startsWith(forbidden.replace(/^\//, '').toLowerCase())) {
                return { safe: false, reason: `Access to this path is restricted: ${forbidden}` };
            }
        }

        const root = path.resolve(workspaceRoot || '.');
        const absolute = path.resolve(root, normalized);
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { safe: false, reason: `Path is outside the workspace: ${raw}` };
        }

        return { safe: true };
    }

    /** Risk level for a command: 'high' commands need explicit confirmation even in auto mode. */
    getCommandRiskLevel(command: string): 'low' | 'medium' | 'high' {
        for (const segment of this.splitSegments((command ?? '').trim())) {
            for (const pattern of this.CAUTION_COMMANDS) {
                if (pattern.test(segment)) { return 'high'; }
            }
        }
        return 'low';
    }

    /** Whether a command should require explicit approval even in Agent Auto-Edit mode. */
    requiresExplicitApproval(command: string): boolean {
        return this.getCommandRiskLevel(command) === 'high';
    }

    /** Guard against runaway loops. */
    canExecuteOperation(operationCount: number): { allowed: boolean; reason?: string } {
        if (operationCount > this.MAX_ITERATIONS) {
            return {
                allowed: false,
                reason: `Maximum iterations (${this.MAX_ITERATIONS}) reached. The agent stopped to avoid runaway execution.`
            };
        }
        return { allowed: true };
    }

    /** Guard against retrying the same failing operation forever. */
    canRetry(retryCount: number): { allowed: boolean; reason?: string } {
        if (retryCount >= this.MAX_RETRIES) {
            return { allowed: false, reason: `Maximum retries (${this.MAX_RETRIES}) reached. Operation abandoned.` };
        }
        return { allowed: true };
    }

    /** Mask obvious secrets before output is shown or sent back to the model. */
    sanitizeCommandOutput(output: string): string {
        return (output ?? '')
            .replace(/(password|passwd|pwd)(\s*[=:]\s*)\S+/gi, '$1$2***')
            .replace(/(token|access_token|refresh_token)(\s*[=:]\s*)\S+/gi, '$1$2***')
            .replace(/(api[_-]?key|secret[_-]?key|secret)(\s*[=:]\s*)\S+/gi, '$1$2***')
            .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1***')
            .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
            .replace(/\b(ghp_[A-Za-z0-9]{10,})/g, 'ghp_***')
            .replace(/\b(AKIA[0-9A-Z]{12,})/g, 'AKIA***');
    }
}
