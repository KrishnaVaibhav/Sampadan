import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { LoadedPdfPayload, PdfTrustReport } from './lib/types'
import { createSamplePdf, readPdfSummary } from './test/pdf-fixtures'

const { openDialogMock, saveDialogMock, invokeMock } = vi.hoisted(() => ({
  openDialogMock: vi.fn(),
  saveDialogMock: vi.fn(),
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
  save: saveDialogMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('./lib/pdf-engine', async () => {
  const actual = await vi.importActual<typeof import('./lib/pdf-engine')>('./lib/pdf-engine')

  return {
    ...actual,
    loadPdfProxy: vi.fn(async (bytes: Uint8Array) => {
      const { PDFDocument } = await actual.getPdfLib()
      const document = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
      const pageCount = document.getPageCount()

      return {
        numPages: pageCount,
        getPage: async (pageNumber: number) => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => undefined,
          getTextContent: async () => ({
            items: [{ str: `Sample page ${pageNumber}`, hasEOL: true }],
          }),
        }),
        destroy: async () => undefined,
      }
    }),
  }
})

vi.mock('./lib/session/recent-files', () => ({
  loadRecentPaths: vi.fn(() => []),
  rememberRecentPath: vi.fn((paths: string[], path: string) => [path, ...paths.filter((candidate) => candidate !== path)]),
}))

import App from './App.svelte'

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const value of bytes) {
    binary += String.fromCharCode(value)
  }
  return btoa(binary)
}

const decodeBase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

const fileNameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path

const emptyTrustReport: PdfTrustReport = {
  signatureCount: 0,
  signatures: [],
  signatureValidationRuntime: null,
  attachmentCount: 0,
  attachments: [],
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
  recommendations: [],
}

