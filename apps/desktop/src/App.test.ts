import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { LoadedPdfPayload, PdfTrustReport } from './lib/types'

const { openDialogMock, saveDialogMock, invokeMock } = vi.hoisted(() => ({
  openDialogMock: vi.fn(),
  saveDialogMock: vi.fn(),
  invokeMock: vi.fn(),
}))
const encodeBase64 = (value: string) => btoa(value)

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
  save: saveDialogMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('./lib/pdf-engine', () => ({
  getPdfLib: vi.fn(),
  loadPdfProxy: vi.fn(async () => ({
    numPages: 3,
    getPage: async (pageNumber: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => undefined,
      getTextContent: async () => ({
        items: [{ str: `Page ${pageNumber} text`, hasEOL: true }],
      }),
    }),
    destroy: async () => undefined,
  })),
}))

vi.mock('./lib/viewer/pdf-viewer', () => ({
  renderPdfPageToCanvas: vi.fn(async (_pdfProxy, pageNumber: number, scale: number, canvas: HTMLCanvasElement) => {
    canvas.width = Math.round(800 * scale)
    canvas.height = Math.round(1000 * scale)
    canvas.style.width = `${Math.round(800 * scale)}px`
    canvas.style.height = `${Math.round(1000 * scale)}px`
    canvas.setAttribute('data-page', String(pageNumber))
  }),
  generatePageThumbnails: vi.fn(async () => [
    { pageNumber: 1, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==', width: 120, height: 160 },
    { pageNumber: 2, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==', width: 120, height: 160 },
    { pageNumber: 3, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==', width: 120, height: 160 },
  ]),
  extractPageTextSpans: vi.fn(async (_pdfProxy, pageNumber: number) => [
    {
      id: `target-${pageNumber}-page`,
      pageNumber,
      text: 'Page',
      xPercent: 12,
      yPercent: 14,
      widthPercent: 8,
      heightPercent: 4,
      fontSize: 16,
    },
    {
      id: `target-${pageNumber}-number`,
      pageNumber,
      text: String(pageNumber),
      xPercent: 20.4,
      yPercent: 14,
      widthPercent: 4.2,
      heightPercent: 4,
      fontSize: 16,
    },
    {
      id: `target-${pageNumber}-line`,
      pageNumber,
      text: 'line',
      xPercent: 25.2,
      yPercent: 14,
      widthPercent: 10.8,
      heightPercent: 4,
      fontSize: 16,
    },
  ]),
  extractPageAnnotations: vi.fn(async (_pdfProxy, pageNumber: number) => [
    {
      id: `annotation-${pageNumber}`,
      pageNumber,
      kind: 'highlight',
      xPercent: 12,
      yPercent: 14,
      widthPercent: 24,
      heightPercent: 4,
      quads: [
        {
          xPercent: 12,
          yPercent: 14,
          widthPercent: 24,
          heightPercent: 4,
        },
      ],
      contents: 'Existing annotation',
      title: 'Sampadan',
      colorCss: 'rgb(247, 224, 46)',
      opacity: 0.28,
    },
  ]),
  extractDocumentTextPages: vi.fn(async () => ['Page 1 text', 'Page 2 text', 'Page 3 text']),
  extractDocumentTextLayout: vi.fn(async () => [
    {
      pageNumber: 1,
      width: 595,
      height: 842,
      lines: [
        {
          id: 'layout-1-title',
          pageNumber: 1,
          text: 'Sample page 1',
          xPercent: 12,
          yPercent: 10,
          widthPercent: 28,
          heightPercent: 4,
          fontSize: 26,
        },
        {
          id: 'layout-1-body',
          pageNumber: 1,
          text: 'Body content for page 1',
          xPercent: 12,
          yPercent: 18,
          widthPercent: 44,
          heightPercent: 3.8,
          fontSize: 14,
        },
      ],
    },
    {
      pageNumber: 2,
      width: 595,
      height: 842,
      lines: [
        {
          id: 'layout-2-title',
          pageNumber: 2,
          text: 'Sample page 2',
          xPercent: 12,
          yPercent: 10,
          widthPercent: 28,
          heightPercent: 4,
          fontSize: 26,
        },
      ],
    },
    {
      pageNumber: 3,
      width: 595,
      height: 842,
      lines: [
        {
          id: 'layout-3-title',
          pageNumber: 3,
          text: 'Sample page 3',
          xPercent: 12,
          yPercent: 10,
          widthPercent: 28,
          heightPercent: 4,
          fontSize: 26,
        },
      ],
    },
  ]),
  extractDocumentText: vi.fn(async () => 'Document text'),
}))

vi.mock('./lib/operations/pdf-document', () => ({
  mergeDocuments: vi.fn(async () => Uint8Array.from([9, 9, 9, 9])),
  insertDocumentAfterPage: vi.fn(async () => Uint8Array.from([8, 8, 8, 8])),
  addAttachmentToDocument: vi.fn(async () => Uint8Array.from([4, 4, 4, 4])),
  addFreeTextBlockToDocument: vi.fn(async () => Uint8Array.from([3, 3, 3, 3])),
  addImageStampToDocument: vi.fn(async () => Uint8Array.from([6, 6, 6])),
  addReviewNoteToDocument: vi.fn(async () => Uint8Array.from([7, 7, 7])),
  rotatePageInDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  movePageInDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  extractPagesFromDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  deletePageFromDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  duplicatePageInDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  insertBlankPageAfterCurrent: vi.fn(async () => Uint8Array.from([1, 2, 3])),
  splitDocumentIntoSinglePages: vi.fn(async () => [Uint8Array.from([1]), Uint8Array.from([2])]),
  addTextWatermarkToDocument: vi.fn(async () => Uint8Array.from([4, 4, 4])),
  addPageNumbersToDocument: vi.fn(async () => Uint8Array.from([5, 5, 5])),
  replaceRegionWithTextInDocument: vi.fn(async () => Uint8Array.from([2, 2, 2, 2])),
  replaceTargetedTextInDocument: vi.fn(async () => ({
    bytes: Uint8Array.from([2, 2, 2, 2]),
    strategy: 'content-stream',
  })),
  readMetadataFromDocument: vi.fn(async () => ({
    title: 'Sample PDF',
    author: 'Krishna Vaibhav',
    subject: 'Regression',
    keywords: 'sample, test',
    creator: 'Sampadan',
    producer: 'Sampadan',
  })),
  applyMetadataToDocument: vi.fn(async () => Uint8Array.from([1, 2, 3])),
}))

vi.mock('./lib/operations/pdf-annotations', () => ({
  addStickyNoteAnnotationToDocument: vi.fn(async () => Uint8Array.from([9, 9, 1])),
  addTextMarkupAnnotationToDocument: vi.fn(async () => Uint8Array.from([9, 9, 2])),
  removeAnnotationFromDocument: vi.fn(async () => Uint8Array.from([9, 9, 3])),
  updateAnnotationInDocument: vi.fn(async () => Uint8Array.from([9, 9, 4])),
}))

vi.mock('./lib/operations/pdf-forms', () => ({
  readFormFieldsFromDocument: vi.fn(async () => [
    {
      name: 'applicant.fullName',
      label: 'fullName',
      kind: 'text',
      value: 'Krishna Vaibhav',
      options: [],
      readOnly: false,
      required: true,
      exported: true,
      multiline: false,
      password: false,
      combed: false,
      maxLength: 64,
      multiSelect: false,
      editable: true,
      acceptsCustomText: false,
      notes: [],
    },
    {
      name: 'approval.accepted',
      label: 'accepted',
      kind: 'checkbox',
      value: true,
      options: [],
      readOnly: false,
      required: false,
      exported: true,
      multiline: false,
      password: false,
      combed: false,
      maxLength: null,
      multiSelect: false,
      editable: true,
      acceptsCustomText: false,
      notes: [],
    },
    {
      name: 'contact.department',
      label: 'department',
      kind: 'dropdown',
      value: 'Engineering',
      options: ['Engineering', 'Product', 'Legal'],
      readOnly: false,
      required: false,
      exported: true,
      multiline: false,
      password: false,
      combed: false,
      maxLength: null,
      multiSelect: false,
      editable: true,
      acceptsCustomText: false,
      notes: [],
    },
  ]),
  applyFormFieldValuesToDocument: vi.fn(async () => Uint8Array.from([8, 8, 8, 8])),
  flattenFormFieldsInDocument: vi.fn(async () => Uint8Array.from([8, 8, 8, 9])),
}))

vi.mock('./lib/session/recent-files', () => ({
  loadRecentPaths: vi.fn(() => ['C:/docs/recent.pdf']),
  rememberRecentPath: vi.fn((paths: string[], path: string) => [path, ...paths.filter((candidate) => candidate !== path)]),
}))

import App from './App.svelte'
import * as annotationOperations from './lib/operations/pdf-annotations'

const sampleTrustReport: PdfTrustReport = {
  signatureCount: 1,
  signatures: [
    {
      fieldName: 'Approval',
      signerName: 'Krishna Vaibhav',
      reason: 'Approved',
      location: 'Halifax',
      contactInfo: null,
      modificationTime: 'D:20260318070000Z',
      filter: 'Adobe.PPKLite',
      subFilter: 'adbe.pkcs7.detached',
      byteRange: [0, 100, 200, 300],
      coversWholeDocument: false,
      isTimestamp: false,
      docMdp: true,
      integrityStatus: 'verified',
      integrityMessage: 'Detached CMS signature verified locally against the PDF ByteRange content.',
      certificateTrustStatus: 'self-signed',
      certificateTrustMessage: 'error 18 at 0 depth lookup: self-signed certificate. Revocation was not checked.',
      certificates: [
        {
          subject: 'CN=Krishna Vaibhav',
          subjectCommonName: 'Krishna Vaibhav',
          issuer: 'CN=Krishna Vaibhav',
          issuerCommonName: 'Krishna Vaibhav',
          serialNumber: 'A1B2C3D4',
          notBefore: 'Mar 18 07:00:00 2026 GMT',
          notAfter: 'Mar 19 07:00:00 2026 GMT',
          sha256Fingerprint: 'AA:BB:CC:DD',
          validityStatus: 'current',
          selfSigned: true,
          notes: ['Certificate subject and issuer match. The certificate appears self-issued or self-signed.'],
        },
      ],
      notes: ['Contains DocMDP certification policy'],
    },
  ],
  signatureValidationRuntime: {
    available: true,
    binaryPath: 'openssl',
    version: 'OpenSSL 3.0.18 30 Sep 2025',
    missingReason: null,
  },
  attachmentCount: 1,
  attachments: [
    {
      fileName: 'report.xlsx',
      description: 'Quarterly workbook',
      relationship: 'Data',
      embedded: true,
      notes: ['Embedded file stream reference present'],
    },
  ],
  encryption: {
    encrypted: false,
    handler: null,
    algorithm: null,
    version: null,
    revision: null,
    keyLengthBits: null,
    permissions: null,
    streamFilter: null,
    stringFilter: null,
    encryptMetadata: null,
    notes: [],
  },
  recommendations: [
    'Saving edits will create a new PDF revision and may invalidate existing signatures.',
    'This PDF contains embedded attachments. Inspect bundled files before sharing or archiving.',
  ],
}

function createPayload(
  fileName = 'sample.pdf',
  path: string | null = 'C:/docs/sample.pdf',
  overrides: Partial<LoadedPdfPayload> = {},
): LoadedPdfPayload {
  const flags = {
    encrypted: false,
    signed: true,
    hasForms: true,
    hasXfa: false,
    hasJavascript: false,
    hasAttachments: true,
    tagged: false,
    linearized: false,
    likelyScanned: false,
    mixedContent: true,
    ...overrides.flags,
  }

  return {
    path: overrides.path ?? path,
    fileName: overrides.fileName ?? fileName,
    size: overrides.size ?? 4096,
    version: overrides.version ?? '1.7',
    bytesBase64: overrides.bytesBase64 ?? encodeBase64('%PDF-sample'),
    flags,
    trustReport: overrides.trustReport ?? sampleTrustReport,
  }
}

function getInvokePayloads(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => (payload ?? {}) as Record<string, unknown>)
}

function expectCamelCasePayloadKeys(
  payloads: Array<Record<string, unknown>>,
  expectedKeys: string[],
) {
  expect(payloads.length).toBeGreaterThan(0)

  for (const payload of payloads) {
    expect(Object.keys(payload)).toEqual(expect.arrayContaining(expectedKeys))
    expect(Object.keys(payload).some((key) => key.includes('_'))).toBe(false)
  }
}

beforeEach(() => {
  openDialogMock.mockReset()
  saveDialogMock.mockReset()
  invokeMock.mockReset()
  vi.mocked(annotationOperations.addStickyNoteAnnotationToDocument).mockClear()
  vi.mocked(annotationOperations.addTextMarkupAnnotationToDocument).mockClear()
  vi.mocked(annotationOperations.removeAnnotationFromDocument).mockClear()
  vi.mocked(annotationOperations.updateAnnotationInDocument).mockClear()

  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'get_ocr_status':
        return {
          available: true,
          binaryPath: 'C:/Program Files/Tesseract-OCR/tesseract.exe',
          version: 'tesseract v5.5.0',
          languages: ['eng', 'osd'],
          recommendedLanguage: 'eng',
          missingReason: null,
        }
      case 'get_qpdf_status':
        return {
          available: true,
          binaryPath: 'C:/Program Files/qpdf 12.3.2/bin/qpdf.exe',
          version: 'qpdf version 12.3.2',
          missingReason: null,
        }
      case 'load_pdf':
        return createPayload()
      case 'protect_pdf_bytes':
        return createPayload((args?.fileName as string | undefined) ?? 'sample-protected.pdf', null)
      case 'decrypt_pdf_bytes':
        return createPayload((args?.fileName as string | undefined) ?? 'sample.pdf', null)
      case 'load_file_bytes': {
        const path = String(args?.path ?? '')
        if (path.toLowerCase().endsWith('.png')) {
          return {
            fileName: 'stamp.png',
            bytesBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
          }
        }

        return {
          fileName: path.split(/[\\/]/).pop() ?? 'report.txt',
          bytesBase64: encodeBase64('attachment-bytes'),
        }
      }
      case 'save_file_bytes':
        return null
      case 'extract_pdf_attachments':
        return [
          {
            fileName: 'report.xlsx',
            description: 'Quarterly workbook',
            relationship: 'Data',
            bytesBase64: encodeBase64('attachment-bytes'),
            notes: ['Embedded file stream reference present'],
          },
        ]
      case 'inspect_pdf_bytes':
        return createPayload((args?.fileName as string | undefined) ?? 'generated.pdf', null)
      case 'run_ocr_image':
        return {
          language: 'eng',
          text: 'Detected text',
          durationMs: 18,
          sourceLabel: (args?.sourceLabel as string | undefined) ?? 'page-preview',
        }
      case 'run_ocr_pdf':
        return {
          language: 'eng',
          bytesBase64: encodeBase64('%PDF-searchable'),
          durationMs: 25,
          sourceLabel: (args?.sourceLabel as string | undefined) ?? 'page-searchable-pdf',
        }
      default:
        throw new Error(`Unexpected invoke command: ${command}`)
    }
  })
})

