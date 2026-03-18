import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'

import type { PdfDocumentTextLayoutPage, PdfPageTextSpan } from '../types'
import { withoutExtension } from '../pdf-utils'

type ExportLineRole = 'title' | 'heading' | 'body'

export type StructuredDocumentBlockKind = 'title' | 'heading' | 'paragraph'

export interface StructuredDocumentLine {
  text: string
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
  fontSize: number
}

export interface StructuredDocumentBlock {
  kind: StructuredDocumentBlockKind
  text: string
  lineCount: number
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
  fontSize: number
  lines: StructuredDocumentLine[]
}

export interface StructuredDocumentPage {
  pageNumber: number
  width: number
  height: number
  columnCount: number
  rawText: string
  blocks: StructuredDocumentBlock[]
}

export interface StructuredDocumentExport {
  formatVersion: 1
  generatedBy: 'Sampadan'
  title: string
  sourceFileName: string
  pageCount: number
  pages: StructuredDocumentPage[]
}

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

  const middleIndex = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
  }

  return sorted[middleIndex]
}

function resolveLineRole(line: PdfPageTextSpan, baselineFontSize: number, pageLineCount: number): ExportLineRole {
  const normalizedText = line.text.trim()
  const shortLine = normalizedText.length > 0 && normalizedText.length <= 96
  const uppercaseHeavy = normalizedText === normalizedText.toUpperCase() && normalizedText.length <= 72

  if (pageLineCount === 1 && shortLine && line.fontSize >= 18) {
    return 'title'
  }

  if (shortLine && line.fontSize >= Math.max(baselineFontSize * 1.6, baselineFontSize + 5)) {
    return 'title'
  }

  if ((shortLine || uppercaseHeavy) && line.fontSize >= Math.max(baselineFontSize * 1.12, baselineFontSize + 2)) {
    return 'heading'
  }

  return 'body'
}

function resolveLineFontSize(line: StructuredDocumentLine | PdfPageTextSpan) {
  return clampNumber(line.fontSize * 0.92, 10, 42)
}

function resolveDocxTextSize(fontSize: number, kind: StructuredDocumentBlockKind) {
  const baseSize = Math.round(clampNumber(fontSize * 1.5, 20, 46))

  if (kind === 'title') {
    return Math.max(baseSize, 28)
  }

  if (kind === 'heading') {
    return Math.max(baseSize, 24)
  }

  return Math.min(baseSize, 26)
}

function resolveDocxSpacingBefore(verticalGapPercent: number, kind: StructuredDocumentBlockKind) {
  const scaledGap = Math.round(clampNumber(verticalGapPercent * 10, 0, kind === 'paragraph' ? 120 : 220))
  return kind === 'paragraph' ? scaledGap : Math.max(80, scaledGap)
}

function resolveDocxHeading(kind: StructuredDocumentBlockKind) {
  if (kind === 'title') {
    return HeadingLevel.HEADING_2
  }

  if (kind === 'heading') {
    return HeadingLevel.HEADING_3
  }

  return undefined
}

function mapLineRoleToBlockKind(role: ExportLineRole): StructuredDocumentBlockKind {
  if (role === 'title') {
    return 'title'
  }

  if (role === 'heading') {
    return 'heading'
  }

  return 'paragraph'
}

function mergeBlockText(currentText: string, nextText: string) {
  if (!currentText) {
    return nextText
  }

  if (currentText.endsWith('-')) {
    return `${currentText.slice(0, -1)}${nextText.trimStart()}`
  }

  return `${currentText} ${nextText}`.replace(/\s+/g, ' ').trim()
}

function clusterColumns(lines: PdfPageTextSpan[]) {
  const clusters: Array<{ startXPercent: number; lines: PdfPageTextSpan[] }> = []
  const sortedByX = [...lines].sort((left, right) => left.xPercent - right.xPercent)

  for (const line of sortedByX) {
    const lastCluster = clusters.at(-1)
    if (!lastCluster || Math.abs(line.xPercent - lastCluster.startXPercent) > 12) {
      clusters.push({
        startXPercent: line.xPercent,
        lines: [line],
      })
      continue
    }

    lastCluster.lines.push(line)
    lastCluster.startXPercent =
      lastCluster.lines.reduce((sum, entry) => sum + entry.xPercent, 0) / lastCluster.lines.length
  }

  return clusters
}

