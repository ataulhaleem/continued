/**
 * Model tools for the browser build: the same `model-catalog` and `model-probe` as the editor,
 * bound to this host's LlmClient. They send only the fixed benchmark prompts and the task text
 * the harness passes in — never page content — so they are read-only and need no approval.
 */

import { BrowserTool } from './tools';
import { LlmClient } from '../core/llmClient';
import { catalogJson, MODEL_CATALOG_DESCRIPTION, MODEL_PROBE_DESCRIPTION, normaliseProvider, runProbe } from '../../../core/harness/modelBench';

export function createModelTools(llm: LlmClient): BrowserTool[] {
    return [
        {
            id: 'model-catalog', name: 'Model catalog', source: 'built-in', enabled: true, readOnly: true,
            description: MODEL_CATALOG_DESCRIPTION,
            args: [{ name: 'provider', description: 'blablador (default), ollama, openai, gemini or anthropic', default: 'blablador' }],
            async execute(args) {
                return catalogJson(normaliseProvider(args.provider), await llm.listModels());
            }
        },
        {
            id: 'model-probe', name: 'Model probe', source: 'built-in', enabled: true, readOnly: true,
            description: MODEL_PROBE_DESCRIPTION,
            args: [
                { name: 'model', description: 'Model id as listed by model-catalog', required: true },
                { name: 'task', description: 'Your own prompt, sent to the model as-is (optional)', multiline: true },
                { name: 'timeoutMs', description: 'Timeout per call', default: '60000' }
            ],
            async execute(args) {
                const model = String(args.model ?? '').trim();
                if (!model) { throw new Error('model is required'); }
                const n = Number(args.timeoutMs);
                const timeoutMs = Math.max(5000, Number.isFinite(n) && n > 0 ? n : 60000);
                return runProbe(
                    async (id, system, prompt, o) => (await llm.completeDetailed(id, system, [{ role: 'user', content: prompt }], o)).text,
                    model, String(args.task ?? '').trim(), timeoutMs
                );
            }
        }
    ];
}
