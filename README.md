# Sampadan

Sampadan is an open-source PDF workstation in development.

The project is intended to cover practical PDF workflows such as editing, OCR, forms, signatures, validation, and safe handling of complex documents.

## Meaning

`Sampadan` comes from `sampadan`, a word associated with editing and editorial work.

## Status

Bootstrap phase.

## Architecture

The current codebase architecture reference lives in `docs/architecture/codebase-architecture.md`.

## Development

Desktop app commands live in `apps/desktop`.

```bash
cd apps/desktop
npm ci
npm run check
npm run tauri:dev
```

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
