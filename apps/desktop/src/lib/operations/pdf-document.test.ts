import { describe, expect, test } from 'vitest'

import { createSamplePdf, readPdfSummary } from '../../test/pdf-fixtures'
import { loadPdfProxy } from '../pdf-engine'
import { extractPageTextSpans } from '../viewer/pdf-viewer'
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
  replaceTargetedTextInDocument,
  replaceRegionWithTextInDocument,
  rotatePageInDocument,
  splitDocumentIntoSinglePages,
} from './pdf-document'

const tinyPngBytes = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='),
  (character) => character.charCodeAt(0),
)

function textToPdfHex(text: string) {
  return Array.from(text)
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())
    .join('')
}

function decodePdfContentBytes(bytes: Uint8Array) {
  let value = ''

  for (const byte of bytes) {
    value += String.fromCharCode(byte)
  }

  return value
}

async function createAdjustedTextArrayPdf() {
  const { PDFDocument, PDFName, PDFRef, PDFStream, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const source = await createSamplePdf(1)
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false })
  const page = document.getPage(0)
  const context = page.node.context
  const contents = page.node.normalizedEntries().Contents
  const bodyHex = textToPdfHex('Body content for page 1')
  const bodyPrefixHex = textToPdfHex('Body content')
  const bodySuffixHex = textToPdfHex(' for page 1')
  let rewritten = false

  if (!contents) {
    throw new Error('Expected page contents for adjusted-text PDF fixture.')
  }

  for (let index = 0; index < contents.size(); index += 1) {
    const token = contents.get(index)
    const stream = contents.lookupMaybe(index, PDFStream)
    if (!stream) {
      continue
    }

    let contentBytes: Uint8Array
    if (stream instanceof PDFRawStream) {
      contentBytes = decodePDFRawStream(stream).decode()
    } else {
      const unencoded = (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents
      contentBytes = typeof unencoded === 'function' ? unencoded.call(stream) : stream.getContents()
    }

    const decoded = decodePdfContentBytes(contentBytes)
    if (!decoded.includes(`<${bodyHex}> Tj`)) {
      continue
    }

    const replacement = decoded.replace(
      `<${bodyHex}> Tj`,
      `[<${bodyPrefixHex}> -120 <${bodySuffixHex}>] TJ`,
    )
    const replacementStream = context.flateStream(replacement)
    const filterName = PDFName.of('Filter')
    const decodeParmsName = PDFName.of('DecodeParms')

    for (const [key, value] of stream.dict.entries()) {
      if (key === PDFName.Length || key === filterName || key === decodeParmsName) {
        continue
      }

      replacementStream.dict.set(key, value)
    }

    if (token instanceof PDFRef) {
      context.assign(token, replacementStream)
    } else {
      contents.set(index, replacementStream)
    }

    rewritten = true
    break
  }

  if (!rewritten) {
    throw new Error('Failed to create a TJ adjusted-text fixture.')
  }

  return new Uint8Array(await document.save())
}

async function createSplitTextRunPdf() {
  const { PDFDocument, PDFName, PDFRef, PDFStream, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const source = await createSamplePdf(1)
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false })
  const page = document.getPage(0)
  const context = page.node.context
  const contents = page.node.normalizedEntries().Contents
  const bodyHex = textToPdfHex('Body content for page 1')
  const bodyPrefixHex = textToPdfHex('Body content ')
  const bodySuffixHex = textToPdfHex('for page 1')
  let rewritten = false

  if (!contents) {
    throw new Error('Expected page contents for split-text PDF fixture.')
  }

  for (let index = 0; index < contents.size(); index += 1) {
    const token = contents.get(index)
    const stream = contents.lookupMaybe(index, PDFStream)
    if (!stream) {
      continue
    }

    let contentBytes: Uint8Array
    if (stream instanceof PDFRawStream) {
      contentBytes = decodePDFRawStream(stream).decode()
    } else {
      const unencoded = (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents
      contentBytes = typeof unencoded === 'function' ? unencoded.call(stream) : stream.getContents()
    }

    const decoded = decodePdfContentBytes(contentBytes)
    if (!decoded.includes(`<${bodyHex}> Tj`)) {
      continue
    }

    const replacement = decoded.replace(
      `<${bodyHex}> Tj`,
      `<${bodyPrefixHex}> Tj\n<${bodySuffixHex}> Tj`,
    )
    const replacementStream = context.flateStream(replacement)
    const filterName = PDFName.of('Filter')
    const decodeParmsName = PDFName.of('DecodeParms')

    for (const [key, value] of stream.dict.entries()) {
      if (key === PDFName.Length || key === filterName || key === decodeParmsName) {
        continue
      }

      replacementStream.dict.set(key, value)
    }

    if (token instanceof PDFRef) {
      context.assign(token, replacementStream)
    } else {
      contents.set(index, replacementStream)
    }

    rewritten = true
    break
  }

  if (!rewritten) {
    throw new Error('Failed to create a split text-run fixture.')
  }

  return new Uint8Array(await document.save())
}