function orderLinesForReading(lines: PdfPageTextSpan[]) {
  if (lines.length <= 1) {
    return [...lines]
  }

  const clusters = clusterColumns(lines)
  const usableColumns = clusters.filter((cluster) => cluster.lines.length >= 2)

  if (usableColumns.length <= 1) {
    return [...lines].sort((left, right) => {
      if (Math.abs(left.yPercent - right.yPercent) > 2.2) {
        return left.yPercent - right.yPercent
      }

      return left.xPercent - right.xPercent
    })
  }

  const columnAssignments = new Map<string, number>()
  usableColumns
    .sort((left, right) => left.startXPercent - right.startXPercent)
    .forEach((cluster, index) => {
      for (const line of cluster.lines) {
        columnAssignments.set(line.id, index)
      }
    })

  return [...lines].sort((left, right) => {
    const leftWide = left.widthPercent >= 55
    const rightWide = right.widthPercent >= 55
    if (leftWide !== rightWide) {
      if (Math.abs(left.yPercent - right.yPercent) > 2.2) {
        return left.yPercent - right.yPercent
      }

      return leftWide ? -1 : 1
    }

    const leftColumn = columnAssignments.get(left.id) ?? 0
    const rightColumn = columnAssignments.get(right.id) ?? 0
    if (leftColumn !== rightColumn) {
      return leftColumn - rightColumn
    }

    if (Math.abs(left.yPercent - right.yPercent) > 2.2) {
      return left.yPercent - right.yPercent
    }

    return left.xPercent - right.xPercent
  })
}

function shouldAppendLineToBlock(
  block: StructuredDocumentBlock,
  line: PdfPageTextSpan,
  nextKind: StructuredDocumentBlockKind,
) {
  if (block.kind !== nextKind) {
    return false
  }

  const previousLine = block.lines.at(-1)
  if (!previousLine) {
    return false
  }

  const verticalGapPercent = line.yPercent - (previousLine.yPercent + previousLine.heightPercent)
  const horizontalShift = Math.abs(line.xPercent - previousLine.xPercent)

  if (block.kind === 'paragraph') {
    return verticalGapPercent <= Math.max(previousLine.heightPercent * 1.6, 4.8) && horizontalShift <= 8
  }

  return verticalGapPercent <= Math.max(previousLine.heightPercent * 1.2, 3.4) && horizontalShift <= 10
}

function buildStructuredBlocks(layoutPage: PdfDocumentTextLayoutPage): StructuredDocumentBlock[] {
  const baseline = resolveLayoutBaselineFontSize(layoutPage)
  const orderedLines = orderLinesForReading(layoutPage.lines)
  const blocks: StructuredDocumentBlock[] = []

  for (const line of orderedLines) {
    const kind = mapLineRoleToBlockKind(resolveLineRole(line, baseline, layoutPage.lines.length))
    const currentBlock = blocks.at(-1)
    const structuredLine: StructuredDocumentLine = {
      text: line.text,
      xPercent: line.xPercent,
      yPercent: line.yPercent,
      widthPercent: line.widthPercent,
      heightPercent: line.heightPercent,
      fontSize: line.fontSize,
    }

    if (currentBlock && shouldAppendLineToBlock(currentBlock, line, kind)) {
      currentBlock.lines.push(structuredLine)
      currentBlock.lineCount = currentBlock.lines.length
      currentBlock.text = mergeBlockText(currentBlock.text, line.text)
      currentBlock.xPercent = Math.min(currentBlock.xPercent, line.xPercent)
      currentBlock.yPercent = Math.min(currentBlock.yPercent, line.yPercent)
      currentBlock.widthPercent = Math.max(currentBlock.widthPercent, line.xPercent + line.widthPercent - currentBlock.xPercent)
      currentBlock.heightPercent = Math.max(
        currentBlock.heightPercent,
        line.yPercent + line.heightPercent - currentBlock.yPercent,
      )
      currentBlock.fontSize = Math.max(currentBlock.fontSize, line.fontSize)
      continue
    }

    blocks.push({
      kind,
      text: line.text,
      lineCount: 1,
      xPercent: line.xPercent,
      yPercent: line.yPercent,
      widthPercent: line.widthPercent,
      heightPercent: line.heightPercent,
      fontSize: line.fontSize,
      lines: [structuredLine],
    })
  }

  return blocks
}

