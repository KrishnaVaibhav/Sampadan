import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export interface PdfAnnotationFixtureSummary {
  id: string
  subtype: string
  contents: string
  title: string | null
}

export async function createSamplePdf(pageCount = 3) {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)

  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([595, 842])
    page.drawText(`Sampadan Sample Page ${index + 1}`, {
      x: 56,
      y: 780,
      size: 28,
      font,
      color: rgb(0.12, 0.16, 0.22),
    })
    page.drawText(`Body content for page ${index + 1}`, {
      x: 56,
      y: 736,
      size: 14,
      font,
      color: rgb(0.26, 0.31, 0.38),
    })
  }

  document.setTitle('Sampadan Fixture')
  document.setAuthor('Krishna Vaibhav')
  document.setSubject('PDF workflow regression fixture')
  document.setKeywords(['sampadan', 'fixture', 'pdf'])
  document.setCreator('Sampadan Tests')
  document.setProducer('Sampadan Tests')

  return new Uint8Array(await document.save())
}

export async function createSampleAcroFormPdf() {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([595, 842])
  const form = document.getForm()

  page.drawText('Sampadan Form Fixture', {
    x: 56,
    y: 788,
    size: 24,
    font,
    color: rgb(0.12, 0.16, 0.22),
  })

  page.drawText('Full Name', {
    x: 56,
    y: 748,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const fullName = form.createTextField('applicant.fullName')
  fullName.setText('Krishna Vaibhav')
  fullName.addToPage(page, {
    x: 56,
    y: 716,
    width: 220,
    height: 24,
    font,
    borderColor: rgb(0.64, 0.69, 0.78),
  })

  page.drawText('Approved', {
    x: 82,
    y: 678,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const accepted = form.createCheckBox('approval.accepted')
  accepted.check()
  accepted.addToPage(page, {
    x: 56,
    y: 672,
    width: 18,
    height: 18,
    borderColor: rgb(0.64, 0.69, 0.78),
  })

  page.drawText('Department', {
    x: 56,
    y: 636,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const department = form.createDropdown('contact.department')
  department.setOptions(['Engineering', 'Product', 'Legal'])
  department.select('Engineering')
  department.addToPage(page, {
    x: 56,
    y: 604,
    width: 170,
    height: 24,
    font,
    borderColor: rgb(0.64, 0.69, 0.78),
  })

  page.drawText('Languages', {
    x: 56,
    y: 560,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const languages = form.createOptionList('contact.languages')
  languages.setOptions(['English', 'Hindi', 'French'])
  languages.enableMultiselect()
  languages.select(['English', 'Hindi'])
  languages.addToPage(page, {
    x: 56,
    y: 484,
    width: 180,
    height: 64,
    font,
    borderColor: rgb(0.64, 0.69, 0.78),
  })

  page.drawText('Status', {
    x: 320,
    y: 748,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const status = form.createRadioGroup('decision.status')
  status.addOptionToPage('approved', page, {
    x: 320,
    y: 714,
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: rgb(0.64, 0.69, 0.78),
  })
  page.drawText('Approved', {
    x: 344,
    y: 716,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  status.addOptionToPage('rejected', page, {
    x: 320,
    y: 684,
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: rgb(0.64, 0.69, 0.78),
  })
  page.drawText('Rejected', {
    x: 344,
    y: 686,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  status.select('approved')

  page.drawText('Locked Note', {
    x: 320,
    y: 636,
    size: 11,
    font,
    color: rgb(0.26, 0.31, 0.38),
  })
  const lockedNote = form.createTextField('review.lockedNote')
  lockedNote.setText('Internal use only')
  lockedNote.enableReadOnly()
  lockedNote.addToPage(page, {
    x: 320,
    y: 604,
    width: 180,
    height: 24,
    font,
    borderColor: rgb(0.64, 0.69, 0.78),
  })

  document.setTitle('Sampadan Form Fixture')
  document.setAuthor('Krishna Vaibhav')
  document.setSubject('Fillable PDF regression fixture')
  document.setKeywords(['sampadan', 'fixture', 'forms'])
  document.setCreator('Sampadan Tests')
  document.setProducer('Sampadan Tests')

  return new Uint8Array(await document.save())
}

export async function readPdfFormValues(bytes: Uint8Array) {
  const pdfLib = await import('pdf-lib')
  const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = pdfLib
  const document = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  const form = document.getForm()
  const values: Record<string, string | boolean | string[]> = {}

  for (const field of form.getFields()) {
    if (field instanceof PDFTextField) {
      values[field.getName()] = field.getText() ?? ''
      continue
    }

    if (field instanceof PDFCheckBox) {
      values[field.getName()] = field.isChecked()
      continue
    }

    if (field instanceof PDFRadioGroup) {
      values[field.getName()] = field.getSelected() ?? ''
      continue
    }

    if (field instanceof PDFDropdown) {
      values[field.getName()] = field.isMultiselect() ? field.getSelected() : field.getSelected()[0] ?? ''
      continue
    }

    if (field instanceof PDFOptionList) {
      values[field.getName()] = field.isMultiselect() ? field.getSelected() : field.getSelected()[0] ?? ''
    }
  }

  return values
}

export async function readPdfSummary(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  return {
    pageCount: document.getPageCount(),
    title: document.getTitle() ?? '',
    author: document.getAuthor() ?? '',
    subject: document.getSubject() ?? '',
    keywords: document.getKeywords() ?? [],
    creator: document.getCreator() ?? '',
    producer: document.getProducer() ?? '',
  }
}

export async function readPdfPageAnnotations(bytes: Uint8Array, pageNumber: number) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await getDocument({ data: bytes.slice() }).promise

  try {
    const page = await document.getPage(pageNumber)
    const annotations = await page.getAnnotations()

    return (annotations as Array<{ subtype?: string; contentsObj?: { str?: string }; titleObj?: { str?: string } }>).map(
      (annotation) =>
        ({
          id: String((annotation as { id?: unknown }).id ?? ''),
          subtype: annotation.subtype ?? 'Unknown',
          contents: annotation.contentsObj?.str ?? '',
          title: annotation.titleObj?.str ?? null,
        }) satisfies PdfAnnotationFixtureSummary,
    )
  } finally {
    await document.destroy()
  }
}
