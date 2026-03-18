import { describe, expect, test } from 'vitest'

import { createSamplePdf, readPdfPageAnnotations, readPdfSummary } from '../../test/pdf-fixtures'

import {
  addStickyNoteAnnotationToDocument,
  addTextMarkupAnnotationToDocument,
  removeAnnotationFromDocument,
  updateAnnotationInDocument,
} from './pdf-annotations'

describe('real PDF annotation operations', () => {
  test('adds sticky note and text markup annotations to real PDF bytes', async () => {
    const source = await createSamplePdf(1)

    const highlighted = await addTextMarkupAnnotationToDocument(source, {
      kind: 'highlight',
      pageIndex: 0,
      xPercent: 9.5,
      yPercent: 10.4,
      widthPercent: 32,
      heightPercent: 3.2,
      title: 'Editor Review',
      contents: 'Check the heading tone.',
    })

    const underlined = await addTextMarkupAnnotationToDocument(highlighted, {
      kind: 'underline',
      pageIndex: 0,
      xPercent: 9.5,
      yPercent: 15.8,
      widthPercent: 28,
      heightPercent: 3,
      title: 'Editor Review',
      contents: 'Underline the body line.',
    })

    const struck = await addTextMarkupAnnotationToDocument(underlined, {
      kind: 'strikeout',
      pageIndex: 0,
      xPercent: 44,
      yPercent: 15.8,
      widthPercent: 18,
      heightPercent: 3,
      title: 'Editor Review',
      contents: 'Remove this phrase.',
    })

    const annotated = await addStickyNoteAnnotationToDocument(struck, {
      title: 'Review Note',
      contents: 'Double-check the caption on this page.',
      pageIndexes: [0],
      xPercent: 74,
      yPercent: 9,
      tone: 'amber',
    })

    expect((await readPdfSummary(annotated)).pageCount).toBe(1)

    const annotations = await readPdfPageAnnotations(annotated, 1)
    expect(annotations.map((annotation) => annotation.subtype)).toEqual(
      expect.arrayContaining(['Highlight', 'Underline', 'StrikeOut', 'Text']),
    )
    expect(annotations.find((annotation) => annotation.subtype === 'Text')?.contents).toContain('Double-check')
    expect(annotations.find((annotation) => annotation.subtype === 'Highlight')?.title).toBe('Editor Review')

    const stickyNote = annotations.find((annotation) => annotation.subtype === 'Text')
    expect(stickyNote?.id).toBeTruthy()

    const removedStickyNote = await removeAnnotationFromDocument(annotated, {
      pageIndex: 0,
      annotationId: stickyNote!.id,
    })

    const annotationsAfterRemoval = await readPdfPageAnnotations(removedStickyNote, 1)
    expect(annotationsAfterRemoval.map((annotation) => annotation.subtype)).toEqual(
      expect.arrayContaining(['Highlight', 'Underline', 'StrikeOut']),
    )
    expect(annotationsAfterRemoval.map((annotation) => annotation.subtype)).not.toContain('Text')
  })

  test('updates existing annotation dictionaries in place on real PDF bytes', async () => {
    const source = await createSamplePdf(1)

    const highlighted = await addTextMarkupAnnotationToDocument(source, {
      kind: 'highlight',
      pageIndex: 0,
      xPercent: 10,
      yPercent: 12,
      widthPercent: 28,
      heightPercent: 3.2,
      title: 'Initial Review',
      contents: 'Original markup note.',
    })

    const annotated = await addStickyNoteAnnotationToDocument(highlighted, {
      title: 'Original Note',
      contents: 'Original sticky note.',
      pageIndexes: [0],
      xPercent: 72,
      yPercent: 10,
      tone: 'amber',
    })

    const initialAnnotations = await readPdfPageAnnotations(annotated, 1)
    const highlight = initialAnnotations.find((annotation) => annotation.subtype === 'Highlight')
    const stickyNote = initialAnnotations.find((annotation) => annotation.subtype === 'Text')

    expect(highlight?.id).toBeTruthy()
    expect(stickyNote?.id).toBeTruthy()

    const highlightUpdated = await updateAnnotationInDocument(annotated, {
      pageIndex: 0,
      annotationId: highlight!.id,
      title: 'Updated Review',
      contents: 'Updated markup note.',
    })

    const fullyUpdated = await updateAnnotationInDocument(highlightUpdated, {
      pageIndex: 0,
      annotationId: stickyNote!.id,
      title: 'Updated Note',
      contents: 'Updated sticky note.',
      tone: 'blue',
    })

    const updatedAnnotations = await readPdfPageAnnotations(fullyUpdated, 1)

    expect(updatedAnnotations).toHaveLength(2)
    expect(updatedAnnotations.find((annotation) => annotation.subtype === 'Highlight')).toMatchObject({
      title: 'Updated Review',
      contents: 'Updated markup note.',
    })
    expect(updatedAnnotations.find((annotation) => annotation.subtype === 'Text')).toMatchObject({
      title: 'Updated Note',
      contents: 'Updated sticky note.',
    })
  })
})
