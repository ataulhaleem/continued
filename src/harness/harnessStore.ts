/**
 * Loads and saves user harness definitions from `.continued/harnesses/*.json`.
 */

import * as vscode from 'vscode';
import { HarnessDefinition } from './types';
import { validateHarness } from './harnessEngine';

export const HARNESS_DIR = ['.continued', 'harnesses'];

export function harnessDirUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }
    return vscode.Uri.joinPath(folders[0].uri, ...HARNESS_DIR);
}

export function harnessFileUri(id: string): vscode.Uri | null {
    const dir = harnessDirUri();
    return dir ? vscode.Uri.joinPath(dir, `${id}.json`) : null;
}

export interface LoadedHarnesses {
    harnesses: HarnessDefinition[];
    problems: string[];
}

export async function loadUserHarnesses(): Promise<LoadedHarnesses> {
    const dir = harnessDirUri();
    const result: LoadedHarnesses = { harnesses: [], problems: [] };
    if (!dir) { return result; }

    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
        return result; // no directory yet
    }

    for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) { continue; }
        try {
            const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name)));
            const def = JSON.parse(raw) as HarnessDefinition;
            def.source = 'user';
            if (!def.id) { def.id = name.replace(/\.json$/i, ''); }
            const problems = validateHarness(def);
            if (problems.length) {
                result.problems.push(`${name}: ${problems.join('; ')}`);
                continue;
            }
            result.harnesses.push(def);
        } catch (error) {
            result.problems.push(`${name}: ${(error as Error).message}`);
        }
    }
    return result;
}

export async function saveUserHarness(def: HarnessDefinition): Promise<vscode.Uri> {
    const dir = harnessDirUri();
    if (!dir) { throw new Error('Open a workspace folder before saving a harness.'); }
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `${def.id}.json`);
    const toSave: HarnessDefinition = { ...def, source: 'user' };
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${JSON.stringify(toSave, null, 2)}\n`));
    return file;
}

export async function deleteUserHarness(id: string): Promise<void> {
    const file = harnessFileUri(id);
    if (!file) { throw new Error('Open a workspace folder before deleting a harness.'); }
    try {
        await vscode.workspace.fs.delete(file, { useTrash: true });
    } catch {
        await vscode.workspace.fs.delete(file, { useTrash: false });
    }
}

export function slugifyHarnessId(name: string): string {
    const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-harness';
    return base.endsWith('-harness') ? base : `${base}-harness`;
}
