---
title: Enclave
description: A local-first AI agent for research software, with workflow-harnesses, for VS Code, the browser and the terminal.
navigation:
  title: Overview
---

# Enclave

Enclave is a local-first AI agent for research work. Inference runs on a model on your own machine
through Ollama, or on an institutional endpoint such as [Blablador](https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_api_access/)
at Jülich Supercomputing Centre, and every model is labelled at the point of selection with where it
runs and who operates it. Every action that changes something is approval-gated. Repeatable work is
written down as a **workflow-harness**: a JSON document in which you fix the procedure and a model is
consulted only at the steps you declare.

::callout{type="note" title="Formerly Continued"}
The project is being renamed from *Continued* to *Enclave*. Store listings, package names and
folder names are changing over release by release; where a name below still says Continued, it is
the same software.
::

## Distributions

| Surface | Package | Install |
| --- | --- | --- |
| VS Code, VSCodium, Cursor, code-server | `AtaUlHaleem.continued` | [Marketplace](https://marketplace.visualstudio.com/items?itemName=AtaUlHaleem.continued) · [Open VSX](https://open-vsx.org/extension/AtaUlHaleem/continued) |
| Firefox (sidebar) | `Enclave` | [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/continued/) |
| Chrome, Edge (side panel) | `Enclave` | Chrome Web Store (pending) · [load unpacked](/browser) |
| Terminal | `enclave-cli` | `npm install -g ./enclave-cli-<version>.tgz` from a release, or `npx enclave-cli` once published |

All four share one core: the harness engine, the document format, the exporters and the user
interface. What differs is what the agent acts on: files and terminals in the editor, tabs in the
browser, a directory in the terminal.

## What you can do

- **Chat and agent mode** over your code, with approval cards for every write and every command.
- **Workflow-harnesses**: build them on a canvas, run them, and read each step live. Six ship with
  the editor and nine with the browser, including four for reading scientific articles and PDFs.
- **Export** any harness as portable JSON, as a Markdown playbook for Codex, OpenCode, Hermes or
  Continue.dev, or as Common Workflow Language runnable with `cwltool`.
- **Run in a container**: a sealed Podman container executes the CWL export against a read-only
  copy of your workspace.
- **Choose a model on measurement**: the Blablador harness probes every model your token can reach
  and reports which respond, which follow instructions, and how fast.

## Where to go next

- [Getting started](/getting-started) — install a host, point it at Ollama or Blablador.
- [Workflow-harnesses](/harnesses) — the concept, the format, export and containers.
- [Command line](/cli) — `enclave run`, `enclave repro`.
- [Publications](/publications) — the papers and how to cite.
