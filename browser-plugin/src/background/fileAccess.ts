/**
 * Reading `file://` tabs is opt-in twice over: the user switches it on in the options page,
 * and the browser itself has to grant the extension file access. Chrome keeps that behind the
 * per-extension "Allow access to file URLs" switch, which no API can flip; Firefox folds it
 * into the host-permission grant, which the options page can request after a click.
 *
 * Kept apart from tools.ts so the options page can import it without the tool bundle.
 */

import { ext } from './storage';

export const FILE_ORIGIN = 'file:///*';

// Chrome exposes a `browser` namespace too these days, so the extension URL scheme is the
// reliable tell: Firefox serves extension pages from moz-extension://.
export const isFirefox = ext.runtime.getURL('').startsWith('moz-extension://');
export const isChrome = !isFirefox;

/** Can the extension reach `file://` pages right now? */
export async function hasFileAccess(): Promise<boolean> {
    try {
        // Chrome: the per-extension "Allow access to file URLs" switch. Firefox 153+: the separate
        // "Access local files on your computer" permission; this call reports it correctly there
        // (older Firefox always answered false, hence the fallback to the origin check).
        const api = (ext as { extension?: { isAllowedFileSchemeAccess?: () => Promise<boolean> } }).extension;
        if (typeof api?.isAllowedFileSchemeAccess === 'function' && await api.isAllowedFileSchemeAccess()) { return true; }
        if (isChrome) { return false; }
        return await ext.permissions.contains({ origins: [FILE_ORIGIN] });
    } catch {
        return false;
    }
}

/**
 * Ask the browser for file access. Firefox shows its prompt only when this is the first thing a
 * click handler does: any `await` before it ends the user gesture and the request is refused
 * without a prompt. Callers therefore invoke this synchronously from the click, and the promise
 * resolves to the state afterwards. Chrome has no prompt; its switch is the only way.
 */
export function requestFileAccess(): Promise<boolean> {
    let request: Promise<unknown>;
    try { request = ext.permissions.request({ origins: [FILE_ORIGIN] }); } catch { request = Promise.resolve(); }
    return request.catch(() => undefined).then(() => hasFileAccess());
}

/** What the user has to do in the browser when the grant is missing. */
export function fileAccessHelp(): string {
    return isChrome
        ? 'In Chrome, open chrome://extensions, click Details on Enclave and switch on "Allow access to file URLs".'
        : 'In Firefox, open about:addons, choose Enclave → Permissions and switch on "Access local files on your computer" (Firefox 153 and later keep it separate from website access).';
}
