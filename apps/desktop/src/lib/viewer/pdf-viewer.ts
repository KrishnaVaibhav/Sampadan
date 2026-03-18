import type { PageThumbnail } from '../types'

import type { PdfProxy } from '../pdf-engine'

export async function renderPdfPageToCanvas(
  pdfProxy: PdfProxy,
  pageNumber: number,
  scale: number,
  canvas: HTMLCanvasElement,
) {
  const page = await pdfProxy.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const outputScale = window.devicePixelRatio || 1
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Canvas rendering context is unavailable.')
  }

  canvas.width = Math.floor(viewport.width * outputScale)
  canvas.height = Math.floor(viewport.height * outputScale)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise

  page.cleanup()
}

export async function generatePageThumbnails(
  pdfProxy: PdfProxy,
  options: { scale?: number } = {},
): Promise<PageThumbnail[]> {
  const scale = options.scale ?? 0.22
  const thumbnails: PageThumbnail[] = []

  for (let pageNumber = 1; pageNumber <= pdfProxy.numPages; pageNumber += 1) {
    const page = await pdfProxy.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('Canvas rendering context is unavailable for thumbnails.')
    }

    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise

    thumbnails.push({
      pageNumber,
      dataUrl: canvas.toDataURL('image/jpeg', 0.74),
      width: canvas.width,
      height: canvas.height,
    })

    page.cleanup()
  }

  return thumbnails
}

export async function extractDocumentTextPages(pdfProxy: PdfProxy): Promise<string[]> {
  const pages: string[] = []

  for (let pageNumber = 1; pageNumber <= pdfProxy.numPages; pageNumber += 1) {
    const page = await pdfProxy.getPage(pageNumber)
    const content = await page.getTextContent()
    const lines: string[] = []

    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (!item.str) {
        continue
      }

      lines.push(item.str)
      lines.push(item.hasEOL ? '\n' : ' ')
    }

    const normalized = lines
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    pages.push(normalized)
  }

  return pages
}

export async function extractDocumentText(pdfProxy: PdfProxy): Promise<string> {
  const pages = await extractDocumentTextPages(pdfProxy)
  return pages.map((text, index) => `Page ${index + 1}\n${text}`).join('\n\n')
}
