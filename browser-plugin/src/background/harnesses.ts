/**
 * Built-in harnesses for the browser build. They use the browser tools and act as
 * templates in the Harness view.
 */

import { HarnessDefinition } from '../../../core/harness/types';
import { BLABLADOR_MODELS_HARNESS } from '../../../core/harness/modelBench';

export const builtInBrowserHarnesses: HarnessDefinition[] = [
    BLABLADOR_MODELS_HARNESS,
    // ---- for researchers: the tab may show an HTML article or a PDF; read-page handles both ----
    {
        id: 'extract-quantities-harness',
        name: 'Extract quantitative results (HTML or PDF)',
        description: 'Reads the article in the active tab — a web page or a PDF — and pulls out every reported quantity: value, unit, uncertainty or interval, sample size, condition, where it appears and the sentence it comes from. Delivered as a table and as CSV you can paste into a spreadsheet. Values are copied verbatim, never computed.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Focus (optional)', placeholder: 'e.g. "effect sizes and p-values only", "everything in Table 2"', required: false },
        steps: [
            { id: 'read', name: 'Read article', type: 'tool', pluginId: 'read-page', args: { maxChars: '60000' }, timeoutMs: 180000 },
            {
                id: 'extract', name: 'Extract quantities', type: 'llm', expect: 'json', timeoutMs: 300000,
                prompt: 'From the article text in the run context (step read), extract every quantitative result as a JSON array. One object per reported quantity with exactly these keys: "quantity" (what is measured), "value" (as written, verbatim), "unit" (or ""), "uncertainty" (SD, SE, CI, IQR or range as written, or ""), "n" (sample size if stated, or ""), "condition" (group, treatment, time point, or ""), "location" (section, table/figure number, or the [page N] marker), "quote" (the sentence or table cell it comes from, verbatim, max 200 chars). Copy numbers exactly; do not convert units or compute anything; skip citation years, page numbers and reference-list numbers. {{input}}\nIf the text contains no quantitative results, return [].'
            },
            {
                id: 'table', name: 'Table and CSV', type: 'llm', timeoutMs: 300000,
                prompt: 'The run context holds the extracted quantities (step extract, JSON) from the article (step read). Write: "## Quantitative results — <article title>" ; one sentence on how many quantities were found and from which sections; a Markdown table with columns Quantity, Value, Unit, Uncertainty, n, Condition, Location, in the order they appear in the article; then "### CSV" followed by a ```csv code block with the same rows and a header row (quote fields containing commas); then "### Notes" with at most 3 bullets on anything ambiguous (e.g. a value whose unit was not stated). Copy every value exactly as it is in the JSON. Do not add rows that are not in the JSON.'
            }
        ]
    },
    {
        id: 'answer-from-article-harness',
        name: 'Answer a question from this article (HTML or PDF)',
        description: 'Reads the whole article in the active tab — web page or PDF — and answers your question from the text alone, quoting the passages it relies on with their page or section. Says plainly when the article does not contain the answer.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Question', placeholder: 'e.g. "what sample size did they use, and how was it justified?"', required: true },
        steps: [
            { id: 'read', name: 'Read article', type: 'tool', pluginId: 'read-page', args: { maxChars: '60000' }, timeoutMs: 180000 },
            {
                id: 'answer', name: 'Answer', type: 'llm', timeoutMs: 300000,
                prompt: 'Answer this question using only the article text in the run context (step read): "{{input}}"\nStructure: a direct answer in one to three sentences; then "**Evidence**" with 1–4 verbatim quotes, each followed by its [page N] marker or section name in parentheses; then, if relevant, "**Caveats**" (one or two lines: what the article leaves unclear). If the article does not contain the answer, say exactly that and name the closest passage; do not answer from general knowledge. If the read text is truncated, say which part of the article you could see.'
            }
        ]
    },
    {
        id: 'referee-report-harness',
        name: 'Referee-style review of this article (HTML or PDF)',
        description: 'Reads the article in the active tab and reviews it the way a careful referee would, in four parallel lanes — claims and contribution, methods and statistics, evidence and reproducibility, presentation — then merges them into a structured report with a recommendation. Every concern must point at a passage; the report says where the text was silent instead of guessing.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Venue or focus (optional)', placeholder: 'e.g. "for a methods journal", "focus on the statistics"', required: false },
        steps: [
            { id: 'read', name: 'Read article', type: 'tool', pluginId: 'read-page', args: { maxChars: '60000' }, timeoutMs: 180000 },
            {
                id: 'lanes', name: 'Review in parallel', type: 'parallel',
                steps: [
                    { id: 'claims', name: 'Claims and contribution', type: 'llm', timeoutMs: 300000, prompt: 'From the article (step read): state the research question, the main claims (numbered), and what the authors say is new. For each claim, quote the sentence that makes it with its [page N] marker. Then say in two sentences whether the claims are proportionate to what the abstract and conclusion promise. Use only the text.' },
                    { id: 'methods', name: 'Methods and statistics', type: 'llm', timeoutMs: 300000, prompt: 'From the article (step read), assess the methods: design, sample or dataset and its size, controls or baselines, statistical tests and whether assumptions, multiple-comparison handling, effect sizes and uncertainty are reported. List concrete concerns as bullets, each citing the passage ([page N] or section). Where the text is silent on something a referee would expect, say "not reported" rather than assuming.' },
                    { id: 'evidence', name: 'Evidence and reproducibility', type: 'llm', timeoutMs: 300000, prompt: 'From the article (step read): do the reported results support each claim? Note results that are described but not quantified, figures or tables referred to but not explained, and any mismatch between numbers in the text. Then check reproducibility: data availability, code availability, preregistration, versions of software or instruments, and ethics or approval statements — quote each statement found, and list what is missing. Use only the text.' },
                    { id: 'presentation', name: 'Presentation', type: 'llm', timeoutMs: 300000, prompt: 'From the article (step read): assess structure and clarity for a reader in the field — is the abstract accurate, are terms defined, are limitations stated, are the figures and tables (as described) sufficient? Give at most 6 specific, actionable suggestions, each pointing at a passage or section.' }
                ]
            },
            {
                id: 'report', name: 'Referee report', type: 'llm', timeoutMs: 300000,
                prompt: 'Merge the four lane outputs in the run context (steps claims, methods, evidence, presentation) into one referee report with exactly these sections: "## Summary" (3–5 sentences: what the paper does and finds, in neutral terms), "## Strengths" (bullets), "## Major concerns" (numbered; each one sentence of concern, one of why it matters, and the passage it refers to), "## Minor points" (bullets), "## Questions to the authors" (numbered, answerable), "## Reproducibility" (what is available, what is missing), "## Recommendation" (one of: accept, minor revision, major revision, reject — with two sentences of justification tied to the major concerns). {{input}}\nKeep every concern traceable to a passage; drop anything a lane could not ground in the text. End with one line: "This report was produced by a language model reading the text alone; it has not checked the data, the code or the literature."'
            }
        ]
    },
    {
        id: 'compare-articles-harness',
        name: 'Compare two articles (two tabs, HTML or PDF)',
        description: 'Picks two open tabs showing articles — web pages or PDFs — reads both in parallel, digests each into the same structure (question, methods, data, results with numbers, limitations) and writes a side-by-side comparison: where they agree, where they contradict each other, and what each does that the other does not.',
        version: '1.0.0',
        source: 'built-in',
        input: { label: 'Which two, and what to compare (optional)', placeholder: 'e.g. "the two arXiv tabs; focus on the datasets and reported accuracy"', required: false },
        steps: [
            { id: 'tabs', name: 'List tabs', type: 'resource', pluginId: 'tabs' },
            {
                id: 'pick', name: 'Pick two tabs', type: 'llm', expect: 'json',
                prompt: 'From the tab list in the run context, return a JSON array of exactly two tab ids (numbers) for the two articles to compare — scholarly articles, preprints or PDFs, not search pages, this extension or browser-internal pages. {{input}}\nIf the user named tabs, honour that; otherwise prefer the active tab and the most similar other article. Example: [12, 15]'
            },
            {
                id: 'each', name: 'Read and digest each', type: 'foreach', items: '{{steps.pick.json}}', parallel: true, maxItems: 2,
                steps: [
                    { id: 'read', name: 'Read', type: 'tool', pluginId: 'read-page', args: { tabId: '{{item}}', maxChars: '45000' }, onError: 'continue', timeoutMs: 180000 },
                    {
                        id: 'digest', name: 'Digest', type: 'llm', when: '{{steps.read.status}} == done', timeoutMs: 300000,
                        prompt: 'Digest the article in step read (tab {{item}}) under exactly these headings, using only its text and quoting numbers verbatim with [page N] markers where present: **Title and authors**, **Research question**, **Methods**, **Data or materials** (source, size), **Main results** (with the numbers), **Stated limitations**, **Availability** (data, code). Where the text is silent, write "not stated".'
                    }
                ]
            },
            {
                id: 'compare', name: 'Compare', type: 'llm', timeoutMs: 300000,
                prompt: 'Using the two digests in the run context, write "## Side by side": a Markdown table with one row per heading of the digests (Research question, Methods, Data, Main results, Limitations, Availability) and one column per article (use short titles). Then "## Agreement" (bullets), "## Contradictions or tensions" (bullets, each naming the two passages), "## Only in one of them" (bullets), and "## Assessment" (3–5 sentences: which evidence is stronger and why, in terms of the numbers and methods reported). {{input}}\nIf one article could not be read, say so first and compare what is available.'
            }
        ]
    },
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
        description: 'Searches the active tab (HTML pages only) for the terms in your question, reads the matches, and answers with quotes. Cheap on long pages; for PDFs and full articles use "Answer a question from this article".',
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
