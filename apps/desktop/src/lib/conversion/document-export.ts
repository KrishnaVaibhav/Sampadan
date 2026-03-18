import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'

import { withoutExtension } from '../pdf-utils'

function resolveDocumentTitle(fileName: string) {
  return withoutExtension(fileName) || 'Sampadan Export'
}

function normalizePageText(text: string) {
  const normalized = text.trim()
  return normalized || '[No text detected]'
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildMarkdownExport(fileName: string, pages: string[]) {
  const title = resolveDocumentTitle(fileName)
  const lines: string[] = [`# ${title}`, '']

  pages.forEach((pageText, index) => {
    lines.push(`## Page ${index + 1}`)
    lines.push('')
    lines.push(normalizePageText(pageText))
    lines.push('')
  })

  return new TextEncoder().encode(lines.join('\n').trimEnd())
}

export function buildHtmlExport(fileName: string, pages: string[]) {
  const title = resolveDocumentTitle(fileName)
  const sections = pages
    .map((pageText, index) => {
      const paragraphs = normalizePageText(pageText)
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
        .join('\n        ')

      return `      <section class="page-block">\n        <h2>Page ${index + 1}</h2>\n        ${paragraphs}\n      </section>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Georgia", "Times New Roman", serif;
      }

      body {
        margin: 0;
        background: #f6f3ed;
        color: #1f2430;
      }

      main {
        max-width: 900px;
        margin: 0 auto;
        padding: 48px 24px 64px;
      }

      h1 {
        margin: 0 0 24px;
        font-size: 2rem;
      }

      .page-block {
        background: #fffdf8;
        border: 1px solid #e2dbcf;
        border-radius: 18px;
        padding: 24px;
        margin-bottom: 20px;
        box-shadow: 0 10px 30px rgba(31, 36, 48, 0.08);
      }

      h2 {
        margin-top: 0;
        font-size: 1.1rem;
      }

      p {
        margin: 0 0 12px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
${sections}
    </main>
  </body>
</html>`

  return new TextEncoder().encode(html)
}

export async function buildDocxExport(fileName: string, pages: string[]) {
  const title = resolveDocumentTitle(fileName)
  const children: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 280 },
    }),
  ]

  pages.forEach((pageText, index) => {
    children.push(
      new Paragraph({
        text: `Page ${index + 1}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: index === 0 ? 120 : 280, after: 160 },
      }),
    )

    for (const paragraph of normalizePageText(pageText).split(/\n{2,}/)) {
      children.push(
        new Paragraph({
          children: [new TextRun(paragraph)],
          spacing: { after: 160 },
        }),
      )
    }
  })

  const document = new Document({
    sections: [
      {
        children,
      },
    ],
  })

  const blob = await Packer.toBlob(document)
  return new Uint8Array(await blob.arrayBuffer())
}
