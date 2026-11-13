// pdf.js ships types for its main entry only; the minified builds are the same modules.
declare module 'pdfjs-dist/legacy/build/pdf.min.mjs' { export * from 'pdfjs-dist'; }
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' { export const WorkerMessageHandler: unknown; }
