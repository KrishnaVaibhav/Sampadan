# Sampadan Desktop

This package contains the local-first desktop application for Sampadan.

## Stack

- `Tauri 2`
- `Svelte 5 + TypeScript + Vite`
- `Rust`
- `PDF.js`
- `pdf-lib`

## Current Capabilities

- open, save, and merge PDFs
- rotate, reorder, duplicate, delete, and insert blank pages
- extract page ranges and split documents into single-page files
- export page PNGs and document text
- edit PDF metadata
- run local OCR through Tesseract when available on the device
- create searchable OCR PDF copies from scanned pages
- inspect signature and trust metadata with local report export

## Development

```bash
cd apps/desktop
npm ci
npm run check
npm run tauri:dev
```

## Packaging

```bash
cd apps/desktop
npm run tauri:build
```

## OCR

The desktop app probes the local machine for a Tesseract binary at runtime. On Windows it checks standard install locations such as `C:\Program Files\Tesseract-OCR\tesseract.exe` if `tesseract` is not already on `PATH`.
