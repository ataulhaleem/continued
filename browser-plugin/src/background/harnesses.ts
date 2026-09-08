/**
 * Built-in harnesses for the browser build. They use the browser tools and act as
 * templates in the Harness view.
 */

import { HarnessDefinition } from '../core/harness/types';

export const builtInBrowserHarnesses: HarnessDefinition[] = [
    {
        id: 'summarise-page-harness',
        name: 'Summarise this page',
        description: 'Reads the active tab and writes a structured summary with key points and open questions.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Focus (optional)', placeholder: 'e.g. "what does it say about pricing?"', required: false },
        steps: [
            { id: 'read', name: 'Read page', type: 'tool', pluginId: 'read-page', args: { maxChars: '16000' } },
            {
                id: 'summary', name: 'Summarise', type: 'llm',
                prompt: 'Summarise the page in the run context: a 2-sentence overview, then 5–8 key points as bullets, then "Open questions" (max 3). {{input}} Use Markdown; cite the page title once.'
            }
        ]
    },
    {
        id: 'compare-tabs-harness',
        name: 'Compare open tabs (parallel)',
        description: 'Reads up to 6 open tabs at the same time, summarises each, then produces a comparison table. Demonstrates parallel lanes and for-each.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'What to compare (optional)', placeholder: 'e.g. "price, licence, supported platforms"', required: false },
        steps: [
            { id: 'tabs', name: 'List tabs', type: 'resource', pluginId: 'tabs' },
            {
                id: 'ids', name: 'Pick tab ids', type: 'llm', expect: 'json',
                prompt: 'From the tab list in the run context, return a JSON array of up to 6 tab ids (numbers) for real web pages worth comparing — skip browser-internal pages, search engines and this extension. Example: [12, 15, 20]'
            },
            {
                id: 'each', name: 'Read and summarise each', type: 'foreach', items: '{{steps.ids.json}}', parallel: true, maxItems: 6,
                steps: [
                    { id: 'page', name: 'Read', type: 'tool', pluginId: 'read-page', args: { tabId: '{{item}}', maxChars: '8000' }, onError: 'continue' },
                    { id: 'brief', name: 'Brief', type: 'llm', when: '{{steps.page.status}} == done', prompt: 'In 4 bullets, summarise this page (step "page" in the run context). Start with its title in bold. {{input}}' }
                ]
            },
            {
                id: 'table', name: 'Compare', type: 'llm',
                prompt: 'Using the per-tab briefs in the run context, write a Markdown comparison table (one row per page) followed by a short recommendation. {{input}} If a page could not be read, say so in its row.'
            }
        ]
    },
    {
        id: 'research-urls-harness',
        name: 'Research a list of URLs',
        description: 'Fetches each URL from the input (one per line) without opening tabs, extracts the relevant facts, and compiles notes with sources.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'URLs, one per line', placeholder: 'https://…\nhttps://…', required: true },
        steps: [
            {
                id: 'each', name: 'Fetch and extract', type: 'foreach', items: '{{input}}', parallel: true, maxItems: 10,
                steps: [
                    { id: 'fetch', name: 'Fetch', type: 'tool', pluginId: 'fetch-url', args: { url: '{{item}}', maxChars: '12000' }, onError: 'retry-then-continue', retries: 1 },
                    { id: 'facts', name: 'Extract facts', type: 'llm', when: '{{steps.fetch.status}} == done', prompt: 'From the fetched page in the run context ({{item}}), list the 5 most important facts as bullets, each ending with the source URL in parentheses. Skip boilerplate.' }
                ]
            },
            {
                id: 'notes', name: 'Compile notes', type: 'llm',
                prompt: 'Combine the per-URL facts in the run context into research notes: a short synthesis paragraph, then grouped bullet points with sources, then a "Sources that failed" list if any fetch failed.'
            }
        ]
    },
    {
        id: 'find-on-page-harness',
        name: 'Answer a question from this page',
        description: 'Searches the active tab for the terms in your question, reads the matches, and answers with quotes.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Question', placeholder: 'e.g. "what is the refund policy?"', required: true },
        steps: [
            { id: 'terms', name: 'Key terms', type: 'llm', expect: 'json', prompt: 'Return a JSON array of 2–4 short search terms (single words or two-word phrases) most likely to appear on a web page that answers: {{input}}' },
            {
                id: 'search', name: 'Search page', type: 'foreach', items: '{{steps.terms.json}}', maxItems: 4,
                steps: [{ id: 'hits', name: 'Find', type: 'tool', pluginId: 'find-in-page', args: { query: '{{item}}', context: '2' }, onError: 'continue' }]
            },
            { id: 'answer', name: 'Answer', type: 'llm', prompt: 'Answer the question "{{input}}" using only the page excerpts in the run context. Quote the relevant lines. If the page does not contain the answer, say so plainly.' }
        ]
    }
];
