import { describe, expect, test } from 'vitest'

import { buildDocxExport, buildHtmlExport, buildMarkdownExport } from './document-export'

describe('document export helpers', () => {
  test('builds markdown and html exports from extracted page text', () => {
    const pages = ['First page text', 'Second page line 1\nSecond page line 2']

    const markdown = new TextDecoder().decode(buildMarkdownExport('sample.pdf', pages))
    expect(markdown).toContain('# sample')
    expect(markdown).toContain('## Page 1')
    expect(markdown).toContain('Second page line 2')

    const html = new TextDecoder().decode(buildHtmlExport('sample.pdf', pages))
    expect(html).toContain('<h1>sample</h1>')
    expect(html).toContain('<h2>Page 2</h2>')
    expect(html).toContain('Second page line 1<br />Second page line 2')
  })

  test('builds a docx export as a zip container', async () => {
    const bytes = await buildDocxExport('sample.pdf', ['First page text'])

    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.length).toBeGreaterThan(200)
  })
})
