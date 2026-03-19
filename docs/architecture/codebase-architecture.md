# Sampadan Codebase Architecture

## Purpose

This file is the durable reference for how the codebase is organized, which layers own which responsibilities, and how new features should be added without collapsing the app into a monolith.

The product target is:

- local-first PDF workstation
- no mandatory servers
- cross-platform desktop delivery for Windows, Linux, and macOS
- later capability reuse for a browser surface where practical

## Product Principles

- Documents stay on the user's device by default.
- The PDF viewer should remain the dominant visual surface in the desktop workspace.
- The UI never performs privileged file IO directly.
- Heavy PDF work runs outside the main UI thread.
- Rendering and mutation are separate concerns.
- Unsafe or obscure PDF features are classified before mutation.
- New features should land behind clear module boundaries.

## Current Stack

- Desktop shell: `Tauri 2`
- Frontend: `Svelte 5 + TypeScript + Vite`
- Native layer: `Rust`
- Viewer/rendering: `PDF.js`
- PDF mutation today: `pdf-lib`
- Native OCR today: local `Tesseract` runtime detection and invocation
- Native `qpdf` work today: local runtime detection, encrypted-PDF unlock/decrypt flow, and AES-256 protected-copy generation
- Native signature validation today: local `OpenSSL` runtime detection, detached CMS verification, and signer certificate inspection
- Native PDF pipeline planned: deeper `qpdf` repair/normalization plus `PDFium`

## Repository Layout

```text
Sampadan/
  apps/
    desktop/
      src/
      src-tauri/
  docs/
    architecture/
  crates/
  packages/
```

## Layer Ownership

### 1. UI Layer

Path: `apps/desktop/src/`

Owns:

- application shell
- viewer-first layout and responsive shell composition
- grouped toolbar lanes that keep navigation, zoom, edit, and export controls aligned
- toolbar and page controls
- canvas viewer host
- user workflow state
- document session status

Does not own:

- direct disk writes
- trusted PDF inspection
- long-running OCR or signing jobs

### 2. Command Bridge

Boundary: Tauri invoke commands between `src/` and `src-tauri/`

Owns:

- validated requests from UI to native code
- serialization of document bytes and metadata
- future job progress events

Rules:

- keep command inputs explicit
- return structured payloads, not ad hoc strings
- keep security-sensitive logic in Rust

### 3. Native Core

Path: `apps/desktop/src-tauri/src/`

Owns:

- local file reads and writes
- PDF fingerprinting and classification
- safe save pipeline
- future orchestration for OCR, signatures, repair, and conversions

Current commands:

- `load_pdf`
- `load_file_bytes`
- `inspect_pdf_bytes`
- `get_qpdf_status`
- `decrypt_pdf_bytes`
- `protect_pdf_bytes`
- `save_file_bytes`
- `extract_pdf_attachments`
- `get_ocr_status`
- `run_ocr_image`
- `run_ocr_pdf`

The same inspection pass now returns a native trust report with parsed signature, attachment, and encryption details when they are available. When a signed PDF exposes a detached CMS payload and a usable `ByteRange`, Sampadan also attempts local cryptographic verification through `OpenSSL`, inventories embedded signer certificates, and tries a local CA-store chain validation. Revocation is not checked yet.
Embedded file export also routes through the native layer so attachment parsing and stream decoding stay outside the UI thread.
Encrypted-PDF unlock and protected-copy export also route through Rust so password handling, qpdf invocation, and the resulting decrypted or encrypted bytes stay out of the browser-side layer.

### 4. Document Engine Layer

Current:

- `PDF.js` for viewing, page rendering, text-target extraction, and annotation overlay extraction
- `pdf-lib` for merge, extract, rotate, reorder, direct page-overlay editing, and restricted content-stream text rewrites on simple born-digital PDFs

Planned split:

- `PDF.js`: viewport, text layer, selection, search UI
- `pdf-lib`: lightweight structural edits and positioned page-edit overlays
- `qpdf`: repair, normalization, encryption, advanced page operations
- `PDFium`: high-fidelity rendering, printing, thumbnails, difficult PDFs
- `Tesseract`: OCR pipeline

## Runtime Flow

### Open Document

1. UI selects a file path through Tauri dialog.
2. Rust reads the file and classifies PDF capabilities and risks.
3. Rust returns document bytes plus metadata.
4. If the PDF is encrypted, frontend stages it as a locked session instead of handing encrypted bytes to the editor workspace.
5. If the PDF is not encrypted, frontend loads bytes into `PDF.js`.
6. Viewer renders the active page to canvas.

### Unlock Encrypted Document

1. UI collects the open password, if one is required.
2. Frontend sends the locked PDF bytes to Rust through `decrypt_pdf_bytes`.
3. Rust resolves the local `qpdf` runtime and stages temporary input/output files.
4. `qpdf` decrypts the PDF into normal editable bytes on-device.
5. Rust reclassifies the unlocked bytes and returns them to the UI.
6. Frontend replaces the locked session with a normal `WorkspaceDocument`.

### Mutate Document

