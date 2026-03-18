import type { PageThumbnail, PdfPageTextSpan } from '../types'

import { getPdfJs, type PdfProxy } from '../pdf-engine'

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

export async function extractPageTextSpans(
  pdfProxy: PdfProxy,
  pageNumber: number,
  scale: number,
): Promise<PdfPageTextSpan[]> {
  const [{ Util }, page] = await Promise.all([getPdfJs(), pdfProxy.getPage(pageNumber)])
  const viewport = page.getViewport({ scale })
  const content = await page.getTextContent()

  const rawSpans = (content.items as Array<{
    str?: string
    hasEOL?: boolean
    width?: number
    height?: number
    transform?: number[]
  }>)
    .map((item, index) => {
      const text = item.str?.trim() ?? ''
      if (!text || !item.transform) {
        return null
      }

      const transform = Util.transform(viewport.transform, item.transform)
      const width = Math.max(item.width ? item.width * viewport.scale : 0, Math.abs(transform[0]), 1)
      const height = Math.max(
        item.height ? item.height * viewport.scale : 0,
        Math.hypot(transform[2], transform[3]),
        8,
      )
      const left = clampNumber(transform[4], 0, Math.max(0, viewport.width - 1))
      const top = clampNumber(transform[5] - height, 0, Math.max(0, viewport.height - 1))

      return {
        id: `${pageNumber}-${index}-${text.slice(0, 24)}`,
        text,
        hasEOL: item.hasEOL ?? false,
        left,
        top,
        right: clampNumber(left + width, 0, viewport.width),
        bottom: clampNumber(top + height, 0, viewport.height),
        fontSize: clampNumber(height * 0.9, 8, 72),
      }
    })
    .filter((span): span is NonNullable<typeof span> => Boolean(span))

  const mergedSpans: PdfPageTextSpan[] = []
  let lineText = ''
  let lineLeft = 0
  let lineTop = 0
  let lineRight = 0
  let lineBottom = 0
  let lineFontSize = 12
  let lineStartId = ''

  const flushLine = () => {
    if (!lineText.trim()) {
      lineText = ''
      return
    }

    mergedSpans.push({
      id: lineStartId,
      pageNumber,
      text: lineText.trim(),
      xPercent: (lineLeft / viewport.width) * 100,
      yPercent: (lineTop / viewport.height) * 100,
      widthPercent: ((lineRight - lineLeft) / viewport.width) * 100,
      heightPercent: ((lineBottom - lineTop) / viewport.height) * 100,
      fontSize: lineFontSize,
    })

    lineText = ''
  }

  for (const span of rawSpans) {
    if (!lineText) {
      lineText = span.text
      lineLeft = span.left
      lineTop = span.top
      lineRight = span.right
      lineBottom = span.bottom
      lineFontSize = span.fontSize
      lineStartId = span.id
      if (span.hasEOL) {
        flushLine()
      }
      continue
    }

    const sameLine = Math.abs(span.top - lineTop) <= Math.max(6, (lineBottom - lineTop) * 0.45)
    const gap = span.left - lineRight
    const closeEnough = gap <= Math.max(18, lineFontSize * 1.2)

    if (!sameLine || !closeEnough) {
      flushLine()
      lineText = span.text
      lineLeft = span.left
      lineTop = span.top
      lineRight = span.right
      lineBottom = span.bottom
      lineFontSize = span.fontSize
      lineStartId = span.id
      if (span.hasEOL) {
        flushLine()
      }
      continue
    }

    lineText = `${lineText} ${span.text}`.trim()
    lineLeft = Math.min(lineLeft, span.left)
    lineTop = Math.min(lineTop, span.top)
    lineRight = Math.max(lineRight, span.right)
    lineBottom = Math.max(lineBottom, span.bottom)
    lineFontSize = Math.max(lineFontSize, span.fontSize)

    if (span.hasEOL) {
      flushLine()
    }
  }

  flushLine()
  page.cleanup()
  return mergedSpans.filter((span) => span.widthPercent > 0.4 && span.heightPercent > 0.4)
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
