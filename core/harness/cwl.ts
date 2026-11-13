/**
 * Common Workflow Language export.
 *
 * A harness is a dataflow graph with a fixed control structure, which is also what a CWL
 * `Workflow` is, so the translation is structural rather than a rewrite. What does not map
 * one-to-one is the step body: a harness step invokes an Enclave plugin or a language model,
 * while a CWL step must run a `CommandLineTool`. The export therefore ships a single generic
 * tool — a stdlib-only Python runner staged by `InitialWorkDirRequirement` — and every harness
 * step becomes a CWL step that calls it with a JSON `spec` describing what to do. The runner
 * implements the same `{{…}}` template substitution as the engine, so prompts and arguments
 * resolve identically, and it records a `status` output (`done`/`failed`/`skipped`) so the
 * harness error policies and status conditions survive: `onError: continue` becomes a tool
 * that exits 0 on failure, and `when: {{steps.x.status}} == failed` becomes a CWL v1.2 `when`.
 *
 * Correspondence:
 *
 *   tool / resource        → step calling `enclave_step` (read-only built-ins are reimplemented
 *                            by the runner; anything else yields a step whose output says why
 *                            it could not run, and the document header lists it)
 *   llm                    → `enclave_step` in `llm` mode: POST to an OpenAI-compatible
 *                            `/chat/completions` (Ollama, Blablador, …) with `NetworkAccess`;
 *                            endpoint, model and key are workflow inputs
 *   parallel               → children flattened; CWL runs independent steps concurrently
 *   sequence               → children flattened with an ordering edge between siblings
 *   foreach                → items step → `ExpressionTool` → scattered sub-workflow
 *   when                   → CWL `when` for `{{steps.x.status}} ==|!= value`; other forms are
 *                            evaluated by the runner, which then reports `skipped`
 *   group / foreach output → a `join` step collecting the children, as the engine does
 *   harness output         → a final `collect` step producing `output` and `run_record`
 *
 * The document is emitted as YAML by a small emitter here rather than a dependency: every
 * scalar is written as a JSON-quoted string, which is valid YAML and escapes anything a
 * prompt might contain. The runner script is the one literal block, and it deliberately
 * contains no `$(` or `${`, because `entry` is an expression-evaluated field in CWL.
 *
 * Free of editor and browser APIs; shared by both hosts and unit-tested directly.
 */

import { ForeachStep, HarnessDefinition, HarnessStep, LlmStep, ToolStep } from './types';
import { walkSteps } from './portable';

export const CWL_VERSION = 'v1.2';
export const CWL_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export interface CwlOptions {
    /** Recorded in the document header for provenance. */
    generator?: string;
    /** Default value of the `llm_model` workflow input. */
    defaultModel?: string;
    /** Fixed timestamp; defaults to now. Present so tests are deterministic. */
    now?: Date;
}

export interface CwlExport {
    /** The `.cwl` document. */
    workflow: string;
    /** A job file with every workflow input filled with a sensible default. */
    job: string;
    /** Harness constructs that could not be translated faithfully, one line each. */
    notes: string[];
    /** The object graph the YAML was produced from — exposed for tests. */
    graph: CwlGraph;
}

export interface CwlGraph {
    cwlVersion: string;
    $graph: Array<Record<string, unknown>>;
}

/** Plugins the runner can execute without the editor. */
export const CWL_SUPPORTED_PLUGINS: ReadonlySet<string> = new Set([
    'run-command', 'read-file', 'grep-search', 'semantic-search', 'list-directory', 'file-info',
    'workspace-files', 'git-info', 'git-summary', 'csv-preview', 'json-query'
]);

// ---------------------------------------------------------------------------
// Identifiers and references
// ---------------------------------------------------------------------------

/** CWL identifiers are safest as `[A-Za-z_][A-Za-z0-9_]*`; harness ids may contain `-` and `.`. */
export function cwlId(id: string): string {
    const safe = String(id).replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z_]/.test(safe) ? safe : `s_${safe}`;
}

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Step ids referenced as `{{steps.<id>…}}` in the given texts. */
function stepRefs(texts: unknown[]): string[] {
    const ids = new Set<string>();
    for (const text of texts) {
        if (typeof text !== 'string') { continue; }
        let m: RegExpExecArray | null;
        TEMPLATE_RE.lastIndex = 0;
        while ((m = TEMPLATE_RE.exec(text)) !== null) {
            const ref = m[1].trim().match(/^steps\.([A-Za-z0-9_-]+)/);
            if (ref) { ids.add(ref[1]); }
        }
    }
    return Array.from(ids);
}

/** Every templated text a step carries. */
function templateTexts(step: HarnessStep): unknown[] {
    const texts: unknown[] = [step.when];
    switch (step.type) {
        case 'tool': texts.push(...Object.values(step.args ?? {})); break;
        case 'skill': texts.push(step.input); break;
        case 'llm': texts.push(step.prompt, step.system); break;
        case 'foreach': texts.push(step.items); break;
        default: break;
    }
    return texts;
}

/** Step ids a single step reads through its templated fields. */
function referencedSteps(step: HarnessStep): string[] {
    return stepRefs(templateTexts(step));
}

/**
 * Bare variables (`{{activeFile}}`, `{{selection}}`, `{{input}}`, …) a harness references
 * anywhere, including inside groups and loops. Step references are not included. Used to know,
 * before a run leaves the editor, which editor state has to travel with it.
 */
