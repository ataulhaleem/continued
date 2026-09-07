import * as assert from 'assert';
import {
    ACTION_MARKER,
    RESULT_MARKER,
    actionCommandLabel,
    decodeAction,
    decodeToolResult,
    encodeAction,
    encodeToolResult,
    extractJsonAction,
    extractLegacyAction,
    formatActionDescription,
    isLegacyUiLabel,
    isReadOnlyAction,
    lenientJsonParse,
    parseAgentAction,
    sanitizeAgentDisplayResponse
} from '../agentActions';

suite('agentActions — JSON parsing', () => {
    test('parses the primary action format', () => {
        assert.deepStrictEqual(parseAgentAction('{"action":"read-file","path":"src/a.ts"}'), { type: 'read-file', path: 'src/a.ts' });
        assert.deepStrictEqual(parseAgentAction('{"action":"final-answer","message":"done"}'), { type: 'final-answer', message: 'done' });
        assert.deepStrictEqual(
            parseAgentAction('{"action":"grep-search","query":"TODO","filePattern":"**/*.ts"}'),
            { type: 'grep-search', query: 'TODO', filePattern: '**/*.ts' }
        );
        assert.deepStrictEqual(parseAgentAction('{"action":"run-command","command":"npm test"}'), { type: 'run-command', command: 'npm test' });
    });

    test('defaults grep filePattern and accepts field aliases', () => {
        assert.deepStrictEqual(parseAgentAction('{"action":"grep-search","query":"x"}'), { type: 'grep-search', query: 'x', filePattern: '**/*' });
        assert.deepStrictEqual(parseAgentAction('{"action":"read_file","filePath":"a.txt"}'), { type: 'read-file', path: 'a.txt' });
        assert.deepStrictEqual(parseAgentAction('{"action":"readFile","file":"a.txt"}'), { type: 'read-file', path: 'a.txt' });
    });

    test('tolerates prose and markdown fences around the JSON', () => {
        const response = 'Sure, I will read the file first.\n```json\n{"action":"read-file","path":"README.md"}\n```\nLet me know.';
        assert.deepStrictEqual(parseAgentAction(response), { type: 'read-file', path: 'README.md' });
    });

    test('strips <think> blocks before parsing', () => {
        const response = '<think>{"action":"delete-file","path":"nope"} hmm</think>{"action":"read-file","path":"a"}';
        assert.deepStrictEqual(parseAgentAction(response), { type: 'read-file', path: 'a' });
    });

    test('keeps code fences that live inside a write-file content string', () => {
        const content = '# Title\n\n```js\nconsole.log(1);\n```\n';
        const response = JSON.stringify({ action: 'write-file', path: 'README.md', content });
        const action = parseAgentAction(response);
        assert.ok(action && action.type === 'write-file');
        assert.strictEqual(action.content, content);
    });

    test('handles braces and escaped quotes inside content', () => {
        const content = 'function f() { return { a: "}" }; }';
        const response = JSON.stringify({ action: 'write-file', path: 'f.js', content });
        const action = parseAgentAction(response);
        assert.ok(action && action.type === 'write-file');
        assert.strictEqual(action.content, content);
    });

    test('repairs raw newlines inside JSON strings (lenient parse)', () => {
        const response = '{"action":"write-file","path":"a.txt","content":"line one\nline two"}';
        const action = parseAgentAction(response);
        assert.ok(action && action.type === 'write-file');
        assert.strictEqual(action.content, 'line one\nline two');
        assert.strictEqual(lenientJsonParse('{"a":"x\ty"}') && (lenientJsonParse('{"a":"x\ty"}') as { a: string }).a, 'x\ty');
        assert.strictEqual(lenientJsonParse('not json'), null);
    });

    test('accepts function-call style shapes and maps unknown names to use-tool', () => {
        assert.deepStrictEqual(
            parseAgentAction('{"name":"read-file","arguments":{"path":"a.ts"}}'),
            { type: 'read-file', path: 'a.ts' }
        );
        assert.deepStrictEqual(
            parseAgentAction('{"action":"use-tool","tool":"list-files-tool","args":{"dir":"."}}'),
            { type: 'use-tool', tool: 'list-files-tool', args: { dir: '.' } }
        );
        assert.deepStrictEqual(
            parseAgentAction('{"tool":"count-loc-tool","parameters":{"path":"x"}}'),
            { type: 'use-tool', tool: 'count-loc-tool', args: { path: 'x' } }
        );
        assert.deepStrictEqual(parseAgentAction('{"action":"use-resource","resource":"workspace-files"}'), { type: 'use-resource', resource: 'workspace-files' });
        assert.deepStrictEqual(parseAgentAction('{"action":"use-skill","skill":"review-skill"}'), { type: 'use-skill', skill: 'review-skill' });
    });

    test('supports the legacy JSON formats from earlier releases', () => {
        assert.deepStrictEqual(parseAgentAction('{"command":"readFile","path":"a"}'), { type: 'read-file', path: 'a' });
        assert.deepStrictEqual(parseAgentAction('{"command":"writeFile","path":"a","content":"x"}'), { type: 'write-file', path: 'a', content: 'x' });
        assert.deepStrictEqual(parseAgentAction('{"cmd":["run-shell","ls -la"]}'), { type: 'run-command', command: 'ls -la' });
        assert.deepStrictEqual(parseAgentAction('{"cmd":["write-file","a","b"]}'), { type: 'write-file', path: 'a', content: 'b' });
    });

    test('returns null for prose or unrelated JSON', () => {
        assert.strictEqual(parseAgentAction('I think we should look at the file.'), null);
        assert.strictEqual(parseAgentAction('{"foo":"bar"}'), null);
        assert.strictEqual(parseAgentAction('{"command":"npm test"}'), null);
        assert.strictEqual(parseAgentAction(''), null);
    });

    test('allows an explicitly empty file', () => {
        assert.deepStrictEqual(parseAgentAction('{"action":"write-file","path":"empty.txt","content":""}'), { type: 'write-file', path: 'empty.txt', content: '' });
    });
});

