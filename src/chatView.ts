/**
 * Chat View - Main TypeScript module
 * Generates the complete chat view HTML (layout + styles + webview script).
 */

import { styles } from './chatView/styles';
import { htmlLayout } from './chatView/layout';
import { harnessScript, harnessStyles } from './chatView/harnessView';

/**
 * Initialize and generate the complete HTML document
 */
export function generateChatViewHTML(): string {
  const styleTag = styles.getAllStyles();
  const layoutHTML = htmlLayout.getAllHTML();

  const html = layoutHTML.replace(
    '</head>',
    `${styleTag}<style>${harnessStyles}</style></head>`
  ).replace(
    '</body>',
    `<script>${harnessScript}</script><script>${getInitializationScript()}</script></body>`
  );

  return html;
}

/**
 * The webview script. Everything runs inside the webview sandbox, so the classes
 * are defined inline (no module imports are available there).
 */
function getInitializationScript(): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();

      function escapeHtml(text) {
        return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      // ==================== Message rendering ====================
      class MessageRenderer {
        constructor(messagesDivId) {
          this.messagesDiv = document.getElementById(messagesDivId);
          this.currentAiBubble = null;   // bubble that tool results attach to
          this.streamingBubble = null;   // bubble being filled by streamToken
        }
        compileMarkdownToHtml(rawText) {
          if (!rawText) return '';
          let codeBlocks = [];
          let html = escapeHtml(rawText);

          html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
            const language = (lang || '').trim() || 'plaintext';
            const uid = 'code_' + Math.random().toString(36).substring(2, 11);
            const codeHtml = '<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">'+language+'</span><button class="md-copy-btn" onclick="window.copyCodeSnippet(\\''+uid+'\\')">Copy</button></div><pre class="md-code-pre"><code id="'+uid+'">'+code.replace(/^\\n+|\\n+$/g, '')+'</code></pre></div>';
            codeBlocks.push(codeHtml);
            return '__CODE_BLOCK_' + (codeBlocks.length - 1) + '__';
          });

          html = html.replace(/\`([^\`\\n]+)\`/g, '<code class="inline-code">$1</code>');
          html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
          html = html.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
          html = html.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

          html = html.replace(/^######\\s+(.+)$/gm, '<h6>$1</h6>');
          html = html.replace(/^#####\\s+(.+)$/gm, '<h5>$1</h5>');
          html = html.replace(/^####\\s+(.+)$/gm, '<h4>$1</h4>');
          html = html.replace(/^###\\s+(.+)$/gm, '<h3>$1</h3>');
          html = html.replace(/^##\\s+(.+)$/gm, '<h2>$1</h2>');
          html = html.replace(/^#\\s+(.+)$/gm, '<h1>$1</h1>');

          html = html.replace(/^(?:- |\\* )(.+(?:\\n(?:- |\\* ).+)*)/gm, (match) => {
            const items = match.split('\\n').map(line => '<li>'+line.replace(/^(- |\\* )/, '')+'</li>').join('');
            return '<ul>'+items+'</ul>';
          });

          html = html.replace(/^(?:\\d+\\. )(.+(?:\\n\\d+\\. .+)*)/gm, (match) => {
            const items = match.split('\\n').map(line => '<li>'+line.replace(/^\\d+\\. /, '')+'</li>').join('');
            return '<ol>'+items+'</ol>';
          });

          html = html.replace(/(^|\\n)&gt;\\s?(.*)/g, '$1<blockquote>$2</blockquote>');

          const blocks = html.split(/\\n\\s*\\n/).map(b => b.trim()).filter(Boolean);
          html = blocks.map(block => {
            if (/^<(h\\d|ul|ol|li|blockquote|div|pre|table)/.test(block) || /^__CODE_BLOCK_\\d+__$/.test(block)) return block;
            return '<p>'+block.replace(/\\n/g, '<br/>')+'</p>';
          }).join('');

          codeBlocks.forEach((blockHtml, index) => {
            html = html.replace('__CODE_BLOCK_' + index + '__', blockHtml);
          });

          return html;
        }
        scrollToBottom() { this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight; }
        appendUserMessage(text, onResend) {
          const wrap = document.createElement('div');
          wrap.className = 'user-msg-wrap';
          const msgDiv = document.createElement('div');
          msgDiv.className = 'message user';
          msgDiv.textContent = text;
          const resendBtn = document.createElement('button');
          resendBtn.className = 'resend-btn';
          resendBtn.title = 'Resend';
          resendBtn.innerHTML = '↺';
          resendBtn.addEventListener('click', () => onResend && onResend(text));
          wrap.appendChild(msgDiv);
          wrap.appendChild(resendBtn);
          this.messagesDiv.appendChild(wrap);
          this.scrollToBottom();
        }
        appendAssistantBubble(html, extraClass) {
          const msgDiv = document.createElement('div');
          msgDiv.className = 'message ai' + (extraClass ? ' ' + extraClass : '');
          msgDiv.innerHTML = html || '';
          this.messagesDiv.appendChild(msgDiv);
          this.currentAiBubble = msgDiv;
          this.scrollToBottom();
          return msgDiv;
        }
        appendAssistantRendered(text) {
          return this.appendAssistantBubble(this.compileMarkdownToHtml(text || ''));
        }
        appendAgentAction(label) {
          return this.appendAssistantBubble(this.compileMarkdownToHtml(label || ''), 'agent-action');
        }
        startStreamingBubble() {
          this.streamingBubble = this.appendAssistantBubble('');
          this.streamingBubble.dataset.rawContent = '';
        }
        appendStreamToken(token) {
          if (!this.streamingBubble) { this.startStreamingBubble(); }
          const raw = (this.streamingBubble.dataset.rawContent || '') + token;
          this.streamingBubble.dataset.rawContent = raw;
          this.streamingBubble.innerHTML = this.compileMarkdownToHtml(raw);
          this.scrollToBottom();
        }
        finishStreamingBubble(text) {
          const bubble = this.streamingBubble;
          this.streamingBubble = null;
          const html = this.compileMarkdownToHtml(text || '');
          if (bubble) {
            if (!html.trim()) {
              bubble.remove();
              if (this.currentAiBubble === bubble) this.currentAiBubble = null;
            } else {
              bubble.innerHTML = html;
              delete bubble.dataset.rawContent;
              this.currentAiBubble = bubble;
            }
          } else if (html.trim()) {
            this.appendAssistantBubble(html);
          }
          this.scrollToBottom();
        }
        showStatusBox(label) {
          let box = document.getElementById('agent-status-box');
          if (!box) {
            box = document.createElement('div');
            box.id = 'agent-status-box';
            box.className = 'agent-status-box';
            const header = document.createElement('div');
            header.className = 'agent-status-header';
            header.id = 'agent-status-header';
            const thinking = document.createElement('div');
            thinking.className = 'agent-status-thinking';
            thinking.id = 'agent-status-thinking';
            box.appendChild(header);
            box.appendChild(thinking);
          }
          // Keep the status box at the bottom of the conversation
          this.messagesDiv.appendChild(box);
          box.classList.remove('hidden');
          document.getElementById('agent-status-header').textContent = label || 'Working\\u2026';
          this.scrollToBottom();
          return box;
        }
        updateStatusThinking(text) {
          const el = document.getElementById('agent-status-thinking');
          if (el) {
            el.textContent += text;
            const box = document.getElementById('agent-status-box');
            if (box) box.scrollTop = box.scrollHeight;
            this.scrollToBottom();
          }
        }
        updateStatusLabel(label) {
          const el = document.getElementById('agent-status-header');
          if (el) el.textContent = label;
        }
        hideStatusBox() {
          const box = document.getElementById('agent-status-box');
          if (box) {
            box.classList.add('hidden');
            const thinking = document.getElementById('agent-status-thinking');
            if (thinking) thinking.textContent = '';
          }
        }
        appendToolResult(command, output) {
          const safeCmd = escapeHtml(command);
          const safeOut = escapeHtml(output);
          const failed = /^(FAILED|BLOCKED|DECLINED)\\b/.test(String(output || ''));
          const title = failed ? 'Tool result (failed)' : 'Tool result';
          const toolHtml = '<div class="tool-inline' + (failed ? ' tool-failed' : '') + '"><div class="tool-inline-header"><span class="tool-inline-title">'+title+'</span><span>agent</span></div><pre class="tool-inline-command"><code>'+safeCmd+'</code></pre><details><summary>Show output</summary><pre class="tool-inline-output"><code>'+safeOut+'</code></pre></details></div>';
          if (!this.currentAiBubble || this.currentAiBubble === this.streamingBubble) {
            this.appendAssistantBubble(toolHtml, 'agent-action');
            return;
          }
          this.currentAiBubble.innerHTML = (this.currentAiBubble.innerHTML || '') + toolHtml;
          this.scrollToBottom();
        }
        clear() {
          this.messagesDiv.innerHTML = '';
          this.currentAiBubble = null;
          this.streamingBubble = null;
        }
      }

      // ==================== Agent change review panel ====================
      class PendingOpsPanel {
        constructor(vscode) {
          this.vscode = vscode;
          this.panel = document.getElementById('pending-ops-panel');
          this.list = document.getElementById('pending-ops-list');
          this.toggle = document.getElementById('pending-ops-toggle');
          this.approveAll = document.getElementById('approve-all-ops');
          this.rejectAll = document.getElementById('reject-all-ops');
          this.expanded = true;
          this.setupListeners();
        }
        setupListeners() {
          this.toggle.addEventListener('click', () => {
            this.expanded = !this.expanded;
            this.toggle.textContent = (this.expanded ? '▼' : '▶') + ' Agent Changes';
            this.list.style.display = this.expanded ? 'flex' : 'none';
          });
          this.approveAll.addEventListener('click', () => this.vscode.postMessage({ type: 'approveAllOps' }));
          this.rejectAll.addEventListener('click', () => this.vscode.postMessage({ type: 'rejectAllOps' }));
        }
        makeItem(typeClass, typeLabel, path, opType, idx, hint) {
          const item = document.createElement('div');
          item.className = 'pending-op-item';
          item.innerHTML = '<div class="pending-op-item-header"><span class="pending-op-type '+typeClass+'" title="'+escapeHtml(hint)+'">'+typeLabel+'</span><span class="pending-op-path" title="'+escapeHtml(path)+'">'+escapeHtml(path)+'</span><button class="pending-op-btn" style="padding:2px 4px;font-size:8px;" title="Keep this change">✓</button><button class="pending-op-btn" style="padding:2px 4px;font-size:8px;" title="Revert this change">↶</button></div>';
          item.querySelector('button:nth-child(3)').addEventListener('click', () => this.vscode.postMessage({type:'approveOp', opType:opType, index:idx}));
          item.querySelector('button:nth-child(4)').addEventListener('click', () => this.vscode.postMessage({type:'rejectOp', opType:opType, index:idx}));
          return item;
        }
        render(edits, deletes) {
          this.list.innerHTML = '';
          edits.forEach((edit, idx) => {
            const created = !!edit.created;
            this.list.appendChild(this.makeItem('write', created ? 'A' : 'M', edit.relativePath, 'write', idx, created ? 'Created by agent' : 'Modified by agent'));
          });
          deletes.forEach((dPath, idx) => {
            this.list.appendChild(this.makeItem('delete', 'D', dPath, 'delete', idx, 'Deleted by agent'));
          });
          const count = edits.length + deletes.length;
          this.toggle.textContent = (this.expanded ? '▼' : '▶') + ' Agent Changes (' + count + ')';
          this.panel.classList.toggle('hidden', count === 0);
        }
      }

      // ==================== File attachments ====================
      class FileAttachment {
        constructor() {
          this.attachedFiles = new Map();
          this.input = document.getElementById('file-upload');
          this.btn = document.getElementById('attach-file-btn');
          this.container = document.getElementById('attached-files');
          this.setupListeners();
        }
        setupListeners() {
          this.btn.addEventListener('click', () => this.input.click());
          this.input.addEventListener('change', (e) => {
            Array.from(e.target.files || []).forEach(file => {
              if (!this.attachedFiles.has(file.name)) {
                this.attachedFiles.set(file.name, file);
                this.addFileDisplay(file.name);
              }
            });
            this.input.value = '';
          });
        }
        addFileDisplay(name) {
          const item = document.createElement('div');
          item.className = 'attached-file-item';
          item.innerHTML = '<span>📄 '+escapeHtml(name)+'</span><button class="attached-file-remove" type="button">✕</button>';
          item.querySelector('button').addEventListener('click', () => {
            this.attachedFiles.delete(name);
            this.refreshDisplay();
          });
          this.container.appendChild(item);
        }
        refreshDisplay() {
          this.container.innerHTML = '';
          this.attachedFiles.forEach(f => this.addFileDisplay(f.name));
        }
        async getFilesData() {
          return Promise.all(Array.from(this.attachedFiles.values()).map(file => new Promise(resolve => {
            const reader = new FileReader();
            reader.onerror = () => resolve({name:file.name, type:file.type, size:file.size, isImage:false, content:''});
            if (file.type.startsWith('image/')) {
              reader.onload = (e) => resolve({name:file.name, type:file.type, size:file.size, isImage:true, content:e.target.result});
              reader.readAsDataURL(file);
            } else {
              reader.onload = (e) => resolve({name:file.name, type:file.type, size:file.size, isImage:false, content:e.target.result});
              reader.readAsText(file);
            }
          })));
        }
        clear() { this.attachedFiles.clear(); this.container.innerHTML = ''; }
        hasFiles() { return this.attachedFiles.size > 0; }
        names() { return Array.from(this.attachedFiles.keys()); }
      }

      // ==================== Plugin manager ====================
      class PluginManager {
        constructor(vscode) {
          this.vscode = vscode;
          this.list = document.getElementById('plugins-list');
          this.countEl = document.getElementById('plugins-enabled-count');
        }
        render(plugins) {
          this.list.innerHTML = '';
          const categories = [['tools', 'Tools'], ['resources', 'Resources'], ['skills', 'Skills']];
          categories.forEach(([cat, label]) => {
            const items = plugins[cat] || [];
            if (items.length === 0) return;
            const title = document.createElement('div');
            title.style.cssText = 'font-size:11px;font-weight:700;margin-top:8px;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);text-transform:uppercase;';
            title.textContent = label;
            this.list.appendChild(title);
            items.forEach(plugin => {
              const card = document.createElement('div');
              card.className = 'plugin-card';

              const cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.checked = !!plugin.enabled;
              cb.title = plugin.enabled ? 'Disable' : 'Enable';
              cb.addEventListener('change', () => this.vscode.postMessage({type:'togglePlugin', pluginId:plugin.id, enabled:cb.checked}));

              const info = document.createElement('div');
              info.className = 'plugin-info';
              const name = document.createElement('div');
              name.className = 'plugin-name';
              name.textContent = plugin.name + ' v' + (plugin.version || '1.0.0');
              const meta = document.createElement('div');
              meta.className = 'plugin-meta';
              const badge = document.createElement('span');
              badge.className = 'plugin-badge';
              badge.textContent = (plugin.harness ? 'harness · ' : '') + (plugin.source === 'user' ? 'user' : 'built-in');
              const id = document.createElement('span');
              id.className = 'plugin-id';
              id.textContent = plugin.id;
              meta.appendChild(badge);
              meta.appendChild(id);
              const desc = document.createElement('div');
              desc.className = 'plugin-desc';
              desc.textContent = plugin.description || '';
              info.appendChild(name);
              info.appendChild(meta);
              if (plugin.description) info.appendChild(desc);

              card.appendChild(cb);
              card.appendChild(info);

              if (plugin.source === 'user' && !plugin.harness) {
                const actions = document.createElement('div');
                actions.className = 'plugin-card-actions';
                const editBtn = document.createElement('button');
                editBtn.className = 'plugin-action-btn';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => this.vscode.postMessage({type:'editPlugin', pluginId:plugin.id}));
                const delBtn = document.createElement('button');
                delBtn.className = 'plugin-action-btn';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', () => this.vscode.postMessage({type:'deletePlugin', pluginId:plugin.id, pluginName:plugin.name}));
                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
                card.appendChild(actions);
              }
              this.list.appendChild(card);
            });
          });
          if (!this.list.children.length) {
            const empty = document.createElement('div');
            empty.className = 'plugins-hint';
            empty.textContent = 'No plugins registered yet.';
            this.list.appendChild(empty);
          }
        }
        setCount(c) { this.countEl.textContent = String(c || '0'); }
      }

      // ==================== Global setup ====================
      const mr = new MessageRenderer('messages');
      const pops = new PendingOpsPanel(vscode);
      const fa = new FileAttachment();
      const pm = new PluginManager(vscode);
      let isWaiting = false;
      let isAgentRunning = false;
      let currentPlan = '';

      const els = {
        historyScreen: document.getElementById('history-screen'),
        sessionsContainer: document.getElementById('sessions-list-container'),
        newChatBtn: document.getElementById('new-chat-btn'),
        pluginsScreen: document.getElementById('plugins-screen'),
        pluginsBackBtn: document.getElementById('plugins-back-btn'),
        reloadPluginsBtn: document.getElementById('reload-plugins-btn'),
        openPluginsFolderBtn: document.getElementById('open-plugins-folder-btn'),
        createToolBtn: document.getElementById('create-tool-btn'),
        createSkillBtn: document.getElementById('create-skill-btn'),
        createResourceBtn: document.getElementById('create-resource-btn'),
        createPluginModal: document.getElementById('create-plugin-modal'),
        pluginTypeInput: document.getElementById('plugin-type-input'),
        pluginNameInput: document.getElementById('plugin-name-input'),
        pluginDescriptionInput: document.getElementById('plugin-description-input'),
        pluginCodeInput: document.getElementById('plugin-code-input'),
        cancelPluginBtn: document.getElementById('cancel-plugin-btn'),
        createPluginSubmitBtn: document.getElementById('create-plugin-submit-btn'),
        chatContainer: document.getElementById('chat-container'),
        backBtn: document.getElementById('back-btn'),
        sendBtn: document.getElementById('send-btn'),
        promptInput: document.getElementById('prompt'),
        modelSelect: document.getElementById('model-select'),
        modeSelect: document.getElementById('mode-select'),
        clearBtn: document.getElementById('clear-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        pluginsBtn: document.getElementById('plugins-btn'),
        harnessBtn: document.getElementById('harness-btn'),
        harnessScreen: document.getElementById('harness-screen'),
        planPanel: document.getElementById('plan-panel'),
        planContent: document.getElementById('plan-content'),
        executePlanBtn: document.getElementById('execute-plan-btn'),
        editPlanBtn: document.getElementById('edit-plan-btn'),
        cancelPlanBtn: document.getElementById('cancel-plan-btn'),
        approvalPanel: document.getElementById('approval-panel'),
        approvalMsg: document.getElementById('approval-msg'),
        approvalPreviewDetails: document.getElementById('approval-preview-details'),
        approvalPreview: document.getElementById('approval-preview'),
        allowBtn: document.getElementById('allow-btn'),
        denyBtn: document.getElementById('deny-btn'),
        deletePanel: document.getElementById('delete-panel'),
        deleteMsg: document.getElementById('delete-msg'),
        allowDelBtn: document.getElementById('allow-del-btn'),
        denyDelBtn: document.getElementById('deny-del-btn'),
        commandPanel: document.getElementById('command-panel'),
        commandMsg: document.getElementById('command-msg'),
        commandShellLabel: document.getElementById('command-shell-label'),
        allowCmdBtn: document.getElementById('allow-cmd-btn'),
        denyCmdBtn: document.getElementById('deny-cmd-btn'),
        cancelAgentBtn: document.getElementById('cancel-agent-btn')
      };

      function hideApprovalPanels() {
        els.approvalPanel.style.display = 'none';
        els.deletePanel.style.display = 'none';
        els.commandPanel.style.display = 'none';
      }

      function setWorking(active, label, agent) {
        isWaiting = active;
        isAgentRunning = active && !!agent;
        els.sendBtn.disabled = active;
        els.sendBtn.classList.toggle('working', active);
        els.sendBtn.textContent = active ? (label || 'Working\\u2026') : 'Send';
        if (els.cancelAgentBtn) els.cancelAgentBtn.classList.toggle('hidden', !active);
        if (active) {
          mr.showStatusBox(label || 'Working\\u2026');
        } else {
          mr.hideStatusBox();
          hideApprovalPanels();
        }
      }

      window.copyCodeSnippet = function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        navigator.clipboard.writeText(el.innerText).then(() => {
          const btn = el.closest('.md-code-block, .code-block-wrapper')?.querySelector('.md-copy-btn, .copy-btn');
          if (!btn) return;
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = orig, 1500);
        }).catch(e => console.error('Copy failed', e));
      };

      function currentFileOrNull() {
        const text = document.getElementById('current-file-text')?.textContent || '';
        return text && text !== 'No file open' ? text : null;
      }

      // ==================== Event listeners ====================
      vscode.postMessage({ type: 'getModels' });
      els.modelSelect.addEventListener('change', () => vscode.postMessage({type:'saveModelPreference', model:els.modelSelect.value}));
      els.modeSelect.addEventListener('change', () => vscode.postMessage({type:'saveModePreference', mode:els.modeSelect.value}));

      if (els.cancelAgentBtn) {
        els.cancelAgentBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'cancelAgent' });
          setWorking(false);
          mr.appendAssistantRendered('⛔ Agent cancelled by user.');
        });
      }

      els.executePlanBtn.addEventListener('click', () => {
        if (!currentPlan) return;
        els.planPanel.classList.add('hidden');
        els.modeSelect.value = 'agent';
        vscode.postMessage({type:'saveModePreference', mode:'agent'});
        mr.appendUserMessage('▶ Execute plan', null);
        setWorking(true, '⏳ Agent starting…', true);
        vscode.postMessage({type:'executePlan', plan:currentPlan, model:els.modelSelect.value, currentFile: currentFileOrNull()});
        currentPlan = '';
      });
      els.editPlanBtn.addEventListener('click', () => {
        els.promptInput.value = 'Execute this plan:\\n\\n' + currentPlan;
        els.modeSelect.value = 'agent';
        vscode.postMessage({type:'saveModePreference', mode:'agent'});
        els.promptInput.focus();
        els.planPanel.classList.add('hidden');
      });
      els.cancelPlanBtn.addEventListener('click', () => {
        els.planPanel.classList.add('hidden');
        currentPlan = '';
      });

      els.newChatBtn.addEventListener('click', () => vscode.postMessage({type:'startNewChat'}));
      els.settingsBtn.addEventListener('click', () => vscode.postMessage({type:'openSettings'}));
      els.pluginsBtn.addEventListener('click', () => {
        els.chatContainer.classList.add('hidden');
        els.pluginsScreen.classList.remove('hidden');
        vscode.postMessage({type:'getPlugins'});
      });
      els.pluginsBackBtn.addEventListener('click', () => {
        els.pluginsScreen.classList.add('hidden');
        els.chatContainer.classList.remove('hidden');
      });
      els.reloadPluginsBtn?.addEventListener('click', () => vscode.postMessage({type:'reloadPlugins'}));
      window.ContinuedHarness.init(vscode, {
        escapeHtml: escapeHtml,
        markdown: (text) => mr.compileMarkdownToHtml(text || ''),
        getModel: () => els.modelSelect.value,
        getMode: () => els.modeSelect.value,
        getModels: () => Array.from(els.modelSelect.options).map(o => o.value),
        showChat: () => { els.harnessScreen.classList.add('hidden'); els.chatContainer.classList.remove('hidden'); }
      });
      els.harnessBtn?.addEventListener('click', () => {
        els.chatContainer.classList.add('hidden');
        els.pluginsScreen.classList.add('hidden');
        window.ContinuedHarness.open();
      });
      els.openPluginsFolderBtn?.addEventListener('click', () => vscode.postMessage({type:'openPluginsFolder'}));

      function openCreateModal(type) {
        els.pluginTypeInput.value = type;
        els.pluginNameInput.value = '';
        els.pluginDescriptionInput.value = '';
        els.pluginCodeInput.value = '';
        els.createPluginModal.classList.remove('hidden');
        els.pluginNameInput.focus();
      }
      els.createToolBtn?.addEventListener('click', () => openCreateModal('tool'));
      els.createSkillBtn?.addEventListener('click', () => openCreateModal('skill'));
      els.createResourceBtn?.addEventListener('click', () => openCreateModal('resource'));
      els.cancelPluginBtn?.addEventListener('click', () => els.createPluginModal.classList.add('hidden'));
      els.createPluginModal?.addEventListener('click', (e) => {
        if (e.target === els.createPluginModal) els.createPluginModal.classList.add('hidden');
      });
      els.createPluginSubmitBtn?.addEventListener('click', () => {
        const pluginName = els.pluginNameInput.value.trim();
        if (!pluginName) { els.pluginNameInput.focus(); return; }
        vscode.postMessage({
          type: 'createPlugin',
          pluginType: els.pluginTypeInput.value,
          pluginName: pluginName,
          description: els.pluginDescriptionInput.value.trim(),
          code: els.pluginCodeInput.value
        });
        els.createPluginModal.classList.add('hidden');
      });

      els.backBtn.addEventListener('click', () => {
        els.chatContainer.classList.add('hidden');
        els.historyScreen.classList.remove('hidden');
        vscode.postMessage({type:'showHistoryList'});
      });
      els.clearBtn.addEventListener('click', () => {
        mr.clear();
        hideApprovalPanels();
        els.planPanel.classList.add('hidden');
        setWorking(false);
        vscode.postMessage({type:'clearHistory'});
      });

      function sendPrompt(txt, filesData) {
        const mode = els.modeSelect.value;
        const isAgent = mode === 'agent' || mode === 'agent-auto';
        setWorking(true, isAgent ? '⏳ Agent starting…' : (mode === 'plan' ? '📋 Planning…' : 'Working…'), isAgent);
        vscode.postMessage({type:'sendPrompt', value:txt, model:els.modelSelect.value, mode:mode, attachedFiles:filesData || [], currentFile: currentFileOrNull()});
      }
      function onResend(resendTxt) {
        if (isWaiting) return;
        mr.appendUserMessage(resendTxt, onResend);
        sendPrompt(resendTxt, []);
      }

      els.sendBtn.addEventListener('click', () => {
        if (isWaiting) return;
        const txt = els.promptInput.value.trim();
        if (!txt && !fa.hasFiles()) return;
        const shown = txt || '(attached files)';
        const label = fa.hasFiles() ? shown + '\\n📎 ' + fa.names().join(', ') : shown;
        mr.appendUserMessage(label, onResend);
        fa.getFilesData().then(filesData => {
          sendPrompt(txt, filesData);
          fa.clear();
          els.promptInput.value = '';
        });
      });
      els.promptInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.sendBtn.click(); }
      });

      els.allowBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToEdit', action:'Allow'}); });
      els.denyBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToEdit', action:'Deny'}); });
      els.allowDelBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToDelete', action:'Allow'}); });
      els.denyDelBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToDelete', action:'Deny'}); });
      els.allowCmdBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToCommand', action:'Allow'}); });
      els.denyCmdBtn.addEventListener('click', () => { hideApprovalPanels(); vscode.postMessage({type:'respondToCommand', action:'Deny'}); });

      // ==================== Messages from the extension ====================
      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
          case 'loadSessionView':
            els.chatContainer.classList.remove('hidden');
            els.historyScreen.classList.add('hidden');
            mr.clear();
            setWorking(false);
            els.planPanel.classList.add('hidden');
            (msg.history || []).forEach(m => {
              if (m.role === 'user') { mr.appendUserMessage(m.content, onResend); return; }
              if (m.kind === 'action') { mr.appendAgentAction(m.content); return; }
              if (m.kind === 'tool') { mr.appendToolResult(m.command, m.output); return; }
              mr.appendAssistantRendered(m.content);
            });
            break;
          case 'renderSessions':
            els.sessionsContainer.innerHTML = '';
            msg.sessions.forEach(s => {
              const item = document.createElement('div');
              item.className = 'session-item';
              const title = document.createElement('span');
              title.className = 'session-title';
              title.textContent = s.title || 'Untitled Chat';
              title.addEventListener('click', () => vscode.postMessage({type:'selectSession', sessionId:s.id}));
              const del = document.createElement('button');
              del.className = 'delete-session-btn';
              del.textContent = '×';
              del.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({type:'deleteSession', sessionId:s.id});
              });
              item.appendChild(title);
              item.appendChild(del);
              els.sessionsContainer.appendChild(item);
            });
            break;
          case 'setModels': {
            const previous = els.modelSelect.value;
            els.modelSelect.innerHTML = '';
            msg.models.forEach(m => {
              const opt = document.createElement('option');
              opt.value = m;
              opt.textContent = m;
              els.modelSelect.appendChild(opt);
            });
            const wanted = msg.savedModel || previous;
            if (wanted) {
              if (!Array.from(els.modelSelect.options).some(o => o.value === wanted)) {
                const saved = document.createElement('option');
                saved.value = wanted;
                saved.textContent = wanted;
                els.modelSelect.insertBefore(saved, els.modelSelect.firstChild);
              }
              els.modelSelect.value = wanted;
            }
            if (msg.savedMode) els.modeSelect.value = msg.savedMode;
            break;
          }
          case 'setPlugins':
            pm.render(msg.plugins || {});
            pm.setCount(msg.enabledCount || '0');
            break;
          case 'startStream':
            mr.startStreamingBubble();
            break;
          case 'thinkingToken':
            mr.showStatusBox('\\ud83e\\udde0 Thinking\\u2026');
            if (msg.value) mr.updateStatusThinking(msg.value);
            break;
          case 'thinkingDone':
            mr.updateStatusLabel('\\ud83e\\udde0 Done thinking');
            break;
          case 'streamToken':
            mr.appendStreamToken(msg.value || '');
            break;
          case 'assistantResponse':
            mr.finishStreamingBubble(msg.content || '');
            if (!isAgentRunning) setWorking(false);
            break;
          case 'agentAction':
            mr.appendAgentAction(msg.content || '');
            break;
          case 'commandResult':
            mr.appendToolResult(msg.command, msg.output);
            break;
          case 'agentWorking': {
            isAgentRunning = true;
            isWaiting = true;
            els.sendBtn.disabled = true;
            els.sendBtn.classList.add('working');
            if (els.cancelAgentBtn) els.cancelAgentBtn.classList.remove('hidden');
            const stepLabel = '\\u23f3 Step ' + (msg.step || '') + (msg.label ? ': ' + msg.label : '\\u2026');
            els.sendBtn.textContent = stepLabel;
            mr.showStatusBox(stepLabel);
            break;
          }
          case 'agentDone':
            isAgentRunning = false;
            setWorking(false);
            break;
          case 'setCurrentFile': {
            const fileEl = document.getElementById('current-file-text');
            const indicator = document.getElementById('current-file-indicator');
            if (fileEl) fileEl.textContent = msg.filePath || 'No file open';
            if (indicator) indicator.title = msg.filePath || '';
            break;
          }
          case 'requestEditApproval':
            els.approvalMsg.textContent = 'Agent wants to write: ' + msg.filename + (msg.lines ? ' (' + msg.lines + ' lines)' : '');
            if (els.approvalPreview) {
              els.approvalPreview.textContent = msg.preview || '';
              els.approvalPreviewDetails.open = false;
              els.approvalPreviewDetails.style.display = msg.preview ? '' : 'none';
            }
            els.approvalPanel.style.display = 'flex';
            break;
          case 'showPlan':
            currentPlan = msg.plan || '';
            els.planContent.textContent = currentPlan;
            els.planPanel.classList.remove('hidden');
            break;
          case 'requestDeleteApproval':
            els.deleteMsg.textContent = 'Agent wants to delete: ' + msg.filename;
            els.deletePanel.style.display = 'flex';
            break;
          case 'requestCommandApproval': {
            const cmdTxt = String(msg.command || '').trim();
            els.commandMsg.textContent = cmdTxt || 'No command provided';
            els.commandShellLabel.textContent = msg.kind === 'plugin'
              ? 'plugin'
              : ((cmdTxt.startsWith('pwsh') || cmdTxt.startsWith('powershell')) ? 'pwsh' : 'bash');
            els.commandPanel.style.display = 'flex';
            break;
          }
          case 'updatePendingOps':
            pops.render(msg.edits || [], msg.deletes || []);
            break;
          case 'harnessChatRecord':
            mr.appendUserMessage(msg.user || '', null);
            mr.appendAssistantRendered(msg.assistant || '');
            break;
          default:
            window.ContinuedHarness.onMessage(msg);
        }
      });
    })();
  `;
}
