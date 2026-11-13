# Enclave CLI

Run, validate, export and reproduce workflow-harnesses from the terminal. Same engine and same
document format as the VS Code and browser hosts; only the host differs.

```bash
npm install -g enclave-harness      # or: npx enclave-harness …   (command: enclave)
enclave list                         # built-in harnesses and .continued/harnesses/ in this workspace
enclave run                          # interactive: pick a harness, give the input, pick a model
enclave run workspace-health-harness --model llama3 --yes
enclave run ./my.harness.json --input "focus on tests" --model blablador/alias-code
enclave repro workspace-health-harness --runs 10 --model llama3 --model blablador/alias-large --yes
enclave validate ./my.harness.json
enclave export workspace-health-harness --format cwl --out exports/
enclave models
enclave probe --provider blablador
```

**Models.** A bare name is an Ollama model (`ENCLAVE_OLLAMA_URL`, default `http://localhost:11434`).
`blablador/<id>`, `openai/<id>`, `anthropic/<id>` and `gemini/<id>` read their keys from
`ENCLAVE_BLABLADOR_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. `ENCLAVE_MODEL`
sets the default.

**Approvals.** Read-only tools never ask. `run-command` asks on the terminal (`y` / `N` / `a` for
all) unless `--yes` grants every request or `--no-approvals` declines every request. A forbidden
command is blocked whatever the answer; a declined step is terminal, as in the editor.

**Tools available here.** `run-command`, `read-file`, `grep-search`, `semantic-search`,
`list-directory`, `file-info`, `git-info`, `csv-preview`, `json-query`; resources
`workspace-files`, `git-summary`. Editor-only plugins (diagnostics, open editors, browser tabs)
make a step report failure with the reason; its error policy then applies.

**Reproducibility.** `enclave repro` runs a harness *N* times per model, records for every step
its status, attempt count and a hash of its output, and reports three things: *structural
stability* (share of runs with the modal step graph), *step-output stability* (distinct outputs
per step; expected to be 1 for every step that is not, and does not contain, an `llm` step) and
*approval determinism* (whether every run raised the same number of approval requests). Records
and a Markdown report land in `.continued/repro/<id>-<timestamp>/`. Exit code 2 means a step
that should have been deterministic produced differing outputs.

**Testing the contract.** `enclave conformance` runs ten adversarial cases (forbidden commands,
mutations, path traversal, a declined step under a retry policy, injected instructions) through
this host with a stub model, under both approval modes, and reports whether the contract held.
`enclave grounding <run.json>` checks quotes and numbers in model steps against the read steps;
`--check-grounding` on `run` does it immediately.

**Files.** A run writes `run.json` (the run and its record) and `output.md` to
`.continued/harness-runs/<id>-<timestamp>/`. `--json` prints the same to stdout instead.

Build from source: `cd cli && npm ci && npm run build` → `dist/enclave.js`.
