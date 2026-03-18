import { getPdfLib } from '../pdf-engine'
import type { PdfMetadataDraft } from '../types'

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await getPdfLib()
  return PDFDocument.load(bytes.slice(), { updateMetadata: false })
}

async function saveDocument(document: Awaited<ReturnType<typeof loadDocument>>) {
  return document.save()
}

export async function mergeDocuments(buffers: Uint8Array[]) {
  const { PDFDocument } = await getPdfLib()
  const merged = await PDFDocument.create()

  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer.slice(), { updateMetadata: false })
    const pages = await merged.copyPages(source, source.getPageIndices())
    for (const page of pages) {
      merged.addPage(page)
    }
  }

  return merged.save()
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
  const keywords = document.getKeywords()

  return {
    title: document.getTitle() ?? '',
    author: document.getAuthor() ?? '',
    subject: document.getSubject() ?? '',
    keywords: Array.isArray(keywords) ? keywords.join(', ') : '',
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

  if (metadata.title.trim()) document.setTitle(metadata.title.trim())
  if (metadata.author.trim()) document.setAuthor(metadata.author.trim())
  if (metadata.subject.trim()) document.setSubject(metadata.subject.trim())
  if (keywords.length > 0) document.setKeywords(keywords)
  if (metadata.creator.trim()) document.setCreator(metadata.creator.trim())
  if (metadata.producer.trim()) document.setProducer(metadata.producer.trim())

  return saveDocument(document)
}
