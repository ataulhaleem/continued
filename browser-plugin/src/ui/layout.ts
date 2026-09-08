/**
 * HTML Layout Structure for Chat View
 * Main container layouts and screen definitions
 */

import { harnessLayout } from './harnessView';

export const htmlLayout = {
  /**
   * History screen - shows chat sessions
   */
  historyScreen: `
    <div id="history-screen">
      <button class="new-chat-btn" id="new-chat-btn">+ New Chat</button>
      <div class="section-header">Sessions</div>
      <div id="sessions-list-container"></div>
    </div>
  `,

  /**
   * Plugins management screen
   */
  pluginsScreen: `
    <div id="plugins-screen" class="hidden">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <button id="plugins-back-btn" class="control-btn" title="Back">⬅</button>
        <div style="display: flex; gap: 6px;">
          <button id="reload-plugins-btn" class="control-btn" title="Reload plugins from disk">↻ Reload</button>
          <button id="open-plugins-folder-btn" class="control-btn" title="Reveal .continued/plugins/">📁 Folder</button>
        </div>
      </div>
      <div class="plugins-actions">
        <div class="plugins-hint">
          Enabled plugins are offered to the agent as actions and can be invoked in chat with
          <strong>/tool</strong>, <strong>/resource</strong> and <strong>/skill</strong>.
          User plugins live in <strong>.continued/plugins/</strong> as plain JavaScript files.
        </div>
        <div class="plugins-buttons">
          <button id="create-tool-btn" class="plugin-action-btn">+ Tool</button>
          <button id="create-skill-btn" class="plugin-action-btn">+ Skill</button>
          <button id="create-resource-btn" class="plugin-action-btn">+ Resource</button>
        </div>
        <span id="plugins-enabled-count">0</span> plugins enabled
      </div>
      <div id="plugins-list" style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1; overflow-y: auto;"></div>
    </div>
  `,

  /**
   * Create plugin modal
   */
  createPluginModal: `
    <div id="create-plugin-modal" class="hidden">
      <div class="modal-content">
        <div class="modal-title">Create New Plugin</div>

        <div class="modal-input-group">
          <label for="plugin-type-input">Plugin Type</label>
          <select id="plugin-type-input">
            <option value="tool">Tool — performs an operation with arguments</option>
            <option value="skill">Skill — orchestrates a multi-step workflow</option>
            <option value="resource">Resource — provides context data</option>
          </select>
        </div>

        <div class="modal-input-group">
          <label for="plugin-name-input">Plugin Name</label>
          <input type="text" id="plugin-name-input" placeholder="e.g., Count Lines">
        </div>

        <div class="modal-input-group">
          <label for="plugin-description-input">Description (shown to the agent)</label>
          <textarea id="plugin-description-input" placeholder="What this plugin does and which args it accepts..."></textarea>
        </div>

        <div class="modal-input-group">
          <label for="plugin-code-input">Initial Code (JavaScript, optional — leave empty for a template)</label>
          <textarea id="plugin-code-input" placeholder="module.exports.tool = { id: '...', ... }"></textarea>
        </div>

        <div class="modal-buttons">
          <button id="cancel-plugin-btn" class="modal-btn-secondary">Cancel</button>
          <button id="create-plugin-submit-btn" class="modal-btn-primary">Create Plugin</button>
        </div>
      </div>
    </div>
  `,

  /**
   * Main chat container with all panels and controls
   */
  chatContainer: `
    <div id="chat-container" class="hidden">
      <div id="controls-row">
        <button id="back-btn" class="control-btn" title="Go Back">⬅</button>
        <select id="model-select" style="flex: 1 1 40%; min-width: 0;">
          <option value="llama3">Loading...</option>
        </select>
        <select id="mode-select" style="flex: 1 1 40%; min-width: 0;" title="Chat: free chat | Agent: approve every change | Agent Auto: auto-apply with review | Plan: write a plan first">
          <option value="chat">💬 Chat Mode</option>
          <option value="agent">🤖 Agent Mode</option>
          <option value="agent-auto">⚡ Agent Auto-Edit</option>
          <option value="plan">📋 Plan Mode</option>
        </select>
        <button id="clear-btn" class="control-btn" title="Clear Chat">Clear</button>
        <button id="plugins-btn" class="control-btn" style="padding: 4px 6px;" title="Manage Plugins">🔌</button>
        <button id="harness-btn" class="control-btn" style="padding: 4px 6px;" title="Harnesses: build and run workflows">🧩</button>
        <button id="settings-btn" class="control-btn" style="padding: 4px 6px;" title="Import Cloud Provider">⚙️</button>
      </div>

      <div id="messages"></div>

      <div id="plan-panel" class="hidden">
        <div class="panel-header plan-header">📋 Plan ready — execute it with the agent?</div>
        <div id="plan-content" class="plan-content"></div>
        <div class="button-row">
          <button id="execute-plan-btn" class="btn-primary">▶ Execute Plan</button>
          <button id="edit-plan-btn" class="btn-secondary">✎ Edit Plan</button>
          <button id="cancel-plan-btn" class="btn-secondary">Dismiss</button>
        </div>
      </div>

      <div id="approval-panel">
        <div id="approval-msg" class="panel-header approval-header">Agent wants to edit file...</div>
        <details id="approval-preview-details" class="approval-preview-details">
          <summary>Preview content</summary>
          <pre id="approval-preview" class="approval-preview"></pre>
        </details>
        <div class="button-row">
          <button id="allow-btn" class="btn-primary">Allow Edit</button>
          <button id="deny-btn" class="btn-secondary">Deny</button>
        </div>
      </div>

      <div id="delete-panel">
        <div id="delete-msg" class="panel-header delete-header">Agent wants to delete file...</div>
        <div class="button-row">
          <button id="allow-del-btn" class="btn-danger">Allow Delete</button>
          <button id="deny-del-btn" class="btn-secondary">Deny</button>
        </div>
      </div>

      <div id="command-panel">
        <div class="cmd-approval-title">
          <span class="cmd-approval-icon"></span>
          <span>Run <span id="command-shell-label" class="cmd-approval-shell">bash</span> command?</span>
        </div>
        <div id="command-msg" class="cmd-approval-preview">echo "hello"</div>
        <div class="cmd-approval-actions">
          <button id="allow-cmd-btn" class="cmd-allow-btn">Allow</button>
          <button id="deny-cmd-btn" class="cmd-deny-btn">Skip</button>
        </div>
      </div>

      <div id="pending-ops-panel" class="pending-ops-panel hidden">
        <div class="pending-ops-header">
          <button id="pending-ops-toggle" class="pending-ops-toggle">▼ Agent Changes</button>
          <div class="pending-ops-controls">
            <button id="approve-all-ops" class="btn-primary-sm" title="Keep every change and clear this list">✓ Keep All</button>
            <button id="reject-all-ops" class="btn-danger-sm" title="Restore every file to its state before the agent touched it">↶ Revert All</button>
          </div>
        </div>
        <div id="pending-ops-list" class="pending-ops-list"></div>
      </div>

      <div id="input-area">
        <div id="current-file-indicator" class="current-file-indicator">
          <span id="current-file-text">No file open</span>
        </div>
        <div class="input-row">
          <textarea id="prompt" rows="3" placeholder="Ask Continued... (type /plugins to list plugin commands)"></textarea>
          <input id="file-upload" type="file" style="display: none;" multiple>
          <button id="attach-file-btn" class="attach-file-btn" title="Attach text file(s) as context">📎</button>
        </div>
        <div id="attached-files" class="attached-files-container"></div>
        <div class="input-actions-row">
          <button id="send-btn">Send</button>
          <button id="cancel-agent-btn" class="cancel-agent-btn hidden" title="Cancel agent">✕ Cancel</button>
        </div>
      </div>
    </div>
  `,

  /**
   * Combine all HTML sections
   */
  getAllHTML(): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body>
        ${this.historyScreen}
        ${this.pluginsScreen}
        ${this.createPluginModal}
        ${harnessLayout}
        ${this.chatContainer}
      </body>
      </html>
    `;
  }
};
