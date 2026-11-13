/**
 * Example workspace plugin.
 *
 * Copy this file into `.continued/plugins/` in your workspace and edit it. The first time it
 * is seen you will be asked whether to load it, because loading runs this code with the same
 * access the extension has; you are asked again whenever the file changes.
 *
 * The loader requires plain CommonJS JavaScript:
 *
 *   - the file must end in `.js` or `.cjs` (a `.ts` file is skipped),
 *   - it must assign to `module.exports.tool`, `module.exports.resource` or
 *     `module.exports.skill` — one of each at most, per file,
 *   - it must not import from the extension's sources; those paths do not exist at runtime.
 *
 * Node's built-ins are available (`fs`, `path`, `child_process`, …). The `vscode` module is
 * not, so read and write files through `fs` with paths under the workspace.
 */

const fs = require('fs');
const path = require('path');

/**
 * A tool performs an action. The agent calls it with:
 *   {"action":"use-tool","tool":"count-loc","args":{"filePath":"src/index.ts"}}
 * and you can call it from chat with:
 *   /tool count-loc {"filePath":"src/index.ts"}
 */
module.exports.tool = {
    id: 'count-loc',
    name: 'Count Lines of Code',
    version: '1.0.0',
    author: 'Your Name',
    description: 'Count total, code, blank and comment lines in a workspace file. args: { filePath }',
    // Disabled until you tick it in the Plugin Manager, so nothing new runs unannounced.
    enabled: false,
    source: 'user',
    category: 'tool',

    // Declared arguments: shown in the harness builder and described to the agent.
    args: [
        { name: 'filePath', description: 'Workspace-relative path', required: true }
    ],

    // This tool only reads, so it never asks for approval. Remove this line if yours writes.
    readOnly: true,

    async execute(args) {
        const relative = String(args.filePath || '').trim();
        if (!relative) { throw new Error('count-loc needs a "filePath" argument.'); }

        // Always resolve against the workspace root and refuse anything outside it.
        const root = process.cwd();
        const absolute = path.resolve(root, relative);
        if (path.relative(root, absolute).startsWith('..')) {
            throw new Error(`Access denied: "${relative}" is outside the workspace.`);
        }

        const lines = fs.readFileSync(absolute, 'utf-8').split('\n');
        const blank = lines.filter(l => !l.trim()).length;
        const comment = lines.filter(l => /^\s*(\/\/|#|\*|\/\*)/.test(l)).length;

        return {
            file: relative,
            totalLines: lines.length,
            blankLines: blank,
            commentLines: comment,
            codeLines: lines.length - blank - comment
        };
    }
};

/**
 * A resource supplies context rather than performing an action. The agent fetches it with
 * {"action":"use-resource","resource":"team-standards"}, or `/resource team-standards` in chat.
 */
module.exports.resource = {
    id: 'team-standards',
    name: 'Team Standards',
    version: '1.0.0',
    author: 'Your Name',
    description: 'The conventions this group expects code to follow.',
    enabled: false,
    source: 'user',
    category: 'resource',

    async fetch() {
        return {
            codeStyle: 'TypeScript, ESLint, no default exports',
            review: 'Every change goes through a merge request',
            standards: [
                'Exported functions carry a doc comment saying why, not what.',
                'No `var`; prefer `const`.',
                'Errors are reported with enough context to act on.'
            ]
        };
    }
};
