import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null
let pdfLibPromise: Promise<typeof import('pdf-lib')> | null = null
let workerConfigured = false

export async function getPdfJs() {
  pdfJsPromise ??= import('pdfjs-dist')
  const module = await pdfJsPromise

  if (!workerConfigured) {
    module.GlobalWorkerOptions.workerSrc = pdfWorker
    workerConfigured = true
  }

  return module
}

export async function getPdfLib() {
  pdfLibPromise ??= import('pdf-lib')
  return pdfLibPromise
}

export async function loadPdfProxy(bytes: Uint8Array) {
  const { getDocument } = await getPdfJs()
  return getDocument({ data: bytes }).promise
}

export type PdfProxy = Awaited<ReturnType<typeof loadPdfProxy>>
