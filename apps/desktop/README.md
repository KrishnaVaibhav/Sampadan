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
- viewer-first workspace with the PDF canvas as the dominant surface
- rotate, reorder, duplicate, delete, and insert blank pages
- extract page ranges and split documents into single-page files
- add text watermarks, image stamps, sticky-note annotations, highlight/underline/strikeout annotations, current-page annotation inspection, in-place comment editing, and removal, review notes, free text blocks, direct on-page text-target editing with word-level viewer targets, shift-click and Shift+Arrow contiguous multi-word selection, and draggable/resizable snapping region handles, width-safe born-digital text rewrites for simple standard-font PDFs including split `Tj`/`TJ` runs and line-show text operators, whiteout-and-replace edits, and page numbers
- read, fill, and flatten standard AcroForm text, checkbox, radio, dropdown, and option-list fields locally
- embed local attachment files into PDFs and export embedded attachments
- export page PNGs, document text, Markdown, layout-aware HTML, layout-aware DOCX, and structured JSON
- edit PDF metadata
- unlock encrypted PDFs into a normal editable workspace through local `qpdf`
- save password-protected PDF copies through local `qpdf`
- run local OCR through Tesseract when available on the device
- create searchable OCR PDF copies from scanned pages
- inspect signature, attachment, and encryption trust metadata with local report export
- cryptographically verify detached CMS PDF signatures locally when OpenSSL is available
- inspect embedded signer certificates and attempt local CA-store trust validation through OpenSSL

## Development

```bash
cd apps/desktop
npm ci
npm run check
npm test
npm run tauri:dev
```

## Packaging

```bash
cd apps/desktop
npm run tauri:build
```

## OCR

The desktop app probes the local machine for a Tesseract binary at runtime. On Windows it checks standard install locations such as `C:\Program Files\Tesseract-OCR\tesseract.exe` if `tesseract` is not already on `PATH`.

## Protected PDFs

The desktop app probes the local machine for a `qpdf` binary when you unlock an encrypted PDF or save a protected copy. If `qpdf` is not already on `PATH`, you can point Sampadan at a local install with `SAMPADAN_QPDF_PATH`.

## Signature Validation

The desktop app probes the local machine for an OpenSSL binary when it encounters signed PDFs. If `openssl` is not already on `PATH`, you can point Sampadan at a local install with `SAMPADAN_OPENSSL_PATH`.

Sampadan currently performs:

- detached CMS integrity verification against the PDF `ByteRange`
- embedded signer certificate inventory
- local certificate-chain trust attempts against the OpenSSL CA store

Revocation checking is still pending.
