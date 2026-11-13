/**
 * Harness definitions — declarative workflows built from plugins and model calls.
 *
 * A harness is stored as JSON in `.continued/harnesses/<id>.json` and executed by
 * `harnessEngine.ts`. Values in step arguments and prompts may reference earlier
 * results with `{{steps.<id>.output}}`, the run input with `{{input}}`, the current
 * loop item with `{{item}}`, and workspace variables such as `{{activeFile}}`.
 */

export type OnError = 'stop' | 'continue' | 'retry-then-stop' | 'retry-then-continue';

export interface HarnessStepBase {
    /** Unique within the harness; used in `{{steps.<id>...}}` references. */
    id: string;
    name?: string;
    /** Skip the step unless this template evaluates truthy (e.g. `{{steps.test.status}} == failed`). */
    when?: string;
    onError?: OnError;
    /** Retries for the retry policies (default 2). */
    retries?: number;
    /** Per-attempt timeout in milliseconds (default 120000). */
    timeoutMs?: number;
}

export interface ToolStep extends HarnessStepBase {
    type: 'tool';
    pluginId: string;
    /** Argument templates; strings are interpolated, "true"/"false"/numbers are coerced. */
    args: Record<string, unknown>;
}

export interface ResourceStep extends HarnessStepBase {
    type: 'resource';
    pluginId: string;
}

export interface SkillStep extends HarnessStepBase {
    type: 'skill';
    pluginId: string;
    /** Optional input passed to the skill (harnesses accept it as `{{input}}`). */
    input?: string;
}

export interface LlmStep extends HarnessStepBase {
    type: 'llm';
    /** Prompt template. */
    prompt: string;
    /** Extra system instructions appended to the harness briefing. */
    system?: string;
    /** Model id; empty means "the model selected in the sidebar". */
    model?: string;
    /** `json` validates the reply as JSON (retrying once with a correction). */
    expect?: 'text' | 'json';
}

export interface ParallelStep extends HarnessStepBase {
    type: 'parallel';
    /** Each child is one branch; use a `sequence` child for a multi-step branch. */
    steps: HarnessStep[];
}

export interface SequenceStep extends HarnessStepBase {
    type: 'sequence';
    /** Children run in order; the group's output is the last successful child's output. */
    steps: HarnessStep[];
}

export interface ForeachStep extends HarnessStepBase {
    type: 'foreach';
    /** Template that resolves to an array (e.g. `{{steps.find.lines}}`) or newline-separated text. */
    items: string;
    /** Variable name for the current item (default `item`). */
    itemVar?: string;
    /** Run iterations concurrently. */
    parallel?: boolean;
    /** Safety cap on iterations (default 50). */
    maxItems?: number;
    steps: HarnessStep[];
}

export type HarnessStep = ToolStep | ResourceStep | SkillStep | LlmStep | ParallelStep | SequenceStep | ForeachStep;

export interface HarnessDefinition {
    id: string;
    name: string;
    description?: string;
    version?: string;
    source: 'built-in' | 'user';
    /** Describes the free-text input the user is asked for when running. */
    input?: {
        label?: string;
        placeholder?: string;
        required?: boolean;
    };
    steps: HarnessStep[];
    /** Template for the final output; defaults to the output of the last top-level step. */
    output?: string;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepRun {
    id: string;
    name: string;
    type: HarnessStep['type'];
    status: StepStatus;
    attempts: number;
    output?: string;
    error?: string;
    /** Notes for humans and for LLM steps: retries, skipped reasons, coercions. */
    notes: string[];
    startedAt?: number;
    endedAt?: number;
    children?: StepRun[];
}

export interface HarnessRun {
    harnessId: string;
    harnessName: string;
    input: string;
    status: 'running' | 'done' | 'failed' | 'cancelled';
    steps: StepRun[];
    output: string;
    error?: string;
    startedAt: number;
    endedAt?: number;
}

export interface PluginArgSpec {
    name: string;
    description?: string;
    required?: boolean;
    /** Hint for the builder UI. */
    multiline?: boolean;
    default?: string;
}
