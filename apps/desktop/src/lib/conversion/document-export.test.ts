import JSZip from 'jszip'
import { describe, expect, test } from 'vitest'

import {
  buildDocxExport,
  buildHtmlExport,
  buildMarkdownExport,
  buildStructuredDocument,
  buildStructuredJsonExport,
} from './document-export'

describe('document export helpers', () => {
  test('builds markdown and layout-aware html exports from extracted page text', () => {
    const pages = ['First page text', 'Second page line 1\nSecond page line 2']
    const layoutPages = [
      {
        pageNumber: 1,
        width: 595,
        height: 842,
        lines: [
          {
            id: 'layout-1-title',
            pageNumber: 1,
            text: 'First page text',
            xPercent: 12,
            yPercent: 9,
            widthPercent: 30,
            heightPercent: 4,
            fontSize: 24,
          },
        ],
      },
      {
        pageNumber: 2,
        width: 595,
        height: 842,
        lines: [
          {
            id: 'layout-2-heading',
            pageNumber: 2,
            text: 'Second page line 1',
            xPercent: 12,
            yPercent: 12,
            widthPercent: 36,
            heightPercent: 4,
            fontSize: 20,
          },
          {
            id: 'layout-2-body',
            pageNumber: 2,
            text: 'Second page line 2',
            xPercent: 12,
            yPercent: 18,
            widthPercent: 36,
            heightPercent: 3.6,
            fontSize: 14,
          },
        ],
      },
    ]

    const markdown = new TextDecoder().decode(buildMarkdownExport('sample.pdf', pages))
    expect(markdown).toContain('# sample')
    expect(markdown).toContain('## Page 1')
    expect(markdown).toContain('Second page line 2')

    const html = new TextDecoder().decode(buildHtmlExport('sample.pdf', pages, layoutPages))
    expect(html).toContain('<h1>sample</h1>')
    expect(html).toContain('class="page-sheet"')
    expect(html).toContain('class="page-block-node page-block-heading"')
    expect(html).toContain('First page text')
    expect(html).toContain('left: 12.00%; top: 12.00%; width: 36.00%')
  })

  test('builds a structured docx export as a zip container', async () => {
    const bytes = await buildDocxExport(
      'sample.pdf',
      ['First page text', 'Second page line 1\nSecond page line 2'],
      [
        {
          pageNumber: 1,
          width: 595,
          height: 842,
          lines: [
            {
              id: 'docx-layout-1-title',
              pageNumber: 1,
              text: 'First page text',
              xPercent: 12,
              yPercent: 9,
              widthPercent: 30,
              heightPercent: 4,
              fontSize: 24,
            },
          ],
        },
        {
          pageNumber: 2,
          width: 595,
          height: 842,
          lines: [
            {
              id: 'docx-layout-2-title',
              pageNumber: 2,
              text: 'Second page line 1',
              xPercent: 12,
              yPercent: 12,
              widthPercent: 36,
              heightPercent: 4,
              fontSize: 20,
            },
            {
              id: 'docx-layout-2-body',
              pageNumber: 2,
              text: 'Second page line 2',
              xPercent: 12,
              yPercent: 18,
              widthPercent: 36,
              heightPercent: 3.6,
              fontSize: 14,
            },
          ],
        },
      ],
    )

    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.length).toBeGreaterThan(200)

    const archive = await JSZip.loadAsync(bytes)
    const documentXml = await archive.file('word/document.xml')?.async('string')

    expect(documentXml).toContain('Page 2')
    expect(documentXml).toContain('Second page line 1')
    expect(documentXml).toContain('w:pageBreakBefore')
  })

  test('builds a structured document model and json export from layout pages', () => {
    const pages = ['First page text', 'Second page line 1\nSecond page line 2']
    const layoutPages = [
      {
        pageNumber: 1,
        width: 595,
        height: 842,
        lines: [
          {
            id: 'json-layout-1-title',
            pageNumber: 1,
            text: 'First page text',
            xPercent: 12,
            yPercent: 9,
            widthPercent: 30,
            heightPercent: 4,
            fontSize: 24,
          },
        ],
      },
      {
        pageNumber: 2,
        width: 595,
        height: 842,
        lines: [
          {
            id: 'json-layout-2-heading',
            pageNumber: 2,
            text: 'Second page line 1',
            xPercent: 12,
            yPercent: 12,
            widthPercent: 36,
            heightPercent: 4,
            fontSize: 20,
          },
          {
            id: 'json-layout-2-body',
            pageNumber: 2,
            text: 'Second page line 2',
            xPercent: 12.4,
            yPercent: 18,
            widthPercent: 36,
            heightPercent: 3.6,
            fontSize: 14,
          },
        ],
      },
    ]

    const documentModel = buildStructuredDocument('sample.pdf', pages, layoutPages)
    expect(documentModel.pageCount).toBe(2)
    expect(documentModel.pages[0]?.blocks[0]?.kind).toBe('title')
    expect(documentModel.pages[1]?.blocks[0]?.kind).toBe('heading')
    expect(documentModel.pages[1]?.blocks[1]?.kind).toBe('paragraph')

    const json = JSON.parse(new TextDecoder().decode(buildStructuredJsonExport('sample.pdf', pages, layoutPages)))
    expect(json.generatedBy).toBe('Sampadan')
    expect(json.pages[1].blocks[1].text).toBe('Second page line 2')
    expect(json.pages[1].columnCount).toBeGreaterThanOrEqual(1)
  })
})
