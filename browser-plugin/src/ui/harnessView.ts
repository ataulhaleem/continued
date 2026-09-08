/**
 * Harness dashboard — layout, styles and webview script.
 *
 * The builder is an n8n-style vertical flow canvas: Start → nodes → End, with (+)
 * slots on every connector, parallel groups rendered as side-by-side lanes, loops
 * and sequences as containers, drag-and-drop between slots, and a properties panel
 * for the selected node.
 *
 * The script is plain JS that runs inside the webview. It is kept free of template
 * literals so it can live inside this TypeScript template string without escaping.
 * It exposes `window.ContinuedHarness = { init, open, onMessage }`.
 */

export const harnessLayout = `
    <div id="harness-screen" class="hidden">
      <div class="harness-topbar">
        <button id="harness-back-btn" class="control-btn" title="Back to chat">⬅</button>
        <div class="harness-tabs">
          <button class="harness-tab active" data-tab="list">Harnesses</button>
          <button class="harness-tab" data-tab="builder">Builder</button>
          <button class="harness-tab" data-tab="run">Run</button>
        </div>
        <button id="harness-reload-btn" class="control-btn" title="Reload harnesses and plugins from disk">↻</button>
      </div>
      <div id="harness-error" class="harness-error hidden"></div>

      <div id="harness-tab-list" class="harness-tab-panel">
        <div class="plugins-hint">
          A harness is a fixed workflow: tools, resources, skills and model calls run in order, in parallel, or per item.
          Every harness is also a skill the agent can call with <strong>use-skill</strong>, and you can run one in chat with <strong>/harness &lt;id&gt;</strong>.
        </div>
        <div class="modal-input-group">
          <label for="harness-select">Harness</label>
          <select id="harness-select"></select>
        </div>
        <div id="harness-detail" class="harness-detail"></div>
        <div class="modal-input-group" id="harness-input-group">
          <label id="harness-input-label" for="harness-input">Input</label>
          <textarea id="harness-input" rows="2" placeholder=""></textarea>
        </div>
        <div class="harness-actions">
          <button id="harness-run-btn" class="btn-primary">▶ Run</button>
          <button id="harness-edit-btn" class="plugin-action-btn">Edit</button>
          <button id="harness-duplicate-btn" class="plugin-action-btn">Duplicate</button>
          <button id="harness-delete-btn" class="plugin-action-btn">Delete</button>
          <button id="harness-open-btn" class="plugin-action-btn" title="Open the JSON file">JSON</button>
          <button id="harness-new-btn" class="plugin-action-btn">+ New</button>
        </div>
        <div id="harness-problems" class="harness-problems hidden"></div>
      </div>

      <div id="harness-tab-builder" class="harness-tab-panel hidden">
        <div class="harness-form-grid">
          <div class="modal-input-group"><label for="hb-name">Name</label><input id="hb-name" type="text" placeholder="e.g. Review TODOs"></div>
          <div class="modal-input-group"><label for="hb-id">Id</label><input id="hb-id" type="text" placeholder="review-todos-harness"></div>
        </div>
        <div class="hb-toolbar">
          <span class="hb-toolbar-hint">Click <b>+</b> to insert · click a node to edit · drag nodes onto <b>+</b> · <b>⇶</b> makes a node parallel</span>
        </div>
        <div id="hb-canvas" class="hb-canvas"></div>
        <div id="hb-props" class="hb-props hidden"></div>
        <details class="harness-details">
          <summary>Variables you can use in any field</summary>
          <div id="hb-variables" class="harness-variables"></div>
        </details>
        <div class="harness-actions">
          <button id="hb-save-btn" class="btn-primary">💾 Save</button>
          <button id="hb-save-run-btn" class="plugin-action-btn">Save &amp; Run</button>
          <button id="hb-cancel-btn" class="plugin-action-btn">Cancel</button>
        </div>
        <div id="hb-menu" class="hb-menu hidden"></div>
      </div>

      <div id="harness-tab-run" class="harness-tab-panel hidden">
        <div id="harness-run-header" class="harness-run-header">No harness has run yet.</div>
        <div class="harness-actions"><button id="harness-stop-btn" class="btn-danger hidden">■ Stop</button></div>
        <div id="harness-run-steps" class="harness-run-steps"></div>
        <div id="harness-run-output" class="harness-run-output"></div>
      </div>
    </div>
`;

