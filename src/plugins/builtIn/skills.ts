import * as vscode from 'vscode';

// Placeholder skills - these are triggered through the chat interface

export async function explainCode() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (text) {
            vscode.window.showInformationMessage('Code explanation requested via chat.');
        }
    }
}

export async function refactorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const code = editor.document.getText(selection);
    if (!code) {
        vscode.window.showErrorMessage('No code selected');
        return;
    }

    vscode.window.showInformationMessage('Refactor requested via chat.');
}
