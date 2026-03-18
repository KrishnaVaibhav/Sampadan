import { describe, expect, test } from 'vitest'

import { createSamplePdf, readPdfSummary } from '../../test/pdf-fixtures'
import {
  addPageNumbersToDocument,
  addImageStampToDocument,
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
})