export const harnessStyles = `
    #harness-screen { display: flex; flex-direction: column; height: 100%; gap: 8px; overflow: hidden; }
    #harness-screen.hidden { display: none; }
    .harness-topbar { display: flex; align-items: center; gap: 6px; }
    .harness-tabs { display: flex; gap: 2px; flex: 1; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius-md); padding: 2px; }
    .harness-tab { flex: 1; border: none; background: transparent; color: var(--vscode-descriptionForeground); padding: 5px 6px; border-radius: var(--border-radius-sm); cursor: pointer; font-size: 11px; font-weight: 600; }
    .harness-tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .harness-tab-panel { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1; min-height: 0; padding-right: 2px; position: relative; }
    .harness-tab-panel.hidden { display: none; }
    .harness-error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-errorForeground); padding: 8px; border-radius: var(--border-radius-sm); font-size: 11px; white-space: pre-wrap; }
    .harness-error.hidden { display: none; }
    .harness-problems { font-size: 11px; color: var(--vscode-editorWarning-foreground); white-space: pre-wrap; }
    .harness-problems.hidden { display: none; }
    .harness-detail { font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
    .harness-detail .plugin-desc { font-size: 12px; }
    .harness-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .harness-actions .btn-primary, .harness-actions .btn-danger { padding: 6px 12px; font-size: 12px; }
    .harness-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .harness-form-grid .modal-input-group { margin-bottom: 0; }
    #harness-screen .modal-input-group { margin-bottom: 0; gap: 4px; }
    #harness-screen .modal-input-group textarea { min-height: 48px; }
    .harness-details { font-size: 11px; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-widget-border, #444); border-radius: var(--border-radius-sm); padding: 6px 8px; }
    .harness-details summary { cursor: pointer; font-weight: 600; }
    .harness-details > *:not(summary) { margin-top: 6px; }
    .harness-check { font-size: 11px; display: flex; align-items: center; gap: 6px; }
    .harness-variables { display: flex; flex-wrap: wrap; gap: 4px; }
    .harness-variables code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-size: 10px; cursor: pointer; }
    .hb-toolbar { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* ---- canvas ---- */
    .hb-canvas { display: flex; flex-direction: column; align-items: center; padding: 6px 0 10px 0; overflow-x: auto; background: radial-gradient(var(--vscode-widget-border, #3a3a3a) 1px, transparent 1px); background-size: 14px 14px; border-radius: var(--border-radius-md); border: 1px solid var(--vscode-widget-border, #333); }
    .hb-flow { display: flex; flex-direction: column; align-items: center; }
    .hb-terminal { border-radius: 999px; padding: 4px 14px; font-size: 11px; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); cursor: pointer; border: 2px solid transparent; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
    .hb-terminal.selected { border-color: var(--vscode-focusBorder); }
    .hb-slot { display: flex; flex-direction: column; align-items: center; }
    .hb-line { width: 2px; height: 9px; background: var(--vscode-widget-border, #666); }
    .hb-plus { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--vscode-widget-border, #666); background: var(--vscode-editor-background); color: var(--vscode-foreground); font-size: 13px; line-height: 16px; text-align: center; cursor: pointer; opacity: 0.75; transition: transform 0.1s, opacity 0.1s; user-select: none; }
    .hb-plus:hover { opacity: 1; transform: scale(1.2); border-color: var(--vscode-focusBorder); }
    .hb-slot.drop-ok .hb-plus { opacity: 1; transform: scale(1.35); background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); border-color: var(--vscode-focusBorder); }
    .hb-slot.empty .hb-plus { width: auto; border-radius: 999px; padding: 0 10px; font-size: 10px; line-height: 18px; }
    .hb-node { position: relative; width: 196px; box-sizing: border-box; border: 1px solid var(--vscode-widget-border, #555); border-radius: 8px; padding: 6px 8px; background: var(--vscode-editorWidget-background); cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
    .hb-node:hover { border-color: var(--vscode-textLink-foreground); }
    .hb-node.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .hb-node.dragging { opacity: 0.4; }
    .hb-node.st-done { border-left: 4px solid var(--vscode-testing-iconPassed, #3fb950); }
    .hb-node.st-failed { border-left: 4px solid var(--vscode-errorForeground); }
    .hb-node.st-running { border-left: 4px solid var(--vscode-progressBar-background, #0a84ff); }
    .hb-node.st-skipped { opacity: 0.6; }
    .hb-node-title { display: flex; gap: 6px; align-items: center; font-size: 12px; font-weight: 600; min-width: 0; }
    .hb-node-title .id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-node-sub { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .hb-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
    .hb-chip { font-size: 9px; padding: 0 5px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .hb-chip.warn { background: var(--vscode-editorWarning-foreground); color: #000; }
    .hb-node-actions { position: absolute; top: -9px; right: -6px; display: none; gap: 2px; }
    .hb-node:hover > .hb-node-actions, .hb-node.selected > .hb-node-actions, .hb-group-head:hover > .hb-node-actions { display: flex; }
    .hb-act { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--vscode-widget-border, #666); background: var(--vscode-editor-background); color: var(--vscode-foreground); font-size: 10px; line-height: 16px; text-align: center; cursor: pointer; padding: 0; }
    .hb-act:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
    .hb-act.danger:hover { color: var(--vscode-errorForeground); }
    .hb-group { border: 1px dashed var(--vscode-editorWarning-foreground); border-radius: 10px; padding: 4px 6px 6px 6px; background: rgba(127,127,127,0.06); max-width: 100%; }
    .hb-group.sequence { border-color: var(--vscode-textLink-foreground); }
    .hb-group.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .hb-group-head { position: relative; display: flex; gap: 6px; align-items: center; font-size: 11px; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 6px; white-space: nowrap; }
    .hb-group-head:hover { background: var(--vscode-toolbar-hoverBackground); }
    .hb-group-head .sub { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 10px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
    .hb-lanes { display: flex; gap: 8px; align-items: flex-start; overflow-x: auto; padding: 2px; }
    .hb-lane { display: flex; flex-direction: column; align-items: center; min-width: 120px; padding: 2px; border-radius: 8px; }
    .hb-lane-add { align-self: center; margin-top: 30px; white-space: nowrap; }
    .hb-lane .hb-node { width: 170px; }
    .hb-group-body { display: flex; flex-direction: column; align-items: center; }

    /* ---- insert menu ---- */
    .hb-menu { position: absolute; z-index: 60; width: 250px; max-height: 300px; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #555); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .hb-menu.hidden { display: none; }
    .hb-menu input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 6px; font-size: 11px; margin-bottom: 4px; }
    .hb-menu-group { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 6px 4px 2px 4px; }
    .hb-menu-item { padding: 4px 6px; cursor: pointer; font-size: 11px; border-radius: 4px; display: flex; gap: 6px; align-items: baseline; }
    .hb-menu-item:hover, .hb-menu-item.active { background: var(--vscode-list-hoverBackground); }
    .hb-menu-item .desc { color: var(--vscode-descriptionForeground); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-menu-title { font-size: 11px; font-weight: 600; margin: 0 4px 4px 4px; }

    /* ---- properties panel ---- */
    .hb-props { border: 1px solid var(--vscode-focusBorder); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--vscode-editorWidget-background); }
    .hb-props.hidden { display: none; }
    .hb-props-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
    .hb-props-head .close { margin-left: auto; }
    .hb-props label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
    .hb-props input, .hb-props select, .hb-props textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--border-radius-sm); padding: 5px 6px; font-size: 11px; font-family: var(--vscode-font-family); width: 100%; box-sizing: border-box; }
    .hb-props textarea { min-height: 48px; resize: vertical; font-family: var(--vscode-editor-font-family); }
    .hb-props .field { display: flex; flex-direction: column; gap: 3px; }
    .hb-props .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .hb-props .field-hint { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* ---- run tab ---- */
    .harness-run-header { font-size: 12px; font-weight: 600; display: flex; flex-direction: column; gap: 4px; }
    .harness-run-header .harness-run-error { font-weight: 400; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .harness-run-steps { display: flex; flex-direction: column; gap: 4px; }
    .harness-run-step { border-left: 3px solid var(--vscode-widget-border, #555); padding: 4px 8px; font-size: 11px; background: var(--vscode-editorWidget-background); border-radius: 0 var(--border-radius-sm) var(--border-radius-sm) 0; }
    .harness-run-step.done { border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
    .harness-run-step.failed { border-left-color: var(--vscode-errorForeground); }
    .harness-run-step.running { border-left-color: var(--vscode-progressBar-background, #0a84ff); }
    .harness-run-step.skipped { opacity: 0.6; }
    .harness-run-step-head { display: flex; gap: 6px; align-items: baseline; }
    .harness-run-step-head .id { font-family: var(--vscode-editor-font-family); }
    .harness-run-step-head .meta { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: auto; white-space: nowrap; }
    .harness-run-step .err { color: var(--vscode-errorForeground); white-space: pre-wrap; margin-top: 2px; }
    .harness-run-step .notes { color: var(--vscode-descriptionForeground); white-space: pre-wrap; margin-top: 2px; font-size: 10px; }
    .harness-run-step details { margin-top: 3px; }
    .harness-run-step details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .harness-run-step pre { margin: 4px 0 0 0; max-height: 220px; overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: var(--border-radius-sm); font-size: 10px; white-space: pre-wrap; word-break: break-word; }
    .harness-run-children { margin-left: 8px; margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
    .harness-run-output { font-size: 12px; }
    .harness-run-output .message.ai { margin: 0; max-width: 100%; }
    .harness-empty { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }
    .harness-steps-header { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
`;

