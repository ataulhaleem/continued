/**
 * Message Renderer Component
 * Handles markdown compilation and message display
 */

const COMMAND_RESULT_PREFIX = '[[COMMAND_RESULT]]';

export class MessageRenderer {
  private currentAiBubble: HTMLElement | null = null;
  private messagesDiv: HTMLElement;

  constructor(messagesDivId: string) {
    const div = document.getElementById(messagesDivId);
    if (!div) throw new Error(`Messages container not found: ${messagesDivId}`);
    this.messagesDiv = div;
  }

  compileMarkdownToHtml(rawText: string): string {
    if (!rawText) return '';

    if (rawText.startsWith(COMMAND_RESULT_PREFIX)) {
      try {
        const payload = JSON.parse(rawText.slice(COMMAND_RESULT_PREFIX.length));
        return this.renderCommandResultHtml(payload.command || '', payload.output || '');
      } catch {
        // fallback to regular markdown parser
      }
    }

    const codeBlocks: string[] = [];
    let html = rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Extract and format <run_shell command="..." /> tags
    html = html.replace(/&lt;run_shell\s+command=["']([^"']+)["']\s*\/?&gt;/gi, (match, command) => {
      const uid = 'cmd_' + Math.random().toString(36).substring(2, 11);
      const cmdHtml = `
        <div class="md-code-block" style="border-left: 3px solid var(--vscode-testing-iconErrored, #f48771);">
          <div class="md-code-header">
            <span class="md-code-lang">$ COMMAND</span>
            <button class="md-copy-btn" onclick="window.copyCodeSnippet('${uid}')">Copy</button>
          </div>
          <pre class="md-code-pre"><code id="${uid}">${command}</code></pre>
        </div>`;
      const token = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(cmdHtml);
      return token;
    });

    // Extract code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const language = (lang || '').trim() || 'plaintext';
      const uid = 'code_' + Math.random().toString(36).substring(2, 11);
      const codeHtml = `
        <div class="md-code-block">
          <div class="md-code-header">
            <span class="md-code-lang">${language}</span>
            <button class="md-copy-btn" onclick="window.copyCodeSnippet('${uid}')">Copy</button>
          </div>
          <pre class="md-code-pre"><code id="${uid}">${code.trim()}</code></pre>
        </div>`;
      const token = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(codeHtml);
      return token;
    });

    // Format inline code
    html = html.replace(/`([^\`\n]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\](https?:\/\/[^\s)]+)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Headers
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Lists
    html = html.replace(/^(?:- |\* )(.+(?:\n(?:- |\* ).+)*)/gm, (match) => {
      const items = match.split('\n').map(line => `<li>${line.replace(/^(- |\* )/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    });

    html = html.replace(/^(?:\d+\. )(.+(?:\n\d+\. .+)*)/gm, (match) => {
      const items = match.split('\n').map(line => `<li>${line.replace(/^\d+\. /, '')}</li>`).join('');
      return `<ol>${items}</ol>`;
    });

    // Blockquotes
    html = html.replace(/(^|\n)&gt;\s?(.*)/g, '$1<blockquote>$2</blockquote>');

    // Paragraphs
    const blocks = html.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    html = blocks.map(block => {
      if (/^<(h\d|ul|ol|li|blockquote|div|pre|table)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
    }).join('');

    // Restore code blocks
    codeBlocks.forEach((blockHtml, index) => {
      html = html.replace(`__CODE_BLOCK_${index}__`, blockHtml);
    });

    return html;
  }

  private escapeHtml(text: any): string {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private renderCommandResultHtml(command: string, output: string): string {
    const safeCommand = this.escapeHtml(command || '');
    const safeOutput = this.escapeHtml(output || 'No output');
    return `
      <div class="tool-inline">
        <div class="tool-inline-header">
          <span class="tool-inline-title">Tool: shell command executed</span>
          <span>agent tool result</span>
        </div>
        <pre class="tool-inline-command"><code>${safeCommand}</code></pre>
        <details>
          <summary>Show raw output</summary>
          <pre class="tool-inline-output"><code>${safeOutput}</code></pre>
        </details>
      </div>`;
  }

  appendMessage(text: string, role: 'user' | 'assistant' | 'system'): void {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    msgDiv.textContent = text;
    this.messagesDiv.appendChild(msgDiv);
    this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight;

    if (role === 'assistant') this.currentAiBubble = msgDiv;
  }

  appendAssistantRendered(text: string): void {
    this.appendMessage('', 'assistant');
    const rendered = this.compileMarkdownToHtml(text || '');
    this.replaceCurrentAiBubbleWithHtml(rendered);
  }

  replaceCurrentAiBubbleWithHtml(html: string): void {
    if (this.currentAiBubble) {
      this.currentAiBubble.innerHTML = html;
      this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight;
    }
  }

  appendToolResultToCurrentAssistant(command: string, output: string): void {
    const toolHtml = this.renderCommandResultHtml(command, output);
    if (!this.currentAiBubble) {
      this.appendMessage('', 'assistant');
      this.replaceCurrentAiBubbleWithHtml(toolHtml);
      return;
    }

    const existing = this.currentAiBubble.innerHTML || '';
    this.currentAiBubble.innerHTML = `${existing}${toolHtml}`;
    this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight;
  }

  getCurrentAiBubble(): HTMLElement | null {
    return this.currentAiBubble;
  }

  setCurrentAiBubble(element: HTMLElement | null): void {
    this.currentAiBubble = element;
  }

  clear(): void {
    this.messagesDiv.innerHTML = '';
    this.currentAiBubble = null;
  }
}

// Global function for copy button
declare global {
  interface Window {
    copyCodeSnippet(elementId: string): void;
  }
}

window.copyCodeSnippet = function(elementId: string): void {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const wrapper = el.closest('.md-code-block, .code-block-wrapper');
    const btn = wrapper ? wrapper.querySelector('.md-copy-btn, .copy-btn') as HTMLButtonElement : null;
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = original, 1500);
  }).catch(err => console.error('Copy failed', err));
};
