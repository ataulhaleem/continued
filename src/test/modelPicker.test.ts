/**
 * Tests for the searchable model picker.
 *
 * The picker ships as a string of browser JavaScript (it runs inside the webview / side panel,
 * where module imports are not available), so the compiler never sees it. These tests evaluate
 * that exact string against a small DOM stub, which is the only way a mistake in it gets caught
 * before it reaches a user.
 */

import * as assert from 'assert';
import { modelPickerScript } from '../../core/ui/modelPicker';

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

class ClassList {
    private readonly names = new Set<string>();
    add(...items: string[]) { items.forEach(i => this.names.add(i)); }
    remove(...items: string[]) { items.forEach(i => this.names.delete(i)); }
    contains(name: string) { return this.names.has(name); }
    reset(value: string) {
        this.names.clear();
        String(value).split(/\s+/).filter(Boolean).forEach(n => this.names.add(n));
    }
}

class StubElement {
    readonly tagName: string;
    readonly children: StubElement[] = [];
    readonly attrs: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly classList = new ClassList();
    private readonly listeners: Record<string, Array<(event: any) => void>> = {};
    private text = '';
    value = '';
    title = '';
    type = '';

    constructor(tag: string) { this.tagName = (tag || 'div').toUpperCase(); }

    set className(value: string) { this.classList.reset(value); }
    set textContent(value: string) { this.text = String(value); this.children.length = 0; }
    get textContent(): string {
        return this.children.length ? this.children.map(c => c.textContent).join('') : this.text;
    }
    get firstChild(): StubElement | null { return this.children[0] ?? null; }

    appendChild(child: StubElement) { this.children.push(child); return child; }
    removeChild(child: StubElement) {
        const i = this.children.indexOf(child);
        if (i !== -1) { this.children.splice(i, 1); }
        return child;
    }
    setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
    getAttribute(key: string) { return this.attrs[key] ?? null; }
    addEventListener(type: string, fn: (event: any) => void) { (this.listeners[type] ??= []).push(fn); }
    dispatchEvent(event: any) { (this.listeners[event.type] ?? []).forEach(fn => fn.call(this, event)); return true; }
    click() { this.dispatchEvent({ type: 'click', target: this }); }
    scrollIntoView() { /* layout only */ }
    focus() { /* focus only */ }
    contains(node: StubElement): boolean {
        return node === this || this.children.some(c => c.contains(node));
    }

    descendants(): StubElement[] { return this.children.flatMap(c => [c, ...c.descendants()]); }
    private matchesSelector(selector: string): boolean {
        if (selector.startsWith('#')) { return this.attrs.id === selector.slice(1); }
        if (selector.startsWith('.')) { return this.classList.contains(selector.slice(1)); }
        return this.tagName === selector.toUpperCase();
    }
    querySelector(selector: string): StubElement | null {
        return this.descendants().find(e => e.matchesSelector(selector)) ?? null;
    }
    querySelectorAll(selector: string): StubElement[] {
        return this.descendants().filter(e => e.matchesSelector(selector));
    }
}

function el(tag: string, attrs: Record<string, string> = {}, children: StubElement[] = []): StubElement {
    const node = new StubElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') { node.className = value; } else { node.setAttribute(key, value); }
    }
    children.forEach(c => node.appendChild(c));
    return node;
}

/** The same structure `modelPickerLayout` produces. */
function buildRoot(): StubElement {
    return el('div', { id: 'model-picker', class: 'model-picker' }, [
        el('input', { id: 'model-select', type: 'hidden' }),
        el('button', { id: 'model-picker-trigger', class: 'model-picker-trigger' }, [
            el('span', { class: 'model-picker-trigger-text' }, [
                el('span', { id: 'model-picker-label', class: 'model-picker-label' }),
                el('span', { id: 'model-picker-meta', class: 'model-picker-meta' })
            ])
        ]),
        el('div', { id: 'model-picker-panel', class: 'model-picker-panel hidden' }, [
            el('input', { id: 'model-picker-search', class: 'model-picker-search' }),
            el('div', { id: 'model-picker-list', class: 'model-picker-list' })
        ])
    ]);
}

interface Harness {
    picker: any;
    root: StubElement;
    input: StubElement;
    list: StubElement;
    changeEvents: () => number;
    optionNames: () => string[];
    groupNames: () => string[];
}

function mount(): Harness {
    const root = buildRoot();
    const globals = globalThis as any;
    globals.document = {
        getElementById: (id: string) => (root.attrs.id === id ? root : root.querySelector('#' + id)),
        createElement: (tag: string) => new StubElement(tag),
        addEventListener: () => { /* outside-click handler */ }
    };
    globals.window = globals;
    globals.Event = class { type: string; constructor(type: string) { this.type = type; } };

    new Function(modelPickerScript)();
    const picker = globals.window.ContinuedModelPicker.attach('model-picker');
    assert.ok(picker, 'picker failed to attach');

    const input = root.querySelector('#model-select')!;
    const list = root.querySelector('#model-picker-list')!;
    let changes = 0;
    input.addEventListener('change', () => { changes++; });

    return {
        picker,
        root,
        input,
        list,
        changeEvents: () => changes,
        optionNames: () => list.querySelectorAll('.model-picker-option-name').map(n => n.textContent),
        groupNames: () => list.querySelectorAll('.model-picker-group').map(g => g.textContent)
    };
}