export const harnessScript = `
window.ContinuedHarness = (function () {
  var vscode = null;
  var api = null;
  var catalog = { harnesses: [], plugins: { tools: [], resources: [], skills: [] }, variables: [], problems: [] };
  var draft = null;
  var draftIdTouched = false;
  var selected = null;      // step object, or 'start' / 'end'
  var dragging = null;      // { step, arr, index }
  var run = null;
  var activeTab = 'list';
  var pendingRunAfterSave = null;
  var el = {};
  var GROUP_TYPES = { parallel: true, foreach: true, sequence: true };
  var ICONS = { tool: '🔧', resource: '📦', skill: '🧩', llm: '🧠', parallel: '⇶', foreach: '↻', sequence: '⋯' };

  function $(id) { return document.getElementById(id); }
  function esc(text) { return api.escapeHtml(text); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function showError(message) {
    el.error.textContent = message || '';
    el.error.classList.toggle('hidden', !message);
    if (message) { el.error.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------------------------------------------------------------- tabs
  function switchTab(tab) {
    activeTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.harness-tab'), function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    el.tabList.classList.toggle('hidden', tab !== 'list');
    el.tabBuilder.classList.toggle('hidden', tab !== 'builder');
    el.tabRun.classList.toggle('hidden', tab !== 'run');
    showError('');
    closeMenu();
    if (tab === 'builder' && !draft) { newDraft(); }
    if (tab === 'builder') { renderCanvas(); }
  }
  function open() { el.screen.classList.remove('hidden'); vscode.postMessage({ type: 'harnessCatalog' }); }
  function close() { el.screen.classList.add('hidden'); api.showChat(); }

  // ---------------------------------------------------------------- list tab
  function selectedHarness() {
    var id = el.select.value;
    for (var i = 0; i < catalog.harnesses.length; i++) { if (catalog.harnesses[i].id === id) { return catalog.harnesses[i]; } }
    return null;
  }
  function renderList() {
    var previous = el.select.value;
    el.select.innerHTML = '';
    [['built-in', 'Built-in'], ['user', 'Your harnesses']].forEach(function (g) {
      var items = catalog.harnesses.filter(function (x) { return x.source === g[0]; });
      if (!items.length) { return; }
      var og = document.createElement('optgroup'); og.label = g[1];
      items.forEach(function (x) { var opt = document.createElement('option'); opt.value = x.id; opt.textContent = x.name + ' (' + x.stepCount + ' step' + (x.stepCount === 1 ? '' : 's') + ')'; og.appendChild(opt); });
      el.select.appendChild(og);
    });
    if (previous && catalog.harnesses.some(function (x) { return x.id === previous; })) { el.select.value = previous; }
    renderDetail();
    var hasProblems = catalog.problems && catalog.problems.length;
    el.problems.textContent = hasProblems ? 'Some harness files could not be loaded:\\n' + catalog.problems.join('\\n') : '';
    el.problems.classList.toggle('hidden', !hasProblems);
  }
  function renderDetail() {
    var x = selectedHarness();
    if (!x) { el.detail.innerHTML = '<div class="harness-empty">No harnesses available.</div>'; el.inputGroup.style.display = 'none'; return; }
    el.detail.innerHTML = '<div class="plugin-meta"><span class="plugin-badge">' + esc(x.source) + '</span><span class="plugin-id">' + esc(x.id) + '</span></div><div class="plugin-desc">' + esc(x.description || '(no description)') + '</div>';
    var inp = x.input || null;
    el.inputGroup.style.display = '';
    el.inputLabel.textContent = (inp && inp.label ? inp.label : 'Input') + (inp && inp.required ? ' (required)' : ' (optional)');
    el.input.placeholder = inp && inp.placeholder ? inp.placeholder : 'Free text available to steps as {{input}}';
    var isUser = x.source === 'user';
    el.editBtn.disabled = !isUser;
    el.editBtn.title = isUser ? 'Edit in the builder' : 'Built-in harnesses cannot be edited — duplicate it first';
    el.deleteBtn.disabled = !isUser;
    el.openBtn.disabled = !isUser;
  }
  function runSelected() {
    var x = selectedHarness();
    if (!x) { return; }
    var input = el.input.value.trim();
    if (x.input && x.input.required && !input) { showError('This harness needs an input: ' + (x.input.label || 'input') + '.'); el.input.focus(); return; }
    showError('');
    run = null;
    switchTab('run');
    renderRun();
    vscode.postMessage({ type: 'harnessRun', id: x.id, input: input, model: api.getModel(), mode: api.getMode() });
  }

  // ---------------------------------------------------------------- draft helpers
  function newDraft() {
    draft = { id: '', name: '', description: '', source: 'user', input: { label: 'Input', placeholder: '', required: false }, steps: [], output: '' };
    draftIdTouched = false;
    selected = 'start';
    el.hbName.value = '';
    el.hbId.value = '';
    renderCanvas();
    renderProps();
    renderVariables();
  }
  function loadDraft(definition) {
    draft = JSON.parse(JSON.stringify(definition));
    if (!draft.input) { draft.input = { label: 'Input', placeholder: '', required: false }; }
    draftIdTouched = true;
    selected = null;
    el.hbName.value = draft.name || '';
    el.hbId.value = draft.id || '';
    renderCanvas();
    renderProps();
    renderVariables();
  }
  function slug(name) {
    var base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-harness';
    return base.slice(-8) === '-harness' ? base : base + '-harness';
  }
  function allStepIds(steps, acc) {
    acc = acc || [];
    (steps || []).forEach(function (s) { acc.push(s.id); if (s.steps) { allStepIds(s.steps, acc); } });
    return acc;
  }
  function uniqueStepId(prefix) {
    var ids = allStepIds(draft.steps);
    var n = 1;
    while (ids.indexOf(prefix + n) !== -1) { n++; }
    return prefix + n;
  }
  function findPlugin(kind, id) {
    var list = catalog.plugins[kind] || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }
  function makeStep(kind, pluginId) {
    if (kind === 'llm') { return { id: uniqueStepId('llm'), type: 'llm', prompt: '', expect: 'text' }; }
    if (kind === 'parallel') { return { id: uniqueStepId('parallel'), type: 'parallel', steps: [] }; }
    if (kind === 'sequence') { return { id: uniqueStepId('seq'), type: 'sequence', steps: [] }; }
    if (kind === 'foreach') { return { id: uniqueStepId('each'), type: 'foreach', items: '', itemVar: 'item', steps: [] }; }
    if (kind === 'resource') { return { id: uniqueStepId('resource'), type: 'resource', pluginId: pluginId }; }
    if (kind === 'skill') { return { id: uniqueStepId('skill'), type: 'skill', pluginId: pluginId, input: '' }; }
    var base = (pluginId || 'step').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 12) || 'step';
    var step = { id: uniqueStepId(base + '-'), type: 'tool', pluginId: pluginId, args: {} };
    var plugin = findPlugin('tools', pluginId);
    ((plugin && plugin.args) || []).forEach(function (a) { step.args[a.name] = a['default'] || ''; });
    return step;
  }
  function stepContainsArray(step, arr) {
    if (!step || !step.steps) { return false; }
    if (step.steps === arr) { return true; }
    for (var i = 0; i < step.steps.length; i++) { if (stepContainsArray(step.steps[i], arr)) { return true; } }
    return false;
  }
  function subtitleOf(step) {
    if (step.type === 'tool') { var p = findPlugin('tools', step.pluginId); return (p ? p.name : step.pluginId) + argsPreview(step); }
    if (step.type === 'resource') { var r = findPlugin('resources', step.pluginId); return r ? r.name : step.pluginId; }
    if (step.type === 'skill') { var s = findPlugin('skills', step.pluginId); return s ? s.name : step.pluginId; }
    if (step.type === 'llm') { return step.prompt ? step.prompt.replace(/\\s+/g, ' ').slice(0, 60) : '(no prompt yet)'; }
    if (step.type === 'foreach') { return 'for each of ' + (step.items || '?'); }
    if (step.type === 'parallel') { return (step.steps || []).length + ' lane(s)'; }
    if (step.type === 'sequence') { return (step.steps || []).length + ' step(s)'; }
    return '';
  }
  function argsPreview(step) {
    var keys = Object.keys(step.args || {}).filter(function (k) { return String(step.args[k] || '').trim(); });
    if (!keys.length) { return ''; }
    return ' · ' + keys.map(function (k) { return String(step.args[k]).replace(/\\s+/g, ' ').slice(0, 24); }).join(', ');
  }

  // ---------------------------------------------------------------- run status overlay
  function runStatusMap() {
    var map = {};
    if (!run || !draft || run.harnessId !== draft.id) { return map; }
    var visit = function (steps) { (steps || []).forEach(function (s) { if (s.id) { map[s.id] = s.status; } if (s.children) { visit(s.children); } }); };
    visit(run.steps);
    return map;
  }

  // ---------------------------------------------------------------- canvas
  function renderCanvas() {
    if (!draft) { return; }
    var statuses = runStatusMap();
    el.canvas.innerHTML = '';
    var start = h('div', 'hb-terminal' + (selected === 'start' ? ' selected' : ''), '▶ Start' + (draft.input && draft.input.label ? ' · ' + draft.input.label : ''));
    start.title = 'Harness settings and input';
    start.addEventListener('click', function () { select('start'); });
    el.canvas.appendChild(start);
    el.canvas.appendChild(renderFlow(draft.steps, statuses));
    var end = h('div', 'hb-terminal' + (selected === 'end' ? ' selected' : ''), '■ End' + (draft.output ? ' · ' + draft.output : ''));
    end.title = 'Output template';
    end.addEventListener('click', function () { select('end'); });
    el.canvas.appendChild(end);
  }

  function renderFlow(arr, statuses) {
    var col = h('div', 'hb-flow');
    col.appendChild(makeSlot({ arr: arr, index: 0 }, arr.length === 0));
    arr.forEach(function (step, i) {
      col.appendChild(renderNode(step, arr, i, statuses));
      col.appendChild(makeSlot({ arr: arr, index: i + 1 }, false));
    });
    return col;
  }

  // A slot inserts at target = { arr, index } or converts a lane: { parallel, laneIndex, position }
  function insertAt(target, step) {
    if (target.arr) { target.arr.splice(target.index, 0, step); return; }
    var lane = target.parallel.steps[target.laneIndex];
    if (lane.type === 'sequence') { lane.steps.splice(target.position === 'before' ? 0 : lane.steps.length, 0, step); return; }
    var seq = { id: uniqueStepId('lane'), type: 'sequence', steps: target.position === 'before' ? [step, lane] : [lane, step] };
    target.parallel.steps[target.laneIndex] = seq;
  }
  function targetArrayOf(target) {
    if (target.arr) { return target.arr; }
    var lane = target.parallel.steps[target.laneIndex];
    return lane.type === 'sequence' ? lane.steps : target.parallel.steps;
  }
  function makeSlot(target, isEmpty) {
    var slot = h('div', 'hb-slot' + (isEmpty ? ' empty' : ''));
    if (!isEmpty) { slot.appendChild(h('div', 'hb-line')); }
    var plus = h('div', 'hb-plus', isEmpty ? '+ add first step' : '+');
    plus.title = 'Insert a step here';
    plus.addEventListener('click', function (e) {
      e.stopPropagation();
      openMenu(plus, 'Insert step', function (step) { insertAt(target, step); select(step); });
    });
    slot.appendChild(plus);
    if (!isEmpty) { slot.appendChild(h('div', 'hb-line')); }
    slot.addEventListener('dragover', function (e) {
      if (!dragging) { return; }
      if (stepContainsArray(dragging.step, targetArrayOf(target))) { return; }
      e.preventDefault();
      slot.classList.add('drop-ok');
    });
    slot.addEventListener('dragleave', function () { slot.classList.remove('drop-ok'); });
    slot.addEventListener('drop', function (e) {
      e.preventDefault();
      slot.classList.remove('drop-ok');
      if (!dragging) { return; }
      var moving = dragging; dragging = null;
      if (stepContainsArray(moving.step, targetArrayOf(target))) { return; }
      var srcIdx = moving.arr.indexOf(moving.step);
      if (srcIdx === -1) { return; }
      if (target.parallel) {
        // Dropping a lane onto its own before/after slot is a no-op.
        if (target.parallel.steps[target.laneIndex] === moving.step) { return; }
        if (moving.arr === target.parallel.steps && srcIdx < target.laneIndex) { target.laneIndex--; }
      }
      // Remove from the source first, then fix up the target index if it was in the same array.
      moving.arr.splice(srcIdx, 1);
      if (target.arr && target.arr === moving.arr && target.index > srcIdx) { target.index--; }
      insertAt(target, moving.step);
      select(moving.step);
    });
    return slot;
  }

  function nodeActions(step, arr, index) {
    var actions = h('div', 'hb-node-actions');
    var par = h('button', 'hb-act', '⇶');
    par.title = 'Run this step in parallel with a new step';
    par.addEventListener('click', function (e) {
      e.stopPropagation();
      openMenu(par, 'Run in parallel with…', function (other) {
        var group = { id: uniqueStepId('parallel'), type: 'parallel', steps: [step, other] };
        arr.splice(index, 1, group);
        select(other);
      });
    });
    var del = h('button', 'hb-act danger', '✕');
    del.title = 'Remove';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      arr.splice(index, 1);
      if (selected === step) { selected = null; }
      renderCanvas(); renderProps();
    });
    actions.appendChild(par);
    actions.appendChild(del);
    return actions;
  }

  function makeDraggable(node, step, arr, index) {
    node.draggable = true;
    node.addEventListener('dragstart', function (e) {
      e.stopPropagation();
      dragging = { step: step, arr: arr, index: index };
      node.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', step.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
    });
    node.addEventListener('dragend', function () {
      dragging = null;
      node.classList.remove('dragging');
      Array.prototype.forEach.call(el.canvas.querySelectorAll('.drop-ok'), function (s) { s.classList.remove('drop-ok'); });
    });
  }

  function chipsFor(step) {
    var chips = h('div', 'hb-chips');
    if (step.onError && step.onError !== 'stop') { chips.appendChild(h('span', 'hb-chip warn', step.onError === 'continue' ? 'continue on error' : step.onError.replace(/-/g, ' '))); }
    if (step.when) { chips.appendChild(h('span', 'hb-chip', 'when ' + step.when.slice(0, 22))); }
    if (step.expect === 'json') { chips.appendChild(h('span', 'hb-chip', 'json')); }
    if (step.type === 'foreach' && step.parallel) { chips.appendChild(h('span', 'hb-chip', 'parallel')); }
    return chips.childNodes.length ? chips : null;
  }

  function renderNode(step, arr, index, statuses) {
    var status = statuses[step.id] ? ' st-' + statuses[step.id] : '';
    if (GROUP_TYPES[step.type]) { return renderGroup(step, arr, index, statuses, status); }
    var node = h('div', 'hb-node' + (selected === step ? ' selected' : '') + status);
    var title = h('div', 'hb-node-title');
    title.appendChild(h('span', '', ICONS[step.type] || '•'));
    title.appendChild(h('span', 'id', step.id));
    node.appendChild(title);
    node.appendChild(h('div', 'hb-node-sub', subtitleOf(step)));
    var chips = chipsFor(step);
    if (chips) { node.appendChild(chips); }
    node.appendChild(nodeActions(step, arr, index));
    node.addEventListener('click', function (e) { e.stopPropagation(); select(step); });
    makeDraggable(node, step, arr, index);
    return node;
  }

  function renderGroup(step, arr, index, statuses, status) {
    var group = h('div', 'hb-group ' + step.type + (selected === step ? ' selected' : ''));
    var head = h('div', 'hb-group-head' + status.replace(' st-', ' hb-node st-'));
    head.className = 'hb-group-head';
    head.appendChild(h('span', '', ICONS[step.type]));
    head.appendChild(h('span', '', step.id));
    head.appendChild(h('span', 'sub', subtitleOf(step)));
    if (statuses[step.id]) { head.appendChild(h('span', 'hb-chip', statuses[step.id])); }
    var chips = chipsFor(step);
    if (chips) { head.appendChild(chips); }
    head.appendChild(nodeActions(step, arr, index));
    head.addEventListener('click', function (e) { e.stopPropagation(); select(step); });
    makeDraggable(head, step, arr, index);
    group.appendChild(head);

    if (step.type === 'parallel') {
      var lanes = h('div', 'hb-lanes');
      step.steps.forEach(function (child, laneIndex) {
        var lane = h('div', 'hb-lane');
        if (child.type === 'sequence') {
          lane.appendChild(renderFlow(child.steps, statuses));
          var laneLabel = h('div', 'hb-chip', child.id);
          laneLabel.title = 'Lane settings';
          laneLabel.style.cursor = 'pointer';
          laneLabel.addEventListener('click', function (e) { e.stopPropagation(); select(child); });
          lane.insertBefore(laneLabel, lane.firstChild);
        } else {
          lane.appendChild(makeSlot({ parallel: step, laneIndex: laneIndex, position: 'before' }, false));
          lane.appendChild(renderNode(child, step.steps, laneIndex, statuses));
          lane.appendChild(makeSlot({ parallel: step, laneIndex: laneIndex, position: 'after' }, false));
        }
        lanes.appendChild(lane);
      });
      var addLane = h('button', 'plugin-action-btn hb-lane-add', '+ lane');
      addLane.title = 'Add another parallel branch';
      addLane.addEventListener('click', function (e) { e.stopPropagation(); openMenu(addLane, 'New lane starts with…', function (s) { step.steps.push(s); select(s); }); });
      lanes.appendChild(addLane);
      group.appendChild(lanes);
    } else {
      var body = h('div', 'hb-group-body');
      body.appendChild(renderFlow(step.steps, statuses));
      group.appendChild(body);
    }
    return group;
  }

  function select(what) {
    selected = what;
    renderCanvas();
    renderProps();
    if (what && what !== 'start' && what !== 'end') { el.props.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------------------------------------------------------------- insert menu
  var menuOnPick = null;
  function menuEntries() {
    var entries = [
      { group: 'Steps', kind: 'llm', label: '🧠 LLM step', desc: 'ask the model' },
      { group: 'Steps', kind: 'parallel', label: '⇶ Parallel group', desc: 'run lanes at once' },
      { group: 'Steps', kind: 'foreach', label: '↻ For each item', desc: 'loop over a list' },
      { group: 'Steps', kind: 'sequence', label: '⋯ Sequence', desc: 'group steps in order' }
    ];
    [['tools', 'tool', '🔧'], ['resources', 'resource', '📦'], ['skills', 'skill', '🧩']].forEach(function (k) {
      (catalog.plugins[k[0]] || []).forEach(function (p) {
        entries.push({ group: k[0].charAt(0).toUpperCase() + k[0].slice(1), kind: k[1], pluginId: p.id, label: k[2] + ' ' + p.name + (p.harness ? ' (harness)' : ''), desc: p.description || p.id });
      });
    });
    return entries;
  }
  function openMenu(anchor, title, onPick) {
    menuOnPick = onPick;
    var menu = el.menu;
    menu.innerHTML = '';
    menu.appendChild(h('div', 'hb-menu-title', title));
    var search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Type to filter…';
    menu.appendChild(search);
    var list = h('div', '');
    menu.appendChild(list);
    var entries = menuEntries();
    var renderItems = function () {
      var q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      var lastGroup = '';
      var first = true;
      entries.forEach(function (entry) {
        if (q && (entry.label + ' ' + entry.desc + ' ' + (entry.pluginId || '')).toLowerCase().indexOf(q) === -1) { return; }
        if (entry.group !== lastGroup) { list.appendChild(h('div', 'hb-menu-group', entry.group)); lastGroup = entry.group; }
        var item = h('div', 'hb-menu-item' + (first ? ' active' : ''));
        first = false;
        item.appendChild(h('span', '', entry.label));
        item.appendChild(h('span', 'desc', entry.desc));
        item.addEventListener('click', function () { pick(entry); });
        list.appendChild(item);
      });
      if (!list.childNodes.length) { list.appendChild(h('div', 'harness-empty', 'Nothing matches.')); }
    };
    var pick = function (entry) {
      var handler = menuOnPick;   // closeMenu() clears it, so grab it first
      closeMenu();
      var step = makeStep(entry.kind, entry.pluginId);
      if (handler) { handler(step); }
      renderCanvas();
      renderProps();
    };
    search.addEventListener('input', renderItems);
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeMenu(); }
      if (e.key === 'Enter') { var active = list.querySelector('.hb-menu-item.active'); if (active) { active.click(); } }
    });
    renderItems();
    // Position under the anchor, inside the builder panel.
    var panelRect = el.tabBuilder.getBoundingClientRect();
    var rect = anchor.getBoundingClientRect();
    var left = rect.left - panelRect.left + el.tabBuilder.scrollLeft;
    var top = rect.bottom - panelRect.top + el.tabBuilder.scrollTop + 4;
    var maxLeft = Math.max(0, el.tabBuilder.clientWidth - 254);
    menu.style.left = Math.min(left, maxLeft) + 'px';
    menu.style.top = top + 'px';
    menu.classList.remove('hidden');
    setTimeout(function () { search.focus(); }, 0);
  }
  function closeMenu() { el.menu.classList.add('hidden'); menuOnPick = null; }

  // ---------------------------------------------------------------- properties panel
  function field(labelText, control, hint) {
    var wrap = h('div', 'field');
    wrap.appendChild(h('label', '', labelText));
    wrap.appendChild(control);
    if (hint) { wrap.appendChild(h('div', 'field-hint', hint)); }
    return wrap;
  }
  function textInput(value, onChange, placeholder, multiline) {
    var input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) { input.type = 'text'; }
    input.value = value == null ? '' : String(value);
    if (placeholder) { input.placeholder = placeholder; }
    input.addEventListener('input', function () { onChange(input.value); });
    input.addEventListener('change', function () { renderCanvas(); });
    return input;
  }
  function selectInput(options, value, onChange) {
    var select = document.createElement('select');
    options.forEach(function (o) { var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; select.appendChild(opt); });
    select.value = value;
    if (select.value !== value && options.length) { select.value = options[0][0]; onChange(select.value); }
    select.addEventListener('change', function () { onChange(select.value); renderCanvas(); });
    return select;
  }
  function pluginOptions(kind) { return (catalog.plugins[kind] || []).map(function (p) { return [p.id, p.name + ' — ' + p.id]; }); }

  function renderProps() {
    var panel = el.props;
    panel.innerHTML = '';
    if (!selected) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var head = h('div', 'hb-props-head');
    var closeBtn = h('button', 'hb-act close', '✕');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', function () { select(null); });

    if (selected === 'start') {
      head.appendChild(h('span', '', '▶ Harness settings'));
      head.appendChild(closeBtn);
      panel.appendChild(head);
      panel.appendChild(field('Description (shown to the agent when it picks skills)', textInput(draft.description, function (v) { draft.description = v; }, '', true)));
      var row = h('div', 'field-row');
      row.appendChild(field('Input label', textInput(draft.input.label, function (v) { draft.input.label = v; }, 'Input')));
      row.appendChild(field('Input placeholder', textInput(draft.input.placeholder, function (v) { draft.input.placeholder = v; }, '')));
      panel.appendChild(row);
      var req = h('label', 'harness-check');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!draft.input.required;
      cb.addEventListener('change', function () { draft.input.required = cb.checked; });
      req.appendChild(cb); req.appendChild(document.createTextNode(' Input is required'));
      panel.appendChild(req);
      return;
    }
    if (selected === 'end') {
      head.appendChild(h('span', '', '■ Output'));
      head.appendChild(closeBtn);
      panel.appendChild(head);
      panel.appendChild(field('Output template (empty = output of the last step)', textInput(draft.output, function (v) { draft.output = v; }, '{{steps.report.output}}')));
      return;
    }

    var step = selected;
    head.appendChild(h('span', '', (ICONS[step.type] || '•') + ' ' + step.type));
    head.appendChild(closeBtn);
    panel.appendChild(head);
    var idRow = h('div', 'field-row');
    idRow.appendChild(field('Id', textInput(step.id, function (v) { step.id = v.trim(); }, 'step-id'), 'Reference: {{steps.' + step.id + '.output}}'));
    idRow.appendChild(field('Label', textInput(step.name, function (v) { step.name = v; }, 'optional')));
    panel.appendChild(idRow);

    if (step.type === 'tool') {
      panel.appendChild(field('Tool', selectInput(pluginOptions('tools'), step.pluginId, function (v) {
        step.pluginId = v;
        var plugin = findPlugin('tools', v);
        var next = {};
        ((plugin && plugin.args) || []).forEach(function (a) { next[a.name] = step.args && step.args[a.name] != null ? step.args[a.name] : (a['default'] || ''); });
        step.args = next;
        renderProps();
      })));
      var plugin = findPlugin('tools', step.pluginId);
      if (plugin && plugin.description) { panel.appendChild(h('div', 'field-hint', plugin.description)); }
      var specs = (plugin && plugin.args) || [];
      specs.forEach(function (a) {
        var multiline = a.multiline || a.name === 'content';
        panel.appendChild(field(a.name + (a.required ? ' *' : ''), textInput(step.args[a.name], function (v) { step.args[a.name] = v; }, a['default'] || '', multiline), a.description));
      });
      var extra = {};
      Object.keys(step.args || {}).forEach(function (k) { if (!specs.some(function (a) { return a.name === k; })) { extra[k] = step.args[k]; } });
      var argsJson = textInput(specs.length ? (Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '') : JSON.stringify(step.args || {}, null, 2), function (v) {
        try {
          var parsed = v.trim() ? JSON.parse(v) : {};
          if (specs.length) { specs.forEach(function (a) { parsed[a.name] = step.args[a.name]; }); }
          step.args = parsed;
          argsJson.style.borderColor = '';
        } catch (e) { argsJson.style.borderColor = 'var(--vscode-errorForeground)'; }
      }, '{ "key": "value" }', true);
      panel.appendChild(field(specs.length ? 'Extra args (JSON, optional)' : 'Args (JSON)', argsJson, 'Values may contain {{variables}}; "true"/"false" and numbers are converted.'));
    } else if (step.type === 'resource') {
      panel.appendChild(field('Resource', selectInput(pluginOptions('resources'), step.pluginId, function (v) { step.pluginId = v; })));
    } else if (step.type === 'skill') {
      panel.appendChild(field('Skill / harness', selectInput(pluginOptions('skills'), step.pluginId, function (v) { step.pluginId = v; })));
      panel.appendChild(field('Input (optional)', textInput(step.input, function (v) { step.input = v; }, '{{input}}')));
    } else if (step.type === 'llm') {
      panel.appendChild(field('Prompt *', textInput(step.prompt, function (v) { step.prompt = v; }, 'Using the run context, …', true), 'The model always receives the outputs and errors of every earlier step. Ask for the exact format you need.'));
      var lrow = h('div', 'field-row');
      lrow.appendChild(field('Expect', selectInput([['text', 'Text'], ['json', 'JSON (validated, 1 retry)']], step.expect || 'text', function (v) { step.expect = v; })));
      var models = [['', 'Model selected in chat']].concat(api.getModels().map(function (m) { return [m, m]; }));
      lrow.appendChild(field('Model', selectInput(models, step.model || '', function (v) { step.model = v; })));
      panel.appendChild(lrow);
      panel.appendChild(field('Extra system instructions (optional)', textInput(step.system, function (v) { step.system = v; }, '', true)));
    } else if (step.type === 'foreach') {
      panel.appendChild(field('Items *', textInput(step.items, function (v) { step.items = v; }, '{{steps.find.lines}}'), 'A list (e.g. {{steps.<id>.lines}}, {{steps.<id>.json.files}}) or newline-separated text.'));
      var frow = h('div', 'field-row');
      frow.appendChild(field('Item variable', textInput(step.itemVar || 'item', function (v) { step.itemVar = v.trim() || 'item'; }, 'item')));
      frow.appendChild(field('Max items', textInput(step.maxItems || '', function (v) { var n = parseInt(v, 10); step.maxItems = isNaN(n) ? undefined : n; }, '50')));
      panel.appendChild(frow);
      var par = h('label', 'harness-check');
      var pcb = document.createElement('input'); pcb.type = 'checkbox'; pcb.checked = !!step.parallel;
      pcb.addEventListener('change', function () { step.parallel = pcb.checked; renderCanvas(); });
      par.appendChild(pcb); par.appendChild(document.createTextNode(' Run iterations in parallel'));
      panel.appendChild(par);
      panel.appendChild(h('div', 'field-hint', 'Add the loop body with the + slots inside the loop on the canvas.'));
    } else if (step.type === 'parallel') {
      panel.appendChild(h('div', 'field-hint', 'Lanes run at the same time. Use "+ lane" on the canvas to add a branch; drop a node onto a lane\\'s + to make a multi-step branch.'));
    } else if (step.type === 'sequence') {
      panel.appendChild(h('div', 'field-hint', 'Steps in this group run in order; the group\\'s output is its last successful step.'));
    }

    // Error handling & condition — common to every step
    var adv = document.createElement('details');
    adv.className = 'harness-details';
    adv.open = !!(step.when || (step.onError && step.onError !== 'stop') || step.retries != null || step.timeoutMs != null);
    adv.appendChild(h('summary', '', 'Error handling & condition'));
    var erow = h('div', 'field-row');
    erow.appendChild(field('On error', selectInput([['stop', 'Stop the harness'], ['continue', 'Continue with next step'], ['retry-then-stop', 'Retry, then stop'], ['retry-then-continue', 'Retry, then continue']], step.onError || 'stop', function (v) { step.onError = v; })));
    erow.appendChild(field('Retries', textInput(step.retries != null ? step.retries : '', function (v) { var n = parseInt(v, 10); step.retries = isNaN(n) ? undefined : n; }, '2')));
    adv.appendChild(erow);
    var trow = h('div', 'field-row');
    trow.appendChild(field('Timeout (ms)', textInput(step.timeoutMs != null ? step.timeoutMs : '', function (v) { var n = parseInt(v, 10); step.timeoutMs = isNaN(n) ? undefined : n; }, '120000')));
    trow.appendChild(field('Run only when', textInput(step.when, function (v) { step.when = v; }, '{{steps.tests.status}} == failed'), 'Skipped when empty/false. Supports == and !=.'));
    adv.appendChild(trow);
    panel.appendChild(adv);
  }

  function renderVariables() {
    el.hbVariables.innerHTML = '';
    (catalog.variables || []).forEach(function (v) {
      var code = document.createElement('code');
      code.textContent = '{{' + v + '}}';
      code.title = 'Click to copy';
      code.addEventListener('click', function () { navigator.clipboard.writeText('{{' + v + '}}').catch(function () {}); });
      el.hbVariables.appendChild(code);
    });
  }

  function stripInternal(steps) {
    return (steps || []).map(function (s) {
      var copy = {};
      Object.keys(s).forEach(function (k) { if (k.charAt(0) !== '_' && s[k] !== undefined && s[k] !== '') { copy[k] = s[k]; } });
      if (s.steps) { copy.steps = stripInternal(s.steps); }
      return copy;
    });
  }
  function saveDraft(andRun) {
    draft.name = el.hbName.value.trim();
    draft.id = el.hbId.value.trim() || slug(draft.name);
    if (!draft.name) { showError('Give the harness a name.'); el.hbName.focus(); return; }
    var def = { id: draft.id, name: draft.name, description: draft.description || '', version: '1.0.0', source: 'user', input: draft.input, steps: stripInternal(draft.steps) };
    if (draft.output) { def.output = draft.output; }
    pendingRunAfterSave = andRun ? def.id : null;
    vscode.postMessage({ type: 'harnessSave', definition: def });
  }

  // ---------------------------------------------------------------- run tab
  function statusIcon(s) { return s === 'done' ? '✅' : s === 'failed' ? '❌' : s === 'skipped' ? '⏭️' : s === 'running' ? '🔄' : '⏳'; }
  function renderRunStep(s) {
    var div = h('div', 'harness-run-step ' + s.status);
    var elapsed = s.startedAt && s.endedAt ? ((s.endedAt - s.startedAt) / 1000).toFixed(1) + 's' : (s.status === 'running' ? 'running…' : '');
    div.innerHTML =
      '<div class="harness-run-step-head"><span>' + statusIcon(s.status) + '</span><span class="id">' + esc(s.id) + '</span>' +
      (s.name && s.name !== s.id ? '<span>' + esc(s.name) + '</span>' : '') +
      '<span class="meta">' + esc(s.type) + (s.attempts > 1 ? ' · ' + s.attempts + ' attempts' : '') + (elapsed ? ' · ' + elapsed : '') + '</span></div>' +
      (s.error ? '<div class="err">' + esc(s.error) + '</div>' : '') +
      (s.notes && s.notes.length ? '<div class="notes">' + esc(s.notes.join(' · ')) + '</div>' : '');
    if (s.output && !GROUP_TYPES[s.type]) {
      var det = document.createElement('details');
      det.innerHTML = '<summary>Output (' + s.output.length + ' chars)</summary>';
      var pre = document.createElement('pre');
      pre.textContent = s.output.length > 20000 ? s.output.slice(0, 20000) + '\\n[… truncated in view]' : s.output;
      det.appendChild(pre);
      div.appendChild(det);
    }
    if (s.children && s.children.length) {
      var kids = h('div', 'harness-run-children');
      s.children.forEach(function (c) { kids.appendChild(renderRunStep(c)); });
      div.appendChild(kids);
    }
    return div;
  }
  function renderRun() {
    if (!run) {
      el.runHeader.textContent = 'Starting…';
      el.runSteps.innerHTML = '';
      el.runOutput.innerHTML = '';
      el.stopBtn.classList.add('hidden');
      return;
    }
    var running = run.status === 'running';
    var elapsed = (((run.endedAt || Date.now()) - run.startedAt) / 1000).toFixed(1) + 's';
    var label = run.status === 'done' ? '✅ Completed' : run.status === 'failed' ? '❌ Failed' : run.status === 'cancelled' ? '⛔ Cancelled' : '🔄 Running';
    el.runHeader.innerHTML = '<div>' + esc(run.harnessName) + ' — ' + label + ' · ' + elapsed + '</div>' +
      (run.input ? '<div class="plugin-desc">Input: ' + esc(run.input) + '</div>' : '') +
      (run.error ? '<div class="harness-run-error">' + esc(run.error) + '</div>' : '');
    el.stopBtn.classList.toggle('hidden', !running);
    el.runSteps.innerHTML = '';
    run.steps.forEach(function (s) { el.runSteps.appendChild(renderRunStep(s)); });
    el.runOutput.innerHTML = run.output && !running ? '<div class="harness-steps-header"><span>Output</span></div><div class="message ai">' + api.markdown(run.output) + '</div>' : '';
    if (activeTab === 'builder') { renderCanvas(); }
  }

  // ---------------------------------------------------------------- messages
  function onMessage(msg) {
    switch (msg.type) {
      case 'harnessCatalog':
        catalog = msg.catalog || catalog;
        renderList();
        if (draft) { renderCanvas(); renderProps(); renderVariables(); }
        return true;
      case 'harnessDefinition':
        loadDraft(msg.definition);
        if (msg.openBuilder !== false) { switchTab('builder'); }
        return true;
      case 'harnessSaved':
        showError('');
        el.select.value = msg.id;
        switchTab('list');
        renderDetail();
        if (pendingRunAfterSave === msg.id) { pendingRunAfterSave = null; runSelected(); }
        return true;
      case 'harnessError':
        showError(msg.message || 'Unknown error');
        return true;
      case 'harnessRunUpdate':
        run = msg.run;
        if (activeTab === 'run') { renderRun(); } else if (activeTab === 'builder') { renderCanvas(); }
        return true;
      case 'harnessRunDone':
        run = msg.run;
        renderRun();
        return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- init
  function init(vscodeApi, hostApi) {
    vscode = vscodeApi;
    api = hostApi;
    el = {
      screen: $('harness-screen'), error: $('harness-error'),
      tabList: $('harness-tab-list'), tabBuilder: $('harness-tab-builder'), tabRun: $('harness-tab-run'),
      select: $('harness-select'), detail: $('harness-detail'), inputGroup: $('harness-input-group'), inputLabel: $('harness-input-label'), input: $('harness-input'),
      runBtn: $('harness-run-btn'), editBtn: $('harness-edit-btn'), duplicateBtn: $('harness-duplicate-btn'), deleteBtn: $('harness-delete-btn'), openBtn: $('harness-open-btn'), newBtn: $('harness-new-btn'),
      problems: $('harness-problems'),
      hbName: $('hb-name'), hbId: $('hb-id'), canvas: $('hb-canvas'), props: $('hb-props'), menu: $('hb-menu'), hbVariables: $('hb-variables'),
      hbSaveBtn: $('hb-save-btn'), hbSaveRunBtn: $('hb-save-run-btn'), hbCancelBtn: $('hb-cancel-btn'),
      runHeader: $('harness-run-header'), runSteps: $('harness-run-steps'), runOutput: $('harness-run-output'), stopBtn: $('harness-stop-btn')
    };
    $('harness-back-btn').addEventListener('click', close);
    $('harness-reload-btn').addEventListener('click', function () { vscode.postMessage({ type: 'harnessReload' }); });
    Array.prototype.forEach.call(document.querySelectorAll('.harness-tab'), function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });
    el.select.addEventListener('change', renderDetail);
    el.runBtn.addEventListener('click', runSelected);
    el.editBtn.addEventListener('click', function () { var x = selectedHarness(); if (x) { vscode.postMessage({ type: 'harnessGet', id: x.id }); } });
    el.duplicateBtn.addEventListener('click', function () { var x = selectedHarness(); if (x) { vscode.postMessage({ type: 'harnessDuplicate', id: x.id }); } });
    el.deleteBtn.addEventListener('click', function () { var x = selectedHarness(); if (x) { vscode.postMessage({ type: 'harnessDelete', id: x.id }); } });
    el.openBtn.addEventListener('click', function () { var x = selectedHarness(); if (x) { vscode.postMessage({ type: 'harnessOpenFile', id: x.id }); } });
    el.newBtn.addEventListener('click', function () { newDraft(); switchTab('builder'); el.hbName.focus(); });
    el.hbName.addEventListener('input', function () { if (draft) { draft.name = el.hbName.value; } if (!draftIdTouched) { el.hbId.value = slug(el.hbName.value); if (draft) { draft.id = el.hbId.value; } } });
    el.hbId.addEventListener('input', function () { draftIdTouched = true; if (draft) { draft.id = el.hbId.value.trim(); } });
    el.hbSaveBtn.addEventListener('click', function () { saveDraft(false); });
    el.hbSaveRunBtn.addEventListener('click', function () { saveDraft(true); });
    el.hbCancelBtn.addEventListener('click', function () { draft = null; selected = null; switchTab('list'); });
    el.stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'harnessStop' }); });
    el.input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { runSelected(); } });
    el.canvas.addEventListener('click', function () { closeMenu(); });
    document.addEventListener('click', function (e) { if (!el.menu.classList.contains('hidden') && !el.menu.contains(e.target)) { closeMenu(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); } });
  }

  return { init: init, open: open, onMessage: onMessage };
})();
`;
