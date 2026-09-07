/**
 * Built-in Search Tools and Resources
 * Provides workspace search capabilities
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ITool, IResource } from '../types';

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
 * Validate that a glob pattern is safe
 */
function validateGlobPattern(pattern: string): void {
    // Block attempts to escape workspace
    if (pattern.includes('..') || pattern.startsWith('/')) {
        throw new Error('Unsafe glob pattern: cannot use ".." or absolute paths');
    }
}

/**
 * Search files using VS Code workspace find API
 */
export const semanticSearchTool: ITool = {
    id: 'semantic-search',
    name: 'Semantic Search',
    version: '1.0.0',
    author: 'Continued',
    description: 'Search for files by name or pattern in the workspace',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'pattern', description: 'Glob such as src/**/*.ts', required: true }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.pattern || typeof args.pattern !== 'string') {
            throw new Error('Missing required argument: pattern (string, e.g., "*.ts" or "src/**/*.test.ts")');
        }
        
        try {
            validateGlobPattern(args.pattern);
            const files = await vscode.workspace.findFiles(args.pattern, null, 100);
            
            if (files.length === 0) {
                return `No files found matching pattern: ${args.pattern}`;
            }
            
            const workspaceRoot = getWorkspaceRoot();
            const results = files.map(f => {
                const relative = path.relative(workspaceRoot, f.fsPath);
                return relative;
            }).sort();
            
            return `Found ${results.length} files:\n${results.join('\n')}`;
        } catch (error) {
            throw new Error(`Semantic search failed: ${(error as Error).message}`);
        }
    }
};

/**
 * Search for text content within files using grep-like functionality
 */
export const grepSearchTool: ITool = {
    id: 'grep-search',
    name: 'Grep Search',
    version: '1.0.0',
    author: 'Continued',
    description: 'Search for text content within files in the workspace',
    enabled: true,
    source: 'built-in',
    category: 'tool',
    args: [{ name: 'query', description: 'Regex or text to find', required: true }, { name: 'filePattern', description: 'Glob to search in', default: '**/*' }, { name: 'caseSensitive', description: 'true/false', default: 'true' }],
    
    async execute(args: Record<string, any>): Promise<string> {
        if (!args.query || typeof args.query !== 'string') {
            throw new Error('Missing required argument: query (string)');
        }
        
        const pattern = (typeof args.filePattern === 'string' && args.filePattern.trim()) ? args.filePattern.trim() : '**/*';
        const caseSensitive = args.caseSensitive !== false;
        
        try {
            validateGlobPattern(pattern);
            
            // Use workspace.findFiles to get files
            const files = await vscode.workspace.findFiles(pattern, null, 200);
            
            const workspaceRoot = getWorkspaceRoot();
            const results: string[] = [];
            const regex = new RegExp(args.query, caseSensitive ? 'g' : 'gi');
            let matchCount = 0;
            
            for (const file of files) {
                try {
                    const content = fs.readFileSync(file.fsPath, 'utf-8');
                    const lines = content.split('\n');
                    
                    lines.forEach((line, lineNum) => {
                        if (regex.test(line)) {
                            const relative = path.relative(workspaceRoot, file.fsPath);
                            results.push(`${relative}:${lineNum + 1}: ${line.trim()}`);
                            matchCount++;
                            regex.lastIndex = 0; // Reset regex state
                        }
                    });
                } catch {
                    // Skip files that can't be read
                }
            }
            
            if (matchCount === 0) {
                return `No matches found for: ${args.query}`;
            }
            
            return `Found ${matchCount} matches:\n${results.slice(0, 50).join('\n')}${results.length > 50 ? '\n... (showing first 50)' : ''}`;
        } catch (error) {
            throw new Error(`Grep search failed: ${(error as Error).message}`);
        }
    }
};

/**
 * Get a list of all files in the workspace
 */
export const workspaceFilesResource: IResource = {
    id: 'workspace-files',
    name: 'Workspace Files',
    version: '1.0.0',
    author: 'Continued',
    description: 'Get a list of all files in the workspace',
    enabled: true,
    source: 'built-in',
    category: 'resource',
    
    async fetch(): Promise<string> {
        try {
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
            
            if (files.length === 0) {
                return 'Workspace is empty or no files found';
            }
            
            const workspaceRoot = getWorkspaceRoot();
            const fileList = files
                .map(f => {
                    const relative = path.relative(workspaceRoot, f.fsPath);
                    const stat = fs.statSync(f.fsPath);
                    const isDir = stat.isDirectory();
                    return {
                        path: relative,
                        isDirectory: isDir,
                        size: stat.size,
                        modified: stat.mtime.toISOString()
                    };
                })
                .sort((a, b) => a.path.localeCompare(b.path));
            
            const summary = {
                totalFiles: fileList.length,
                directories: fileList.filter(f => f.isDirectory).length,
                files: fileList.filter(f => !f.isDirectory).length,
                totalSize: fileList.reduce((sum, f) => sum + f.size, 0),
                structure: fileList.slice(0, 100) // First 100 entries
            };
            
            return JSON.stringify(summary, null, 2);
        } catch (error) {
            throw new Error(`Failed to fetch workspace files: ${(error as Error).message}`);
        }
    }
};