/**
 * Centralized CSS styles for the chat view
 * Organized by component for maintainability
 */

export const styles = {
  // Global styles
  root: `
    :root {
      --border-radius-sm: 4px;
      --border-radius-md: 8px;
      --border-radius-lg: 12px;
      --transition-fast: 0.15s ease;
    }
  `,

  body: `
    body {
      padding: 12px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
  `,

  // Utility classes
  utilities: `
    .hidden { display: none !important; }
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
  `,

  // History screen
  historyScreen: `
    #history-screen {
      display: flex;
      flex-direction: column;
      gap: 12px;
      height: 100%;
    }
    .new-chat-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 14px;
      font-weight: 600;
      border-radius: var(--border-radius-md);
      cursor: pointer;
      text-align: center;
      transition: filter var(--transition-fast), transform var(--transition-fast);
      font-size: 13px;
    }
    .new-chat-btn:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }
    .new-chat-btn:active {
      transform: translateY(0);
    }
    .section-header {
      font-size: 11px;
      font-weight: 700;
      margin-top: 8px;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    #sessions-list-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow-y: auto;
      flex-grow: 1;
    }
    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-keybindingTable-rowsBackground, var(--vscode-textBlockQuote-background));
      padding: 10px 12px;
      border-radius: var(--border-radius-md);
      cursor: pointer;
      border: 1px solid var(--vscode-widget-border, transparent);
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }
    .session-item:hover {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-hoverBackground);
    }
    .session-title {
      flex-grow: 1;
      font-size: 12.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 8px;
    }
    .delete-session-btn {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: var(--border-radius-sm);
      transition: color var(--transition-fast), background var(--transition-fast);
    }
    .delete-session-btn:hover {
      color: var(--vscode-errorForeground);
      background: var(--vscode-list-invalidItemForeground, rgba(255, 0, 0, 0.1));
    }
  `,

  // Chat container
  chatContainer: `
    #chat-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    #controls-row {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
      align-items: center;
      width: 100%;
      background: var(--vscode-editor-background);
      padding: 6px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
    }
    select, button.control-btn {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 5px 8px;
      font-size: 12px;
      border-radius: var(--border-radius-sm);
      outline: none;
    }
    select {
      cursor: pointer;
    }
    button.control-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      cursor: pointer;
    }
  `,

  // Messages
  messages: `
    #messages {
      flex-grow: 1;
      overflow-y: auto;
      margin-bottom: 12px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      padding: 10px 14px;
      border-radius: var(--border-radius-md);
      word-wrap: break-word;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.45;
      max-width: 90%;
    }
    .user-msg-wrap {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 3px;
      align-self: flex-end;
      max-width: 90%;
    }
    .user-msg-wrap .message.user {
      max-width: 100%;
      align-self: unset;
    }
    .resend-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 13px;
      padding: 1px 4px;
      border-radius: 4px;
      opacity: 0.5;
      transition: opacity 0.15s ease;
      line-height: 1;
    }
    .resend-btn:hover { opacity: 1; color: var(--vscode-button-background); }
    .agent-status-box {
      align-self: stretch;
      margin: 4px 0 6px 0;
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-button-background);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      font-size: 11px;
      overflow: hidden;
      animation: slideUp 0.18s cubic-bezier(.16,1,.3,1);
    }
    .agent-status-box.hidden { display: none !important; }
    .agent-status-header {
      padding: 5px 10px;
      font-weight: 600;
      font-size: 11px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-status-thinking {
      padding: 6px 10px;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      max-height: 80px;
      overflow-y: auto;
      min-height: 0;
    }
    .agent-status-thinking:empty { display: none; }
    .user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
      border-bottom-right-radius: 2px;
    }
    .ai {
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-foreground);
      align-self: flex-start;
      border-top-left-radius: 2px;
      white-space: normal;
    }
    .ai p { margin: 0 0 8px 0; }
    .ai p:last-child { margin-bottom: 0; }
    .ai h1, .ai h2, .ai h3, .ai h4, .ai h5, .ai h6 { margin: 10px 0 8px 0; line-height: 1.25; }
    .ai h1 { font-size: 17px; }
    .ai h2 { font-size: 16px; }
    .ai h3 { font-size: 14px; }
    .ai ul, .ai ol { margin: 6px 0 10px 20px; padding: 0; }
    .ai li { margin: 3px 0; }
    .ai blockquote {
      margin: 8px 0;
      padding: 6px 10px;
      border-left: 3px solid var(--vscode-textLink-foreground);
      background: var(--vscode-editor-background);
      border-radius: 4px;
    }
    .ai a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .ai a:hover { text-decoration: underline; }
    .ai code.inline-code {
      background: var(--vscode-textCodeBlock-background, rgba(120, 120, 120, 0.15));
      padding: 2px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
  `,

  // Code blocks
  codeBlock: `
    .md-code-block {
      margin: 10px 0;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .md-code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
      color: var(--vscode-descriptionForeground);
      padding: 6px 10px;
      font-size: 11px;
      font-family: var(--vscode-font-family);
    }
    .md-code-lang {
      text-transform: uppercase;
      font-weight: 600;
    }
    .md-copy-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .md-copy-btn:hover {
      filter: brightness(1.08);
    }
    .md-code-pre {
      margin: 0;
      padding: 10px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.45;
      color: var(--vscode-editor-foreground);
    }
  `,

  // Tool inline display
  toolInline: `
    .tool-inline {
      margin-top: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      overflow: hidden;
    }
    .tool-inline-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      font-size: 11px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    .tool-inline-title {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .tool-inline-command {
      padding: 8px 10px;
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      overflow-x: auto;
    }
    .tool-inline-note {
      margin: 0;
      padding: 8px 10px;
      font-size: 12px;
    }
    .tool-inline details {
      padding: 0 10px 10px;
    }
    .tool-inline summary {
      cursor: pointer;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .tool-inline-output {
      margin: 8px 0 0;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      max-height: 200px;
      overflow: auto;
    }
  `,

  // Approval panels
  approvalPanel: `
    #approval-panel, #delete-panel, #command-panel, #save-discard-panel {
      display: none;
      flex-direction: column;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      padding: 12px;
      margin-bottom: 12px;
      border-radius: var(--border-radius-lg);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes slideUp {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .panel-header {
      font-size: 12px;
      margin-bottom: 10px;
      font-weight: 600;
      line-height: 1.3;
    }
    .approval-header { color: var(--vscode-editorWarning-foreground); }
    .delete-header { color: var(--vscode-errorForeground); }
    .save-discard-header { color: var(--vscode-editorInfo-foreground); }
    .plan-header { color: var(--vscode-textLink-foreground); }
    .approval-preview-details {
      margin-bottom: 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .approval-preview-details summary { cursor: pointer; }
    .approval-preview {
      margin: 6px 0 0 0;
      padding: 8px;
      max-height: 160px;
      overflow: auto;
      background: var(--vscode-textCodeBlock-background);
      border-radius: var(--border-radius-sm);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre;
      color: var(--vscode-editor-foreground);
    }
    .message.ai.agent-action {
      opacity: 0.9;
      font-size: 12px;
    }
    .tool-inline.tool-failed {
      border-left: 3px solid var(--vscode-errorForeground, #f48771);
    }
    .tool-inline.tool-failed .tool-inline-title {
      color: var(--vscode-errorForeground, #f48771);
    }
    .plugin-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
      word-break: break-word;
    }
    .plugin-meta {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .plugin-badge {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 1px 5px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .plugin-id {
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
  `,

  // Plan panel
  planPanel: `
    #plan-panel {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-textLink-foreground);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #plan-panel.hidden { display: none; }
    .plan-content {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px 12px;
      border-radius: 4px;
      max-height: 250px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
      color: var(--vscode-foreground);
    }
  `,

  // Button rows
  buttonRow: `
    .button-row {
      display: flex;
      gap: 8px;
    }
    .button-row button {
      flex: 1;
      padding: 6px 10px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      border-radius: var(--border-radius-sm);
      transition: filter var(--transition-fast);
    }
    .button-row button:hover { filter: brightness(1.1); }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-danger {
      background: var(--vscode-errorForeground);
      color: #fff;
    }
  `,

  // Command panel
  commandPanel: `
    #command-panel {
      border-color: var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
      background: var(--vscode-editorWidget-background);
      gap: 8px;
    }
    .cmd-approval-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 600;
    }
    .cmd-approval-icon {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiBlue, var(--vscode-button-background));
      display: inline-block;
      position: relative;
    }
    .cmd-approval-icon::after {
      content: '';
      position: absolute;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #fff;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    .cmd-approval-shell {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 1px 7px;
    }
    .cmd-approval-preview {
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border-radius: 8px;
      padding: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .cmd-approval-actions {
      display: flex;
      gap: 8px;
    }
    .cmd-approval-actions button {
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .cmd-allow-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .cmd-deny-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `,

  // Input area
  inputArea: `
    #input-area {
      display: flex;
      flex-direction: column;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius-lg);
      padding: 8px;
      transition: border-color var(--transition-fast);
    }
    #input-area:focus-within {
      border-color: var(--vscode-focusBorder);
    }    .input-actions-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    #send-btn {
      flex: 1;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 7px 12px;
      border-radius: var(--border-radius-sm);
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
      transition: filter var(--transition-fast);
      position: relative;
      overflow: hidden;
    }
    #send-btn:hover:not(:disabled) { filter: brightness(1.12); }
    #send-btn:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }
    #send-btn.working {
      background: var(--vscode-button-background);
      animation: pulse-btn 1.4s ease-in-out infinite;
    }
    @keyframes pulse-btn {
      0%, 100% { filter: brightness(1); }
      50%       { filter: brightness(1.3); }
    }
    .cancel-agent-btn {
      background: var(--vscode-errorForeground);
      color: #fff;
      border: none;
      padding: 7px 10px;
      border-radius: var(--border-radius-sm);
      font-weight: 600;
      font-size: 11px;
      cursor: pointer;
      transition: filter var(--transition-fast);
      white-space: nowrap;
    }
    .cancel-agent-btn:hover { filter: brightness(1.12); }
    .cancel-agent-btn.hidden { display: none !important; }
  `,

  // Input area (rest)
  inputAreaRest: `
    .current-file-indicator {
      background: var(--vscode-sideBarSectionHeader-background, rgba(255, 255, 255, 0.05));
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    #current-file-text {
      font-family: monospace;
      font-size: 11px;
      color: var(--vscode-foreground);
    }
    .input-row {
      display: flex;
      gap: 6px;
      margin-bottom: 6px;
    }
    textarea#prompt {
      flex: 1;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius-sm);
      padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      outline: none;
      resize: none;
    }
    textarea#prompt:focus {
      border-color: var(--vscode-focusBorder);
    }
    .attach-file-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 6px 10px;
      border-radius: var(--border-radius-sm);
      cursor: pointer;
      font-size: 16px;
      transition: filter var(--transition-fast);
    }
    .attach-file-btn:hover {
      filter: brightness(1.1);
    }
  `,

  // Attached files
  attachedFiles: `
    .attached-files-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 6px;
    }
    .attached-file-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius-sm);
      padding: 6px 8px;
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 11px;
    }
    .attached-file-icon {
      font-size: 12px;
      flex-shrink: 0;
    }
    .attached-file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: monospace;
    }
    .attached-file-remove {
      cursor: pointer;
      background: none;
      border: none;
      color: inherit;
      padding: 0;
      font-size: 14px;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .attached-file-remove:hover {
      opacity: 1;
    }
  `,

  // Pending operations panel
  pendingOps: `
    .pending-ops-panel {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius-md);
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      max-height: 60vh;
      overflow-y: auto;
    }
    .pending-ops-panel.hidden {
      display: none;
    }
    .pending-ops-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
      padding: 6px 10px;
      gap: 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .pending-ops-toggle {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      font-weight: 600;
      font-size: 11px;
      cursor: pointer;
      padding: 2px 4px;
      flex: 1;
      text-align: left;
      transition: color 0.15s;
      white-space: nowrap;
    }
    .pending-ops-toggle:hover {
      color: var(--vscode-textLink-foreground);
    }
    .pending-ops-controls {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .btn-primary-sm {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s;
      white-space: nowrap;
    }
    .btn-primary-sm:hover {
      filter: brightness(1.1);
    }
    .btn-danger-sm {
      background: var(--vscode-errorForeground);
      color: #ffffff;
      border: none;
      border-radius: 2px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s;
      white-space: nowrap;
    }
    .btn-danger-sm:hover {
      filter: brightness(1.1);
    }
    .pending-ops-list {
      display: flex;
      flex-direction: column;
      padding: 4px;
      gap: 3px;
      flex-grow: 1;
      overflow-y: auto;
    }
    .pending-op-item {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 4px 6px;
      display: flex;
      flex-direction: row;
      gap: 4px;
      align-items: center;
    }
    .pending-op-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .pending-op-type {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .pending-op-type.write {
      background: var(--vscode-debugConsole-infoForeground);
      color: #ffffff;
    }
    .pending-op-type.delete {
      background: var(--vscode-errorForeground);
      color: #ffffff;
    }
    .pending-op-path {
      font-family: monospace;
      font-size: 10px;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
  `,

  // Plugins screen
  pluginsScreen: `
    #plugins-screen {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 8px;
    }
    .plugins-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius-md);
      background: var(--vscode-editor-background);
    }
    .plugins-actions .plugins-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }
    .plugins-actions .plugins-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .plugin-card {
      background: var(--vscode-keybindingTable-rowsBackground, var(--vscode-textBlockQuote-background));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: var(--border-radius-md);
      padding: 10px 12px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }
    .plugin-card:hover {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-hoverBackground);
    }
    .plugin-card input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .plugin-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .plugin-card-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
      flex-shrink: 0;
    }
    .plugin-action-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: var(--border-radius-sm);
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      font-weight: 600;
      transition: filter var(--transition-fast);
    }
    .plugin-action-btn:hover {
      filter: brightness(1.1);
    }
    .plugin-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .plugin-type {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
  `,

  // Create plugin modal
  createPluginModal: `
    #create-plugin-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    #create-plugin-modal.hidden {
      display: none;
    }
    .modal-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius-lg);
      padding: 20px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .modal-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 16px;
      color: var(--vscode-foreground);
    }
    .modal-input-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }
    .modal-input-group label {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .modal-input-group input,
    .modal-input-group select,
    .modal-input-group textarea {
      background: var(--vscode-input-background);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius-sm);
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .modal-input-group input:focus,
    .modal-input-group select:focus,
    .modal-input-group textarea:focus {
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .modal-input-group textarea {
      min-height: 100px;
      resize: vertical;
    }
    .modal-buttons {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .modal-buttons button {
      border: none;
      padding: 8px 16px;
      border-radius: var(--border-radius-sm);
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
      transition: filter var(--transition-fast);
    }
    .modal-buttons button:hover {
      filter: brightness(1.1);
    }
    .modal-btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .modal-btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `,

  /**
   * Combine all styles into a single string
   */
  getAllStyles(): string {
    return `
      <style>
        ${this.root}
        ${this.body}
        ${this.utilities}
        ${this.historyScreen}
        ${this.chatContainer}
        ${this.messages}
        ${this.codeBlock}
        ${this.toolInline}
        ${this.approvalPanel}
        ${this.planPanel}
        ${this.buttonRow}
        ${this.commandPanel}
        ${this.inputArea}
        ${this.inputAreaRest}
        ${this.attachedFiles}
        ${this.pendingOps}
        ${this.pluginsScreen}
        ${this.createPluginModal}
      </style>
    `;
  }
};