export function buildStructuredDocument(
  fileName: string,
  pages: string[],
  layoutPages?: PdfDocumentTextLayoutPage[],
): StructuredDocumentExport {
  const title = resolveDocumentTitle(fileName)
  const structuredPages = pages.map((pageText, index) => {
    const layoutPage = layoutPages?.[index]
    const blocks =
      layoutPage && layoutPage.lines.length > 0
        ? buildStructuredBlocks(layoutPage)
        : buildReadableParagraphs(pageText).map((paragraph, paragraphIndex) => ({
            kind: 'paragraph' as const,
            text: paragraph,
            lineCount: 1,
            xPercent: 0,
            yPercent: paragraphIndex * 8,
            widthPercent: 100,
            heightPercent: 5,
            fontSize: 12,
            lines: [
              {
                text: paragraph,
                xPercent: 0,
                yPercent: paragraphIndex * 8,
                widthPercent: 100,
                heightPercent: 5,
                fontSize: 12,
              },
            ],
          }))

    return {
      pageNumber: index + 1,
      width: layoutPage?.width ?? 0,
      height: layoutPage?.height ?? 0,
      columnCount: layoutPage ? Math.max(1, clusterColumns(layoutPage.lines).length) : 1,
      rawText: normalizePageText(pageText),
      blocks,
    } satisfies StructuredDocumentPage
  })

  return {
    formatVersion: 1,
    generatedBy: 'Sampadan',
    title,
    sourceFileName: fileName,
    pageCount: pages.length,
    pages: structuredPages,
  }
}

function buildLayoutHtmlPage(page: StructuredDocumentPage) {
  const blocks = page.blocks
    .map((block) => {
      const classes = ['page-block-node', `page-block-${block.kind}`].join(' ')
      const tag = block.kind === 'title' ? 'h3' : block.kind === 'heading' ? 'h4' : 'p'

      return `          <${tag} class="${classes}" style="left: ${block.xPercent.toFixed(2)}%; top: ${block.yPercent.toFixed(2)}%; width: ${Math.max(block.widthPercent, 2).toFixed(2)}%; font-size: ${resolveLineFontSize(block).toFixed(1)}px;">${escapeHtml(block.text)}</${tag}>`
    })
    .join('\n')
  const readableParagraphs = page.blocks
    .map((block) => `<p>${escapeHtml(block.text)}</p>`)
    .join('\n          ')

  return `      <section class="page-block layout-block">
        <div class="page-meta">
          <h2>Page ${page.pageNumber}</h2>
          <span>${page.blocks.length} block${page.blocks.length === 1 ? '' : 's'} · ${page.columnCount} column${page.columnCount === 1 ? '' : 's'}</span>
        </div>
        <div class="page-sheet" style="aspect-ratio: ${Math.max(page.width, 1)} / ${Math.max(page.height, 1)};">
${blocks}
        </div>
        <div class="sr-only">
          <h3>Readable text for page ${page.pageNumber}</h3>
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

export function buildHtmlExport(fileName: string, pages: string[], layoutPages?: PdfDocumentTextLayoutPage[]) {
  const documentModel = buildStructuredDocument(fileName, pages, layoutPages)
  const sections = documentModel.pages.map((page) => buildLayoutHtmlPage(page)).join('\n')

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(documentModel.title)}</title>
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
        padding: 18px;
        margin-bottom: 20px;
        box-shadow: 0 10px 30px rgba(31, 36, 48, 0.08);
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

      .page-block-node {
        position: absolute;
        margin: 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        line-height: 1.16;
        color: #1f2430;
      }

      .page-block-title {
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .page-block-heading {
        font-weight: 600;
        color: #25304a;
      }

      .page-block-paragraph {
        font-weight: 400;
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
      <h1>${escapeHtml(documentModel.title)}</h1>
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
  const documentModel = buildStructuredDocument(fileName, pages, layoutPages)
  const children: Paragraph[] = [
    new Paragraph({
      text: documentModel.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 280 },
    }),
  ]

  documentModel.pages.forEach((page, index) => {
    children.push(
      new Paragraph({
        text: `Page ${page.pageNumber}`,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: index > 0,
        spacing: { before: index === 0 ? 120 : 180, after: 160 },
      }),
    )

    let previousBottomPercent = 0

    for (const block of page.blocks) {
      const verticalGapPercent = Math.max(0, block.yPercent - previousBottomPercent)
      previousBottomPercent = block.yPercent + block.heightPercent

      children.push(
        new Paragraph({
          heading: resolveDocxHeading(block.kind),
          spacing: {
            before: resolveDocxSpacingBefore(verticalGapPercent, block.kind),
            after: block.kind === 'paragraph' ? 55 : 120,
          },
          children: [
            new TextRun({
              text: block.text,
              bold: block.kind !== 'paragraph',
              size: resolveDocxTextSize(block.fontSize, block.kind),
            }),
          ],
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

export function buildStructuredJsonExport(
  fileName: string,
  pages: string[],
  layoutPages?: PdfDocumentTextLayoutPage[],
) {
  const documentModel = buildStructuredDocument(fileName, pages, layoutPages)
  return new TextEncoder().encode(JSON.stringify(documentModel, null, 2))
}
