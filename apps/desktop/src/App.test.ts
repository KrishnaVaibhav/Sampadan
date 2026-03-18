import { render, screen, waitFor } from '@testing-library/svelte'
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
  extractDocumentText: vi.fn(async () => 'Document text'),
}))

vi.mock('./lib/operations/pdf-document', () => ({
  mergeDocuments: vi.fn(async () => Uint8Array.from([9, 9, 9, 9])),
  insertDocumentAfterPage: vi.fn(async () => Uint8Array.from([8, 8, 8, 8])),
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

vi.mock('./lib/session/recent-files', () => ({
  loadRecentPaths: vi.fn(() => ['C:/docs/recent.pdf']),
  rememberRecentPath: vi.fn((paths: string[], path: string) => [path, ...paths.filter((candidate) => candidate !== path)]),
}))

import App from './App.svelte'

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
  recommendations: [
    'Saving edits will create a new PDF revision and may invalidate existing signatures.',
    'This PDF contains embedded attachments. Inspect bundled files before sharing or archiving.',
  ],
}

function createPayload(fileName = 'sample.pdf', path: string | null = 'C:/docs/sample.pdf'): LoadedPdfPayload {
  return {
    path,
    fileName,
    size: 4096,
    version: '1.7',
    bytesBase64: encodeBase64('%PDF-sample'),
    flags: {
      encrypted: true,
      signed: true,
      hasForms: true,
      hasXfa: false,
      hasJavascript: false,
      hasAttachments: true,
      tagged: false,
      linearized: false,
      likelyScanned: false,
      mixedContent: true,
    },
    trustReport: sampleTrustReport,
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
      case 'load_file_bytes':
        return {
          fileName: 'stamp.png',
          bytesBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
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
      'Extract Range',
      'Split To Folder',
      'Insert PDF After',
      'Duplicate Page',
      'Delete Page',
      'Blank After',
      'All Pages PNG',
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
      'Add Page Numbers',
      'Save Protected Copy',
    ]) {
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false)
    }

    expect(screen.getByText('AES-256 standard security')).toBeTruthy()
    expect(screen.getByText('1 embedded file')).toBeTruthy()
    expect(screen.getByText('1 signature detected')).toBeTruthy()
    expect(screen.getByText('OpenSSL detected')).toBeTruthy()
    expect(screen.getByText('Integrity: Verified locally')).toBeTruthy()
    expect(screen.getByText('Certificate trust: Self-signed or local root missing')).toBeTruthy()
    expect(screen.getByText('Certificate chain: 1 certificate')).toBeTruthy()
    expect(screen.getByText('SHA-256: AA:BB:CC:DD')).toBeTruthy()
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
    await user.click(screen.getByRole('button', { name: 'Add Page Numbers' }))

    await user.click(screen.getByRole('button', { name: 'Export PNG' }))
    await user.click(screen.getByRole('button', { name: 'Export Text' }))
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
  })
})
