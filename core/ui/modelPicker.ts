/**
 * Searchable model picker.
 *
 * Replaces the plain `<select>` in the controls row. A native select cannot be typed into and
 * shows one line per option, which is not enough once a user has a dozen Ollama tags plus three
 * cloud providers: the ids alone ("qwen2.5-coder:7b", "gemini-2.5-flash") say nothing about how
 * big a model is, how it was quantised, how much context it has, or whether using it sends the
 * conversation off the machine.
 *
 * The picker keeps a hidden `<input id="model-select">` holding the selected id, so existing
 * call sites keep reading `.value` and listening for `change`.
 *
 * Everything is built with DOM APIs rather than markup strings: the browser build runs under
 * `script-src 'self'` with no inline handlers, and add-on reviewers flag dynamic innerHTML.
 */

export const modelPickerLayout = `
    <div id="model-picker" class="model-picker">
      <input type="hidden" id="model-select">
      <button id="model-picker-trigger" class="model-picker-trigger" type="button"
              aria-haspopup="listbox" aria-expanded="false" title="Choose a model">
        <span class="model-picker-trigger-text">
          <span id="model-picker-label" class="model-picker-label">Loading…</span>
          <span id="model-picker-meta" class="model-picker-meta"></span>
        </span>
        <span class="model-picker-caret" aria-hidden="true">▾</span>
      </button>
      <div id="model-picker-panel" class="model-picker-panel hidden">
        <input id="model-picker-search" class="model-picker-search" type="text"
               placeholder="Search models…" autocomplete="off" spellcheck="false"
               aria-controls="model-picker-list">
        <div id="model-picker-list" class="model-picker-list" role="listbox" tabindex="-1"></div>
      </div>
    </div>
`;

export const modelPickerStyles = `
  .model-picker {
    position: relative;
    flex: 1 1 40%;
    min-width: 0;
  }
  .model-picker-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    border-radius: var(--border-radius-sm);
    outline: none;
    cursor: pointer;
    text-align: left;
  }
  .model-picker-trigger:hover,
  .model-picker-trigger[aria-expanded="true"] {
    border-color: var(--vscode-focusBorder, var(--vscode-button-background));
  }
  .model-picker-trigger-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
    line-height: 1.25;
  }
  .model-picker-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-picker-meta {
    font-size: 10px;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-picker-meta:empty { display: none; }
  .model-picker-caret {
    flex: 0 0 auto;
    font-size: 9px;
    opacity: 0.7;
  }

  .model-picker-panel {
    position: absolute;
    z-index: 40;
    top: calc(100% + 4px);
    left: 0;
    /* The controls row is narrow; the list needs more room than the trigger to stay readable. */
    min-width: 100%;
    width: max(260px, 100%);
    max-width: min(420px, calc(100vw - 24px));
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: var(--border-radius-md);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .model-picker-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: none;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    padding: 7px 9px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
  }
  .model-picker-list {
    max-height: 260px;
    overflow-y: auto;
    outline: none;
  }
  .model-picker-group {
    padding: 6px 9px 3px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    position: sticky;
    top: 0;
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
  }
  .model-picker-option {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 9px;
    border: none;
    background: none;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    line-height: 1.35;
  }
  .model-picker-option:hover,
  .model-picker-option.active {
    background: var(--vscode-list-hoverBackground);
  }
  .model-picker-option[aria-selected="true"] {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  .model-picker-option-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .model-picker-option-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-picker-badge {
    flex: 0 0 auto;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 999px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    opacity: 0.85;
  }
  .model-picker-badge.local {
    border-color: var(--vscode-charts-green, #4caf50);
    color: var(--vscode-charts-green, #4caf50);
  }
  .model-picker-badge.cloud {
    border-color: var(--vscode-charts-blue, #4a9eff);
    color: var(--vscode-charts-blue, #4a9eff);
  }
  .model-picker-option-detail,
  .model-picker-option-desc {
    font-size: 10px;
    opacity: 0.65;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-picker-option-id {
    font-size: 10px;
    opacity: 0.5;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .model-picker-empty {
    padding: 10px 9px;
    font-size: 11px;
    opacity: 0.7;
  }
`;

