/**
 * Build the browser extension.
 *
 *   node build.mjs            → dist/chrome/ and dist/firefox/
 *   node build.mjs --watch    → rebuild bundles on change (both targets)
 *
 * 1. Bundle the UI generator, run it, and split the inline <script> blocks into files
 *    (extension CSP forbids inline scripts).
 * 2. Bundle background, side-panel shim and options page.
 * 3. Write a per-browser manifest: Chrome gets side_panel + service_worker, Firefox
 *    gets sidebar_action + background.scripts. Stores reject each other's keys.
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const targets = ['chrome', 'firefox'];
rmSync('dist', { recursive: true, force: true });
for (const t of targets) { mkdirSync(join('dist', t, 'icons'), { recursive: true }); }

// ---- 1. Sidebar HTML from the shared UI modules -------------------------------
const uiTmp = 'dist/.ui-generate.mjs';
await esbuild.build({ entryPoints: ['src/ui/generate.ts'], bundle: true, format: 'esm', platform: 'node', outfile: uiTmp, logLevel: 'silent' });
await import(pathToFileURL(uiTmp).href + `?t=${Date.now()}`);
let html = globalThis.__CONTINUED_HTML__;
rmSync(uiTmp);

const scripts = [];
html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_m, js) => {
  scripts.push(js);
  return `<script src="ui-${scripts.length - 1}.js"></script>`;
});
html = html
  .replace('</head>', '<link rel="stylesheet" href="theme.css"></head>')
  .replace('<body>', '<body><script src="shim.js"></script>');

/**
 * Rewrite `target.innerHTML = <expr>;` into `__setHTML(target, <expr>);` (helper in shim.js,
 * implemented with DOMParser). Add-on linters flag dynamic innerHTML assignments; the
 * markup here is generated from escaped text, but the rewrite makes that explicit and
 * keeps the shared UI sources untouched. Static clears (`innerHTML = ''`) are left alone.
 */
function rewriteInnerHtml(js) {
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\.innerHTML\s*=(?!=)\s*/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(js)) !== null) {
    const target = m[1];
    const exprStart = m.index + m[0].length;
    // Scan to the end of the statement (a ';' at depth 0 outside string literals).
    let i = exprStart, depth = 0, quote = null;
    for (; i < js.length; i++) {
      const ch = js[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { break; } depth--; continue; }
      if (ch === ';' && depth === 0) { break; }
      if (ch === '\n' && depth === 0 && /^\s*[^\s+?:&|.,]/.test(js.slice(i + 1, i + 40)) && !/[+?:&|,(]\s*$/.test(js.slice(exprStart, i))) { break; }
    }
    const expr = js.slice(exprStart, i).trim();
    if (expr === "''" || expr === '""') { continue; }           // static clear: leave as is
    out += js.slice(last, m.index) + `__setHTML(${target}, ${expr})`;
    last = i;
    re.lastIndex = i;
  }
  return out + js.slice(last);
}

for (const t of targets) {
  scripts.forEach((js, i) => {
    // Inline onclick attributes are blocked by CSP; the shim installs a delegated handler instead.
    const cleaned = js.replace(/\s*onclick="window\.copyCodeSnippet\(\\''\+uid\+'\\'\)"/g, '');
    writeFileSync(join('dist', t, `ui-${i}.js`), rewriteInnerHtml(cleaned));
  });
  writeFileSync(join('dist', t, 'sidepanel.html'), html);
}

// ---- 2. Bundles -----------------------------------------------------------------
const common = { bundle: true, format: 'iife', platform: 'browser', target: ['chrome116', 'firefox115'], sourcemap: false, logLevel: 'warning' };
const entries = [
  ['src/background/index.ts', 'background.js'],
  ['src/sidepanel/shim.ts', 'shim.js'],
  ['src/options/options.ts', 'options.js']
];
const bundles = targets.flatMap(t => entries.map(([entry, out]) => ({ entryPoints: [entry], outfile: join('dist', t, out) })));

// ---- 3. Static files & manifests ------------------------------------------------
const base = JSON.parse(readFileSync('manifest.json', 'utf-8'));

function manifestFor(target) {
  const m = JSON.parse(JSON.stringify(base));
  if (target === 'chrome') {
    delete m.background.scripts;
    delete m.sidebar_action;
    delete m.browser_specific_settings;
  } else {
    delete m.background.service_worker;
    delete m.side_panel;
    delete m.minimum_chrome_version;
    m.permissions = m.permissions.filter(p => p !== 'sidePanel');
  }
  return m;
}

function copyStatic() {
  for (const t of targets) {
    const dir = join('dist', t);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestFor(t), null, 2) + '\n');
    copyFileSync('src/ui/theme.css', join(dir, 'theme.css'));
    copyFileSync('src/options/options.html', join(dir, 'options.html'));
    copyFileSync('src/options/options.css', join(dir, 'options.css'));
    for (const icon of readdirSync('src/icons')) { copyFileSync(join('src/icons', icon), join(dir, 'icons', icon)); }
  }
}
copyStatic();

if (watch) {
  const contexts = await Promise.all(bundles.map(b => esbuild.context({ ...common, ...b })));
  await Promise.all(contexts.map(c => c.watch()));
  console.log('watching… (UI HTML and manifests are generated once per build; re-run for those)');
} else {
  await Promise.all(bundles.map(b => esbuild.build({ ...common, ...b })));
  console.log(`built ${base.name} ${base.version} → dist/chrome, dist/firefox (${scripts.length} UI scripts extracted)`);
}
