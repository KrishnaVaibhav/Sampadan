import { getPdfLib } from '../pdf-engine'
import type { PdfMetadataDraft } from '../types'

export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type PageNumberPosition =
  | 'header-left'
  | 'header-center'
  | 'header-right'
  | 'footer-left'
  | 'footer-center'
  | 'footer-right'

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await getPdfLib()
  return PDFDocument.load(bytes.slice(), { updateMetadata: false })
}

async function saveDocument(document: Awaited<ReturnType<typeof loadDocument>>) {
  return document.save()
}

async function appendCopiedPages(
  target: Awaited<ReturnType<typeof loadDocument>>,
  source: Awaited<ReturnType<typeof loadDocument>>,
  pageIndexes: number[],
) {
  if (pageIndexes.length === 0) {
    return
  }

  const pages = await target.copyPages(source, pageIndexes)
  for (const page of pages) {
    target.addPage(page)
  }
}

function normalizePageIndexes(pageIndexes: number[], pageCount: number) {
  const uniqueIndexes = Array.from(
    new Set(
      pageIndexes.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount),
    ),
  ).sort((left, right) => left - right)

  if (uniqueIndexes.length === 0) {
    throw new Error('Choose at least one valid page.')
  }

  return uniqueIndexes
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function resolveOverlayPosition(options: {
  pageWidth: number
  pageHeight: number
  textWidth: number
  textHeight: number
  position: WatermarkPosition
}) {
  const marginX = clampNumber(options.pageWidth * 0.06, 18, 42)
  const marginY = clampNumber(options.pageHeight * 0.05, 18, 42)

  switch (options.position) {
    case 'top-left':
      return {
        x: marginX,
        y: options.pageHeight - marginY - options.textHeight,
      }
    case 'top-right':
      return {
        x: options.pageWidth - marginX - options.textWidth,
        y: options.pageHeight - marginY - options.textHeight,
      }
    case 'bottom-left':
      return {
        x: marginX,
        y: marginY,
      }
    case 'bottom-right':
      return {
        x: options.pageWidth - marginX - options.textWidth,
        y: marginY,
      }
    case 'center':
    default:
      return {
        x: (options.pageWidth - options.textWidth) / 2,
        y: (options.pageHeight - options.textHeight) / 2,
      }
  }
}

function resolvePageNumberPosition(options: {
  pageWidth: number
  pageHeight: number
  textWidth: number
  textHeight: number
  position: PageNumberPosition
}) {
  const marginX = clampNumber(options.pageWidth * 0.045, 20, 36)
  const marginY = clampNumber(options.pageHeight * 0.03, 18, 30)
  const isHeader = options.position.startsWith('header')
  const y = isHeader ? options.pageHeight - marginY - options.textHeight : marginY

  if (options.position.endsWith('left')) {
    return { x: marginX, y }
  }

  if (options.position.endsWith('right')) {
    return { x: options.pageWidth - marginX - options.textWidth, y }
  }

  return {
    x: (options.pageWidth - options.textWidth) / 2,
    y,
  }
}

export async function mergeDocuments(buffers: Uint8Array[]) {
  const { PDFDocument } = await getPdfLib()
  const merged = await PDFDocument.create()

  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer.slice(), { updateMetadata: false })
    await appendCopiedPages(merged, source, source.getPageIndices())
  }

  return merged.save()
}

export async function insertDocumentAfterPage(
  bytes: Uint8Array,
  insertedBytes: Uint8Array,
  afterPageIndex: number,
) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const inserted = await loadDocument(insertedBytes)
  const result = await PDFDocument.create()
  const pageCount = source.getPageCount()
  const insertIndex = clampNumber(afterPageIndex, 0, pageCount - 1)

  await appendCopiedPages(
    result,
    source,
    Array.from({ length: insertIndex + 1 }, (_, index) => index),
  )
  await appendCopiedPages(result, inserted, inserted.getPageIndices())
  await appendCopiedPages(
    result,
    source,
    Array.from({ length: pageCount - insertIndex - 1 }, (_, index) => insertIndex + index + 1),
  )

  return result.save()
}

export async function rotatePageInDocument(bytes: Uint8Array, pageIndex: number, delta: number) {
  const { degrees } = await getPdfLib()
  const document = await loadDocument(bytes)
  const page = document.getPage(pageIndex)
  const nextRotation = (page.getRotation().angle + delta + 360) % 360
  page.setRotation(degrees(nextRotation))
  return saveDocument(document)
}