1. UI triggers an operation such as rotate, reorder, merge, insert, watermark, image stamping, sticky-note or text-markup annotation, review notes, page numbering, or AcroForm filling.
2. Frontend uses the document mutation layer to produce a new byte stream.
3. Rust re-inspects the updated bytes.
4. Frontend replaces the active workspace with the new classified document.
5. Document remains in memory until explicitly saved.

### Annotate Document

1. Frontend uses `PDF.js` text geometry to target existing born-digital text or a manual page position.
2. The annotation module writes true PDF annotations into the page `Annots` array locally through `pdf-lib`.
3. The viewer extracts current-page annotations back out of the PDF so highlights and sticky notes stay visible inside Sampadan's overlay layer.
4. The rail exposes current-page annotation entries so users can inspect, edit, and remove them locally.
5. Saved PDFs preserve those annotations for other readers instead of flattening them into page content by default.

### Fill Standard Forms

1. Frontend reads standard AcroForm fields through the local PDF mutation layer.
2. The rail exposes compact field editors for text, checkbox, radio, dropdown, and option-list values.
3. Applying changes writes the new field values into the PDF bytes locally through `pdf-lib`.
4. Optional flattening converts the current widget appearances into page content and removes interactive fields.
5. XFA and hybrid form packages remain inspect-only until a dedicated subsystem exists for them.

### Save Document

1. UI resolves a target path.
2. Frontend sends bytes to Rust.
3. Rust writes staged output to disk.
4. UI reloads the saved path as the canonical workspace state.

### OCR Document

1. UI renders one page or the full document to local canvas images.
2. Frontend sends PNG bytes plus requested language to Rust.
3. Rust resolves the local Tesseract binary and available language data.
4. Rust runs OCR on-device and returns either extracted text or a searchable PDF page.
5. Frontend can review text in memory or merge page-level OCR PDFs into a generated searchable copy.
6. User exports the OCR text or saves the searchable PDF copy explicitly.

### Save Protected Copy

1. UI collects owner/open password settings plus permission choices.
2. Frontend sends the current PDF bytes and protection options to Rust.
3. Rust resolves the local `qpdf` runtime and stages temporary input/output files.
4. `qpdf` generates an AES-256 protected copy with the selected permission restrictions.
5. Rust reclassifies the protected bytes and returns them to the UI.
6. Frontend saves the protected copy without replacing the current viewer session.

## State Model

The frontend keeps one active `WorkspaceDocument` plus an optional pending encrypted session while a locked PDF waits for local unlock.

Core fields:

- `path`
- `fileName`
- `bytes`
- `byteLength`
- `pageCount`
- `version`
- `flags`
- `modified`
- `source`

Classification flags currently tracked:

- encrypted
- signed
- forms
- XFA
- JavaScript
- attachments
- tagged
- linearized
- likely scanned
- mixed content

## Planned Module Expansion

These are the modules the codebase should grow into instead of adding more logic to `App.svelte`.

### Frontend packages

- `src/lib/session/recent-files.ts`
  Current recent-file persistence module
- `src/lib/viewer/pdf-viewer.ts`
  PDF.js canvas rendering, thumbnails, text extraction, annotation extraction, page text-target geometry, and layout-aware text-line export data
- `src/lib/conversion/document-export.ts`
  local Markdown plus semantic structured JSON, layout-aware HTML, and layout-aware DOCX generation from extracted PDF text and page geometry
- `src/lib/operations/pdf-document.ts`
  merge, insert, rotate, extract, reorder, split, watermark, image stamping, review notes, true page-edit overlays, restricted content-stream text rewrites, text-targeted replacement fallback, embedded attachments, page numbering, metadata, and export helpers
- `src/lib/operations/pdf-annotations.ts`
  true sticky-note and text-markup PDF annotation writes plus current-page annotation editing and removal
- `src/lib/operations/pdf-forms.ts`
  standard AcroForm field discovery, field-value application, and form flattening
- `src/lib/types.ts`
  shared desktop payloads for trust, forms, OCR, qpdf runtime state, and protected-copy options
- `src/lib/ocr/ocr-client.ts`
  OCR status probing and native OCR text/PDF invocation bridge
- `src/App.test.ts`
  regression suite for critical desktop UI actions and trust/OCR/form flows
- `src/App.workflow.test.ts`
  real-PDF workflow regression for open, encrypted unlock, mutate, form fill/flatten, metadata, save, merge, and export paths
- `src/test/pdf-fixtures.ts`
  generated real-PDF fixtures, including fillable AcroForm samples and annotation summary helpers used by regression tests
- `src/lib/operations/pdf-document.test.ts`
  real-byte coverage for structural edits and metadata round-trips
- `src/lib/operations/pdf-annotations.test.ts`
  real-byte coverage for sticky-note and text-markup PDF annotations
- `src/lib/operations/pdf-forms.test.ts`
  real-byte coverage for standard AcroForm field discovery, fill, and flatten flows
- `src/lib/conversion/`
  PNG export, image pipelines, later DOCX/HTML export adapters
- `src/lib/components/`
  toolbar, page strip, inspector, status surfaces

### Native modules

