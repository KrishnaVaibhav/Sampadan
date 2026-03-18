import { getPdfLib } from '../pdf-engine'
import type { ReviewNoteTone } from './pdf-document'

export type PdfMarkupAnnotationKind = 'highlight' | 'underline' | 'strikeout'

type StickyNoteOptions = {
  title: string
  contents: string
  pageIndexes: number[]
  xPercent: number
  yPercent: number
  tone: ReviewNoteTone
}

type TextMarkupOptions = {
  kind: PdfMarkupAnnotationKind
  pageIndex: number
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
  title?: string
  contents?: string
}

type RemoveAnnotationOptions = {
  pageIndex: number
  annotationId: string
}

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await getPdfLib()
  return PDFDocument.load(bytes.slice(), { updateMetadata: false })
}

async function saveDocument(document: Awaited<ReturnType<typeof loadDocument>>) {
  return document.save()
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function normalizePageIndexes(pageIndexes: number[], pageCount: number) {
  const uniqueIndexes = Array.from(
    new Set(pageIndexes.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount)),
  ).sort((left, right) => left - right)

  if (uniqueIndexes.length === 0) {
    throw new Error('Choose at least one valid page for the annotation.')
  }

  return uniqueIndexes
}

function resolveRelativeRect(options: {
  pageWidth: number
  pageHeight: number
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
}) {
  const width = clampNumber(options.pageWidth * (options.widthPercent / 100), 12, options.pageWidth)
  const height = clampNumber(options.pageHeight * (options.heightPercent / 100), 8, options.pageHeight)
  const x = clampNumber(options.pageWidth * (options.xPercent / 100), 0, Math.max(0, options.pageWidth - width))
  const topY = clampNumber(options.pageHeight * (options.yPercent / 100), 0, Math.max(0, options.pageHeight - height))

  return {
    x,
    y: options.pageHeight - topY - height,
    width,
    height,
  }
}

function resolveStickyNoteRect(options: {
  pageWidth: number
  pageHeight: number
  xPercent: number
  yPercent: number
}) {
  const size = clampNumber(Math.min(options.pageWidth, options.pageHeight) * 0.03, 18, 26)
  const x = clampNumber(options.pageWidth * (options.xPercent / 100), 0, Math.max(0, options.pageWidth - size))
  const topY = clampNumber(options.pageHeight * (options.yPercent / 100), 0, Math.max(0, options.pageHeight - size))

  return {
    x,
    y: options.pageHeight - topY - size,
    width: size,
    height: size,
  }
}

function resolveToneColor(tone: ReviewNoteTone) {
  switch (tone) {
    case 'blue':
      return [0.29, 0.57, 0.9]
    case 'green':
      return [0.24, 0.66, 0.43]
    case 'rose':
      return [0.86, 0.42, 0.52]
    case 'amber':
    default:
      return [0.96, 0.74, 0.28]
  }
}

function resolveMarkupColor(kind: PdfMarkupAnnotationKind) {
  switch (kind) {
    case 'underline':
      return [0.19, 0.52, 0.94]
    case 'strikeout':
      return [0.86, 0.32, 0.38]
    case 'highlight':
    default:
      return [0.97, 0.88, 0.18]
  }
}

function buildPdfDate(date: Date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  return `D:${year}${month}${day}${hour}${minute}${second}Z`
}

function buildAnnotationName(prefix: string) {
  return `Sampadan-${prefix}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`
}

function parseAnnotationRefId(annotationId: string) {
  const normalized = annotationId.trim()
  const simpleMatch = normalized.match(/^(\d+)R$/)
  if (simpleMatch) {
    return {
      objectNumber: Number.parseInt(simpleMatch[1], 10),
      generationNumber: 0,
    }
  }

  const extendedMatch = normalized.match(/^(\d+)R(\d+)$/)
  if (extendedMatch) {
    return {
      objectNumber: Number.parseInt(extendedMatch[1], 10),
      generationNumber: Number.parseInt(extendedMatch[2], 10),
    }
  }

  return null
}

export async function addStickyNoteAnnotationToDocument(bytes: Uint8Array, options: StickyNoteOptions) {
  const pdfLib = await getPdfLib()
  const { PDFName, PDFString, AnnotationFlags } = pdfLib
  const document = await loadDocument(bytes)
  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const now = buildPdfDate(new Date())
  const title = options.title.trim() || 'Sampadan'
  const contents = options.contents.trim()

  if (!contents) {
    throw new Error('Sticky note text is required.')
  }

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const rect = resolveStickyNoteRect({
      pageWidth: width,
      pageHeight: height,
      xPercent: options.xPercent,
      yPercent: options.yPercent,
    })
    const context = page.node.context
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      T: PDFString.of(title),
      Contents: PDFString.of(contents),
      Name: PDFName.of('Comment'),
      C: resolveToneColor(options.tone),
      F: AnnotationFlags.Print | AnnotationFlags.NoZoom | AnnotationFlags.NoRotate,
      Open: false,
      NM: PDFString.of(buildAnnotationName('text')),
      M: PDFString.of(now),
      P: page.ref,
    })

    page.node.addAnnot(context.register(annotation))
  }

  return saveDocument(document)
}

export async function addTextMarkupAnnotationToDocument(bytes: Uint8Array, options: TextMarkupOptions) {
  const pdfLib = await getPdfLib()
  const { PDFString, AnnotationFlags } = pdfLib
  const document = await loadDocument(bytes)

  if (options.pageIndex < 0 || options.pageIndex >= document.getPageCount()) {
    throw new Error('Choose a valid page before creating the annotation.')
  }

  const page = document.getPage(options.pageIndex)
  const { width, height } = page.getSize()
  const rect = resolveRelativeRect({
    pageWidth: width,
    pageHeight: height,
    xPercent: options.xPercent,
    yPercent: options.yPercent,
    widthPercent: options.widthPercent,
    heightPercent: options.heightPercent,
  })
  const title = options.title?.trim() || 'Sampadan'
  const contents = options.contents?.trim() ?? ''
  const context = page.node.context
  const now = buildPdfDate(new Date())
  const quadPoints = [
    rect.x,
    rect.y + rect.height,
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y,
  ]
  const subtype =
    options.kind === 'highlight'
      ? 'Highlight'
      : options.kind === 'underline'
        ? 'Underline'
        : 'StrikeOut'

  const annotation = context.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    QuadPoints: quadPoints,
    T: PDFString.of(title),
    Contents: PDFString.of(contents),
    C: resolveMarkupColor(options.kind),
    CA: options.kind === 'highlight' ? 0.28 : 1,
    F: AnnotationFlags.Print,
    NM: PDFString.of(buildAnnotationName(options.kind)),
    M: PDFString.of(now),
    P: page.ref,
  })

  page.node.addAnnot(context.register(annotation))
  return saveDocument(document)
}

export async function removeAnnotationFromDocument(bytes: Uint8Array, options: RemoveAnnotationOptions) {
  const pdfLib = await getPdfLib()
  const { PDFRef } = pdfLib
  const document = await loadDocument(bytes)

  if (options.pageIndex < 0 || options.pageIndex >= document.getPageCount()) {
    throw new Error('Choose a valid page before removing the annotation.')
  }

  const parsedRef = parseAnnotationRefId(options.annotationId)
  if (!parsedRef) {
    throw new Error('Sampadan could not resolve the selected annotation reference.')
  }

  const page = document.getPage(options.pageIndex)
  const annotRef = PDFRef.of(parsedRef.objectNumber, parsedRef.generationNumber)
  page.node.removeAnnot(annotRef)

  return saveDocument(document)
}
