import { describe, expect, test } from 'vitest'

import { buildPdfPageTextTargets } from './pdf-viewer'

describe('buildPdfPageTextTargets', () => {
  test('splits multi-word text spans into ordered word targets', () => {
    const targets = buildPdfPageTextTargets(
      [
        {
          id: 'span-1',
          text: 'Adobe style editing',
          left: 60,
          top: 120,
          right: 240,
          bottom: 144,
          fontSize: 18,
        },
      ],
      1,
      600,
      800,
    )

    expect(targets.map((target) => target.text)).toEqual(['Adobe', 'style', 'editing'])
    expect(targets[0].xPercent).toBeCloseTo(10, 2)
    expect(targets[1].xPercent).toBeGreaterThan(targets[0].xPercent)
    expect(targets[2].xPercent).toBeGreaterThan(targets[1].xPercent)
    expect(targets[2].xPercent + targets[2].widthPercent).toBeCloseTo(40, 2)
  })

  test('keeps single-word spans as a single target', () => {
    const targets = buildPdfPageTextTargets(
      [
        {
          id: 'span-2',
          text: 'Sampadan',
          left: 72,
          top: 96,
          right: 168,
          bottom: 116,
          fontSize: 16,
        },
      ],
      2,
      600,
      800,
    )

    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual(
      expect.objectContaining({
        id: 'span-2',
        pageNumber: 2,
        text: 'Sampadan',
      }),
    )
  })
})