describe('Sampadan desktop app regression suite', () => {
  test('keeps the viewer dominant and enables the main controls after opening a PDF', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    expect(screen.getByTestId('viewer-shell')).toBeTruthy()
    expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('ocr-page-button') as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByTestId('open-pdf-button'))

    await waitFor(() => {
      expect(screen.getAllByText('sample.pdf').length).toBeGreaterThan(0)
    })

    expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('ocr-page-button') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('searchable-pdf-button') as HTMLButtonElement).disabled).toBe(false)
    await user.type(screen.getByLabelText('Note Text'), 'Viewer review note')

    for (const label of [
      'Save As',
      'Export Text',
      'Export Trust Report',
      'Export Attachments',
      'Attach File',
      'Flatten Forms',
      'Extract Range',
      'Split To Folder',
      'Insert PDF After',
      'Duplicate Page',
      'Delete Page',
      'Blank After',
      'All Pages PNG',
      'Export Markdown',
      'Export HTML',
      'Export DOCX',
      'Export Structured JSON',
      'Next',
      'Fit Width',
      'Rotate Left',
      'Rotate Right',
      'Move Right',
      'Extract Page',
      'Export PNG',
      'Apply Watermark',
      'Place Image Stamp',
      'Add Review Note',
      'Place Text Block',
      'Whiteout + Replace',
      'Add Page Numbers',
      'Save Protected Copy',
    ]) {
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false)
    }

    expect(screen.getByText('1 embedded file')).toBeTruthy()
    expect(screen.getByText('1 signature detected')).toBeTruthy()
    expect(screen.getByText('OpenSSL detected')).toBeTruthy()
    expect(screen.getByText('Integrity: Verified locally')).toBeTruthy()
    expect(screen.getByText('Certificate trust: Self-signed or local root missing')).toBeTruthy()
    expect(screen.getByText('Certificate chain: 1 certificate')).toBeTruthy()
    expect(screen.getByText('SHA-256: AA:BB:CC:DD')).toBeTruthy()
  })

  test('stages encrypted PDFs for local unlock before enabling the editor workspace', async () => {
    openDialogMock.mockResolvedValue('C:/docs/locked.pdf')

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'get_ocr_status':
          return {
            available: true,
            binaryPath: 'C:/Program Files/Tesseract-OCR/tesseract.exe',
            version: 'tesseract v5.5.0',
            languages: ['eng', 'osd'],
            recommendedLanguage: 'eng',
            missingReason: null,
          }
        case 'get_qpdf_status':
          return {
            available: true,
            binaryPath: 'C:/Program Files/qpdf 12.3.2/bin/qpdf.exe',
            version: 'qpdf version 12.3.2',
            missingReason: null,
          }
        case 'load_pdf':
          return createPayload('locked.pdf', 'C:/docs/locked.pdf', {
            flags: {
              encrypted: true,
              signed: false,
              hasForms: false,
              hasXfa: false,
              hasJavascript: false,
              hasAttachments: false,
              tagged: false,
              linearized: false,
              likelyScanned: false,
              mixedContent: false,
            },
            trustReport: {
              ...sampleTrustReport,
              signatureCount: 0,
              signatures: [],
              attachmentCount: 0,
              attachments: [],
              signatureValidationRuntime: null,
              encryption: {
                encrypted: true,
                handler: 'Standard',
                algorithm: 'AES-256 standard security',
                version: 5,
                revision: 6,
                keyLengthBits: 256,
                permissions: -4,
                streamFilter: 'StdCF',
                stringFilter: 'StdCF',
                encryptMetadata: false,
                notes: ['Metadata is excluded from encryption.'],
              },
              recommendations: ['Unlock this PDF locally before editing or OCR.'],
            },
          })
        case 'decrypt_pdf_bytes':
          return createPayload('locked.pdf', null)
        default:
          throw new Error(`Unexpected invoke command: ${command}`)
      }
    })

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))

    await waitFor(() => {
      expect(screen.getByTestId('unlock-pdf-button')).toBeTruthy()
      expect(screen.getByText('Locked PDF')).toBeTruthy()
    })

    expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Unlock this PDF locally before editing or OCR.')).toBeTruthy()
    expect(screen.getByText('AES-256 standard security')).toBeTruthy()

    await user.type(screen.getByLabelText('Open Password'), 'viewer-secret')
    await user.click(screen.getByTestId('unlock-pdf-button'))

    await waitFor(() => {
      expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(false)
      expect(screen.getAllByText('locked.pdf').length).toBeGreaterThan(0)
    })

    expectCamelCasePayloadKeys(getInvokePayloads('decrypt_pdf_bytes'), ['fileName', 'bytesBase64', 'password'])
  })

  test('exports the trust report through the local save pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')
    saveDialogMock.mockResolvedValue('C:/exports/sample-trust-report.json')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByRole('button', { name: 'Export Trust Report' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'save_file_bytes',
        expect.objectContaining({
          path: 'C:/exports/sample-trust-report.json',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  })

  test('exports structured json through the local save pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')
    saveDialogMock.mockResolvedValue('C:/exports/sample-structured.json')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Export Structured JSON' }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    })

    await user.click(screen.getByRole('button', { name: 'Export Structured JSON' }))

    let structuredPayload: Record<string, unknown> | undefined
    await waitFor(() => {
      structuredPayload = getInvokePayloads('save_file_bytes').find(
        (payload) => payload.path === 'C:/exports/sample-structured.json',
      )
      expect(structuredPayload).toBeTruthy()
    })

    const bytesBase64 = String(structuredPayload?.bytesBase64 ?? '')
    const jsonText = atob(bytesBase64)
    const structuredDocument = JSON.parse(jsonText)

    expect(structuredDocument.generatedBy).toBe('Sampadan')
    expect(structuredDocument.sourceFileName).toBe('sample.pdf')
    expect(structuredDocument.pages[0].blocks.length).toBeGreaterThan(0)
    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  })

  test('exports embedded attachments through the local save pipeline', async () => {
    openDialogMock
      .mockResolvedValueOnce('C:/docs/sample.pdf')
      .mockResolvedValueOnce('C:/exports/attachments')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByText('1 embedded file')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Export Attachments' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'extract_pdf_attachments',
        expect.objectContaining({
          bytesBase64: expect.any(String),
        }),
      )
      expect(invokeMock).toHaveBeenCalledWith(
        'save_file_bytes',
        expect.objectContaining({
          path: 'C:/exports/attachments/report.xlsx',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('extract_pdf_attachments'), ['bytesBase64'])
    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  })

  test('attaches a local file through the PDF mutation pipeline', async () => {
    openDialogMock
      .mockResolvedValueOnce('C:/docs/sample.pdf')
      .mockResolvedValueOnce('C:/attachments/report.txt')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('attach-file-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.type(screen.getByLabelText('Attachment Description'), 'Release checklist')
    await user.click(screen.getByTestId('attach-file-button'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'load_file_bytes',
        expect.objectContaining({ path: 'C:/attachments/report.txt' }),
      )
      expect(invokeMock).toHaveBeenCalledWith(
        'inspect_pdf_bytes',
        expect.objectContaining({
          fileName: 'sample.pdf',
          bytesBase64: expect.any(String),
        }),
      )
      expect(screen.getByText('Attached report.txt to sample.pdf')).toBeTruthy()
    })

    expectCamelCasePayloadKeys(getInvokePayloads('load_file_bytes'), ['path'])
    expectCamelCasePayloadKeys(getInvokePayloads('inspect_pdf_bytes'), ['fileName', 'bytesBase64'])
  })

  test('creates a searchable OCR copy through the local OCR pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('searchable-pdf-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('searchable-pdf-button'))

    await waitFor(() => {
      const ocrPdfCalls = getInvokePayloads('run_ocr_pdf')
      expect(ocrPdfCalls).toHaveLength(3)
      expect(invokeMock).toHaveBeenCalledWith(
        'inspect_pdf_bytes',
        expect.objectContaining({
          fileName: 'sample-searchable.pdf',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('run_ocr_pdf'), ['bytesBase64', 'language', 'sourceLabel'])
    expectCamelCasePayloadKeys(getInvokePayloads('inspect_pdf_bytes'), ['fileName', 'bytesBase64'])
  })

  test('sends camelCase payloads through the OCR workbench actions', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')
    saveDialogMock.mockResolvedValue('C:/exports/sample-ocr.txt')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('ocr-page-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('ocr-page-button'))

    await waitFor(() => {
      const ocrImageCalls = getInvokePayloads('run_ocr_image')
      expect(ocrImageCalls).toHaveLength(1)
      expect(ocrImageCalls[0]).toEqual(
        expect.objectContaining({
          bytesBase64: expect.any(String),
          language: 'eng',
          sourceLabel: 'sample.pdf page 1',
        }),
      )
    })

    await user.click(screen.getByRole('button', { name: 'OCR Document' }))

    await waitFor(() => {
      const ocrImageCalls = getInvokePayloads('run_ocr_image')
      expect(ocrImageCalls).toHaveLength(4)
      expect(ocrImageCalls.slice(1).map((payload) => payload.sourceLabel)).toEqual([
        'sample.pdf page 1',
        'sample.pdf page 2',
        'sample.pdf page 3',
      ])
    })

    await user.click(screen.getByRole('button', { name: 'Export OCR Text' }))

    await waitFor(() => {
      const saveCalls = getInvokePayloads('save_file_bytes')
      expect(saveCalls).toHaveLength(1)
      expect(saveCalls[0]).toEqual(
        expect.objectContaining({
          path: 'C:/exports/sample-ocr.txt',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('run_ocr_image'), ['bytesBase64', 'language', 'sourceLabel'])
    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  })

  test('targets existing page text before replacing it', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('toggle-text-target-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('toggle-text-target-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Target text: Page')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Target text: Page'))
    await waitFor(() => {
      expect(screen.getByTestId('inline-text-editor-card')).toBeTruthy()
    })

    await user.clear(screen.getByLabelText('Quick Replace Text'))
    await user.type(screen.getByLabelText('Quick Replace Text'), 'Updated page 1 line')
    await user.click(screen.getByTestId('inline-replace-button'))

    await waitFor(() => {
      expect(screen.getByText('Replaced selected text on page 1')).toBeTruthy()
    })
  })

  test('drags the selected text region directly in the viewer', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('toggle-text-target-button') as HTMLButtonElement).disabled).toBe(false)
    })

    const viewerSurface = screen.getByTestId('viewer-surface') as HTMLDivElement
    vi.spyOn(viewerSurface, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 1000,
      width: 800,
      height: 1000,
      toJSON: () => ({}),
    } as DOMRect)

    await user.click(screen.getByTestId('toggle-text-target-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Target text: Page')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Target text: Page'))
    await waitFor(() => {
      expect(screen.getByTestId('text-target-region-frame')).toBeTruthy()
    })

    const widthInput = screen.getByLabelText('Width %') as HTMLInputElement
    const heightInput = screen.getByLabelText('Height %') as HTMLInputElement

    expect(Number.parseFloat(widthInput.value)).toBeCloseTo(8, 2)
    expect(Number.parseFloat(heightInput.value)).toBeCloseTo(5, 2)

    await fireEvent.pointerDown(screen.getByTestId('text-target-handle-se'), {
      clientX: 160,
      clientY: 190,
    })
    await fireEvent.pointerMove(window, {
      clientX: 284,
      clientY: 260,
    })
    await fireEvent.pointerUp(window)

    expect(Number.parseFloat(widthInput.value)).toBeCloseTo(24, 1)
    expect(Number.parseFloat(heightInput.value)).toBeGreaterThan(5)
  })

  test('extends the direct text selection across contiguous targets with shift-click', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('toggle-text-target-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('toggle-text-target-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Target text: Page')).toBeTruthy()
      expect(screen.getByLabelText('Target text: line')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Target text: Page'))
    await fireEvent.click(screen.getByLabelText('Target text: line'), { shiftKey: true })

    await waitFor(() => {
      expect(screen.getByText('Selected: Page 1 line')).toBeTruthy()
      expect(screen.getByText('3 contiguous targets selected')).toBeTruthy()
    })

    expect((screen.getByLabelText('Quick Replace Text') as HTMLTextAreaElement).value).toBe('Page 1 line')
    expect(Number.parseFloat((screen.getByLabelText('Width %') as HTMLInputElement).value)).toBeCloseTo(24, 1)
  })

  test('extends and shrinks the direct text selection with keyboard arrows', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('toggle-text-target-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('toggle-text-target-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Target text: Page')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Target text: Page'))
    await fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })

    await waitFor(() => {
      expect(screen.getByText('Selected: Page 1')).toBeTruthy()
      expect(screen.getByText('2 contiguous targets selected')).toBeTruthy()
    })

    await fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })

    await waitFor(() => {
      expect(screen.getByText('Selected: Page 1 line')).toBeTruthy()
      expect(screen.getByText('3 contiguous targets selected')).toBeTruthy()
    })

    await fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true })

    await waitFor(() => {
      expect(screen.getByText('Selected: Page 1')).toBeTruthy()
      expect(screen.getByText('2 contiguous targets selected')).toBeTruthy()
    })

    await fireEvent.keyDown(window, { key: 'ArrowLeft' })

    await waitFor(() => {
      expect(screen.getByText('Selected: Page')).toBeTruthy()
    })

    expect((screen.getByLabelText('Quick Replace Text') as HTMLTextAreaElement).value).toBe('Page')
  })

  test('adds true PDF annotations from the selected text flow', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('toggle-text-target-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('toggle-text-target-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Target text: Page')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Target text: Page'))
    await user.clear(screen.getByLabelText('Note Text'))
    await user.type(screen.getByLabelText('Note Text'), 'Review this sentence.')
    await user.click(screen.getByTestId('highlight-selected-text-button'))

    await waitFor(() => {
      expect(screen.getByText('Added highlight annotation to page 1')).toBeTruthy()
    })

    await user.click(screen.getByTestId('sticky-note-button'))

    await waitFor(() => {
      expect(screen.getByText('Added sticky note annotation to page 1')).toBeTruthy()
    })
  })

  test('removes a selected page annotation through the local mutation pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByText('Current Page Annotations')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Remove annotation/i })).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: /Remove annotation/i }))

    await waitFor(() => {
      expect(screen.getByText('Removed highlight annotation from page 1')).toBeTruthy()
    })
  })

  test('updates a selected page annotation through the local mutation pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Select annotation 1')).toBeTruthy()
    })

    await user.click(screen.getByLabelText('Select annotation 1'))

    expect((screen.getByLabelText('Note Title') as HTMLInputElement).value).toBe('Sampadan')
    expect((screen.getByLabelText('Note Text') as HTMLTextAreaElement).value).toBe('Existing annotation')

    await user.clear(screen.getByLabelText('Note Title'))
    await user.type(screen.getByLabelText('Note Title'), 'Updated Review')
    await user.clear(screen.getByLabelText('Note Text'))
    await user.type(screen.getByLabelText('Note Text'), 'Updated annotation text.')
    await user.click(screen.getByTestId('update-selected-annotation-button'))

    await waitFor(() => {
      expect(screen.getByText('Updated selected annotation on page 1')).toBeTruthy()
    })

    expect(annotationOperations.updateAnnotationInDocument).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        pageIndex: 0,
        annotationId: 'annotation-1',
        title: 'Updated Review',
        contents: 'Updated annotation text.',
      }),
    )
  })

  test('applies AcroForm field edits through the local mutation pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByLabelText('Form: fullName')).toBeTruthy()
    })

    await user.clear(screen.getByLabelText('Form: fullName'))
    await user.type(screen.getByLabelText('Form: fullName'), 'Ada Lovelace')
    await user.click(screen.getByLabelText('Form: accepted'))
    await user.selectOptions(screen.getByLabelText('Form: department'), 'Legal')
    await user.click(screen.getByTestId('apply-form-values-button'))

    await waitFor(() => {
      expect(screen.getByText('Applied form field values')).toBeTruthy()
      expect(invokeMock).toHaveBeenCalledWith(
        'inspect_pdf_bytes',
        expect.objectContaining({
          fileName: 'sample.pdf',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('inspect_pdf_bytes'), ['fileName', 'bytesBase64'])
  })

  test('exports a protected copy through the local qpdf pipeline', async () => {
    openDialogMock.mockResolvedValue('C:/docs/sample.pdf')
    saveDialogMock.mockResolvedValue('C:/exports/sample-protected.pdf')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('save-protected-copy-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.type(screen.getByLabelText('Open Password'), 'viewer-secret')
    await user.type(screen.getByLabelText('Owner Password'), 'owner-secret')
    await user.click(screen.getByTestId('save-protected-copy-button'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'protect_pdf_bytes',
        expect.objectContaining({
          fileName: 'sample-protected.pdf',
          bytesBase64: expect.any(String),
          options: expect.objectContaining({
            userPassword: 'viewer-secret',
            ownerPassword: 'owner-secret',
            print: 'full',
            modify: 'annotate',
            allowExtract: true,
            encryptMetadata: true,
          }),
        }),
      )
      expect(invokeMock).toHaveBeenCalledWith(
        'save_file_bytes',
        expect.objectContaining({
          path: 'C:/exports/sample-protected.pdf',
          bytesBase64: expect.any(String),
        }),
      )
    })

    expectCamelCasePayloadKeys(getInvokePayloads('protect_pdf_bytes'), ['fileName', 'bytesBase64', 'options'])
    const protectionOptions = getInvokePayloads('protect_pdf_bytes')[0]?.options as Record<string, unknown>
    expect(Object.keys(protectionOptions).some((key) => key.includes('_'))).toBe(false)
    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  })

  test('runs structural edit and export buttons through the local pipelines', async () => {
    openDialogMock
      .mockResolvedValueOnce('C:/docs/sample.pdf')
      .mockResolvedValueOnce('C:/docs/insert-source.pdf')
      .mockResolvedValueOnce('C:/assets/stamp.png')
      .mockResolvedValueOnce('C:/exports/page-pngs')
      .mockResolvedValueOnce('C:/exports/split-pages')
    saveDialogMock
      .mockResolvedValueOnce('C:/exports/sample-page-001.png')
      .mockResolvedValueOnce('C:/exports/sample.txt')
      .mockResolvedValueOnce('C:/exports/sample.md')
      .mockResolvedValueOnce('C:/exports/sample.html')
      .mockResolvedValueOnce('C:/exports/sample.docx')
      .mockResolvedValueOnce('C:/exports/sample-structured.json')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect((screen.getByTestId('save-pdf-button') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByRole('button', { name: 'Rotate Left' }))
    await user.click(screen.getByRole('button', { name: 'Rotate Right' }))
    await user.click(screen.getByRole('button', { name: 'Move Right' }))
    await user.click(screen.getByRole('button', { name: 'Extract Page' }))
    await user.click(screen.getByRole('button', { name: 'Extract Range' }))
    await user.click(screen.getByRole('button', { name: 'Insert PDF After' }))
    await user.click(screen.getByRole('button', { name: 'Duplicate Page' }))
    await user.click(screen.getByRole('button', { name: 'Delete Page' }))
    await user.click(screen.getByRole('button', { name: 'Blank After' }))

    const titleInput = screen.getByLabelText('Title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Viewer First Regression')
    await user.click(screen.getByRole('button', { name: 'Apply Metadata' }))
    await user.click(screen.getByRole('button', { name: 'Apply Watermark' }))
    await user.click(screen.getByRole('button', { name: 'Place Image Stamp' }))
    await user.type(screen.getByLabelText('Note Text'), 'Check alignment on page 2.')
    await user.click(screen.getByRole('button', { name: 'Add Review Note' }))
    await user.clear(screen.getByLabelText('Edit Text'))
    await user.type(screen.getByLabelText('Edit Text'), 'Edited paragraph for page 2.')
    await user.click(screen.getByRole('button', { name: 'Place Text Block' }))
    await user.click(screen.getByRole('button', { name: 'Whiteout + Replace' }))
    await user.click(screen.getByRole('button', { name: 'Add Page Numbers' }))

    await user.click(screen.getByRole('button', { name: 'Export PNG' }))
    await user.click(screen.getByRole('button', { name: 'Export Text' }))
    await user.click(screen.getByRole('button', { name: 'Export Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Export HTML' }))
    await user.click(screen.getByRole('button', { name: 'Export DOCX' }))
    await user.click(screen.getByRole('button', { name: 'Export Structured JSON' }))
    await user.click(screen.getByRole('button', { name: 'All Pages PNG' }))
    await user.click(screen.getByRole('button', { name: 'Split To Folder' }))

    await waitFor(() => {
      const inspectCalls = invokeMock.mock.calls.filter(([command]) => command === 'inspect_pdf_bytes')
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')

      expect(inspectCalls.length).toBeGreaterThanOrEqual(9)
      expect(saveCalls.length).toBeGreaterThanOrEqual(5)
    })

    expectCamelCasePayloadKeys(getInvokePayloads('inspect_pdf_bytes'), ['fileName', 'bytesBase64'])
    expectCamelCasePayloadKeys(getInvokePayloads('load_file_bytes'), ['path'])
    expectCamelCasePayloadKeys(getInvokePayloads('save_file_bytes'), ['path', 'bytesBase64'])
  }, 10000)
})
