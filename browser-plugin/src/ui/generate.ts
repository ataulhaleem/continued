/**
 * Build-time helper: renders the sidebar HTML from the copied UI modules.
 * `build.mjs` bundles this file, imports it, and reads the global it sets.
 */

import { generateChatViewHTML } from '../../../core/ui/chatView';

(globalThis as unknown as { __CONTINUED_HTML__: string }).__CONTINUED_HTML__ = generateChatViewHTML();
