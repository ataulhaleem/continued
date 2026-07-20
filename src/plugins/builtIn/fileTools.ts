/**
 * Built-in File Tools Plugin
 * Provides read_file, write_file, delete_file operations
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ITool } from '../types';

/**
 * Read a file from the workspace.
 */
export const readFileTool: ITool = {
  id: 'read_file',
  name: 'Read File',
  version: '1.0.0',
  author: 'Continued',
  description: 'Read the contents of a file in the workspace',
  enabled: true,
  source: 'built-in',
  async execute(args: { path: string }) {
    if (!args.path) {
      throw new Error('read_file requires "path" argument');
    }
    try {
      const uri = vscode.Uri.file(args.path);
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(data);
    } catch (e) {
      throw new Error(`Failed to read file: ${args.path} - ${(e as Error).message}`);
    }
  },
};

/**
 * Write content to a file (creates if not exists, overwrites if exists).
 */
export const writeFileTool: ITool = {
  id: 'write_file',
  name: 'Write File',
  version: '1.0.0',
  author: 'Continued',
  description: 'Write or create a file in the workspace',
  enabled: true,
  source: 'built-in',
  async execute(args: { path: string; content: string }) {
    if (!args.path || args.content === undefined) {
      throw new Error('write_file requires "path" and "content" arguments');
    }
    try {
      const uri = vscode.Uri.file(args.path);
      // Ensure parent directory exists
      const dir = path.dirname(args.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = new TextEncoder().encode(args.content);
      await vscode.workspace.fs.writeFile(uri, data);
      return { success: true, path: args.path };
    } catch (e) {
      throw new Error(`Failed to write file: ${args.path} - ${(e as Error).message}`);
    }
  },
};

/**
 * Delete a file from the workspace.
 */
export const deleteFileTool: ITool = {
  id: 'delete_file',
  name: 'Delete File',
  version: '1.0.0',
  author: 'Continued',
  description: 'Delete a file from the workspace',
  enabled: true,
  source: 'built-in',
  async execute(args: { path: string }) {
    if (!args.path) {
      throw new Error('delete_file requires "path" argument');
    }
    try {
      const uri = vscode.Uri.file(args.path);
      await vscode.workspace.fs.delete(uri);
      return { success: true, deleted: args.path };
    } catch (e) {
      throw new Error(`Failed to delete file: ${args.path} - ${(e as Error).message}`);
    }
  },
};