export async function movePageInDocument(bytes: Uint8Array, sourceIndex: number, targetIndex: number) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const reordered = await PDFDocument.create()
  const pageOrder = Array.from({ length: source.getPageCount() }, (_, index) => index)
  const [movedPage] = pageOrder.splice(sourceIndex, 1)
  pageOrder.splice(targetIndex, 0, movedPage)

  const pages = await reordered.copyPages(source, pageOrder)
  for (const page of pages) {
    reordered.addPage(page)
  }

  return reordered.save()
}

export async function extractPagesFromDocument(bytes: Uint8Array, pageIndexes: number[]) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const extracted = await PDFDocument.create()
  const pages = await extracted.copyPages(source, pageIndexes)

  for (const page of pages) {
    extracted.addPage(page)
  }

  return extracted.save()
}

export async function deletePageFromDocument(bytes: Uint8Array, pageIndex: number) {
  const document = await loadDocument(bytes)

  if (document.getPageCount() <= 1) {
    throw new Error('A PDF must keep at least one page.')
  }

  document.removePage(pageIndex)
  return saveDocument(document)
}

export async function duplicatePageInDocument(bytes: Uint8Array, pageIndex: number) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const duplicated = await PDFDocument.create()
  const order = Array.from({ length: source.getPageCount() }, (_, index) => index)
  order.splice(pageIndex + 1, 0, pageIndex)

  const pages = await duplicated.copyPages(source, order)
  for (const page of pages) {
    duplicated.addPage(page)
  }

  return duplicated.save()
}

export async function insertBlankPageAfterCurrent(bytes: Uint8Array, pageIndex: number) {
  const document = await loadDocument(bytes)
  const page = document.getPage(pageIndex)
  const { width, height } = page.getSize()
  document.insertPage(pageIndex + 1, [width, height])
  return saveDocument(document)
}

export async function splitDocumentIntoSinglePages(bytes: Uint8Array) {
  const document = await loadDocument(bytes)
  const segments: Uint8Array[] = []

  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    segments.push(await extractPagesFromDocument(bytes, [pageIndex]))
  }

  return segments
}

export async function readMetadataFromDocument(bytes: Uint8Array): Promise<PdfMetadataDraft> {
  const document = await loadDocument(bytes)
  const keywords = normalizeKeywordsForDraft(document.getKeywords())

  return {
    title: document.getTitle() ?? '',
    author: document.getAuthor() ?? '',
    subject: document.getSubject() ?? '',
    keywords,
    creator: document.getCreator() ?? '',
    producer: document.getProducer() ?? '',
  }
}

export async function applyMetadataToDocument(bytes: Uint8Array, metadata: PdfMetadataDraft) {
  const document = await loadDocument(bytes)
  const keywords = metadata.keywords
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  document.setTitle(metadata.title.trim())
  document.setAuthor(metadata.author.trim())
  document.setSubject(metadata.subject.trim())
  document.setKeywords(keywords)
  document.setCreator(metadata.creator.trim())
  document.setProducer(metadata.producer.trim())

  return saveDocument(document)
}

export async function addTextWatermarkToDocument(
  bytes: Uint8Array,
  options: {
    text: string
    pageIndexes: number[]
    position: WatermarkPosition
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(StandardFonts.HelveticaBold)
  const text = options.text.trim()

  if (!text) {
    throw new Error('Enter watermark text before applying it.')
  }

  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const size = clampNumber(Math.min(width, height) * 0.08, 26, 68)
    const textWidth = font.widthOfTextAtSize(text, size)
    const position = resolveOverlayPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth,
      textHeight: size,
      position: options.position,
    })

    page.drawText(text, {
      x: position.x,
      y: position.y,
      size,
      font,
      color: rgb(0.73, 0.77, 0.84),
    })
  }

  return saveDocument(document)
}

export async function addPageNumbersToDocument(
  bytes: Uint8Array,
  options: {
    startNumber: number
    pageIndexes: number[]
    position: PageNumberPosition
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(StandardFonts.Helvetica)
  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const startNumber = Math.max(1, Math.floor(options.startNumber))

  for (const [offset, pageIndex] of pageIndexes.entries()) {
    const label = String(startNumber + offset)
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const size = clampNumber(Math.min(width, height) * 0.022, 11, 16)
    const textWidth = font.widthOfTextAtSize(label, size)
    const position = resolvePageNumberPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth,
      textHeight: size,
      position: options.position,
    })

    page.drawText(label, {
      x: position.x,
      y: position.y,
      size,
      font,
      color: rgb(0.41, 0.45, 0.54),
    })
  }

  return saveDocument(document)
}

function normalizeKeywordsForDraft(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  if (normalized.includes(',')) {
    return normalized
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .join(', ')
}
