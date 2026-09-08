/**
 * Persistent state for the browser build, kept in extension storage.
 * Keys are stored in `chrome.storage.local`, which is not encrypted: the options
 * page says so, and Ollama needs no key at all.
 */

import { ChatMessage } from '../core/llmClient';
import { HarnessDefinition } from '../core/harness/types';

// Firefox exposes the promise-based `browser.*`; Chrome's `chrome.*` is promise-capable in MV3.
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

export interface Settings {
    ollamaBaseUrl: string;
    keys: { openai: string; gemini: string; anthropic: string; blablador: string };
    lastModel: string;
    lastMode: string;
    maxIterations: number;
    modelTimeoutMs: number;
    maxContextChars: number;
    /** Allow the agent to open/fetch localhost and private-network URLs. */
    allowPrivateNetwork: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
    ollamaBaseUrl: 'http://localhost:11434',
    keys: { openai: '', gemini: '', anthropic: '', blablador: '' },
    lastModel: '',
    lastMode: 'agent',
    maxIterations: 20,
    modelTimeoutMs: 120000,
    maxContextChars: 60000,
    allowPrivateNetwork: false
};

export interface ChatSession {
    id: string;
    title: string;
    history: ChatMessage[];
    mode: string;
}

async function read<T>(key: string, fallback: T): Promise<T> {
    const result = await ext.storage.local.get(key);
    const value = (result as Record<string, unknown>)[key];
    return (value === undefined ? fallback : value) as T;
}

async function write(key: string, value: unknown): Promise<void> {
    await ext.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
    const stored = await read<Partial<Settings>>('settings', {});
    return { ...DEFAULT_SETTINGS, ...stored, keys: { ...DEFAULT_SETTINGS.keys, ...(stored.keys ?? {}) } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await getSettings();
    const next: Settings = { ...current, ...patch, keys: { ...current.keys, ...(patch.keys ?? {}) } };
    await write('settings', next);
    return next;
}

export async function getSessions(): Promise<ChatSession[]> {
    return read<ChatSession[]>('sessions', []);
}

export async function saveSessions(sessions: ChatSession[]): Promise<void> {
    // Keep storage bounded: 40 sessions, 200 messages each.
    await write('sessions', sessions.slice(0, 40).map(s => ({ ...s, history: s.history.slice(-200) })));
}

export async function getLastSessionId(): Promise<string | null> {
    return read<string | null>('lastSessionId', null);
}

export async function setLastSessionId(id: string | null): Promise<void> {
    await write('lastSessionId', id);
}

export async function getUserHarnesses(): Promise<Record<string, HarnessDefinition>> {
    return read<Record<string, HarnessDefinition>>('harnesses', {});
}

export async function saveUserHarnesses(map: Record<string, HarnessDefinition>): Promise<void> {
    await write('harnesses', map);
}

export async function getPluginOverrides(): Promise<Record<string, boolean>> {
    return read<Record<string, boolean>>('pluginOverrides', {});
}

export async function savePluginOverrides(map: Record<string, boolean>): Promise<void> {
    await write('pluginOverrides', map);
}
