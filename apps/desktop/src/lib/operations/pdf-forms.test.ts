import { describe, expect, test } from 'vitest'

import { createSampleAcroFormPdf, readPdfFormValues, readPdfSummary } from '../../test/pdf-fixtures'
import {
  applyFormFieldValuesToDocument,
  flattenFormFieldsInDocument,
  readFormFieldsFromDocument,
} from './pdf-forms'

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

describe('real PDF AcroForm operations', () => {
  test('reads standard AcroForm fields from real PDF bytes', async () => {
    const source = await createSampleAcroFormPdf()
    const fields = await readFormFieldsFromDocument(source)

    expect(fields).toHaveLength(6)
    expect(fields.map((field) => field.kind)).toEqual([
      'text',
      'checkbox',
      'dropdown',
      'option-list',
      'radio',
      'text',
    ])

    expect(fields.find((field) => field.name === 'applicant.fullName')?.value).toBe('Krishna Vaibhav')
    expect(fields.find((field) => field.name === 'approval.accepted')?.value).toBe(true)
    expect(fields.find((field) => field.name === 'contact.department')?.value).toBe('Engineering')
    expect(fields.find((field) => field.name === 'contact.languages')?.value).toEqual(['English', 'Hindi'])
    expect(fields.find((field) => field.name === 'decision.status')?.value).toBe('approved')

    const lockedNote = fields.find((field) => field.name === 'review.lockedNote')
    expect(lockedNote?.readOnly).toBe(true)
    expect(lockedNote?.editable).toBe(false)
  })

  test('applies AcroForm values and preserves a readable PDF', async () => {
    const source = await createSampleAcroFormPdf()

    const updated = await applyFormFieldValuesToDocument(source, [
      { name: 'applicant.fullName', kind: 'text', value: 'Ada Lovelace' },
      { name: 'approval.accepted', kind: 'checkbox', value: false },
      { name: 'contact.department', kind: 'dropdown', value: 'Legal' },
      { name: 'contact.languages', kind: 'option-list', value: ['French'] },
      { name: 'decision.status', kind: 'radio', value: 'rejected' },
      { name: 'review.lockedNote', kind: 'text', value: 'Should remain locked' },
    ])

    expect((await readPdfSummary(updated)).pageCount).toBe(1)

    const values = await readPdfFormValues(updated)
    expect(values['applicant.fullName']).toBe('Ada Lovelace')
    expect(values['approval.accepted']).toBe(false)
    expect(values['contact.department']).toBe('Legal')
    expect(values['contact.languages']).toEqual(['French'])
    expect(values['decision.status']).toBe('rejected')
    expect(values['review.lockedNote']).toBe('Internal use only')
  })

  test('flattens filled form fields into page content', async () => {
    const source = await createSampleAcroFormPdf()

    const filled = await applyFormFieldValuesToDocument(
      source,
      [
        { name: 'applicant.fullName', kind: 'text', value: 'Grace Hopper' },
        { name: 'contact.department', kind: 'dropdown', value: 'Product' },
      ],
      { flatten: true },
    )

    expect(await readFormFieldsFromDocument(filled)).toHaveLength(0)

    const flattenedText = await readPdfText(filled)
    expect(flattenedText).toContain('Grace Hopper')
    expect(flattenedText).toContain('Product')
  })

  test('flattens an existing AcroForm document without separate fill updates', async () => {
    const source = await createSampleAcroFormPdf()
    const flattened = await flattenFormFieldsInDocument(source)

    expect(await readFormFieldsFromDocument(flattened)).toHaveLength(0)
    expect((await readPdfSummary(flattened)).pageCount).toBe(1)
  })
})
