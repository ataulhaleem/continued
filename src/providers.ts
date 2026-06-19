import * as vscode from 'vscode';

export async function showProviderSelector(context: vscode.ExtensionContext) {
    const providers = [
        { label: "OpenAI", description: "Use GPT models" },
        { label: "Gemini", description: "Use Google Gemini" },
        { label: "Anthropic", description: "Use Claude models" },
        { label: "BlaBlaDoor", description: "FZJ Jülich gateway" }
    ];

    const selection = await vscode.window.showQuickPick(providers, {
        placeHolder: "Select a cloud provider to import"
    });

    if (selection) {
        await promptForApiKey(context, selection.label);
    }
}

async function promptForApiKey(context: vscode.ExtensionContext, provider: string) {
    const key = await vscode.window.showInputBox({
        prompt: `Enter your API key for ${provider}`,
        password: true
    });

    if (key) {
        await context.secrets.store(`${provider.toLowerCase()}_api_key`, key);
        vscode.window.showInformationMessage(`${provider} has been successfully configured!`);
    }
}