const MODELS = [
    { id: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b', provider: 'ollama', local: true, detail: '7.6B · Q4_K_M · 4.7 GB', description: 'qwen2 family · runs on this machine' },
    { id: 'llama3:latest', label: 'llama3:latest', provider: 'ollama', local: true, detail: '8.0B · Q4_0 · 4.7 GB' },
    { id: 'openai/gpt-4o', label: 'gpt-4o', provider: 'openai', local: false, detail: 'by system' },
    { id: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini', local: false, detail: '1M context', contextTokens: 1048576 },
    { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', local: false, detail: 'claude-opus-5' }
];

// ---------------------------------------------------------------------------

suite('modelPicker — selection', () => {
    test('shows the provider and detail of the selected model on the trigger', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        assert.strictEqual(h.input.value, 'openai/gpt-4o');
        assert.strictEqual(h.root.querySelector('#model-picker-label')!.textContent, 'gpt-4o');
        assert.strictEqual(h.root.querySelector('#model-picker-meta')!.textContent, 'OpenAI · by system');
    });

    test('restoring a saved model does not fire change, choosing one does', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        assert.strictEqual(h.changeEvents(), 0, 'restoring the saved model fired a change event');

        h.picker.open();
        h.picker.render('claude');
        h.list.querySelectorAll('.model-picker-option')[0].click();
        assert.strictEqual(h.input.value, 'anthropic/claude-opus-5');
        assert.strictEqual(h.changeEvents(), 1);
        assert.ok(h.root.querySelector('#model-picker-panel')!.classList.contains('hidden'), 'panel stayed open');
    });

    test('a remembered model the provider no longer lists is still selectable', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'a-model-i-deleted');
        assert.strictEqual(h.input.value, 'a-model-i-deleted');
        assert.strictEqual(h.picker.ids().length, MODELS.length + 1);
        assert.ok(String(h.picker.find('a-model-i-deleted').detail).includes('not in the current model list'));
    });

    test('a plain list of ids from an older host still works', () => {
        const h = mount();
        h.picker.setModels(['llama3', 'openai/gpt-4o'], 'llama3');
        assert.deepStrictEqual(h.picker.ids(), ['llama3', 'openai/gpt-4o']);
        assert.strictEqual(h.picker.find('llama3').local, true, 'an unprefixed id should be treated as local');
        assert.strictEqual(h.picker.find('openai/gpt-4o').provider, 'openai');
        assert.strictEqual(h.picker.find('openai/gpt-4o').local, false);
    });
});

suite('modelPicker — listing', () => {
    test('groups by provider, marks local vs cloud, and shows the detail line', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        h.picker.open();

        assert.strictEqual(h.list.querySelectorAll('.model-picker-option').length, 5);
        assert.deepStrictEqual(h.groupNames(), ['Ollama (local)', 'Anthropic', 'OpenAI', 'Google Gemini']);
        assert.deepStrictEqual(
            h.list.querySelectorAll('.model-picker-badge').map(b => b.textContent),
            ['local', 'local', 'cloud', 'cloud', 'cloud']
        );
        assert.ok(
            h.list.querySelectorAll('.model-picker-option-detail').some(d => d.textContent === '7.6B · Q4_K_M · 4.7 GB'),
            'the Ollama parameter/quantisation/size line is missing'
        );
    });

    test('a restored model does not split its provider into two headings', () => {
        const h = mount();
        // 'openai/gpt-4o-mini' is unknown, so it is prepended — ahead of the other OpenAI models.
        h.picker.setModels(MODELS, 'openai/gpt-4o-mini');
        h.picker.open();
        const groups = h.groupNames();
        assert.strictEqual(new Set(groups).size, groups.length, `duplicate provider headings: ${groups.join(', ')}`);
        assert.strictEqual(groups.filter(g => g === 'OpenAI').length, 1);
    });
});

suite('modelPicker — search', () => {
    test('matches on name, provider and the detail line, and supports several terms', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        h.picker.open();

        h.picker.render('coder');
        assert.deepStrictEqual(h.optionNames(), ['qwen2.5-coder:7b'], 'name search');

        h.picker.render('gemini');
        assert.deepStrictEqual(h.optionNames(), ['Gemini 2.5 Flash'], 'provider search');

        h.picker.render('Q4_0');
        assert.deepStrictEqual(h.optionNames(), ['llama3:latest'], 'detail search');

        h.picker.render('ollama 8.0b');
        assert.deepStrictEqual(h.optionNames(), ['llama3:latest'], 'multi-term search');
    });

    test('an empty result explains itself instead of showing a blank list', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        h.picker.open();
        h.picker.render('no-such-model');
        assert.strictEqual(h.list.querySelectorAll('.model-picker-option').length, 0);
        assert.ok(h.list.querySelector('.model-picker-empty')!.textContent.includes('No model matches'));
    });

    test('arrow keys move the highlight and Enter picks it', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        h.picker.open();
        h.picker.render('ollama');
        h.picker.setActive(0);
        h.picker.onKeyDown({ key: 'ArrowDown', preventDefault() { /* noop */ } });
        h.picker.onKeyDown({ key: 'Enter', preventDefault() { /* noop */ } });
        assert.strictEqual(h.input.value, 'llama3:latest');
    });

    test('Escape closes without changing the selection', () => {
        const h = mount();
        h.picker.setModels(MODELS, 'openai/gpt-4o');
        h.picker.open();
        h.picker.onKeyDown({ key: 'Escape', preventDefault() { /* noop */ } });
        assert.ok(h.root.querySelector('#model-picker-panel')!.classList.contains('hidden'));
        assert.strictEqual(h.input.value, 'openai/gpt-4o');
        assert.strictEqual(h.changeEvents(), 0);
    });
});
