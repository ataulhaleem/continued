/**
 * Built-in Terminal Tool Plugin
 * Provides run_command operation
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ITool } from '../types';

const execAsync = promisify(exec);

/**
 * Run a shell command in the integrated terminal.
 */
export const runCommandTool: ITool = {
  id: 'run_command',
  name: 'Run Command',
  version: '1.0.0',
  author: 'Continued',
  description: 'Execute a shell command in the terminal',
  enabled: true,
  source: 'built-in',
  async execute(args: { command: string; cwd?: string; timeout?: number }) {
    if (!args.command) {
      throw new Error('run_command requires "command" argument');
    }

    const timeout = args.timeout || 120000; // 120 seconds default
    const cwd = args.cwd || process.cwd();

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB max buffer
      });

      return {
        success: true,
        command: args.command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      };
    } catch (e: any) {
      return {
        success: false,
        command: args.command,
        stdout: e.stdout?.trim() || '',
        stderr: e.stderr?.trim() || e.message,
        exitCode: e.code || 1,
      };
    }
  },
};

/**
 * Open a file in the editor.
 */
export const openFileTool: ITool = {
  id: 'open_file',
  name: 'Open File',
  version: '1.0.0',
  author: 'Continued',
  description: 'Open a file in the VS Code editor',
  enabled: true,
  source: 'built-in',
  async execute(args: { path: string; line?: number; column?: number }) {
    if (!args.path) {
      throw new Error('open_file requires "path" argument');
    }

    try {
      const uri = vscode.Uri.file(args.path);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // Navigate to line/column if specified
      if (args.line || args.column) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const line = Math.max(0, (args.line || 1) - 1);
          const column = Math.max(0, (args.column || 1) - 1);
          editor.selection = new vscode.Selection(
            new vscode.Position(line, column),
            new vscode.Position(line, column)
          );
          editor.revealRange(
            new vscode.Range(
              new vscode.Position(line, 0),
              new vscode.Position(line + 10, 0)
            )
          );
        }
      }

      return { success: true, opened: args.path };
    } catch (e) {
      throw new Error(`Failed to open file: ${args.path} - ${(e as Error).message}`);
    }
  },
};
