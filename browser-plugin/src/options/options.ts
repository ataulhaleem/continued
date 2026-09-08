import { getSettings, saveSettings, ext } from '../background/storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function load(): Promise<void> {
    const s = await getSettings();
    $<HTMLInputElement>('ollamaBaseUrl').value = s.ollamaBaseUrl;
    $<HTMLInputElement>('key-openai').value = s.keys.openai;
    $<HTMLInputElement>('key-gemini').value = s.keys.gemini;
    $<HTMLInputElement>('key-anthropic').value = s.keys.anthropic;
    $<HTMLInputElement>('key-blablador').value = s.keys.blablador;
    $<HTMLInputElement>('maxIterations').value = String(s.maxIterations);
    $<HTMLInputElement>('modelTimeoutMs').value = String(s.modelTimeoutMs);
    $<HTMLInputElement>('maxContextChars').value = String(s.maxContextChars);
    $<HTMLInputElement>('allowPrivateNetwork').checked = s.allowPrivateNetwork;
}

async function save(): Promise<void> {
    const num = (id: string, fallback: number) => { const n = parseInt($<HTMLInputElement>(id).value, 10); return Number.isFinite(n) ? n : fallback; };
    await saveSettings({
        ollamaBaseUrl: $<HTMLInputElement>('ollamaBaseUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:11434',
        keys: {
            openai: $<HTMLInputElement>('key-openai').value.trim(),
            gemini: $<HTMLInputElement>('key-gemini').value.trim(),
            anthropic: $<HTMLInputElement>('key-anthropic').value.trim(),
            blablador: $<HTMLInputElement>('key-blablador').value.trim()
        },
        maxIterations: num('maxIterations', 20),
        modelTimeoutMs: num('modelTimeoutMs', 120000),
        maxContextChars: num('maxContextChars', 60000),
        allowPrivateNetwork: $<HTMLInputElement>('allowPrivateNetwork').checked
    });
    const saved = $('saved');
    saved.textContent = 'Saved. Reopen the side panel to refresh the model list.';
    saved.className = 'status ok';
    setTimeout(() => { saved.textContent = ''; }, 4000);
}

async function testOllama(): Promise<void> {
    const status = $('ollamaStatus');
    const url = $<HTMLInputElement>('ollamaBaseUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:11434';
    status.textContent = 'Testing…';
    status.className = 'status';
    try {
        const res = await fetch(`${url}/api/tags`);
        const json = await res.json() as { models?: Array<{ name: string }> };
        const names = (json.models ?? []).map(m => m.name);
        status.textContent = names.length ? `OK — ${names.length} model(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` : 'Connected, but no models. Run `ollama pull qwen2.5-coder:7b`.';
        status.className = 'status ok';
    } catch (error) {
        status.textContent = `Could not reach ${url}: ${(error as Error).message}. Is Ollama running?`;
        status.className = 'status bad';
    }
}

async function showLog(): Promise<void> {
    const pre = $<HTMLPreElement>('log');
    try {
        const response = await ext.runtime.sendMessage({ type: 'getLog' }) as { log?: string } | undefined;
        pre.textContent = response?.log || '(log is empty — the background may have restarted)';
    } catch (error) {
        pre.textContent = `Could not read log: ${(error as Error).message}`;
    }
    pre.hidden = false;
}

$('save').addEventListener('click', () => { void save(); });
$('testOllama').addEventListener('click', () => { void testOllama(); });
$('showLog').addEventListener('click', () => { void showLog(); });
void load();