suite('agentActions — legacy XML tags', () => {
    test('parses write/delete/run_shell tags', () => {
        assert.deepStrictEqual(extractLegacyAction('<write_file path="a.txt">\nhello\n</write_file>'), { type: 'write-file', path: 'a.txt', content: 'hello' });
        assert.deepStrictEqual(extractLegacyAction('<delete_file path="a.txt"/>'), { type: 'delete-file', path: 'a.txt' });
        assert.deepStrictEqual(extractLegacyAction('<run_shell command="ls -la"/>'), { type: 'run-command', command: 'ls -la' });
        assert.deepStrictEqual(extractLegacyAction('[[run_shell command="pwd"]]'), { type: 'run-command', command: 'pwd' });
        assert.strictEqual(extractLegacyAction('nothing here'), null);
    });

    test('parseAgentAction prefers JSON and falls back to tags', () => {
        assert.deepStrictEqual(parseAgentAction('<run_shell command="pwd"/>'), { type: 'run-command', command: 'pwd' });
        assert.strictEqual(extractJsonAction('<run_shell command="pwd"/>'), null);
    });
});

suite('agentActions — display and history encoding', () => {
    test('round-trips actions through the history marker', () => {
        const action = { type: 'write-file' as const, path: 'a.ts', content: 'x\ny' };
        const encoded = encodeAction(action);
        assert.ok(encoded.startsWith(ACTION_MARKER));
        assert.deepStrictEqual(decodeAction(encoded), action);
        assert.strictEqual(decodeAction('plain text'), null);
    });

    test('round-trips tool results and caps long output', () => {
        const encoded = encodeToolResult('read-file a', 'x'.repeat(50), 10);
        assert.ok(encoded.startsWith(RESULT_MARKER));
        const decoded = decodeToolResult(encoded);
        assert.ok(decoded);
        assert.strictEqual(decoded.command, 'read-file a');
        assert.ok(decoded.output.startsWith('xxxxxxxxxx'));
        assert.ok(decoded.output.includes('output truncated'));
        assert.strictEqual(decodeToolResult('nope'), null);
    });

    test('formats labels for every action type', () => {
        assert.ok(formatActionDescription({ type: 'read-file', path: 'a' }).includes('a'));
        assert.ok(formatActionDescription({ type: 'write-file', path: 'a', content: 'l1\nl2' }).includes('2 lines'));
        assert.strictEqual(formatActionDescription({ type: 'final-answer', message: 'ok' }), 'ok');
        assert.strictEqual(actionCommandLabel({ type: 'run-command', command: 'ls' }), 'ls');
        assert.strictEqual(actionCommandLabel({ type: 'use-tool', tool: 't', args: { a: 1 } }), 'use-tool t {"a":1}');
    });

    test('classifies read-only actions', () => {
        assert.strictEqual(isReadOnlyAction({ type: 'read-file', path: 'a' }), true);
        assert.strictEqual(isReadOnlyAction({ type: 'grep-search', query: 'a', filePattern: '**' }), true);
        assert.strictEqual(isReadOnlyAction({ type: 'write-file', path: 'a', content: '' }), false);
        assert.strictEqual(isReadOnlyAction({ type: 'run-command', command: 'ls' }), false);
        assert.strictEqual(isReadOnlyAction({ type: 'use-tool', tool: 'x', args: {} }), false);
    });

    test('detects legacy UI labels and sanitizes tool tags from prose', () => {
        assert.strictEqual(isLegacyUiLabel('🔍 **Reading** `a`'), true);
        assert.strictEqual(isLegacyUiLabel('✅ Done.'), true);
        assert.strictEqual(isLegacyUiLabel('Here is the answer'), false);
        const cleaned = sanitizeAgentDisplayResponse('Hello <run_shell command="ls"/> world\n{"action":"read-file","path":"a"}');
        assert.strictEqual(cleaned, 'Hello  world');
    });
});
