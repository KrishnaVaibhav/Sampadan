import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'

import type { PdfDocumentTextLayoutPage, PdfPageTextSpan } from '../types'
import { withoutExtension } from '../pdf-utils'

type ExportLineRole = 'title' | 'heading' | 'body'

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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function buildReadableParagraphs(text: string) {
  return normalizePageText(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

function resolveLayoutBaselineFontSize(layoutPage: PdfDocumentTextLayoutPage | undefined) {
  if (!layoutPage || layoutPage.lines.length === 0) {
    return 12
  }

  const sorted = layoutPage.lines
    .map((line) => line.fontSize)
    .filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0)
    .sort((left, right) => left - right)

  if (sorted.length === 0) {
    return 12
  }

  return sorted[Math.floor(sorted.length / 2)]
}

function resolveLineRole(line: PdfPageTextSpan, baselineFontSize: number): ExportLineRole {
  const normalizedText = line.text.trim()
  const shortLine = normalizedText.length > 0 && normalizedText.length <= 96
  const uppercaseHeavy = normalizedText === normalizedText.toUpperCase() && normalizedText.length <= 72

  if (shortLine && line.fontSize >= baselineFontSize * 1.6) {
    return 'title'
  }

  if ((shortLine || uppercaseHeavy) && line.fontSize >= baselineFontSize * 1.22) {
    return 'heading'
  }

  return 'body'
}

function resolveLineFontSize(line: PdfPageTextSpan) {
  return clampNumber(line.fontSize * 0.92, 10, 42)
}

function resolveDocxTextSize(line: PdfPageTextSpan, role: ExportLineRole) {
  const baseSize = Math.round(clampNumber(line.fontSize * 1.5, 20, 46))

  if (role === 'title') {
    return Math.max(baseSize, 28)
  }

  if (role === 'heading') {
    return Math.max(baseSize, 24)
  }

  return Math.min(baseSize, 26)
}

function resolveDocxSpacingBefore(verticalGapPercent: number, role: ExportLineRole) {
  const scaledGap = Math.round(clampNumber(verticalGapPercent * 10, 0, role === 'body' ? 120 : 220))
  return role === 'body' ? scaledGap : Math.max(80, scaledGap)
}

function resolveDocxHeading(role: ExportLineRole) {
  if (role === 'title') {
    return HeadingLevel.HEADING_2
  }

  if (role === 'heading') {
    return HeadingLevel.HEADING_3
  }

  return undefined
}

function buildLayoutHtmlPage(pageText: string, layoutPage: PdfDocumentTextLayoutPage) {
  const baseline = resolveLayoutBaselineFontSize(layoutPage)
  const readableParagraphs = buildReadableParagraphs(pageText)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
    .join('\n          ')
  const lines = layoutPage.lines
    .map((line) => {
      const role = resolveLineRole(line, baseline)
      const classes = ['page-line', `page-line-${role}`].join(' ')

      return `          <div class="${classes}" style="left: ${line.xPercent.toFixed(2)}%; top: ${line.yPercent.toFixed(2)}%; width: ${Math.max(line.widthPercent, 2).toFixed(2)}%; font-size: ${resolveLineFontSize(line).toFixed(1)}px;">${escapeHtml(line.text)}</div>`
    })
    .join('\n')

  return `      <section class="page-block layout-block">
        <div class="page-meta">
          <h2>Page ${layoutPage.pageNumber}</h2>
          <span>${layoutPage.lines.length} text line${layoutPage.lines.length === 1 ? '' : 's'}</span>
        </div>
        <div class="page-sheet" style="aspect-ratio: ${Math.max(layoutPage.width, 1)} / ${Math.max(layoutPage.height, 1)};">
${lines}
        </div>
        <div class="sr-only">
          <h3>Readable text for page ${layoutPage.pageNumber}</h3>
          ${readableParagraphs}
        </div>
      </section>`
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

export function buildHtmlExport(
  fileName: string,
  pages: string[],
  layoutPages?: PdfDocumentTextLayoutPage[],
) {
  const title = resolveDocumentTitle(fileName)
  const sections = pages
    .map((pageText, index) => {
      const layoutPage = layoutPages?.[index]

      if (layoutPage && layoutPage.lines.length > 0) {
        return buildLayoutHtmlPage(pageText, layoutPage)
      }

      const paragraphs = buildReadableParagraphs(pageText)
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

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: #f6f3ed;
        color: #1f2430;
      }

      main {
        max-width: 980px;
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

      .layout-block {
        padding: 18px;
      }

      .page-meta {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
        color: #545d6d;
        font-size: 0.94rem;
      }

      h2 {
        margin: 0;
        font-size: 1.05rem;
      }

      .page-sheet {
        position: relative;
        width: 100%;
        overflow: hidden;
        border: 1px solid #ded5c7;
        border-radius: 14px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 246, 238, 0.98)),
          repeating-linear-gradient(
            180deg,
            rgba(226, 219, 207, 0.28),
            rgba(226, 219, 207, 0.28) 1px,
            transparent 1px,
            transparent 40px
          );
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
      }

      .page-line {
        position: absolute;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        line-height: 1.14;
        color: #1f2430;
      }

      .page-line-title {
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .page-line-heading {
        font-weight: 600;
        color: #25304a;
      }

      p {
        margin: 0 0 12px;
        line-height: 1.6;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
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

export async function buildDocxExport(
  fileName: string,
  pages: string[],
  layoutPages?: PdfDocumentTextLayoutPage[],
) {
  const title = resolveDocumentTitle(fileName)
  const children: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 280 },
    }),
  ]

  pages.forEach((pageText, index) => {
    const layoutPage = layoutPages?.[index]

    children.push(
      new Paragraph({
        text: `Page ${index + 1}`,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: index > 0,
        spacing: { before: index === 0 ? 120 : 180, after: 160 },
      }),
    )

    if (layoutPage && layoutPage.lines.length > 0) {
      const baseline = resolveLayoutBaselineFontSize(layoutPage)
      let previousBottomPercent = 0

      for (const line of layoutPage.lines) {
        const role = resolveLineRole(line, baseline)
        const heading = resolveDocxHeading(role)
        const verticalGapPercent = Math.max(0, line.yPercent - previousBottomPercent)
        previousBottomPercent = line.yPercent + line.heightPercent

        children.push(
          new Paragraph({
            heading,
            spacing: {
              before: resolveDocxSpacingBefore(verticalGapPercent, role),
              after: role === 'body' ? 45 : 110,
            },
            children: [
              new TextRun({
                text: line.text,
                bold: role !== 'body',
                size: resolveDocxTextSize(line, role),
              }),
            ],
          }),
        )
      }

      return
    }

    for (const paragraph of buildReadableParagraphs(pageText)) {
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
