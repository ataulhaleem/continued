/**
 * Grounding: does a model-written step point at the text it was given?
 *
 * The research harnesses instruct a model to quote passages and copy numbers. That is a
 * prompt; this module measures whether it was obeyed. From an `llm` step's output it extracts
 * the *claims that can be checked mechanically*: quoted spans and numbers. Each is looked up in
 * the outputs of the deterministic steps that ran before (the sources). A quotation is grounded
 * when it occurs verbatim (whitespace and case normalised) in a source; a number is grounded
 * when the same numeral occurs in a source. The result is a rate, per step and per run, and a
 * list of what could not be found — which is where fabrication shows.
 *
 * Free of editor, browser and Node APIs.
 */

import { HarnessRun, StepRun } from './types';

export interface Claim { kind: 'quote' | 'number'; text: string; grounded: boolean }

export interface StepGrounding {
    stepId: string;
    quotes: number;
    quotesGrounded: number;
    numbers: number;
    numbersGrounded: number;
    ungrounded: Claim[];
}

export interface GroundingReport {
    harnessId: string;
    sourceChars: number;
    steps: StepGrounding[];
    quotes: number;
    quotesGrounded: number;
    numbers: number;
    numbersGrounded: number;
    /** Grounded claims over all checkable claims, or null when there were none. */
    rate: number | null;
}

export function normalise(text: string): string {
    return text.toLowerCase().replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

const MIN_QUOTE = 12;

/** Quoted spans (straight or curly double quotes) and Markdown block quotes, long enough to be a passage. */
export function extractQuotes(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/["“]([^"“”\n]{12,600})["”]/g)) { out.push(m[1].trim()); }
    for (const m of text.matchAll(/^>\s?(.+)$/gm)) { const q = m[1].trim(); if (q.length >= MIN_QUOTE) { out.push(q); } }
    return out;
}

/**
 * Numerals as a reader would check them: integers and decimals, with thousands separators,
 * optional sign and percent. Years in citations and list numbering are excluded heuristically:
 * a bare 1–2 digit integer at the start of a line, and four-digit numbers in parentheses.
 */
export function extractNumbers(text: string): string[] {
    const stripped = text
        .replace(/^\s*\d{1,2}[.)]\s/gm, ' ')          // list numbering
        .replace(/\((?:[^()]*?\b(1[89]\d\d|20\d\d)\b)[^()]*\)/g, ' ')  // (Author, 2021)
        .replace(/\[page \d+\]/gi, ' ')                 // page markers we added ourselves
        .replace(/\[\d+\]/g, ' ');                      // reference numbers
    const out: string[] = [];
    for (const m of stripped.matchAll(/(?<![\w.])[+\-−]?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?%?|(?<![\w.])[+\-−]?\d+(?:\.\d+)?%?(?![\w])/g)) {
        const n = m[0].replace(/−/g, '-');
        if (/^[+-]?\d$/.test(n)) { continue; }          // single digits are noise (counts, ordinals)
        out.push(n);
    }
    return out;
}

function numberVariants(n: string): string[] {
    const bare = n.replace(/^[+-]/, '').replace(/%$/, '');
    const noSep = bare.replace(/[, ]/g, '');
    const variants = new Set([bare, noSep]);
    if (/^\d+$/.test(noSep) && noSep.length > 3) { variants.add(noSep.replace(/\B(?=(\d{3})+(?!\d))/g, ',')); }
    if (noSep.includes('.')) { variants.add(noSep.replace('.', ',')); }   // decimal comma in sources
    return Array.from(variants);
}

function sourcesOf(run: HarnessRun): string {
    const parts: string[] = [];
    const visit = (steps: StepRun[]): void => {
        for (const s of steps) {
            if (s.type !== 'llm' && s.type !== 'parallel' && s.type !== 'sequence' && s.type !== 'foreach' && s.output) { parts.push(s.output); }
            if (s.children?.length) { visit(s.children); }
        }
    };
    visit(run.steps);
    return parts.join('\n');
}

function llmSteps(run: HarnessRun): StepRun[] {
    const out: StepRun[] = [];
    const visit = (steps: StepRun[]): void => { for (const s of steps) { if (s.type === 'llm' && s.output) { out.push(s); } if (s.children?.length) { visit(s.children); } } };
    visit(run.steps);
    return out;
}

export function checkGrounding(run: HarnessRun): GroundingReport {
    const sourceRaw = sourcesOf(run);
    const source = normalise(sourceRaw);
    const steps: StepGrounding[] = [];
    for (const s of llmSteps(run)) {
        const quotes = extractQuotes(s.output ?? '');
        const numbers = extractNumbers(s.output ?? '');
        const ungrounded: Claim[] = [];
        let qg = 0, ng = 0;
        for (const q of quotes) { if (source.includes(normalise(q))) { qg++; } else { ungrounded.push({ kind: 'quote', text: q, grounded: false }); } }
        for (const n of numbers) {
            const found = numberVariants(n).some(v => new RegExp(`(?<![\\d.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`).test(source));
            if (found) { ng++; } else { ungrounded.push({ kind: 'number', text: n, grounded: false }); }
        }
        steps.push({ stepId: s.id, quotes: quotes.length, quotesGrounded: qg, numbers: numbers.length, numbersGrounded: ng, ungrounded });
    }
    const quotes = steps.reduce((a, s) => a + s.quotes, 0), quotesGrounded = steps.reduce((a, s) => a + s.quotesGrounded, 0);
    const numbers = steps.reduce((a, s) => a + s.numbers, 0), numbersGrounded = steps.reduce((a, s) => a + s.numbersGrounded, 0);
    const total = quotes + numbers;
    return { harnessId: run.harnessId, sourceChars: sourceRaw.length, steps, quotes, quotesGrounded, numbers, numbersGrounded, rate: total ? (quotesGrounded + numbersGrounded) / total : null };
}

export function renderGrounding(r: GroundingReport): string {
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
    const lines = [
        `# Grounding: ${r.harnessId}`,
        '',
        `Sources: ${r.sourceChars} chars from deterministic steps. Quotes grounded: ${r.quotesGrounded}/${r.quotes} (${pct(r.quotesGrounded, r.quotes)}). Numbers grounded: ${r.numbersGrounded}/${r.numbers} (${pct(r.numbersGrounded, r.numbers)}). Overall: ${r.rate === null ? 'no checkable claims' : pct(r.quotesGrounded + r.numbersGrounded, r.quotes + r.numbers)}.`,
        '',
        '| Step | Quotes | Numbers | Ungrounded |',
        '| --- | --- | --- | --- |'
    ];
    for (const s of r.steps) {
        const bad = s.ungrounded.slice(0, 6).map(c => (c.kind === 'quote' ? `“${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}”` : c.text)).join('; ') + (s.ungrounded.length > 6 ? ` … +${s.ungrounded.length - 6}` : '');
        lines.push(`| ${s.stepId} | ${s.quotesGrounded}/${s.quotes} | ${s.numbersGrounded}/${s.numbers} | ${bad || '—'} |`);
    }
    return lines.join('\n');
}
