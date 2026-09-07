/**
 * Built-in Terminal and Command Tools
 * Provides safe command execution and file opening
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ITool } from '../types';

const execAsync = promisify(exec);

/**
 * Get the workspace root directory
 */
function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder is open');
    }
    return folders[0].uri.fsPath;
}

/**
 * Check if a command is safe to execute
 */
function isCommandSafe(command: string): boolean {
    const forbiddenCommands = [
        'rm -rf',
        'sudo',
        'mkfs',
        'dd',
        'shred',
        ':(){:|:&};:' // Forkbomb
    ];
    
    const cmd = command.toLowerCase();
    return !forbiddenCommands.some(forbidden => cmd.includes(forbidden));
}

/**
 * Run a command in the terminal
 */
export const runCommandTool: ITool = {
    id: 'run-command',
    name: 'Run Command',
    version: '1.0.0',
    author: 'Continued',
    description: 'Execute a shell command in the workspace directory',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'command', description: 'Shell command run in the workspace root', required: true }, { name: 'timeout', description: 'Milliseconds', default: '30000' }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.command || typeof args.command !== 'string') {
            throw new Error('Missing required argument: command (string)');
        }
        
        const command = args.command.trim();
        
        if (!isCommandSafe(command)) {
            throw new Error(`Command blocked for safety reasons: "${command}"`);
        }
        
        try {
            const workspaceRoot = getWorkspaceRoot();
            const timeout = args.timeout ? parseInt(args.timeout) : 30000; // 30s default
            
            const { stdout, stderr } = await execAsync(command, {
                cwd: workspaceRoot,
                timeout: timeout,
                maxBuffer: 1024 * 1024 // 1MB output limit
            });
            
            if (stderr) {
                return `Command executed with output:\n${stdout}\n\nStderr:\n${stderr}`;
            }
            
            return `Command executed successfully:\n${stdout}`;
        } catch (error) {
            const err = error as any;
            if (err.killed) {
                throw new Error(`Command timed out (max ${args.timeout || 30000}ms)`);
            }
            throw new Error(`Command execution failed: ${err.message}\n${err.stdout || ''}\n${err.stderr || ''}`);
        }
    }
};

/**
 * Open a file in the editor
 */
export const openFileTool: ITool = {
    id: 'open-file',
    name: 'Open File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Open a file in the VS Code editor at a specific line',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'filePath', description: 'Workspace-relative path', required: true }, { name: 'line', description: '1-based line to reveal' }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            throw new Error('Missing required argument: filePath (string)');
        }
        
        try {
            const workspaceRoot = getWorkspaceRoot();
            const filePath = require('path').resolve(workspaceRoot, args.filePath);
            
            // Validate path is within workspace
            const relative = require('path').relative(workspaceRoot, filePath);
            if (relative.startsWith('..')) {
                throw new Error(`Access denied: Path is outside workspace`);
            }
            
            const uri = vscode.Uri.file(filePath);
            const line = args.line ? parseInt(args.line) - 1 : 0; // Convert to 0-indexed
            
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            
            // Go to line if specified
            if (line >= 0 && line < doc.lineCount) {
                const range = new vscode.Range(line, 0, line, 0);
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
            
            return `File opened: ${args.filePath}${args.line ? ` at line ${args.line}` : ''}`;
        } catch (error) {
            throw new Error(`Failed to open file: ${(error as Error).message}`);
        }
    }
};