export function referencedVariables(def: HarnessDefinition): Set<string> {
    const names = new Set<string>();
    const visit = (steps: HarnessStep[]): void => {
        for (const step of steps) {
            for (const text of templateTexts(step)) {
                if (typeof text !== 'string') { continue; }
                let m: RegExpExecArray | null;
                TEMPLATE_RE.lastIndex = 0;
                while ((m = TEMPLATE_RE.exec(text)) !== null) {
                    const expr = m[1].trim();
                    if (!expr.startsWith('steps.')) { names.add(expr); }
                }
            }
            const children = (step as { steps?: HarnessStep[] }).steps;
            if (Array.isArray(children)) { visit(children); }
        }
    };
    visit(def.steps);
    if (def.output) {
        let m: RegExpExecArray | null;
        TEMPLATE_RE.lastIndex = 0;
        while ((m = TEMPLATE_RE.exec(def.output)) !== null) {
            const expr = m[1].trim();
            if (!expr.startsWith('steps.')) { names.add(expr); }
        }
    }
    return names;
}

/** `{{steps.x.status}} == value` / `!=` — the one condition shape CWL `when` states directly. */
function statusCondition(when: string | undefined): { step: string; op: '==' | '!='; value: string } | null {
    if (!when) { return null; }
    const m = when.trim().match(/^\{\{\s*steps\.([A-Za-z0-9_-]+)\.status\s*\}\}\s*(==|!=)\s*["']?([A-Za-z]+)["']?\s*$/);
    return m ? { step: m[1], op: m[2] as '==' | '!=', value: m[3] } : null;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Executed once per step in a directory holding `inputs.json` (the CWL inputs as JSON) and a
 * staged `workspace/`. Writes `output.txt` and `status.txt`; exits non-zero only when the
 * harness policy says the failure should stop the run. Must contain no `$(` or `${`, and no
 * trailing spaces, so it can be emitted as a YAML literal block inside an expression field.
 */
export const CWL_RUNNER_SCRIPT = String.raw`import json, os, re, subprocess, sys, time, urllib.error, urllib.request

inputs = json.load(open(sys.argv[1], encoding="utf-8"))
spec = json.loads(inputs["spec"])
WS = os.path.abspath("workspace")
OUT, STATUS = "output.txt", "status.txt"

# ---- run context: upstream outputs paired with their ids and statuses ------------------------
ctx = {}
files = inputs.get("context") or []
stats = inputs.get("context_status") or []
for i, cid in enumerate(spec.get("context_ids", [])):
    f = files[i] if i < len(files) else None
    st = stats[i] if i < len(stats) else None
    if f is None:
        ctx[cid] = {"status": "skipped", "text": ""}
    elif isinstance(f, list):
        texts = [open(x["path"], encoding="utf-8", errors="replace").read() for x in f if x]
        ctx[cid] = {"status": "done", "text": "\n\n".join(texts), "parts": texts}
    else:
        ctx[cid] = {"status": st or "done", "text": open(f["path"], encoding="utf-8", errors="replace").read()}

VARS = {
    "input": inputs.get("input") or "",
    "item": inputs.get("item"),
    "index": inputs.get("index"),
    "workspace": WS,
    "activeFile": inputs.get("active_file") or "",
    "selection": inputs.get("selection") or "",
    "date": time.strftime("%Y-%m-%d"),
}
if spec.get("itemVar") and VARS["item"] is not None:
    VARS[spec["itemVar"]] = VARS["item"]

HEADER_RE = re.compile(r"^(Found|No |Command executed|File )", re.I)

def output_lines(text):
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if lines and HEADER_RE.match(lines[0]) and re.search(r"[:.]$", lines[0]):
        return lines[1:]
    return lines

def resolve(expr):
    e = expr.strip()
    if e in VARS and VARS[e] is not None:
        return VARS[e]
    m = re.match(r"^steps\.([A-Za-z0-9_-]+)(?:\.(.+))?$", e)
    if not m:
        raise KeyError("Unknown variable {{" + e + "}}")
    sid, field = m.group(1), m.group(2) or "output"
    if sid not in ctx:
        raise KeyError("Unknown step reference {{" + e + "}}: no step '" + sid + "' has run yet.")
    run = ctx[sid]
    if field == "output":
        return run["text"]
    if field == "status":
        return run["status"]
    if field == "error":
        return run["text"] if run["status"] == "failed" else ""
    if field == "lines":
        return output_lines(run["text"])
    if field == "json" or field.startswith("json."):
        value = json.loads(run["text"])
        for part in (field[5:].split(".") if field != "json" else []):
            if not isinstance(value, dict):
                raise KeyError("{{" + e + "}}: path '" + part + "' not found")
            value = value[part]
        return value
    raise KeyError("Unknown field '" + field + "' in {{" + e + "}}")

def stringify(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(x if isinstance(x, str) else json.dumps(x) for x in v)
    if isinstance(v, dict):
        return json.dumps(v, indent=2)
    return str(v)

TPL = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

def interpolate(t):
    if not isinstance(t, str):
        return t
    whole = re.match(r"^\{\{\s*([^{}]+?)\s*\}\}$", t.strip())
    if whole:
        return resolve(whole.group(1))
    return TPL.sub(lambda m: stringify(resolve(m.group(1))), t)

def truthy(when):
    if not when or not when.strip():
        return True
    text = stringify(interpolate(when)).strip()
    cmp = re.match(r"^(.*?)\s*(==|!=)\s*(.*?)$", text)
    if cmp:
        l, r = cmp.group(1).strip().strip("\"'"), cmp.group(3).strip().strip("\"'")
        return (l == r) if cmp.group(2) == "==" else (l != r)
    return not (text == "" or re.match(r"^(false|0|no|null|undefined)$", text, re.I))

def inside(rel):
    p = os.path.abspath(os.path.join(WS, str(rel)))
    if os.path.commonpath([p, WS]) != WS:
        raise ValueError("Access denied: '" + str(rel) + "' is outside the workspace")
    return p

def file_arg(pid, args):
    rel = stringify(args.get("filePath") or args.get("path") or "")
    if not rel:
        raise ValueError(pid + ": no file path was given. If this step uses {{activeFile}}, "
                         "set the workflow input active_file to a workspace-relative path; "
                         "no active file was passed to this run.")
    return inside(rel)

SKIP_DIRS = (".git", "node_modules", "dist", "out", ".venv", "__pycache__")

def glob_match(rel, pattern):
    alts = [pattern]
    while any("{" in a for a in alts):
        out = []
        for a in alts:
            m = re.search(r"\{([^{}]*)\}", a)
            if not m:
                out.append(a)
                continue
            for choice in m.group(1).split(","):
                out.append(a[:m.start()] + choice + a[m.end():])
        alts = out
    for a in alts:
        rx = re.escape(a).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*").replace(r"\?", "[^/]")
        if re.fullmatch(rx, rel):
            return True
    return False

def walk(pattern):
    pattern = (pattern or "**/*").replace("\\", "/")
    for root, dirs, names in os.walk(WS):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), WS).replace("\\", "/")
            if glob_match(rel, pattern):
                yield rel

def shell(cmd, timeout):
    cp = subprocess.run(cmd, shell=True, cwd=WS, capture_output=True, text=True, timeout=timeout, errors="replace")
    text = (cp.stdout or "") + (("\n" + cp.stderr) if cp.stderr else "")
    return cp.returncode == 0, text.strip()

def run_context():
    lines = []
    for cid, run in ctx.items():
        lines.append("- [" + run["status"].upper() + "] " + cid)
        if run["status"] != "skipped" and run["text"]:
            body = run["text"][:6000] + ("\n[... truncated]" if len(run["text"]) > 6000 else "")
            lines.append("  output:\n" + "\n".join("    " + l for l in body.split("\n")))
    loc = [k + ": " + stringify(v)[:500] for k, v in VARS.items() if k in ("item", "index") and v is not None]
    parts = [
        "Harness: " + spec.get("harnessName", ""),
        ("User input: " + VARS["input"]) if VARS["input"] else "User input: (none)",
        ("Loop variables:\n" + "\n".join("- " + l for l in loc)) if loc else "",
        ("Steps so far:\n" + "\n".join(lines)) if lines else "Steps so far: (none)",
    ]
    return "\n\n".join(x for x in parts if x)

BRIEFING = ("You are one step inside an automated harness (a fixed workflow of tool calls and model calls) "
            "exported to CWL. The RUN CONTEXT below lists every step that ran before you, with its status and output. "
            "Rules: base your answer ONLY on the run context and the instruction; do not invent the output of a step "
            "that FAILED, was SKIPPED or produced nothing. Follow the output format the instruction asks for exactly.")

def call_llm(prompt, system, expect_json):
    base = (inputs.get("llm_base_url") or "http://localhost:11434/v1").rstrip("/")
    body = {"model": inputs.get("llm_model") or "llama3", "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}
    if expect_json:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    key = inputs.get("llm_api_key")
    if key:
        req.add_header("Authorization", "Bearer " + key)
    try:
        with urllib.request.urlopen(req, timeout=spec.get("timeoutMs", 120000) / 1000.0) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        # The usual cause inside a container is that it has no network: say so, and say the fix.
        raise RuntimeError("Model endpoint " + base + " is unreachable from here (" + str(getattr(e, "reason", e)) + "). "
                           "If this run is in a sealed container, model steps cannot succeed: run again with network allowed, "
                           "or point llm_base_url at a server the container can reach.")
    choices = data.get("choices") or []
    text = ((choices[0].get("message") or {}).get("content") if choices else None) or (data.get("message") or {}).get("content") or ""
    return text.strip()

FENCE = chr(96) * 3  # three backticks, spelled out so the script can live inside a JS template literal

def strip_fences(t):
    m = re.match("^" + FENCE + r"[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?" + FENCE + r"\s*$", t.strip())
    return m.group(1) if m else t

def do_llm():
    prompt = stringify(interpolate(spec.get("prompt", "")))
    system = BRIEFING + "\n\n## RUN CONTEXT\n" + run_context()
    if spec.get("system"):
        system += "\n\n## ADDITIONAL INSTRUCTIONS\n" + stringify(interpolate(spec["system"]))
    expect_json = spec.get("expect") == "json"
    if expect_json:
        system += "\n\nReply with ONLY a single JSON value. No prose, no markdown fences."
    reply = call_llm(prompt, system, expect_json)
    if expect_json:
        try:
            return True, json.dumps(json.loads(strip_fences(reply)), indent=2)
        except ValueError:
            retry = prompt + "\n\nYour previous reply was not valid JSON:\n" + reply[:1500] + "\n\nReply again with ONLY valid JSON."
            reply = call_llm(retry, system, True)
            return True, json.dumps(json.loads(strip_fences(reply)), indent=2)
    if not reply:
        raise RuntimeError("LLM step returned an empty reply.")
    return True, reply

def do_tool():
    pid = spec["pluginId"]
    args = {k: (interpolate(v) if isinstance(v, str) else v) for k, v in (spec.get("args") or {}).items()}
    timeout = spec.get("timeoutMs", 120000) / 1000.0
    if pid == "run-command":
        return shell(stringify(args.get("command", "")), timeout)
    if pid == "read-file":
        p = file_arg(pid, args)
        return True, open(p, encoding="utf-8", errors="replace").read()
    if pid == "grep-search":
        rx = re.compile(stringify(args.get("query") or args.get("pattern") or ""))
        hits = []
        for rel in walk(stringify(args.get("filePattern") or "**/*")):
            try:
                with open(os.path.join(WS, rel), encoding="utf-8", errors="replace") as fh:
                    for n, line in enumerate(fh, 1):
                        if rx.search(line):
                            hits.append(rel + ":" + str(n) + ": " + line.rstrip())
                            if len(hits) >= 500:
                                break
            except OSError:
                continue
            if len(hits) >= 500:
                break
        return True, ("Found " + str(len(hits)) + " matches:\n" + "\n".join(hits)) if hits else "No matches found."
    if pid in ("semantic-search", "workspace-files"):
        paths = sorted(walk(stringify(args.get("pattern") or args.get("query") or "**/*")))
        return True, ("Found " + str(len(paths)) + " files:\n" + "\n".join(paths)) if paths else "No files found."
    if pid == "list-directory":
        p = inside(args.get("path") or ".")
        return True, "\n".join(sorted(os.listdir(p)))
    if pid == "file-info":
        p = file_arg(pid, args)
        st = os.stat(p)
        info = {"path": args.get("filePath"), "bytes": st.st_size,
                "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(st.st_mtime))}
        return True, json.dumps(info, indent=2)
    if pid in ("git-info", "git-summary"):
        ok1, a = shell("git status --short --branch", timeout)
        ok2, b = shell("git log -8 --oneline", timeout)
        return ok1 and ok2, a + "\n\n" + b
    if pid == "csv-preview":
        p = file_arg(pid, args)
        with open(p, encoding="utf-8", errors="replace") as fh:
            return True, "".join(fh.readlines()[: int(args.get("rows") or 20)])
    if pid == "json-query":
        p = file_arg(pid, args)
        value = json.load(open(p, encoding="utf-8"))
        for part in [x for x in stringify(args.get("query") or "").split(".") if x]:
            value = value[int(part)] if isinstance(value, list) else value[part]
        return True, json.dumps(value, indent=2)
    return False, spec.get("note") or ("Plugin '" + pid + "' is not available outside the editor.")

def do_join():
    ids = spec.get("context_ids", [])
    if spec.get("joinMode") == "last":
        done = [ctx[c]["text"] for c in ids if ctx.get(c, {}).get("status") == "done"]
        return True, (done[-1] if done else "")
    parts = []
    for cid in ids:
        run = ctx.get(cid, {"status": "skipped", "text": ""})
        if "parts" in run:
            for i, t in enumerate(run["parts"]):
                parts.append("### " + cid + "[" + str(i) + "] [done]\n" + t)
        else:
            parts.append("### " + cid + " [" + run["status"] + "]\n" + run["text"])
    return True, "\n\n".join(parts)

def do_items():
    raw = interpolate(spec.get("items", ""))
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str):
        items = [l.strip() for l in raw.split("\n") if l.strip()]
    elif isinstance(raw, dict):
        items = list(raw.values())
    else:
        items = []
    items = [x if isinstance(x, str) else json.dumps(x) for x in items][: int(spec.get("maxItems") or 50)]
    with open("items.json", "w", encoding="utf-8") as f:
        json.dump(items, f)
    return True, json.dumps(items)

def do_collect():
    record = {"harness": spec.get("harnessName"), "steps": {c: ctx[c]["status"] for c in ctx},
              "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    with open("run_record.json", "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)
    tpl = spec.get("outputTemplate")
    if tpl and tpl.strip():
        return True, stringify(interpolate(tpl))
    done = [ctx[c]["text"] for c in spec.get("context_ids", []) if ctx.get(c, {}).get("status") == "done"]
    return True, (done[-1] if done else "")

MODES = {"tool": do_tool, "llm": do_llm, "join": do_join, "items": do_items, "collect": do_collect}

def finish(text, status, code):
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text if text is not None else "")
    with open(STATUS, "w") as f:
        f.write(status)
    return code

def main():
    policy = spec.get("onError", "stop")
    stops = policy in ("stop", "retry-then-stop")
    try:
        if not truthy(spec.get("when")):
            return finish("", "skipped", 0)
    except Exception as e:
        # As in the engine: a condition that cannot be evaluated fails the step; its policy applies.
        return finish("Condition could not be evaluated: " + str(e), "failed", 1 if stops else 0)
    attempts = 1 + int(spec.get("retries", 2)) if policy.startswith("retry") else 1
    ok, text = False, ""
    for n in range(attempts):
        try:
            ok, text = MODES[spec["mode"]]()
        except Exception as e:
            ok, text = False, type(e).__name__ + ": " + str(e)
        if ok or n == attempts - 1:
            break
        time.sleep(0.5 * (n + 1))
    if not ok and stops:
        sys.stderr.write("step failed and policy is " + policy + "\n" + (text or "") + "\n")
    return finish(text, "done" if ok else "failed", 1 if (not ok and stops) else 0)

sys.exit(main())
`;

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** Where a harness step's outputs live in the CWL graph being built. */
interface Binding {
    /** `stepId/output`, or an input name inside a sub-workflow. */
    output: string;
    /** `stepId/status`, or an input name; null for a scattered array. */
    status: string | null;
    /** The producing step has a CWL `when`, so its outputs may be null. */
    nullable: boolean;
    /** A helper step the translation introduced (e.g. a loop's items step), not a harness step. */
    synthetic?: boolean;
}

interface Scope {
    bindings: Map<string, Binding>;
    /** Inside a foreach body, `item` and `index` are inputs of the sub-workflow. */
    inLoop: boolean;
    itemVar?: string;
}

interface Builder {
    steps: Obj;
    notes: string[];
    harnessName: string;
    usedIds: Set<string>;
}

function uniqueId(b: Builder, base: string): string {
    let id = cwlId(base);
    let n = 1;
    while (b.usedIds.has(id)) { id = `${cwlId(base)}_${++n}`; }
    b.usedIds.add(id);
    return id;
}

const LLM_INPUTS = ['llm_base_url', 'llm_model', 'llm_api_key'] as const;
/** Editor state that travels with the run: `{{activeFile}}` and `{{selection}}`. */
const EDITOR_INPUTS = ['active_file', 'selection'] as const;

/** Inputs every `enclave_step` call takes from the enclosing workflow. */
function commonIn(scope: Scope): Obj {
    const common: Obj = { workspace: 'workspace', input: 'input' };
    for (const k of EDITOR_INPUTS) { common[k] = k; }
    for (const k of LLM_INPUTS) { common[k] = k; }
    if (scope.inLoop) { common.item = 'item'; common.index = 'index'; }
    return common;
}

function baseSpec(step: Pick<HarnessStep, 'id' | 'name' | 'onError' | 'retries' | 'timeoutMs'>, mode: string): Obj {
    const spec: Obj = { mode, id: step.id, name: step.name ?? step.id };
    if (step.onError) { spec.onError = step.onError; }
    if (step.retries !== undefined) { spec.retries = step.retries; }
    if (step.timeoutMs !== undefined) { spec.timeoutMs = step.timeoutMs; }
    return spec;
}

/**
 * Add one call of `enclave_step`. `spec` describes what to do; `refs` are the harness step ids
 * whose outputs it reads; `after` adds an ordering edge without a data dependency.
 */
function addStep(
    b: Builder,
    scope: Scope,
    harnessId: string,
    spec: Obj,
    refs: string[],
    options: { when?: string; after?: string | null; extraOut?: string[] } = {}
): Binding {
    const id = uniqueId(b, harnessId);
    const contextRefs = refs.filter(r => scope.bindings.has(r));
    for (const r of refs) {
        if (!scope.bindings.has(r)) {
            b.notes.push(`Step "${harnessId}" references {{steps.${r}…}}, which does not run before it; the reference resolves to nothing.`);
        }
    }
    spec.context_ids = contextRefs;
    spec.harnessName = b.harnessName;
    if (scope.inLoop && scope.itemVar) { spec.itemVar = scope.itemVar; }

    const stepIn: Obj = { ...commonIn(scope) };
    if (contextRefs.length) {
        stepIn.context = { source: contextRefs.map(r => scope.bindings.get(r)!.output), linkMerge: 'merge_nested' };
        stepIn.context_status = {
            source: contextRefs.map(r => scope.bindings.get(r)!.status ?? scope.bindings.get(r)!.output),
            linkMerge: 'merge_nested'
        };
    }
    if (options.after) { stepIn.after = { source: options.after }; }

    const step: Obj = { run: '#enclave_step', in: stepIn, out: ['output', 'status', ...(options.extraOut ?? [])] };

    // A status comparison is the one condition CWL `when` states directly. The step then yields
    // null when skipped, which downstream context inputs accept. Any other condition is left to
    // the runner, which reports `skipped` with an empty output.
    let nullable = false;
    const cond = statusCondition(options.when);
    if (cond && scope.bindings.has(cond.step)) {
        const src = scope.bindings.get(cond.step)!;
        stepIn.when_status = { source: src.status ?? src.output };
        step.when = `$(inputs.when_status ${cond.op} "${cond.value}")`;
        nullable = true;
    } else if (options.when) {
        spec.when = options.when;
    }
    stepIn.spec = { default: JSON.stringify(spec) };

    b.steps[id] = step;
    const binding: Binding = { output: `${id}/output`, status: `${id}/status`, nullable };
    scope.bindings.set(harnessId, binding);
    return binding;
}

/**
 * Translate sibling steps. In a sequence each sibling follows the previous one; in a parallel
 * group they all follow whatever preceded the group. Returns the bindings in order.
 */
function buildSteps(b: Builder, scope: Scope, steps: HarnessStep[], ordered: boolean, after: string | null): Binding[] {
    const out: Binding[] = [];
    let previous: string | null = after;
    for (const step of steps) {
        const binding = buildStep(b, scope, step, ordered ? previous : after);
        out.push(binding);
        previous = binding.output;
    }
    return out;
}

function unsupported(b: Builder, step: HarnessStep, what: string, note: string): Obj {
    b.notes.push(`Step "${step.id}" ${what}; it will report failure and its policy (${step.onError ?? 'stop'}) applies.`);
    return { ...baseSpec(step, 'tool'), pluginId: (step as { pluginId?: string }).pluginId ?? step.type, args: {}, note };
}

function buildStep(b: Builder, scope: Scope, step: HarnessStep, after: string | null): Binding {
    switch (step.type) {
        case 'tool': {
            const tool = step as ToolStep;
            const spec = CWL_SUPPORTED_PLUGINS.has(tool.pluginId)
                ? { ...baseSpec(step, 'tool'), pluginId: tool.pluginId, args: tool.args ?? {} }
                : unsupported(b, step, `uses plugin "${tool.pluginId}", which the runner cannot execute`,
                    `Plugin '${tool.pluginId}' is not available outside the editor.`);
            return addStep(b, scope, step.id, spec, referencedSteps(step), { when: step.when, after });
        }
        case 'resource': {
            const spec = CWL_SUPPORTED_PLUGINS.has(step.pluginId)
                ? { ...baseSpec(step, 'tool'), pluginId: step.pluginId, args: {} }
                : unsupported(b, step, `reads resource "${step.pluginId}", which only exists inside the editor`,
                    `Resource '${step.pluginId}' describes editor state and is not available outside the editor.`);
            return addStep(b, scope, step.id, spec, referencedSteps(step), { when: step.when, after });
        }
        case 'skill': {
            const spec = unsupported(b, step, `calls skill "${step.pluginId}", which cannot be exported`,
                `Skill '${step.pluginId}' cannot be exported to CWL.`);
            return addStep(b, scope, step.id, spec, referencedSteps(step), { when: step.when, after });
        }
        case 'llm': {
            const llm = step as LlmStep;
            const spec: Obj = { ...baseSpec(step, 'llm'), prompt: llm.prompt };
            if (llm.system) { spec.system = llm.system; }
            if (llm.expect) { spec.expect = llm.expect; }
            if (llm.model) { b.notes.push(`Step "${step.id}" names model "${llm.model}"; the export uses the workflow's llm_model input instead.`); }
            // The engine shows a model step every step that has run so far, not only the ones its
            // prompt names. The export wires the same, so the model reads the same run context.
            const priors = Array.from(scope.bindings.entries()).filter(([, bnd]) => !bnd.synthetic).map(([id]) => id);
            const refs = [...priors, ...referencedSteps(step).filter(r => !priors.includes(r))];
            return addStep(b, scope, step.id, spec, refs, { when: step.when, after });
        }
        case 'parallel':
        case 'sequence': {
            const children = step.steps ?? [];
            buildSteps(b, scope, children, step.type === 'sequence', after);
            const spec = { ...baseSpec(step, 'join'), joinMode: step.type === 'sequence' ? 'last' : 'group' };
            return addStep(b, scope, step.id, spec, children.map(s => s.id), { when: step.when });
        }
        case 'foreach':
            return buildForeach(b, scope, step as ForeachStep, after);
    }
}

function buildForeach(b: Builder, scope: Scope, step: ForeachStep, after: string | null): Binding {
    // 1. Resolve the items expression with the runner, so `.lines` and `.json.path` behave exactly.
    const itemsSpec: Obj = { ...baseSpec(step, 'items'), items: step.items, maxItems: step.maxItems ?? 50 };
    const items = addStep(b, scope, `${step.id}_items`, itemsSpec, referencedSteps(step), { after, extraOut: ['items'] });
    items.synthetic = true;
    const itemsId = items.output.split('/')[0];

    // 2. Parse the JSON list into arrays CWL can scatter over.
    const parseId = uniqueId(b, `${step.id}_parse`);
    b.steps[parseId] = {
        run: {
            class: 'ExpressionTool',
            requirements: { InlineJavascriptRequirement: {} },
            inputs: { list: { type: 'File', loadContents: true } },
            outputs: { items: 'string[]', indexes: 'int[]' },
            expression: '${ var items = JSON.parse(inputs.list.contents); return { items: items, indexes: items.map(function (_, i) { return i; }) }; }'
        },
        in: { list: `${itemsId}/items` },
        out: ['items', 'indexes']
    };

    // 3. The body is a sub-workflow scattered over (item, index). Outer steps it references
    //    become inputs of the sub-workflow.
    const body = step.steps ?? [];
    const innerIds = new Set(walkSteps(body).map(s => s.id));
    const outerRefs = new Set<string>();
    for (const child of walkSteps(body)) {
        for (const r of referencedSteps(child)) {
            if (scope.bindings.has(r) && !innerIds.has(r)) { outerRefs.add(r); }
        }
    }

    const bodyInputs: Obj = {
        workspace: 'Directory', input: 'string', active_file: 'string', selection: 'string', item: 'string', index: 'int',
        llm_base_url: 'string', llm_model: 'string', llm_api_key: 'string?'
    };
    const bodyIn: Obj = { ...commonIn(scope), item: `${parseId}/items`, index: `${parseId}/indexes` };

    const inner: Builder = { steps: {}, notes: b.notes, harnessName: b.harnessName, usedIds: new Set() };
    const innerScope: Scope = { bindings: new Map(), inLoop: true, itemVar: step.itemVar };
    for (const r of outerRefs) {
        const src = scope.bindings.get(r)!;
        const name = `ctx_${cwlId(r)}`;
        bodyInputs[name] = src.nullable ? 'File?' : 'File';
        bodyInputs[`${name}_status`] = src.nullable ? 'string?' : 'string';
        bodyIn[name] = src.output;
        bodyIn[`${name}_status`] = src.status ?? src.output;
        innerScope.bindings.set(r, { output: name, status: `${name}_status`, nullable: src.nullable });
    }

    buildSteps(inner, innerScope, body, true, null);
    const iteration = addStep(inner, innerScope, `${step.id}_iteration`,
        { ...baseSpec({ id: `${step.id}_iteration`, name: 'Iteration result' }, 'join'), joinMode: 'last' },
        body.map(s => s.id));

    const bodyId = uniqueId(b, `${step.id}_body`);
    b.steps[bodyId] = {
        run: {
            class: 'Workflow',
            requirements: { InlineJavascriptRequirement: {}, MultipleInputFeatureRequirement: {}, StepInputExpressionRequirement: {} },
            inputs: bodyInputs,
            outputs: { output: { type: 'File', outputSource: iteration.output } },
            steps: inner.steps
        },
        scatter: ['item', 'index'],
        scatterMethod: 'dotproduct',
        in: bodyIn,
        out: ['output']
    };
    if (!step.parallel) {
        b.notes.push(`Loop "${step.id}" runs its iterations one after another in the harness; a CWL engine may run them concurrently.`);
    }

    // 4. Collect the iterations into the loop's own output, as the engine does. The scattered
    //    output is one array-valued source, so it is wired directly rather than merge-nested.
    const joinId = uniqueId(b, step.id);
    const joinSpec: Obj = { ...baseSpec(step, 'join'), joinMode: 'group', context_ids: [step.id], harnessName: b.harnessName };
    b.steps[joinId] = {
        run: '#enclave_step',
        in: { ...commonIn(scope), context: { source: `${bodyId}/output` }, spec: { default: JSON.stringify(joinSpec) } },
        out: ['output', 'status']
    };
    const binding: Binding = { output: `${joinId}/output`, status: `${joinId}/status`, nullable: false };
    scope.bindings.set(step.id, binding);
    return binding;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function enclaveStepTool(): Obj {
    return {
        class: 'CommandLineTool',
        id: 'enclave_step',
        doc: 'Generic runner for one workflow-harness step. Behaviour is selected by the JSON `spec` input; upstream outputs arrive as `context`. Writes output.txt and status.txt.',
        requirements: {
            InlineJavascriptRequirement: {},
            NetworkAccess: { networkAccess: true },
            InitialWorkDirRequirement: {
                listing: [
                    { entryname: 'enclave_step.py', entry: CWL_RUNNER_SCRIPT },
                    { entryname: 'inputs.json', entry: '$(JSON.stringify(inputs))' },
                    { entryname: 'workspace', entry: '$(inputs.workspace)' }
                ]
            }
        },
        hints: { SoftwareRequirement: { packages: [{ package: 'python', version: ['3.8'] }] } },
        baseCommand: ['python3', 'enclave_step.py', 'inputs.json'],
        inputs: {
            spec: { type: 'string', doc: 'JSON: mode, plugin, arguments, prompt, policy, context ids.' },
            workspace: { type: 'Directory' },
            input: { type: 'string', default: '' },
            active_file: { type: 'string', default: '' },
            selection: { type: 'string', default: '' },
            item: { type: 'string?' },
            index: { type: 'int?' },
            context: { type: { type: 'array', items: ['null', 'File'] }, default: [] },
            context_status: { type: { type: 'array', items: ['null', 'string'] }, default: [] },
            when_status: { type: 'string?', doc: 'Compared by the step\'s `when` clause; the runner ignores it.' },
            after: { type: ['null', 'File'], doc: 'Ordering edge only; the runner ignores it.' },
            llm_base_url: { type: 'string', default: CWL_DEFAULT_BASE_URL },
            llm_model: { type: 'string', default: 'llama3' },
            llm_api_key: { type: 'string?' }
        },
        outputs: {
            output: { type: 'File', outputBinding: { glob: 'output.txt' } },
            status: { type: 'string', outputBinding: { glob: 'status.txt', loadContents: true, outputEval: '$(self[0].contents.trim())' } },
            items: { type: 'File?', outputBinding: { glob: 'items.json' } },
            run_record: { type: 'File?', outputBinding: { glob: 'run_record.json' } }
        }
    };
}

/** Build the object graph. Exposed for tests; `toCwl` serialises it. */
export function buildCwlGraph(def: HarnessDefinition, options: CwlOptions = {}): { graph: CwlGraph; notes: string[] } {
    const notes: string[] = [
        'Approval prompts do not exist in CWL: every run-command in this workflow executes without asking. Run only harnesses you have reviewed.',
        'A skipped step (a false `when`) yields null; downstream steps receive it as a null context entry and treat it as "skipped", as the engine does. cwltool reports this as "conditional step, but pickValue is not used" — that warning is expected.'
    ];
    const b: Builder = { steps: {}, notes, harnessName: def.name, usedIds: new Set() };
    const scope: Scope = { bindings: new Map(), inLoop: false };

    const top = def.steps ?? [];
    buildSteps(b, scope, top, true, null);

    // Final collection: the harness output template, or the last successful top-level step.
    const topIds = top.map(s => s.id);
    const refs = Array.from(new Set([...topIds, ...stepRefs([def.output])]));
    const collectSpec: Obj = { mode: 'collect', id: 'collect', name: 'Collect output' };
    if (def.output) { collectSpec.outputTemplate = def.output; }
    const collect = addStep(b, scope, 'collect', collectSpec, refs, { extraOut: ['run_record'] });
    const collectId = collect.output.split('/')[0];

    const generator = options.generator ?? 'enclave';
    const stamp = (options.now ?? new Date()).toISOString();
    const main: Obj = {
        class: 'Workflow',
        id: 'main',
        label: def.name,
        doc: [
            def.description ?? '',
            '',
            `Exported from the Enclave workflow-harness "${def.id}" by ${generator} on ${stamp}.`,
            'Language-model steps call an OpenAI-compatible /chat/completions endpoint: set llm_base_url',
            '(http://localhost:11434/v1 for Ollama, https://api.blablador.fz-juelich.de/v1 for Blablador),',
            'llm_model and, where the endpoint needs one, llm_api_key.',
            '',
            'Translation notes:',
            ...notes.map(n => `- ${n}`)
        ].join('\n').trim(),
        requirements: {
            InlineJavascriptRequirement: {},
            SubworkflowFeatureRequirement: {},
            ScatterFeatureRequirement: {},
            MultipleInputFeatureRequirement: {},
            StepInputExpressionRequirement: {}
        },
        inputs: {
            workspace: { type: 'Directory', doc: 'The working copy the harness operates on.' },
            input: { type: 'string', default: '', doc: def.input?.label ?? 'Free-text input available to steps as {{input}}.' },
            active_file: { type: 'string', default: '', doc: 'Workspace-relative path the harness sees as {{activeFile}} (the file open in the editor).' },
            selection: { type: 'string', default: '', doc: 'Text the harness sees as {{selection}} (the editor selection).' },
            llm_base_url: { type: 'string', default: CWL_DEFAULT_BASE_URL, doc: 'OpenAI-compatible API base.' },
            llm_model: { type: 'string', default: options.defaultModel ?? 'llama3' },
            llm_api_key: { type: 'string?', doc: 'Bearer token, if the endpoint needs one.' }
        },
        outputs: {
            output: { type: 'File', outputSource: collect.output, doc: 'The harness output.' },
            run_record: { type: 'File?', outputSource: `${collectId}/run_record`, doc: 'Per-step statuses, for the record.' }
        },
        steps: b.steps
    };

    return { graph: { cwlVersion: CWL_VERSION, $graph: [main, enclaveStepTool()] }, notes };
}

// ---------------------------------------------------------------------------
// YAML emission
// ---------------------------------------------------------------------------

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;

function yamlKey(key: string): string {
    return PLAIN_KEY.test(key) ? key : JSON.stringify(key);
}

function isBlock(v: unknown): boolean {
    if (Array.isArray(v)) { return v.length > 0; }
    return !!v && typeof v === 'object' && Object.keys(v as Obj).length > 0;
}

/** A string safe to write as a literal block: multi-line, no tabs/CR, no trailing spaces, plain first line. */
function literalSafe(s: string): boolean {
    return s.includes('\n') && !/[\t\r]/.test(s) && !/ \n| $/.test(s) && !/^[ \n]/.test(s);
}

/**
 * Minimal YAML for the shapes used here. Every scalar string is JSON-quoted, which is valid
 * YAML and escapes anything a prompt can contain; a string is a literal block only when that
 * is known to round-trip. Returns the lines of a block value, each already indented.
 */
function yamlLines(value: unknown, indent: number): string[] {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        const lines: string[] = [];
        for (const item of value) {
            if (isBlock(item) && !Array.isArray(item)) {
                // Mapping item: first entry on the dash line, the rest aligned beneath it.
                const inner = yamlLines(item, indent + 2);
                lines.push(`${pad}- ${inner[0].trimStart()}`, ...inner.slice(1));
            } else if (isBlock(item)) {
                lines.push(`${pad}-`, ...yamlLines(item, indent + 2));
            } else {
                lines.push(`${pad}- ${scalar(item, indent + 2)}`);
            }
        }
        return lines;
    }
    const lines: string[] = [];
    for (const [k, v] of Object.entries(value as Obj)) {
        if (isBlock(v)) {
            lines.push(`${pad}${yamlKey(k)}:`, ...yamlLines(v, indent + 2));
        } else {
            lines.push(`${pad}${yamlKey(k)}: ${scalar(v, indent + 2)}`);
        }
    }
    return lines;
}

/** Render a non-block value that follows `key: ` or `- `. */
function scalar(v: unknown, indent: number): string {
    if (v === null || v === undefined) { return 'null'; }
    if (typeof v === 'boolean' || typeof v === 'number') { return String(v); }
    if (typeof v === 'string') {
        if (literalSafe(v)) {
            const pad = ' '.repeat(indent);
            return `|\n${v.split('\n').map(l => (l.length ? pad + l : '')).join('\n')}`;
        }
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) { return '[]'; }
    return '{}';
}

export function toYaml(value: unknown): string {
    return isBlock(value) ? yamlLines(value, 0).join('\n') : scalar(value, 0);
}

export function toCwl(def: HarnessDefinition, options: CwlOptions = {}): CwlExport {
    const { graph, notes } = buildCwlGraph(def, options);
    const names = cwlFileNames(def);
    const header = [
        '#!/usr/bin/env cwl-runner',
        `# ${def.name} — exported from the Enclave workflow-harness "${def.id}".`,
        `# Run:  cwltool ${names.workflow} ${names.job}`,
        '# Needs python3 on PATH, or a CWL engine providing a Python-capable container.',
        ''
    ].join('\n');
    const workflow = `${header}${toYaml(graph)}\n`;

    const editorVars = referencedVariables(def);
    const job: Obj = {
        workspace: { class: 'Directory', path: '.' },
        input: '',
        active_file: '',
        selection: '',
        llm_base_url: CWL_DEFAULT_BASE_URL,
        llm_model: options.defaultModel ?? 'llama3',
        llm_api_key: null
    };
    const jobText = [
        `# Job file for ${names.workflow}. Edit the values, then:  cwltool ${names.workflow} ${names.job}`,
        '# workspace.path is the directory the harness operates on (here: where you run cwltool).',
        def.input?.label ? `# input: ${def.input.label}${def.input.placeholder ? ` — e.g. ${def.input.placeholder}` : ''}${def.input.required ? ' (required)' : ''}` : '',
        editorVars.has('activeFile') ? '# active_file: this harness reads {{activeFile}} — set it to the workspace-relative path of the file to work on (required).' : '',
        editorVars.has('selection') ? '# selection: this harness reads {{selection}} — paste the text it should work on.' : '',
        '# Blablador: llm_base_url: https://api.blablador.fz-juelich.de/v1, llm_model: alias-code, llm_api_key: <token>',
        toYaml(job),
        ''
    ].filter(l => l !== '').join('\n');

    return { workflow, job: jobText, notes, graph };
}

/** File names for the two artifacts, without a directory. */
export function cwlFileNames(def: HarnessDefinition): { workflow: string; job: string } {
    const base = (def.id || def.name || 'harness').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '') || 'harness';
    return { workflow: `${base}.cwl`, job: `${base}.cwl-job.yml` };
}
