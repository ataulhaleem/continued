/**
 * Built-in File Tools
 * Provides safe file read/write/delete operations with workspace boundary validation
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ITool } from '../types';

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
 * Validate that a file path is within the workspace
 */
function validateFilePath(filePath: string): string {
    const workspaceRoot = getWorkspaceRoot();
    const absolutePath = path.resolve(workspaceRoot, filePath);
    const relativePath = path.relative(workspaceRoot, absolutePath);
    
    // Prevent path traversal attacks
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Access denied: Path "${filePath}" is outside workspace boundaries`);
    }
    
    return absolutePath;
}

/**
 * Read a file from the workspace
 */
export const readFileTool: ITool = {
    id: 'read-file',
    name: 'Read File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Read the contents of a file from the workspace',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'filePath', description: 'Workspace-relative path', required: true }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            throw new Error('Missing required argument: filePath (string)');
        }
        
        try {
            const filePath = validateFilePath(args.filePath);
            
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${args.filePath}`);
            }
            
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                throw new Error(`Path is a directory, not a file: ${args.filePath}`);
            }
            
            // Limit file size to 1MB to prevent memory issues
            const MAX_FILE_SIZE = 1024 * 1024;
            if (stats.size > MAX_FILE_SIZE) {
                throw new Error(`File too large (>${MAX_FILE_SIZE / 1024 / 1024}MB): ${args.filePath}`);
            }
            
            const content = fs.readFileSync(filePath, 'utf-8');
            return content;
        } catch (error) {
            throw new Error(`Failed to read file: ${(error as Error).message}`);
        }
    }
};

/**
 * Write content to a file in the workspace
 */
export const writeFileTool: ITool = {
    id: 'write-file',
    name: 'Write File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Write or overwrite a file in the workspace',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'filePath', description: 'Workspace-relative path', required: true }, { name: 'content', description: 'Full file content', required: true, multiline: true }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            throw new Error('Missing required argument: filePath (string)');
        }
        if (typeof args.content !== 'string') {
            throw new Error('Missing required argument: content (string)');
        }
        
        try {
            const filePath = validateFilePath(args.filePath);
            
            // Create directory if it doesn't exist
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(filePath, args.content, 'utf-8');
            
            // Try to open the file in the editor
            try {
                const uri = vscode.Uri.file(filePath);
                await vscode.window.showTextDocument(uri);
            } catch {
                // Silently ignore if we can't open in editor
            }
            
            return `File written successfully: ${args.filePath}`;
        } catch (error) {
            throw new Error(`Failed to write file: ${(error as Error).message}`);
        }
    }
};

/**
 * Delete a file from the workspace
 */
export const deleteFileTool: ITool = {
    id: 'delete-file',
    name: 'Delete File',
    version: '1.0.0',
    author: 'Continued',
    description: 'Delete a file from the workspace',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'filePath', description: 'Workspace-relative path', required: true }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.filePath || typeof args.filePath !== 'string') {
            throw new Error('Missing required argument: filePath (string)');
        }
        
        try {
            const filePath = validateFilePath(args.filePath);
            
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${args.filePath}`);
            }
            
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                throw new Error(`Path is a directory, not a file: ${args.filePath}`);
            }
            
            fs.unlinkSync(filePath);
            return `File deleted successfully: ${args.filePath}`;
        } catch (error) {
            throw new Error(`Failed to delete file: ${(error as Error).message}`);
        }
    }
};
