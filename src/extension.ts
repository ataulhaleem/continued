import * as vscode from 'vscode';
import { showProviderSelector } from './providers';
import { ContinuedSidebarProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {

    // Register Cloud Provider Import Command
    let disposable = vscode.commands.registerCommand('continued.addProvider', () => {
        showProviderSelector(context);
    });
    context.subscriptions.push(disposable);

    // Bootstrapping the newly modularized Webview View Provider
    const provider = new ContinuedSidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('continued-chat-view', provider)
    );

    // Context Editor Tool Commands
    let inlineEdit = vscode.commands.registerCommand('continued.helloWorld', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const prompt = await vscode.window.showInputBox({ prompt: "What should Continued do?" });
        if (!prompt) { return; }
        vscode.window.showInformationMessage(`Processing: ${prompt}`);
    });
    context.subscriptions.push(inlineEdit);
}