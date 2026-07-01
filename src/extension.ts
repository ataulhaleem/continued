import * as vscode from 'vscode';
import { showProviderSelector } from './providers';
import { ContinuedSidebarProvider } from './chatViewProvider';
import { ContinuedCompletionProvider } from './completionProvider';

export function activate(context: vscode.ExtensionContext) {

    // Bootstrapping the Webview View Provider
    const provider = new ContinuedSidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('continued-chat-view', provider)
    );

    // Register Cloud Provider Import Command
    context.subscriptions.push(
        vscode.commands.registerCommand('continued.addProvider', () => {
            showProviderSelector(context);
        })
    );

    // Register model refresh command — called after a cloud provider key is saved
    context.subscriptions.push(
        vscode.commands.registerCommand('continued.refreshModels', () => {
            provider.triggerModelRefresh();
        })
    );

    // Inline code completion — all file types, uses the last selected model
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new ContinuedCompletionProvider(context)
        )
    );
}