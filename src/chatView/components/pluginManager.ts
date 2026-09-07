/**
 * Plugin Manager Component
 * Handles plugin display and management
 */

export class PluginManager {
  private pluginsList: HTMLElement;
  private pluginsEnabledCount: HTMLElement;
  private vscode: any;

  constructor(vscode: any) {
    this.vscode = vscode;

    const list = document.getElementById('plugins-list');
    const count = document.getElementById('plugins-enabled-count');

    if (!list || !count) {
      throw new Error('Plugin manager elements not found');
    }

    this.pluginsList = list;
    this.pluginsEnabledCount = count;
  }

  render(plugins: any): void {
    this.pluginsList.innerHTML = '';
    const categories = ['tools', 'resources', 'skills'];

    for (const category of categories) {
      const items = plugins[category] || [];
      if (items.length === 0) continue;

      const title = document.createElement('div');
      title.style.cssText = 'font-size: 11px; font-weight: 700; margin-top: 8px; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); text-transform: uppercase;';
      title.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      this.pluginsList.appendChild(title);

      for (const plugin of items) {
        const card = document.createElement('div');
        card.className = 'plugin-card';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = plugin.enabled;
        checkbox.addEventListener('change', () => {
          this.vscode.postMessage({ 
            type: 'togglePlugin', 
            pluginId: plugin.id, 
            enabled: checkbox.checked 
          });
        });

        const info = document.createElement('div');
        info.className = 'plugin-info';

        const name = document.createElement('div');
        name.className = 'plugin-name';
        name.textContent = `${plugin.name} v${plugin.version}`;

        info.appendChild(name);
        card.appendChild(checkbox);
        card.appendChild(info);
        this.pluginsList.appendChild(card);
      }
    }
  }

  setEnabledCount(count: number): void {
    this.pluginsEnabledCount.textContent = String(count || '0');
  }
}
