/**
 * AgentMode - Manages the agent mode state for the Continued extension.
 *
 * Agent mode enables the AI assistant to:
 * - Execute tools (file operations, terminal commands, web search)
 * - Work autonomously through multi-step task chains
 * - Interact directly with the user's workspace
 *
 * This module provides the centralized state and configuration
 * that tells the app the AI is running in agent mode.
 */

export interface AgentModeConfig {
    /** Whether agent mode is currently enabled */
    enabled: boolean;
    /** Whether tool execution is allowed */
    toolsEnabled: boolean;
    /** Whether the AI can chain multiple tool calls autonomously */
    autonomousChaining: boolean;
    /** Maximum number of autonomous steps before requiring user input */
    maxAutonomousSteps: number;
    /** Whether to show agent mode status in the chat UI */
    showStatusIndicator: boolean;
}

export class AgentMode {
    private static instance: AgentMode;
    private config: AgentModeConfig;
    private statusChangeCallbacks: ((enabled: boolean) => void)[];

    private constructor() {
        this.config = {
            enabled: true,
            toolsEnabled: true,
            autonomousChaining: true,
            maxAutonomousSteps: 10,
            showStatusIndicator: true,
        };
        this.statusChangeCallbacks = [];
    }

    /**
     * Get the singleton instance of AgentMode
     */
    public static getInstance(): AgentMode {
        if (!AgentMode.instance) {
            AgentMode.instance = new AgentMode();
        }
        return AgentMode.instance;
    }

    /**
     * Check if agent mode is currently enabled
     */
    public isEnabled(): boolean {
        return this.config.enabled;
    }

    /**
     * Enable agent mode
     */
    public enable(): void {
        this.config.enabled = true;
        this.notifyStatusChange();
    }

    /**
     * Disable agent mode
     */
    public disable(): void {
        this.config.enabled = false;
        this.notifyStatusChange();
    }

    /**
     * Toggle agent mode on/off
     */
    public toggle(): boolean {
        this.config.enabled = !this.config.enabled;
        this.notifyStatusChange();
        return this.config.enabled;
    }

    /**
     * Get the current agent mode configuration
     */
    public getConfig(): AgentModeConfig {
        return { ...this.config };
    }

    /**
     * Update the agent mode configuration
     */
    public updateConfig(partialConfig: Partial<AgentModeConfig>): void {
        this.config = { ...this.config, ...partialConfig };
        this.notifyStatusChange();
    }

    /**
     * Register a callback to be notified when agent mode status changes
     */
    public onStatusChange(callback: (enabled: boolean) => void): void {
        this.statusChangeCallbacks.push(callback);
    }

    /**
     * Notify all registered callbacks of a status change
     */
    private notifyStatusChange(): void {
        for (const callback of this.statusChangeCallbacks) {
            callback(this.config.enabled);
        }
    }

    /**
     * Get a human-readable status string for the UI
     */
    public getStatusString(): string {
        if (!this.config.enabled) {
            return 'Standard Mode';
        }
        return 'Agent Mode';
    }

    /**
     * Get a detailed status description for the chat interface
     */
    public getStatusDescription(): string {
        if (!this.config.enabled) {
            return 'The AI assistant is running in Standard Mode. Tool execution and autonomous chaining are disabled.';
        }
        const tools = this.config.toolsEnabled ? 'enabled' : 'disabled';
        const chaining = this.config.autonomousChaining ? 'enabled' : 'disabled';
        return `The AI assistant is running in Agent Mode. Tools are ${tools}, autonomous chaining is ${chaining}, with a maximum of ${this.config.maxAutonomousSteps} autonomous steps.`;
    }
}