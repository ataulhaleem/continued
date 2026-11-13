// Bundle the CLI into one Node file. The shared core, the browser build's editor-free LLM
// client, the built-in harness list and the guardrails are pulled in by relative import.
import * as esbuild from 'esbuild';
import { chmodSync } from 'fs';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/enclave.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  logLevel: 'warning'
});
chmodSync('dist/enclave.js', 0o755);
console.log('built dist/enclave.js');
