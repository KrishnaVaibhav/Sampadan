import { describe, expect, test } from 'vitest'

import { createSamplePdf, readPdfSummary } from '../../test/pdf-fixtures'
import {
  applyMetadataToDocument,
  deletePageFromDocument,
  duplicatePageInDocument,
  extractPagesFromDocument,
  insertBlankPageAfterCurrent,
  mergeDocuments,
  movePageInDocument,
  readMetadataFromDocument,
  rotatePageInDocument,
  splitDocumentIntoSinglePages,
} from './pdf-document'

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
})
