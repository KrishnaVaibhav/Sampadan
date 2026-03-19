import type { PageThumbnail, PdfDocumentTextLayoutPage, PdfPageAnnotationOverlay, PdfPageTextSpan } from '../types'

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
  const layout = await extractPageTextLayoutData(pdfProxy, pageNumber, scale)
  return layout.targets ?? layout.lines
}

export async function extractDocumentTextLayout(
  pdfProxy: PdfProxy,
  scale = 1,
): Promise<PdfDocumentTextLayoutPage[]> {
  const pages: PdfDocumentTextLayoutPage[] = []

  for (let pageNumber = 1; pageNumber <= pdfProxy.numPages; pageNumber += 1) {
    pages.push(await extractPageTextLayoutData(pdfProxy, pageNumber, scale))
  }

  return pages
}

export async function extractPageAnnotations(
  pdfProxy: PdfProxy,
  pageNumber: number,
  scale: number,
): Promise<PdfPageAnnotationOverlay[]> {
  const [{ Util }, page] = await Promise.all([getPdfJs(), pdfProxy.getPage(pageNumber)])
  const viewport = page.getViewport({ scale })
  const annotations = await page.getAnnotations()

  const overlays = (annotations as Array<Record<string, unknown>>)
    .map((annotation, index) => {
      const kind = resolveAnnotationKind(annotation.subtype)
      if (!kind) {
        return null
      }

      const rectValues = toNumberList(annotation.rect)
      if (rectValues.length < 4) {
        return null
      }

      const rect = toPercentRect(convertPdfRectToViewportRect(viewport, Util, rectValues), viewport.width, viewport.height)
      const quads =
        kind === 'text'
          ? []
          : extractAnnotationQuads(annotation.quadPoints, viewport, Util).map((quad) =>
              toPercentRect(quad, viewport.width, viewport.height),
            )

      return {
        id: String(annotation.id ?? `${pageNumber}-${index}-${kind}`),
        pageNumber,
        kind,
        xPercent: rect.xPercent,
        yPercent: rect.yPercent,
        widthPercent: rect.widthPercent,
        heightPercent: rect.heightPercent,
        quads,
        contents: readAnnotationText(annotation.contentsObj),
        title: readAnnotationText(annotation.titleObj) || null,
        colorCss: resolveAnnotationColor(annotation.color, kind),
        opacity:
          typeof annotation.opacity === 'number' && Number.isFinite(annotation.opacity)
            ? clampNumber(annotation.opacity, 0.12, 1)
            : kind === 'highlight'
              ? 0.28
              : 1,
      } satisfies PdfPageAnnotationOverlay
    })
    .filter((overlay): overlay is PdfPageAnnotationOverlay => Boolean(overlay))

  page.cleanup()
  return overlays
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function measureApproximateGlyphWeight(character: string) {
  if (/\s/.test(character)) {
    return 0.36
  }

  if (/[.,;:!'`|]/.test(character)) {
    return 0.42
  }

  if (/[()\[\]{}]/.test(character)) {
    return 0.52
  }

  if (/[ilIjtfr]/.test(character)) {
    return 0.62
  }

  if (/[mwMW@%&QGO]/.test(character)) {
    return 1.34
  }

  if (/[A-Z0-9]/.test(character)) {
    return 1.02
  }

  return 0.94
}

function measureApproximateTextWeight(text: string) {
  return Array.from(text).reduce((total, character) => total + measureApproximateGlyphWeight(character), 0)
}

export function buildPdfPageTextTargets(
  rawSpans: Array<{
    id: string
    text: string
    left: number
    top: number
    right: number
    bottom: number
    fontSize: number
  }>,
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
): PdfPageTextSpan[] {
  const targets: PdfPageTextSpan[] = []

  for (const span of rawSpans) {
    const normalizedText = span.text.replace(/\s+/g, ' ').trim()
    if (!normalizedText) {
      continue
    }

    const spanWidth = Math.max(span.right - span.left, 1)
    const spanHeight = Math.max(span.bottom - span.top, 1)
    const totalWeight = Math.max(measureApproximateTextWeight(normalizedText), 1)
    const words = normalizedText.match(/\S+/g) ?? []

    if (words.length <= 1) {
      targets.push({
        id: span.id,
        pageNumber,
        text: normalizedText,
        xPercent: (span.left / pageWidth) * 100,
        yPercent: (span.top / pageHeight) * 100,
        widthPercent: (spanWidth / pageWidth) * 100,
        heightPercent: (spanHeight / pageHeight) * 100,
        fontSize: span.fontSize,
      })
      continue
    }

    let searchStart = 0
    for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
      const word = words[wordIndex]
      const wordStart = normalizedText.indexOf(word, searchStart)
      if (wordStart < 0) {
        continue
      }

      const wordEnd = wordStart + word.length
      const leftWeight = measureApproximateTextWeight(normalizedText.slice(0, wordStart))
      const rightWeight = measureApproximateTextWeight(normalizedText.slice(0, wordEnd))
      const left = span.left + (leftWeight / totalWeight) * spanWidth
      const right = wordIndex === words.length - 1 ? span.right : span.left + (rightWeight / totalWeight) * spanWidth

      targets.push({
        id: `${span.id}-word-${wordIndex}`,
        pageNumber,
        text: word,
        xPercent: (left / pageWidth) * 100,
        yPercent: (span.top / pageHeight) * 100,
        widthPercent: ((right - left) / pageWidth) * 100,
        heightPercent: (spanHeight / pageHeight) * 100,
        fontSize: span.fontSize,
      })

      searchStart = wordEnd
    }
  }

  return targets.filter((span) => span.widthPercent > 0.25 && span.heightPercent > 0.25)
}

async function extractPageTextLayoutData(
  pdfProxy: PdfProxy,
  pageNumber: number,
  scale: number,
): Promise<PdfDocumentTextLayoutPage> {
  const [{ Util }, page] = await Promise.all([getPdfJs(), pdfProxy.getPage(pageNumber)])
  const viewport = page.getViewport({ scale })
  const content = await page.getTextContent()

  const rawSpans = (content.items as Array<{
    str?: string
    hasEOL?: boolean
    width?: number
    height?: number
    fontName?: string
    transform?: number[]
  }>)
    .map((item, index) => {
      const text = item.str?.trim() ?? ''
      if (!text || !item.transform) {
        return null
      }

      const transform = Util.transform(viewport.transform, item.transform)
      const style = item.fontName ? (content.styles as Record<string, { ascent?: number; descent?: number }> | undefined)?.[item.fontName] : undefined
      const width = Math.max(item.width ? item.width * viewport.scale : 0, Math.abs(transform[0]), 1)
      const fontHeight = Math.max(
        item.height ? item.height * viewport.scale : 0,
        Math.hypot(transform[2], transform[3]),
        8,
      )
      const ascent =
        typeof style?.ascent === 'number'
          ? style.ascent
          : typeof style?.descent === 'number'
            ? 1 + style.descent
            : 0.88
      const descent = typeof style?.descent === 'number' ? style.descent : ascent - 1
      const left = clampNumber(transform[4], 0, Math.max(0, viewport.width - 1))
      const top = clampNumber(transform[5] - fontHeight * ascent, 0, Math.max(0, viewport.height - 1))
      const bottom = clampNumber(transform[5] - fontHeight * descent, top + 1, viewport.height)

      return {
        id: `${pageNumber}-${index}-${text.slice(0, 24)}`,
        text,
        hasEOL: item.hasEOL ?? false,
        left,
        top,
        right: clampNumber(left + width, 0, viewport.width),
        bottom,
        fontSize: clampNumber(fontHeight, 8, 72),
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

  const textTargets = buildPdfPageTextTargets(rawSpans, pageNumber, viewport.width, viewport.height)

  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    lines: mergedSpans.filter((span) => span.widthPercent > 0.4 && span.heightPercent > 0.4),
    targets: textTargets,
  }
}

function resolveAnnotationKind(subtype: unknown) {
  if (typeof subtype !== 'string') {
    return null
  }

  switch (subtype) {
    case 'Text':
      return 'text'
    case 'Highlight':
      return 'highlight'
    case 'Underline':
      return 'underline'
    case 'StrikeOut':
      return 'strikeout'
    default:
      return null
  }
}

function toNumberList(value: unknown) {
  if (!value || typeof value !== 'object' || !('length' in value)) {
    return []
  }

  return Array.from(value as ArrayLike<number>, (entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
}

function readAnnotationText(value: unknown) {
  if (!value || typeof value !== 'object') {
    return ''
  }

  const text = (value as { str?: unknown }).str
  return typeof text === 'string' ? text : ''
}

function normalizeViewportRect(rect: number[]) {
  const xValues = [rect[0], rect[2]].filter((value) => Number.isFinite(value))
  const yValues = [rect[1], rect[3]].filter((value) => Number.isFinite(value))

  return {
    left: Math.min(...xValues),
    top: Math.min(...yValues),
    right: Math.max(...xValues),
    bottom: Math.max(...yValues),
  }
}

function toPercentRect(rect: number[], viewportWidth: number, viewportHeight: number) {
  const normalized = normalizeViewportRect(rect)

  return {
    xPercent: clampNumber((normalized.left / viewportWidth) * 100, 0, 100),
    yPercent: clampNumber((normalized.top / viewportHeight) * 100, 0, 100),
    widthPercent: clampNumber(((normalized.right - normalized.left) / viewportWidth) * 100, 0, 100),
    heightPercent: clampNumber(((normalized.bottom - normalized.top) / viewportHeight) * 100, 0, 100),
  }
}

function convertPdfPointToViewport(
  viewport: { convertToViewportPoint?: (x: number, y: number) => number[]; transform?: number[] },
  util: { applyTransform: (point: number[], matrix: number[]) => unknown },
  x: number,
  y: number,
) {
  if (typeof viewport.convertToViewportPoint === 'function') {
    return viewport.convertToViewportPoint(x, y)
  }

  if (Array.isArray(viewport.transform)) {
    return util.applyTransform([x, y], viewport.transform) as number[]
  }

  return [x, y]
}

function convertPdfRectToViewportRect(
  viewport: {
    convertToViewportRectangle?: (rect: number[]) => number[]
    convertToViewportPoint?: (x: number, y: number) => number[]
    transform?: number[]
  },
  util: { applyTransform: (point: number[], matrix: number[]) => unknown },
  rect: number[],
) {
  if (typeof viewport.convertToViewportRectangle === 'function') {
    return viewport.convertToViewportRectangle(rect)
  }

  const first = convertPdfPointToViewport(viewport, util, rect[0], rect[1])
  const second = convertPdfPointToViewport(viewport, util, rect[2], rect[3])
  return [first[0], first[1], second[0], second[1]]
}

function extractAnnotationQuads(
  quadPoints: unknown,
  viewport: {
    convertToViewportPoint?: (x: number, y: number) => number[]
    transform?: number[]
  },
  util: { applyTransform: (point: number[], matrix: number[]) => unknown },
) {
  const points = toNumberList(quadPoints)
  const quads: number[][] = []

  for (let index = 0; index + 7 < points.length; index += 8) {
    const corners = [
      convertPdfPointToViewport(viewport, util, points[index], points[index + 1]),
      convertPdfPointToViewport(viewport, util, points[index + 2], points[index + 3]),
      convertPdfPointToViewport(viewport, util, points[index + 4], points[index + 5]),
      convertPdfPointToViewport(viewport, util, points[index + 6], points[index + 7]),
    ]
    const xValues = corners.map((corner) => corner[0])
    const yValues = corners.map((corner) => corner[1])

    quads.push([
      Math.min(...xValues),
      Math.min(...yValues),
      Math.max(...xValues),
      Math.max(...yValues),
    ])
  }

  return quads
}

function resolveAnnotationColor(color: unknown, kind: PdfPageAnnotationOverlay['kind']) {
  const rgb = toNumberList(color)

  if (rgb.length >= 3) {
    return `rgb(${clampNumber(rgb[0], 0, 255)}, ${clampNumber(rgb[1], 0, 255)}, ${clampNumber(rgb[2], 0, 255)})`
  }

  switch (kind) {
    case 'underline':
      return 'rgb(48, 132, 240)'
    case 'strikeout':
      return 'rgb(220, 88, 96)'
    case 'text':
      return 'rgb(245, 188, 71)'
    case 'highlight':
    default:
      return 'rgb(247, 224, 46)'
  }
}
