# Sampadan

Sampadan is an open-source PDF workstation in development.

The project is intended to cover practical PDF workflows such as editing, OCR, forms, signatures, validation, and safe handling of complex documents.

## Meaning

`Sampadan` comes from `sampadan`, a word associated with editing and editorial work.

## Status

Working desktop foundation.

Current local features include:

- open, save, and merge PDFs
- viewer-first desktop layout with the PDF canvas as the primary workspace
- page thumbnails and drag reordering
- rotate, duplicate, delete, and insert blank pages
- extract current pages and custom page ranges
- split to single-page PDFs
- export page PNGs and document text
- run local OCR on the current page or a full document when Tesseract is installed
- create searchable OCR PDF copies locally
- inspect PDF signatures, attachments, and encryption signals
- cryptographically verify detached CMS PDF signatures locally when OpenSSL is available
- metadata inspection and editing

## Architecture

The current codebase architecture reference lives in `docs/architecture/codebase-architecture.md`.

## Development

Desktop app commands live in `apps/desktop`.

```bash
cd apps/desktop
npm ci
npm run check
npm test
npm run tauri:dev
```

Local OCR currently uses a machine-local Tesseract runtime. On Windows, the desktop app will detect standard installs such as `C:\Program Files\Tesseract-OCR\tesseract.exe`.

Local signature verification currently uses a machine-local OpenSSL runtime. If `openssl` is not on `PATH`, Sampadan also supports `SAMPADAN_OPENSSL_PATH`.

Production desktop bundles are created with:

```bash
cd apps/desktop
npm run tauri:build
```

GitHub Actions builds Windows, Linux, and macOS bundles through `.github/workflows/desktop-build.yml`.

## License

Apache-2.0

Copyright (c) 2026 Krishna Vaibhav.

The full license text is in `LICENSE`. Project attribution notices are in `NOTICE`.