async function createTrailingTextRunPdf() {
  const { PDFDocument, PDFName, PDFRef, PDFStream, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const source = await createSamplePdf(1)
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false })
  const page = document.getPage(0)
  const context = page.node.context
  const contents = page.node.normalizedEntries().Contents
  const bodyHex = textToPdfHex('Body content for page 1')
  const tailHex = textToPdfHex(' tail marker')
  let rewritten = false

  if (!contents) {
    throw new Error('Expected page contents for trailing text-run PDF fixture.')
  }

  for (let index = 0; index < contents.size(); index += 1) {
    const token = contents.get(index)
    const stream = contents.lookupMaybe(index, PDFStream)
    if (!stream) {
      continue
    }

    let contentBytes: Uint8Array
    if (stream instanceof PDFRawStream) {
      contentBytes = decodePDFRawStream(stream).decode()
    } else {
      const unencoded = (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents
      contentBytes = typeof unencoded === 'function' ? unencoded.call(stream) : stream.getContents()
    }

    const decoded = decodePdfContentBytes(contentBytes)
    if (!decoded.includes(`<${bodyHex}> Tj`)) {
      continue
    }

    const replacement = decoded.replace(`<${bodyHex}> Tj`, `<${bodyHex}> Tj\n<${tailHex}> Tj`)
    const replacementStream = context.flateStream(replacement)
    const filterName = PDFName.of('Filter')
    const decodeParmsName = PDFName.of('DecodeParms')

    for (const [key, value] of stream.dict.entries()) {
      if (key === PDFName.Length || key === filterName || key === decodeParmsName) {
        continue
      }

      replacementStream.dict.set(key, value)
    }

    if (token instanceof PDFRef) {
      context.assign(token, replacementStream)
    } else {
      contents.set(index, replacementStream)
    }

    rewritten = true
    break
  }

  if (!rewritten) {
    throw new Error('Failed to create a trailing text-run fixture.')
  }

  return new Uint8Array(await document.save())
}

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

  test('targeted born-digital text replacement rewrites the original extracted text when the line is width-safe', async () => {
    const source = await createSamplePdf(2)

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: 'Edited body copy',
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 36,
      heightPercent: 4,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('content-stream')
    const text = await readPdfText(replaced.bytes)
    expect(text).toContain('Edited body copy')
    expect(text).not.toContain('Body content for page 1')
  })

  test('targeted born-digital text replacement rewrites TJ adjusted-text arrays when the line is width-safe', async () => {
    const source = await createAdjustedTextArrayPdf()

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: 'Adjusted body copy',
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 36,
      heightPercent: 4,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('content-stream')
    const text = await readPdfText(replaced.bytes)
    expect(text).toContain('Adjusted body copy')
    expect(text).not.toContain('Body content for page 1')
  })

  test('targeted born-digital text replacement rewrites split Tj text runs when the line is width-safe', async () => {
    const source = await createSplitTextRunPdf()

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: 'Split run body copy',
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 36,
      heightPercent: 4,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('content-stream')
    const text = await readPdfText(replaced.bytes)
    expect(text).toContain('Split run body copy')
    expect(text).not.toContain('Body content for page 1')
  })

  test('targeted born-digital text replacement preserves the following text position when widths differ', async () => {
    const source = await createTrailingTextRunPdf()

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: 'Edit',
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 36,
      heightPercent: 4,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('content-stream')
    const { PDFDocument, PDFName, PDFStream, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
    const document = await PDFDocument.load(replaced.bytes.slice(), { updateMetadata: false })
    const contents = document.getPage(0).node.normalizedEntries().Contents
    const editHex = textToPdfHex('Edit')
    const tailHex = textToPdfHex(' tail marker')
    let rewrittenContent = ''

    if (!contents) {
      throw new Error('Expected page contents for rewritten trailing text-run fixture.')
    }

    for (let index = 0; index < contents.size(); index += 1) {
      const stream = contents.lookupMaybe(index, PDFStream)
      if (!stream) {
        continue
      }

      const contentBytes =
        stream instanceof PDFRawStream
          ? decodePDFRawStream(stream).decode()
          : (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents?.() ?? stream.getContents()
      const decoded = decodePdfContentBytes(contentBytes)
      if (decoded.includes(`<${tailHex}> Tj`)) {
        rewrittenContent = decoded
        break
      }
    }

    expect(rewrittenContent).toMatch(new RegExp(`\\[<${editHex}>\\s+-?\\d+(?:\\.\\d+)?\\]\\s+TJ\\s*<${tailHex}>\\s+Tj`))
  })

  test('targeted text replacement falls back to overlay editing when the new text exceeds the original line box', async () => {
    const source = await createSamplePdf(1)
    const longReplacement =
      'This replacement sentence is intentionally much longer than the original line and should trigger the safe visual fallback path.'

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: longReplacement,
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 18,
      heightPercent: 5,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('overlay')
    expect((await readPdfSummary(replaced.bytes)).pageCount).toBe(1)
    expect(replaced.bytes.length).toBeGreaterThan(source.length)
    const text = await readPdfText(replaced.bytes)
    expect(text).toContain('Body content for page 1')
  })

  test('targeted overlay fallback keeps replacement text close to the original line position', async () => {
    const source = await createSamplePdf(1)

    const replaced = await replaceTargetedTextInDocument(source, {
      targetText: 'Body content for page 1',
      replacementText: 'Edited body copy for page one',
      pageIndex: 0,
      targetOccurrence: 0,
      xPercent: 8,
      yPercent: 10,
      widthPercent: 18,
      heightPercent: 5,
      fontSize: 14,
      alignment: 'left',
    })

    expect(replaced.strategy).toBe('overlay')

    const proxy = await loadPdfProxy(replaced.bytes)
    try {
      const spans = await extractPageTextSpans(proxy, 1, 1)
      const replacementSpans = spans
        .filter((span) => ['Edited', 'body', 'copy', 'for', 'page', 'one'].includes(span.text))
        .sort((left, right) => left.xPercent - right.xPercent)

      expect(replacementSpans.length).toBeGreaterThanOrEqual(3)

      const left = Math.min(...replacementSpans.map((span) => span.xPercent))
      const top = Math.min(...replacementSpans.map((span) => span.yPercent))
      const firstLineSpans = replacementSpans.filter((span) => Math.abs(span.yPercent - top) <= 1.5)
      expect(firstLineSpans.length).toBeGreaterThanOrEqual(2)
      const firstLineGap = firstLineSpans[1].xPercent - (firstLineSpans[0].xPercent + firstLineSpans[0].widthPercent)

      expect(left).toBeGreaterThanOrEqual(7.5)
      expect(left).toBeLessThan(10)
      expect(top).toBeGreaterThanOrEqual(9)
      expect(top).toBeLessThan(12.5)
      expect(firstLineGap).toBeLessThan(2.6)
    } finally {
      await proxy.destroy()
    }
  })
})
