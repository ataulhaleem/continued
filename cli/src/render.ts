/** Terminal rendering: colours when attached to a TTY, plain text otherwise. */

import { HarnessRun, StepRun } from '../../core/harness/types';

const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), cyan = c('36');

export const ICON: Record<string, string> = { pending: '·', running: '▶', done: '✓', failed: '✕', skipped: '⏭', cancelled: '■' };
const PAINT: Record<string, (s: string) => string> = { done: green, failed: red, skipped: yellow, running: cyan, pending: dim, cancelled: red };

export function paint(status: string, text: string): string { return (PAINT[status] ?? ((s: string) => s))(text); }

export function duration(s: { startedAt?: number; endedAt?: number }): string {
    if (!s.startedAt) { return ''; }
    const ms = (s.endedAt ?? Date.now()) - s.startedAt;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Print step transitions as they happen: one line per status change. */
export class ProgressPrinter {
    private seen = new Map<string, string>();
    private paused = false;
    private buffer: string[] = [];
    constructor(private readonly out: NodeJS.WriteStream = process.stderr) {}

    /** While an approval prompt is open, progress lines are held back so they do not interleave with it. */
    pause(): void { this.paused = true; }
    resume(): void {
        this.paused = false;
        if (this.buffer.length) { this.out.write(this.buffer.join('')); this.buffer = []; }
    }
    private emit(line: string): void { if (this.paused) { this.buffer.push(line); } else { this.out.write(line); } }

    update(run: HarnessRun): void {
        const visit = (steps: StepRun[], depth: number): void => {
            for (const s of steps) {
                const key = `${depth}:${s.id}:${s.startedAt ?? ''}`;
                const prev = this.seen.get(key);
                if (prev !== s.status && s.status !== 'pending') {
                    this.seen.set(key, s.status);
                    const indent = '  '.repeat(depth);
                    const tail = s.status === 'running' ? '' : dim(` ${duration(s)}`);
                    const err = s.status === 'failed' && s.error ? `\n${indent}    ${red(s.error.split('\n')[0].slice(0, 160))}` : '';
                    this.emit(`${indent}${paint(s.status, ICON[s.status])} ${s.id} ${dim(`(${s.type})`)}${tail}${err}\n`);
                }
                if (s.children?.length) { visit(s.children, depth + 1); }
            }
        };
        visit(run.steps, 1);
    }
}

export function tree(run: HarnessRun): string {
    const lines: string[] = [];
    const visit = (steps: StepRun[], depth: number): void => {
        for (const s of steps) {
            lines.push(`${'  '.repeat(depth)}${paint(s.status, ICON[s.status])} ${s.id} ${dim(`${s.type} · ${s.status}${s.attempts > 1 ? ` · ${s.attempts} attempts` : ''} · ${duration(s)}`)}`);
            if (s.children?.length) { visit(s.children, depth + 1); }
        }
    };
    visit(run.steps, 1);
    return lines.join('\n');
}

export function table(rows: string[][], header?: string[]): string {
    const all = header ? [header, ...rows] : rows;
    const widths = all[0].map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
    const fmt = (r: string[]) => r.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
    const out = all.map(fmt);
    if (header) { out.splice(1, 0, widths.map(w => '-'.repeat(w)).join('  ')); }
    return out.join('\n');
}