async function buildPayload(bytes: Uint8Array, fileName = 'workflow.pdf', path: string | null = 'C:/docs/workflow.pdf'): Promise<LoadedPdfPayload> {
  const { PDFDocument } = await import('pdf-lib')
  const document = await PDFDocument.load(bytes.slice(), { updateMetadata: false })

  return {
    path,
    fileName,
    size: bytes.length,
    version: '1.7',
    bytesBase64: encodeBase64(bytes),
    flags: {
      encrypted: false,
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
    trustReport: emptyTrustReport,
  }
}

beforeEach(() => {
  openDialogMock.mockReset()
  saveDialogMock.mockReset()
  invokeMock.mockReset()
})

describe('real PDF workflow actions', () => {
  test('button flows mutate and export real PDF bytes without throwing', async () => {
    const sourcePath = 'C:/docs/workflow.pdf'
    const mergePath = 'C:/docs/merge-source.pdf'
    const sourceBytes = await createSamplePdf(3)
    const mergeBytes = await createSamplePdf(2)
    const diskFiles = new Map<string, Uint8Array>([
      [sourcePath, sourceBytes],
      [mergePath, mergeBytes],
    ])
    let currentBytes = sourceBytes
    let directorySelectionIndex = 0

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'get_ocr_status':
          return {
            available: false,
            binaryPath: null,
            version: null,
            languages: [],
            recommendedLanguage: 'eng',
            missingReason: 'Tesseract not installed for this workflow test',
          }
        case 'load_pdf': {
          const path = String(args?.path ?? '')
          const storedBytes = diskFiles.get(path)
          if (!storedBytes) {
            throw new Error(`No PDF fixture registered for ${path}`)
          }
          const bytes = new Uint8Array(Array.from(storedBytes))
          currentBytes = bytes
          return buildPayload(bytes, fileNameFromPath(path), path)
        }
        case 'inspect_pdf_bytes': {
          const nextBytes = decodeBase64(String(args?.bytes_base64 ?? ''))
          currentBytes = nextBytes
          return buildPayload(
            nextBytes,
            String(args?.file_name ?? 'generated.pdf'),
            null,
          )
        }
        case 'save_file_bytes': {
          const path = String(args?.path ?? '')
          const bytes = decodeBase64(String(args?.bytes_base64 ?? ''))
          if (path.toLowerCase().endsWith('.pdf')) {
            diskFiles.set(path, bytes)
          }
          return null
        }
        default:
          throw new Error(`Unexpected invoke command: ${command}`)
      }
    })

    openDialogMock.mockImplementation(async (options?: { directory?: boolean; multiple?: boolean }) => {
      if (options?.directory) {
        directorySelectionIndex += 1
        return directorySelectionIndex === 1 ? 'C:/exports/all-pages' : 'C:/exports/split-pages'
      }

      if (options?.multiple) {
        return [mergePath]
      }

      return sourcePath
    })
    saveDialogMock
      .mockResolvedValueOnce('C:/docs/workflow-edited.pdf')
      .mockResolvedValueOnce('C:/docs/workflow-merged-copy.pdf')
      .mockResolvedValueOnce('C:/exports/page.png')
      .mockResolvedValueOnce('C:/exports/document.txt')
      .mockResolvedValueOnce('C:/exports/trust.json')

    const user = userEvent.setup()
    render(App)

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByText('1/3 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Rotate Left' }))
    await user.click(screen.getByRole('button', { name: 'Move Right' }))
    await user.click(screen.getByRole('button', { name: 'Duplicate Page' }))
    await waitFor(() => {
      expect(screen.getByText('3/4 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Delete Page' }))
    await waitFor(() => {
      expect(screen.getByText('3/3 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Blank After' }))
    await waitFor(() => {
      expect(screen.getByText('4/4 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Extract Page' }))
    await waitFor(() => {
      expect(screen.getByText('1/1 pages')).toBeTruthy()
    })

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByText('1/3 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Extract Range' }))
    await waitFor(() => {
      expect(screen.getByText('1/1 pages')).toBeTruthy()
    })

    await user.click(screen.getByTestId('open-pdf-button'))
    await waitFor(() => {
      expect(screen.getByText('1/3 pages')).toBeTruthy()
    })

    const titleInput = screen.getByLabelText('Title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Workflow Edited')
    await user.click(screen.getByRole('button', { name: 'Apply Metadata' }))
    await waitFor(() => {
      expect(screen.getByDisplayValue('Workflow Edited')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.getAllByText('workflow-edited.pdf').length).toBeGreaterThan(0)
    })

    await user.click(screen.getByRole('button', { name: 'Merge PDFs' }))
    await waitFor(() => {
      expect(screen.getByText('1/5 pages')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Save As' }))
    await waitFor(() => {
      expect(screen.getAllByText('workflow-merged-copy.pdf').length).toBeGreaterThan(0)
    })

    await user.click(screen.getByRole('button', { name: 'Export PNG' }))
    await waitFor(() => {
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')
      expect(saveCalls.length).toBe(3)
    })

    await user.click(screen.getByRole('button', { name: 'All Pages PNG' }))
    await waitFor(() => {
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')
      expect(saveCalls.length).toBe(8)
    })

    await user.click(screen.getByRole('button', { name: 'Split To Folder' }))
    await waitFor(() => {
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')
      expect(saveCalls.length).toBe(13)
    })

    await user.click(screen.getByRole('button', { name: 'Export Text' }))
    await waitFor(() => {
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')
      expect(saveCalls.length).toBe(14)
    })

    await user.click(screen.getByRole('button', { name: 'Export Trust Report' }))

    await waitFor(() => {
      const inspectCalls = invokeMock.mock.calls.filter(([command]) => command === 'inspect_pdf_bytes')
      const saveCalls = invokeMock.mock.calls.filter(([command]) => command === 'save_file_bytes')

      expect(inspectCalls.length).toBeGreaterThanOrEqual(7)
      expect(saveCalls.length).toBe(15)
    })

    const savedEditedSummary = await readPdfSummary(diskFiles.get('C:/docs/workflow-edited.pdf')!)
    expect(savedEditedSummary.title).toBe('Workflow Edited')
    expect(savedEditedSummary.pageCount).toBe(3)

    const savedMergedSummary = await readPdfSummary(diskFiles.get('C:/docs/workflow-merged-copy.pdf')!)
    expect(savedMergedSummary.pageCount).toBe(5)
  })
})
