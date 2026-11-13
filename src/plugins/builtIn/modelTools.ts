/**
 * Model tools: what does my provider offer, and how do those models behave?
 *
 * Both tools talk only to the model provider the user has already configured — the same
 * channel every chat message and every `llm` step uses — and send only the fixed benchmark
 * prompts plus, for `model-probe`, the task text the harness passes in. They never read the
 * workspace, so they are read-only and need no approval. The bodies live in core and are
 * shared with the browser extension; this file binds them to the editor's LlmClient.
 */

import { ITool } from '../types';
import { LlmClient } from '../../llmClient';
import { catalogJson, MODEL_CATALOG_DESCRIPTION, MODEL_PROBE_DESCRIPTION, normaliseProvider, runProbe } from '../../../core/harness/modelBench';
import { optionalNumber, requireString } from './common';

export function createModelTools(llm: LlmClient): ITool[] {
    const catalog: ITool = {
        id: 'model-catalog',
        name: 'Model catalog',
        version: '1.0.0',
        author: 'Continued',
        description: MODEL_CATALOG_DESCRIPTION,
        enabled: true,
        source: 'built-in',
        category: 'tool',
        readOnly: true,
        args: [{ name: 'provider', description: 'blablador (default), ollama, openai, gemini or anthropic', default: 'blablador' }],
        async execute(args) {
            return catalogJson(normaliseProvider(args.provider), await llm.listModels());
        }
    };

    const probe: ITool = {
        id: 'model-probe',
        name: 'Model probe',
        version: '1.0.0',
        author: 'Continued',
        description: MODEL_PROBE_DESCRIPTION,
        enabled: true,
        source: 'built-in',
        category: 'tool',
        readOnly: true,
        args: [
            { name: 'model', description: 'Model id as listed by model-catalog', required: true },
            { name: 'task', description: 'Your own prompt, sent to the model as-is (optional)', multiline: true },
            { name: 'timeoutMs', description: 'Timeout per call', default: '60000' }
        ],
        async execute(args) {
            const model = requireString(args, 'model').trim();
            const timeoutMs = Math.max(5000, optionalNumber(args, 'timeoutMs', 60000));
            return runProbe(
                async (id, system, prompt, o) => (await llm.completeDetailed(id, system, [{ role: 'user', content: prompt }], o)).text,
                model, String(args.task ?? '').trim(), timeoutMs
            );
        }
    };

    return [catalog, probe];
}
