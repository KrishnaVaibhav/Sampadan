import { describe, expect, test } from 'vitest'

import { createSamplePdf, readPdfSummary } from '../../test/pdf-fixtures'
import {
  addAttachmentToDocument,
  addFreeTextBlockToDocument,
  addPageNumbersToDocument,
  addImageStampToDocument,
  addReviewNoteToDocument,
  addTextWatermarkToDocument,
  applyMetadataToDocument,
  deletePageFromDocument,
  duplicatePageInDocument,
  extractPagesFromDocument,
  insertDocumentAfterPage,
  insertBlankPageAfterCurrent,
  mergeDocuments,
  movePageInDocument,
  readMetadataFromDocument,
  replaceRegionWithTextInDocument,
  rotatePageInDocument,
  splitDocumentIntoSinglePages,
} from './pdf-document'

const tinyPngBytes = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='),
  (character) => character.charCodeAt(0),
)

async function readPdfText(bytes: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await getDocument({ data: bytes.slice() }).promise
  const pages: string[] = []

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = (content.items as Array<{ str?: string }>)
        .map((item) => item.str ?? '')
        .join(' ')
        .trim()

      pages.push(text)
    }

    return pages.join('\n')
  } finally {
    await document.destroy()
  }
}

async function readAttachmentNames(bytes: Uint8Array) {
  const { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFString } = await import('pdf-lib')
  const document = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  const names = document.catalog.lookup(PDFName.of('Names'), PDFDict)
  const embeddedFiles = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  const nameEntries = embeddedFiles?.lookupMaybe(PDFName.of('Names'), PDFArray)

  if (!nameEntries) {
    return []
  }

  const attachmentNames: string[] = []
  for (let index = 0; index < nameEntries.size(); index += 2) {
    const value = nameEntries.lookupMaybe(index, PDFString, PDFHexString)
    if (!value) continue
    attachmentNames.push(value.decodeText())
  }

  return attachmentNames
}

describe('real PDF document operations', () => {
  test('merge, extract, split, duplicate, delete, insert, and move all preserve readable PDFs', async () => {
    const source = await createSamplePdf(3)
    const second = await createSamplePdf(2)

    const merged = await mergeDocuments([source, second])
    expect((await readPdfSummary(merged)).pageCount).toBe(5)

    const extracted = await extractPagesFromDocument(source, [0, 2])
    expect((await readPdfSummary(extracted)).pageCount).toBe(2)

    const split = await splitDocumentIntoSinglePages(source)
    expect(split).toHaveLength(3)
    for (const segment of split) {
      expect((await readPdfSummary(segment)).pageCount).toBe(1)
    }

    const duplicated = await duplicatePageInDocument(source, 1)
    expect((await readPdfSummary(duplicated)).pageCount).toBe(4)

    const deleted = await deletePageFromDocument(source, 1)
    expect((await readPdfSummary(deleted)).pageCount).toBe(2)

    const inserted = await insertBlankPageAfterCurrent(source, 0)
    expect((await readPdfSummary(inserted)).pageCount).toBe(4)

    const moved = await movePageInDocument(source, 0, 2)
    expect((await readPdfSummary(moved)).pageCount).toBe(3)
  })

  test('rotation and metadata editing work on real PDF bytes', async () => {
    const source = await createSamplePdf(2)

    const rotated = await rotatePageInDocument(source, 0, 90)
    expect((await readPdfSummary(rotated)).pageCount).toBe(2)

    const metadataBefore = await readMetadataFromDocument(source)
    expect(metadataBefore.title).toBe('Sampadan Fixture')

    const updated = await applyMetadataToDocument(source, {
      title: 'Viewer First Title',
      author: 'Krishna Vaibhav',
      subject: '',
      keywords: 'alpha, beta',
      creator: 'Sampadan Regression',
      producer: '',
    })
    const metadataAfter = await readMetadataFromDocument(updated)
    expect(metadataAfter.title).toBe('Viewer First Title')
    expect(metadataAfter.creator).toBe('Sampadan Regression')
    expect(metadataAfter.author).toBe('Krishna Vaibhav')
    expect(metadataAfter.keywords).toBe('alpha, beta')
  })

  test('insertion and overlay editing keep the PDF readable and add expected text', async () => {
    const source = await createSamplePdf(2)
    const insertedSource = await createSamplePdf(1)

    const inserted = await insertDocumentAfterPage(source, insertedSource, 0)
    expect((await readPdfSummary(inserted)).pageCount).toBe(3)

    const watermarked = await addTextWatermarkToDocument(inserted, {
      text: 'SAMPADAN-WM',
      pageIndexes: [0, 1, 2],
      position: 'center',
    })

    const numbered = await addPageNumbersToDocument(watermarked, {
      startNumber: 10,
      pageIndexes: [0, 1, 2],
      position: 'footer-center',
    })

    const text = await readPdfText(numbered)
    expect(text).toContain('SAMPADAN-WM')
    expect(text).toContain('10')
    expect(text).toContain('11')
    expect(text).toContain('12')
  })

  test('image stamping preserves page count and produces a readable PDF', async () => {
    const source = await createSamplePdf(2)

    const stamped = await addImageStampToDocument(source, tinyPngBytes, {
      pageIndexes: [0, 1],
      position: 'bottom-right',
    })

    expect((await readPdfSummary(stamped)).pageCount).toBe(2)
    expect(stamped.length).toBeGreaterThan(source.length)
  })

  test('attachment insertion preserves the PDF and registers an embedded file name', async () => {
    const source = await createSamplePdf(2)

    const attached = await addAttachmentToDocument(
      source,
      Uint8Array.from(new TextEncoder().encode('release checklist')),
      {
        name: 'report.txt',
        description: 'Release checklist',
      },
    )

    expect((await readPdfSummary(attached)).pageCount).toBe(2)
    expect(await readAttachmentNames(attached)).toContain('report.txt')
  })

  test('review notes preserve readability and embed the note text', async () => {
    const source = await createSamplePdf(2)

    const noted = await addReviewNoteToDocument(source, {
      title: 'Page Review',
      body: 'Follow up on alignment, export formatting, and attachment labeling.',
      pageIndexes: [1],
      position: 'top-right',
      tone: 'blue',
    })

    expect((await readPdfSummary(noted)).pageCount).toBe(2)
    const text = await readPdfText(noted)
    expect(text).toContain('Page Review')
    expect(text).toContain('Follow up on alignment')
  })

  test('positioned text blocks and whiteout replacement write readable edit content', async () => {
    const source = await createSamplePdf(2)

    const withTextBlock = await addFreeTextBlockToDocument(source, {
      text: 'Edited headline for page one',
      pageIndexes: [0],
      xPercent: 12,
      yPercent: 14,
      widthPercent: 46,
      heightPercent: 16,
      fontSize: 18,
      alignment: 'left',
      paperBacking: true,
    })

    const replaced = await replaceRegionWithTextInDocument(withTextBlock, {
      text: 'Replacement body copy',
      pageIndexes: [1],
      xPercent: 18,
      yPercent: 22,
      widthPercent: 42,
      heightPercent: 18,
      fontSize: 16,
      alignment: 'center',
    })

    expect((await readPdfSummary(replaced)).pageCount).toBe(2)
    const text = await readPdfText(replaced)
    expect(text).toContain('Edited headline for page one')
    expect(text).toContain('Replacement body copy')
  })
})
