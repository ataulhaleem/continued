/**
 * File Attachment Component
 * Handles file upload and attachment display
 */

export class FileAttachment {
  private attachedFiles: Map<string, File> = new Map();
  private fileUploadInput: HTMLInputElement;
  private attachFileBtn: HTMLElement;
  private attachedFilesContainer: HTMLElement;

  constructor() {
    const input = document.getElementById('file-upload') as HTMLInputElement;
    const btn = document.getElementById('attach-file-btn');
    const container = document.getElementById('attached-files');

    if (!input || !btn || !container) {
      throw new Error('File attachment elements not found');
    }

    this.fileUploadInput = input;
    this.attachFileBtn = btn;
    this.attachedFilesContainer = container;

    this.setupListeners();
  }

  private setupListeners(): void {
    this.attachFileBtn.addEventListener('click', () => {
      this.fileUploadInput.click();
    });

    this.fileUploadInput.addEventListener('change', (e) => {
      const files = Array.from((e.target as HTMLInputElement).files || []);
      files.forEach(file => {
        if (!this.attachedFiles.has(file.name)) {
          this.attachedFiles.set(file.name, file);
          this.addFileToDisplay(file.name);
        }
      });
      this.fileUploadInput.value = '';
    });
  }

  private addFileToDisplay(fileName: string): void {
    const fileItem = document.createElement('div');
    fileItem.className = 'attached-file-item';
    fileItem.innerHTML = `
      <span>📄 ${fileName}</span>
      <button class="attached-file-remove" onclick="window.removeAttachedFile('${fileName}')" type="button">✕</button>
    `;
    this.attachedFilesContainer.appendChild(fileItem);
  }

  removeFile(fileName: string): void {
    this.attachedFiles.delete(fileName);
    this.refreshDisplay();
  }

  private refreshDisplay(): void {
    this.attachedFilesContainer.innerHTML = '';
    this.attachedFiles.forEach((file) => {
      this.addFileToDisplay(file.name);
    });
  }

  async getAttachedFilesData(): Promise<any[]> {
    return Promise.all(Array.from(this.attachedFiles.values()).map(file => 
      new Promise((resolve) => {
        const isImage = file.type.startsWith('image/');
        const reader = new FileReader();
        if (isImage) {
          reader.onload = (e) => {
            resolve({ 
              name: file.name, 
              type: file.type, 
              size: file.size, 
              isImage: true, 
              content: (e.target as any).result 
            });
          };
          reader.readAsDataURL(file);
        } else {
          reader.onload = (e) => {
            resolve({ 
              name: file.name, 
              type: file.type, 
              size: file.size, 
              isImage: false, 
              content: (e.target as any).result 
            });
          };
          reader.readAsText(file);
        }
      })
    ));
  }

  clear(): void {
    this.attachedFiles.clear();
    this.attachedFilesContainer.innerHTML = '';
  }

  hasFiles(): boolean {
    return this.attachedFiles.size > 0;
  }
}

// Global function for removal
declare global {
  interface Window {
    removeAttachedFile(fileName: string): void;
  }
}

let fileAttachmentInstance: FileAttachment;

window.removeAttachedFile = function(fileName: string): void {
  if (fileAttachmentInstance) {
    fileAttachmentInstance.removeFile(fileName);
  }
};

export function setFileAttachmentInstance(instance: FileAttachment): void {
  fileAttachmentInstance = instance;
}
