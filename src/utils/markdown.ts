/**
 * Safely parses basic Markdown and wraps code blocks with clean UI elements.
 * Built with pure regex to ensure 0% external runtime dependency failures.
 */
export function compileMarkdownToHtml(rawText: string): string {
    if (!rawText) return '';

    let html = rawText;

    // 1. Escape literal HTML tags to prevent cross-site scripting/rendering breaks
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 2. Parse Code Blocks with Dynamic Copy Targets
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const language = lang.trim() || 'plaintext';
        const uniqueId = 'code_' + Math.random().toString(36).substring(2, 11);
        const trimmedCode = code.trim();

        return `
        <div class="code-block-wrapper" style="margin: 10px 0; border-radius: 6px; overflow: hidden; background: #1e1e1e; border: 1px solid var(--vscode-panel-border);">
            <div class="code-block-header" style="display: flex; justify-content: space-between; align-items: center; background: #2d2d2d; color: #ccc; padding: 5px 10px; font-size: 11px; font-family: var(--vscode-font-family);">
                <span style="text-transform: uppercase; font-weight: 600;">${language}</span>
                <button class="copy-btn" onclick="window.copyCodeSnippet('${uniqueId}')" style="background: rgba(255,255,255,0.1); color: #fff; border: none; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;">Copy</button>
            </div>
            <pre style="margin: 0; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: #d4d4d4;"><code id="${uniqueId}">${trimmedCode}</code></pre>
        </div>`;
    });

    // 3. Parse inline code formatting `code`
    html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(120,120,120,0.15); padding: 2px 4px; border-radius: 3px; font-family: monospace;">$1</code>');

    // 4. Parse basic structural elements (Bold & Paragraph breaks)
    html = html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
    html = html.split('\n\n').map(para => para.trim() ? `<p style="margin: 4px 0 8px 0;">${para}</p>` : '').join('');

    return html;
}