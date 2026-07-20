/**
 * Built-in Search Tools Plugin
 * Provides semantic_search and grep_search operations
 */

import * as vscode from 'vscode';
import { ITool, IResource } from '../types';

/**
 * Semantic search: Query LLM to search codebase by meaning.
 */
export const semanticSearchTool: ITool = {
  id: 'semantic_search',
  name: 'Semantic Search',
  version: '1.0.0',
  author: 'Continued',
  description: 'Search codebase by meaning/intent using AI',
  enabled: true,
  source: 'built-in',
  async execute(args: { query: string }) {
    if (!args.query) {
      throw new Error('semantic_search requires "query" argument');
    }
    // This is handled by the agent itself via the model
    // The tool just validates and returns instructions
    return {
      instruction: `Use the model to search for: "${args.query}"`,
      query: args.query,
    };
  },
};

/**
 * Grep search: Fast keyword/regex search in workspace files.
 */
export const grepSearchTool: ITool = {
  id: 'grep_search',
  name: 'Grep Search',
  version: '1.0.0',
  author: 'Continued',
  description: 'Fast keyword/regex search in workspace files',
  enabled: true,
  source: 'built-in',
  async execute(args: { query: string; includePattern?: string }) {
    if (!args.query) {
      throw new Error('grep_search requires "query" argument');
    }

    const pattern = args.includePattern || '**/*.{ts,js,tsx,jsx,py,java,go,rb,rs}';
    try {
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);
      const results: any[] = [];

      const regex = new RegExp(args.query, 'gi');
      for (const file of files) {
        try {
          const data = await vscode.workspace.fs.readFile(file);
          const content = new TextDecoder().decode(data);
          let match;
          while ((match = regex.exec(content)) !== null) {
            results.push({
              file: file.fsPath,
              line: content.substring(0, match.index).split('\n').length,
              match: match[0],
            });
            if (results.length >= 50) { break; } // Limit results
          }
        } catch (e) {
          // Skip unreadable files
        }
      }

      return { query: args.query, matches: results.length, results };
    } catch (e) {
      throw new Error(`Grep search failed: ${(e as Error).message}`);
    }
  },
};

/**
 * Workspace Files Resource: List all files in the workspace.
 */
export const workspaceFilesResource: IResource = {
  id: 'workspace_files',
  name: 'Workspace Files',
  version: '1.0.0',
  author: 'Continued',
  description: 'List of all accessible files in the workspace',
  enabled: true,
  source: 'built-in',
  async fetch() {
    try {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
      return {
        totalFiles: files.length,
        files: files.map(f => f.fsPath),
      };
    } catch (e) {
      throw new Error(`Failed to fetch workspace files: ${(e as Error).message}`);
    }
  },
};
