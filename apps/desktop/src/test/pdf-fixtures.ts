import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

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