export const modelPickerScript = `
(function () {
  var PROVIDER_NAMES = {
    ollama: 'Ollama (local)',
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    anthropic: 'Anthropic',
    blablador: 'Blablador',
    unknown: 'Other'
  };

  var PROVIDER_ORDER = ['ollama', 'blablador', 'anthropic', 'openai', 'gemini'];

  function providerRank(provider) {
    var index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  }

  function providerOf(model) {
    if (model.provider) { return model.provider; }
    var slash = String(model.id || '').indexOf('/');
    return slash === -1 ? 'ollama' : String(model.id).slice(0, slash);
  }

  /** Accept either the structured ModelInfo list or a plain list of ids from an older host. */
  function normalize(entry) {
    var model = typeof entry === 'string' ? { id: entry } : (entry || {});
    var id = String(model.id || '');
    var provider = providerOf(model);
    var slash = id.indexOf('/');
    return {
      id: id,
      label: model.label || (slash === -1 ? id : id.slice(slash + 1)),
      provider: provider,
      local: model.local !== undefined ? !!model.local : provider === 'ollama',
      detail: model.detail || '',
      description: model.description || ''
    };
  }

  function ModelPicker(root) {
    this.root = root;
    this.input = root.querySelector('#model-select');
    this.trigger = root.querySelector('#model-picker-trigger');
    this.labelEl = root.querySelector('#model-picker-label');
    this.metaEl = root.querySelector('#model-picker-meta');
    this.panel = root.querySelector('#model-picker-panel');
    this.search = root.querySelector('#model-picker-search');
    this.list = root.querySelector('#model-picker-list');
    this.models = [];
    this.filtered = [];
    this.activeIndex = -1;

    var self = this;
    this.trigger.addEventListener('click', function () { self.toggle(); });
    this.search.addEventListener('input', function () { self.render(self.search.value); });
    this.search.addEventListener('keydown', function (e) { self.onKeyDown(e); });
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) { self.close(); }
    });
  }

  ModelPicker.prototype.setModels = function (models, selected) {
    this.models = (models || []).map(normalize).filter(function (m) { return m.id; });
    var wanted = selected || this.input.value;
    if (wanted && !this.models.some(function (m) { return m.id === wanted; })) {
      // A remembered model that the provider no longer lists still has to be selectable.
      this.models.unshift(normalize({ id: wanted, detail: 'not in the current model list' }));
    }
    this.select(wanted || (this.models[0] && this.models[0].id) || '', { silent: true });
  };

  ModelPicker.prototype.ids = function () {
    return this.models.map(function (m) { return m.id; });
  };

  ModelPicker.prototype.find = function (id) {
    for (var i = 0; i < this.models.length; i++) {
      if (this.models[i].id === id) { return this.models[i]; }
    }
    return null;
  };

  ModelPicker.prototype.select = function (id, options) {
    if (!id) { return; }
    var changed = this.input.value !== id;
    this.input.value = id;
    var model = this.find(id) || normalize({ id: id });
    this.labelEl.textContent = model.label;
    var meta = [PROVIDER_NAMES[model.provider] || model.provider];
    if (model.detail) { meta.push(model.detail); }
    this.metaEl.textContent = meta.join(' · ');
    this.trigger.title = model.description ? model.id + ' — ' + model.description : model.id;
    if (changed && !(options && options.silent)) {
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  ModelPicker.prototype.toggle = function () {
    if (this.panel.classList.contains('hidden')) { this.open(); } else { this.close(); }
  };

  ModelPicker.prototype.open = function () {
    this.panel.classList.remove('hidden');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.render('');
    this.search.focus();
  };

  ModelPicker.prototype.close = function () {
    this.panel.classList.add('hidden');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.activeIndex = -1;
  };

  /** Every field a user might type: name, full id, provider and the detail line. */
  ModelPicker.prototype.matches = function (model, terms) {
    var haystack = [model.label, model.id, model.provider, model.detail, model.description]
      .join(' ').toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (haystack.indexOf(terms[i]) === -1) { return false; }
    }
    return true;
  };

  ModelPicker.prototype.render = function (query) {
    var self = this;
    var terms = String(query || '').toLowerCase().split(/\\s+/).filter(Boolean);
    // Group headers are emitted when the provider changes, so the rows have to be grouped
    // first: a restored model is prepended to the list and would otherwise split its provider
    // into two headings. Sort is stable, so order within a provider is preserved.
    this.filtered = this.models
      .filter(function (m) { return self.matches(m, terms); })
      .slice()
      .sort(function (a, b) { return providerRank(a.provider) - providerRank(b.provider); });

    while (this.list.firstChild) { this.list.removeChild(this.list.firstChild); }

    if (this.filtered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = this.models.length
        ? 'No model matches “' + query + '”.'
        : 'No models found. Is Ollama running, or a cloud key configured?';
      this.list.appendChild(empty);
      this.activeIndex = -1;
      return;
    }

    var selectedId = this.input.value;
    var lastProvider = null;
    this.filtered.forEach(function (model, index) {
      if (model.provider !== lastProvider) {
        lastProvider = model.provider;
        var group = document.createElement('div');
        group.className = 'model-picker-group';
        group.textContent = PROVIDER_NAMES[model.provider] || model.provider;
        self.list.appendChild(group);
      }

      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-picker-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', model.id === selectedId ? 'true' : 'false');
      option.dataset.index = String(index);

      var head = document.createElement('div');
      head.className = 'model-picker-option-head';
      var name = document.createElement('span');
      name.className = 'model-picker-option-name';
      name.textContent = model.label;
      head.appendChild(name);
      var badge = document.createElement('span');
      badge.className = 'model-picker-badge ' + (model.local ? 'local' : 'cloud');
      badge.textContent = model.local ? 'local' : 'cloud';
      badge.title = model.local
        ? 'Runs on this machine; nothing leaves it.'
        : 'Your prompt and context are sent to ' + (PROVIDER_NAMES[model.provider] || model.provider) + '.';
      head.appendChild(badge);
      option.appendChild(head);

      if (model.detail) {
        var detail = document.createElement('div');
        detail.className = 'model-picker-option-detail';
        detail.textContent = model.detail;
        option.appendChild(detail);
      }
      if (model.description) {
        var desc = document.createElement('div');
        desc.className = 'model-picker-option-desc';
        desc.textContent = model.description;
        desc.title = model.description;
        option.appendChild(desc);
      }
      if (model.label !== model.id) {
        var idLine = document.createElement('div');
        idLine.className = 'model-picker-option-id';
        idLine.textContent = model.id;
        option.appendChild(idLine);
      }

      option.addEventListener('click', function () {
        self.select(model.id);
        self.close();
        self.trigger.focus();
      });
      self.list.appendChild(option);
    });

    this.setActive(this.filtered.findIndex(function (m) { return m.id === selectedId; }));
  };

  ModelPicker.prototype.optionElements = function () {
    return this.list.querySelectorAll('.model-picker-option');
  };

  ModelPicker.prototype.setActive = function (index) {
    var options = this.optionElements();
    if (options.length === 0) { this.activeIndex = -1; return; }
    if (index < 0) { index = 0; }
    if (index >= options.length) { index = options.length - 1; }
    this.activeIndex = index;
    for (var i = 0; i < options.length; i++) { options[i].classList.remove('active'); }
    options[index].classList.add('active');
    options[index].scrollIntoView({ block: 'nearest' });
  };

  ModelPicker.prototype.onKeyDown = function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); this.setActive(this.activeIndex + 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); this.setActive(this.activeIndex - 1); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      var model = this.filtered[this.activeIndex];
      if (model) { this.select(model.id); this.close(); this.trigger.focus(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.close(); this.trigger.focus(); }
  };

  window.ContinuedModelPicker = {
    attach: function (rootId) {
      var root = document.getElementById(rootId || 'model-picker');
      return root ? new ModelPicker(root) : null;
    }
  };
})();
`;
