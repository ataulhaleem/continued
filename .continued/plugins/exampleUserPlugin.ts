/**
 * Example User Plugin Template
 * 
 * Place this file in: .continued/plugins/myCustomTool.ts
 * 
 * This example shows how to create custom tools that hook into the Continued agent.
 */

import { ITool, IResource } from '../../src/plugins/types';

/**
 * Example: Custom Tool for counting lines of code
 */
export const countLinesOfCodeTool: ITool = {
  id: 'count_loc',
  name: 'Count Lines of Code',
  version: '1.0.0',
  author: 'Your Name',
  description: 'Count lines of code in a file (excluding blanks and comments)',
  enabled: false, // Users can enable via checkbox
  source: 'user',
  
  async execute(args: { path: string }) {
    if (!args.path) {
      throw new Error('count_loc requires "path" argument');
    }
    
    // Simulate reading and processing
    // In a real plugin, you'd use vscode.workspace.fs.readFile()
    return {
      success: true,
      file: args.path,
      totalLines: 150,
      codeLines: 120,
      blankLines: 20,
      commentLines: 10,
    };
  },
};

/**
 * Example: Custom Resource for team info
 */
export const teamInfoResource: IResource = {
  id: 'team_info',
  name: 'Team Information',
  version: '1.0.0',
  author: 'Your Name',
  description: 'Provides context about the team and code standards',
  enabled: false,
  source: 'user',
  
  async fetch() {
    return {
      teamName: 'Your Team',
      codeStyle: 'TypeScript with ESLint',
      reviewProcess: 'GitHub Pull Requests',
      standards: [
        'Functions must have JSDoc comments',
        'No var, use const/let',
        'Async/await preferred over callbacks',
      ],
    };
  },
};

/**
 * EXAMPLE: Complex Tool with Error Handling
 * 
 * export const customAnalyzerTool: ITool = {
 *   id: 'custom_analyzer',
 *   name: 'Custom Code Analyzer',
 *   version: '1.0.0',
 *   enabled: false,
 *   source: 'user',
 *   
 *   async execute(args: { path: string; ruleset?: string }) {
 *     try {
 *       // Your custom analysis logic here
 *       return {
 *         success: true,
 *         issues: [...],
 *         recommendations: [...],
 *       };
 *     } catch (e) {
 *       throw new Error(`Analysis failed: ${(e as Error).message}`);
 *     }
 *   },
 * };
 */