- `src-tauri/src/commands.rs`
  Tauri entry points only
- `src-tauri/src/pdf_inspect.rs`
  PDF versioning, classification, signature parsing, trust report generation, and validation orchestration
- `src-tauri/src/ocr.rs`
  local Tesseract detection, language enumeration, and image OCR text/PDF execution
- `src-tauri/src/qpdf.rs`
  local qpdf detection, encrypted-PDF unlock/decrypt, protected-copy option validation, and encrypted PDF generation
- `src-tauri/src/signature_validation.rs`
  local OpenSSL detection, detached CMS verification, signer certificate extraction, and certificate-chain trust checks
- `src-tauri/src/pdf/`
  document inspection and capability detection
- `src-tauri/src/io/`
  save strategy, temp files, path handling
- `src-tauri/src/jobs/`
  background job orchestration and progress reporting
- `src-tauri/src/signatures/`
  signature detection, validation, timestamps
- `src-tauri/src/ocr/`
  Tesseract invocation and image preprocessing

## Feature Delivery Rules

When adding a new feature:

1. Decide whether it is viewer-only, structural-edit, conversion, OCR, or trust/security work.
2. Put PDF byte mutations in a dedicated operation module, not directly inside UI markup.
3. If the feature touches disk, certificates, signatures, or bundled native tools, route through Rust.
4. If the feature is CPU-heavy, design it as a background job from the start.
5. Update this file when a new subsystem or dependency becomes canonical.

## Near-Term Roadmap

### Milestone 1

- desktop workspace shell
- open/save
- render current page
- rotate page
- move page
- extract page
- merge PDFs
- export PNG

### Milestone 2

- thumbnail strip
- split/range extraction
- page delete/insert
- drag reordering
- metadata editor
- better undo-safe save flow

Status on March 18, 2026:

- thumbnail strip implemented
- split/range extraction implemented
- page delete/insert/duplicate implemented
- drag reordering implemented
- metadata editor implemented

### Milestone 3

- OCR with Tesseract
- searchable scan enhancement
- signature validation
- attachment inspection
- encryption controls

Status on March 18, 2026:

- local page OCR implemented
- full-document OCR preview implemented
- OCR runtime detection and language listing implemented
- searchable OCR PDF copy generation implemented
- standard AcroForm discovery, local field filling, and flattening implemented for text, checkbox, radio, dropdown, and option-list fields
- native signature/trust report inspection implemented
- native attachment inspection implemented
- embedded attachment insertion implemented through the frontend PDF mutation layer
- native encryption summary inspection implemented
- write-side protected-copy export implemented through local qpdf
- encrypted-PDF unlock into editable workspace implemented through local qpdf
- true page editing implemented through positioned text-block and whiteout-replace PDF mutations
- true PDF annotation support implemented for sticky notes plus highlight, underline, and strikeout markup
- current-page annotation management, in-place comment editing, and removal implemented in the desktop rail
- text-targeted replacement implemented from PDF.js-extracted page text geometry for born-digital PDFs, with word-level viewer targets, drag-across sweep selection, double-click line targeting, repeated-text match navigation, page-level replace-all for matching text, exact page or document find/replace with result highlighting, F3 navigation, Ctrl/Cmd+F focusing, shift-click and Shift+Arrow contiguous multi-word selection, line-aware ArrowUp/Down and Cmd/Ctrl+Arrow navigation, a direct inline viewer editor, draggable start/end selection grips, keyboard range navigation, and draggable/resizable snapping on-page region handles for faster Acrobat-like interaction
- restricted content-stream rewrite implemented for width-safe `Tj`, split `Tj`/`TJ` sequences, `TJ`, and line-show text operators on simple standard-font born-digital PDFs, with automatic overlay fallback on harder documents
- Markdown plus semantic structured JSON, layout-aware HTML, and layout-aware DOCX conversion/export implemented locally from extracted PDF text and page geometry
- detached CMS signature integrity verification implemented through local OpenSSL
- signer certificate inventory implemented through local OpenSSL
- local CA-store certificate-chain trust attempts implemented
- regression tests now cover critical viewer, OCR, trust, annotation, edit, and export controls
- real-PDF regression coverage now exercises open, reorder, duplicate, delete, blank-page insert, extract, metadata apply, save, merge, and export flows
- revocation and deeper timestamp authority validation still pending

### Milestone 4

- PDF to image batch conversion
- PDF to DOCX or structured export strategy
- PDF/A validation
- repair pipeline with `qpdf`
- high-fidelity print/export via `PDFium`

## Build and Release Strategy

- local development happens in `apps/desktop`
- Windows builds can be validated locally on this machine
- Linux and macOS builds should run in GitHub Actions matrix jobs
- native dependencies must be bundled per platform and documented when added
- Tesseract is currently discovered from the local machine rather than bundled into the app package

## Architectural Debt To Watch

- avoid turning `App.svelte` into the final home for all business logic
- do not bind the save pipeline to browser-only APIs
- do not mix document classification with UI display formatting
- avoid assuming all PDFs are mutable with the same engine
- isolate any future AGPL-sensitive dependency decisions before adoption
