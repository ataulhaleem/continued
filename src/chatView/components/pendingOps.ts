/**
 * Pending Operations Component
 * Handles batch approval panel for file edits and deletes
 */

export interface PendingOperation {
  type: 'write' | 'delete';
  path: string;
}

export class PendingOpsPanel {
  private pendingOpsPanel: HTMLElement;
  private pendingOpsList: HTMLElement;
  private pendingOpsToggle: HTMLElement;
  private approveAllOpsBtn: HTMLElement;
  private rejectAllOpsBtn: HTMLElement;
  private expanded: boolean = true;
  private currentOps: PendingOperation[] = [];
  private vscode: any;

  constructor(vscode: any) {
    this.vscode = vscode;

    const panel = document.getElementById('pending-ops-panel');
    const list = document.getElementById('pending-ops-list');
    const toggle = document.getElementById('pending-ops-toggle');
    const approveAll = document.getElementById('approve-all-ops');
    const rejectAll = document.getElementById('reject-all-ops');

    if (!panel || !list || !toggle || !approveAll || !rejectAll) {
      throw new Error('Pending ops panel elements not found');
    }

    this.pendingOpsPanel = panel;
    this.pendingOpsList = list;
    this.pendingOpsToggle = toggle;
    this.approveAllOpsBtn = approveAll;
    this.rejectAllOpsBtn = rejectAll;

    this.setupListeners();
  }

  private setupListeners(): void {
    this.pendingOpsToggle.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.pendingOpsToggle.textContent = (this.expanded ? '▼' : '▶') + ' Pending Changes';
      this.pendingOpsList.style.display = this.expanded ? 'flex' : 'none';
    });

    this.approveAllOpsBtn.addEventListener('click', () => {
      this.vscode.postMessage({
        type: 'approveAllOps',
        operations: this.currentOps
      });
    });

    this.rejectAllOpsBtn.addEventListener('click', () => {
      this.vscode.postMessage({
        type: 'rejectAllOps'
      });
    });
  }

  render(edits: any[], deletes: string[]): void {
    this.currentOps = [
      ...edits.map(e => ({ type: 'write' as const, path: e.relativePath })),
      ...deletes.map(d => ({ type: 'delete' as const, path: d }))
    ];

    this.pendingOpsList.innerHTML = '';

    edits.forEach((edit, index) => {
      const item = document.createElement('div');
      item.className = 'pending-op-item';
      item.innerHTML = `
        <div class="pending-op-item-header">
          <span class="pending-op-type write">W</span>
          <span class="pending-op-path">${edit.relativePath}</span>
          <button class="pending-op-btn pending-op-btn-approve" data-op-type="write" data-op-index="${index}" style="padding: 2px 4px; font-size: 8px;">✓</button>
          <button class="pending-op-btn pending-op-btn-reject" data-op-type="write" data-op-index="${index}" style="padding: 2px 4px; font-size: 8px;">✗</button>
        </div>
      `;

      item.querySelector('.pending-op-btn-approve')?.addEventListener('click', () => {
        this.vscode.postMessage({
          type: 'approveOp',
          opType: 'write',
          index: index
        });
      });

      item.querySelector('.pending-op-btn-reject')?.addEventListener('click', () => {
        this.vscode.postMessage({
          type: 'rejectOp',
          opType: 'write',
          index: index
        });
      });

      this.pendingOpsList.appendChild(item);
    });

    deletes.forEach((dPath, index) => {
      const item = document.createElement('div');
      item.className = 'pending-op-item';
      item.innerHTML = `
        <div class="pending-op-item-header">
          <span class="pending-op-type delete">D</span>
          <span class="pending-op-path">${dPath}</span>
          <button class="pending-op-btn pending-op-btn-approve" data-op-type="delete" data-op-index="${index}" style="padding: 2px 4px; font-size: 8px;">✓</button>
          <button class="pending-op-btn pending-op-btn-reject" data-op-type="delete" data-op-index="${index}" style="padding: 2px 4px; font-size: 8px;">✗</button>
        </div>
      `;

      item.querySelector('.pending-op-btn-approve')?.addEventListener('click', () => {
        this.vscode.postMessage({
          type: 'approveOp',
          opType: 'delete',
          index: index
        });
      });

      item.querySelector('.pending-op-btn-reject')?.addEventListener('click', () => {
        this.vscode.postMessage({
          type: 'rejectOp',
          opType: 'delete',
          index: index
        });
      });

      this.pendingOpsList.appendChild(item);
    });

    if (edits.length > 0 || deletes.length > 0) {
      this.pendingOpsPanel.classList.remove('hidden');
    } else {
      this.pendingOpsPanel.classList.add('hidden');
    }
  }

  hide(): void {
    this.pendingOpsPanel.classList.add('hidden');
  }
}
