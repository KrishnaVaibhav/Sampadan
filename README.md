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
- insert another PDF at the current page position
- extract current pages and custom page ranges
- split to single-page PDFs
- add text watermarks, image stamps, sticky-note annotations, highlight/underline/strikeout annotations, review notes, free text blocks, text-targeted replacement edits, width-safe born-digital text rewrites for simple standard-font PDFs including split `Tj`/`TJ` runs and line-show text operators, whiteout-and-replace edits, and page numbers to the current page or the full document
- read, fill, and flatten standard AcroForm text, checkbox, radio, dropdown, and option-list fields locally
- export page PNGs, document text, Markdown, HTML, and DOCX
- run local OCR on the current page or a full document when Tesseract is installed
- create searchable OCR PDF copies locally
- inspect PDF signatures, attachments, and encryption signals
- embed local files into PDFs as attachments
- export embedded PDF attachments locally when attachment streams are present
- unlock encrypted PDFs locally into an editable workspace through `qpdf`
- save password-protected PDF copies locally through `qpdf`
- cryptographically verify detached CMS PDF signatures locally when OpenSSL is available
- inspect embedded signer certificates and attempt local certificate-chain trust checks through OpenSSL
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

Encrypted-PDF unlock and protected-copy export currently use a machine-local qpdf runtime. If `qpdf` is not on `PATH`, Sampadan also supports `SAMPADAN_QPDF_PATH`.

Local signature verification currently uses a machine-local OpenSSL runtime. If `openssl` is not on `PATH`, Sampadan also supports `SAMPADAN_OPENSSL_PATH`. Detached signature integrity and certificate-chain trust are checked locally; revocation is not checked yet.

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
