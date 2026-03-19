import { getPdfLib } from '../pdf-engine'
import type { PdfMetadataDraft } from '../types'

export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type ReviewNoteTone = 'amber' | 'blue' | 'green' | 'rose'
export type TextEditAlignment = 'left' | 'center' | 'right'
export type TargetedTextReplacementStrategy = 'content-stream' | 'overlay'
export type PageNumberPosition =
  | 'header-left'
  | 'header-center'
  | 'header-right'
  | 'footer-left'
  | 'footer-center'
  | 'footer-right'

export interface TargetedTextReplacementResult {
  bytes: Uint8Array
  strategy: TargetedTextReplacementStrategy
}

type TextOperandToken = {
  kind: 'string' | 'hex'
  raw: string
  start: number
  end: number
}

type NameToken = {
  kind: 'name'
  raw: string
  start: number
  end: number
}

type WordToken = {
  kind: 'word'
  raw: string
  start: number
  end: number
}

type NumberToken = {
  kind: 'number'
  raw: string
  start: number
  end: number
  value: number
}

type ArrayToken = {
  kind: 'array'
  raw: string
  start: number
  end: number
}

type UnsupportedToken = {
  kind: 'unsupported'
  raw: string
  start: number
  end: number
}

type ParsedContentToken = TextOperandToken | NameToken | WordToken | NumberToken | ArrayToken | UnsupportedToken

type LayoutFontMetrics = {
  widthOfTextAtSize: (text: string, size: number) => number
  heightAtSize?: (size: number, options?: { descender?: boolean }) => number
  sizeAtHeight?: (height: number) => number
}

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await getPdfLib()
  return PDFDocument.load(bytes.slice(), { updateMetadata: false })
}

async function saveDocument(document: Awaited<ReturnType<typeof loadDocument>>) {
  return document.save()
}

async function appendCopiedPages(
  target: Awaited<ReturnType<typeof loadDocument>>,
  source: Awaited<ReturnType<typeof loadDocument>>,
  pageIndexes: number[],
) {
  if (pageIndexes.length === 0) {
    return
  }

  const pages = await target.copyPages(source, pageIndexes)
  for (const page of pages) {
    target.addPage(page)
  }
}

function normalizePageIndexes(pageIndexes: number[], pageCount: number) {
  const uniqueIndexes = Array.from(
    new Set(
      pageIndexes.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount),
    ),
  ).sort((left, right) => left - right)

  if (uniqueIndexes.length === 0) {
    throw new Error('Choose at least one valid page.')
  }

  return uniqueIndexes
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function resolveOverlayPosition(options: {
  pageWidth: number
  pageHeight: number
  textWidth: number
  textHeight: number
  position: WatermarkPosition
}) {
  const marginX = clampNumber(options.pageWidth * 0.06, 18, 42)
  const marginY = clampNumber(options.pageHeight * 0.05, 18, 42)

  switch (options.position) {
    case 'top-left':
      return {
        x: marginX,
        y: options.pageHeight - marginY - options.textHeight,
      }
    case 'top-right':
      return {
        x: options.pageWidth - marginX - options.textWidth,
        y: options.pageHeight - marginY - options.textHeight,
      }
    case 'bottom-left':
      return {
        x: marginX,
        y: marginY,
      }
    case 'bottom-right':
      return {
        x: options.pageWidth - marginX - options.textWidth,
        y: marginY,
      }
    case 'center':
    default:
      return {
        x: (options.pageWidth - options.textWidth) / 2,
        y: (options.pageHeight - options.textHeight) / 2,
      }
  }
}

function resolvePageNumberPosition(options: {
  pageWidth: number
  pageHeight: number
  textWidth: number
  textHeight: number
  position: PageNumberPosition
}) {
  const marginX = clampNumber(options.pageWidth * 0.045, 20, 36)
  const marginY = clampNumber(options.pageHeight * 0.03, 18, 30)
  const isHeader = options.position.startsWith('header')
  const y = isHeader ? options.pageHeight - marginY - options.textHeight : marginY

  if (options.position.endsWith('left')) {
    return { x: marginX, y }
  }

  if (options.position.endsWith('right')) {
    return { x: options.pageWidth - marginX - options.textWidth, y }
  }

  return {
    x: (options.pageWidth - options.textWidth) / 2,
    y,
  }
}

function resolveRelativeEditRect(options: {
  pageWidth: number
  pageHeight: number
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
}) {
  const width = clampNumber(options.pageWidth * (options.widthPercent / 100), 48, options.pageWidth)
  const height = clampNumber(options.pageHeight * (options.heightPercent / 100), 28, options.pageHeight)
  const topX = clampNumber(options.pageWidth * (options.xPercent / 100), 0, Math.max(0, options.pageWidth - width))
  const topY = clampNumber(options.pageHeight * (options.yPercent / 100), 0, Math.max(0, options.pageHeight - height))

  return {
    x: topX,
    y: options.pageHeight - topY - height,
    width,
    height,
  }
}

function resolveAlignedTextX(options: {
  rectX: number
  rectWidth: number
  padding: number
  textWidth: number
  alignment: TextEditAlignment
}) {
  if (options.alignment === 'center') {
    return options.rectX + (options.rectWidth - options.textWidth) / 2
  }

  if (options.alignment === 'right') {
    return options.rectX + options.rectWidth - options.padding - options.textWidth
  }

  return options.rectX + options.padding
}

function normalizeTextForMatch(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function resolveTextHeightAtSize(font: LayoutFontMetrics, size: number) {
  return typeof font.heightAtSize === 'function' ? font.heightAtSize(size, { descender: false }) : size
}

function resolveFontSizeForTargetTextHeight(
  font: LayoutFontMetrics,
  targetTextHeight: number,
  fallbackSize: number,
) {
  const normalizedTargetHeight = Math.max(1, targetTextHeight)
  const heightAtOnePoint = resolveTextHeightAtSize(font, 1)

  if (heightAtOnePoint > 0) {
    return normalizedTargetHeight / heightAtOnePoint
  }

  if (typeof font.sizeAtHeight === 'function') {
    return font.sizeAtHeight(normalizedTargetHeight)
  }

  return fallbackSize
}

function resolveClosestStandardFontName(fontFamilyHint?: string | null) {
  const normalizedHint = (fontFamilyHint ?? '').toLowerCase()
  const wantsMonospace =
    /courier|mono|monospace|consolas|menlo|monaco|source code|jetbrains mono/.test(normalizedHint)
  const wantsSerif =
    !wantsMonospace && /times|serif|georgia|cambria|garamond|palatino|bookman|baskerville/.test(normalizedHint)
  const wantsBold = /bold|black|semibold|demibold|medium/.test(normalizedHint)
  const wantsItalic = /italic|oblique/.test(normalizedHint)

  if (wantsMonospace) {
    if (wantsBold && wantsItalic) {
      return 'Courier-BoldOblique'
    }

    if (wantsBold) {
      return 'Courier-Bold'
    }

    if (wantsItalic) {
      return 'Courier-Oblique'
    }

    return 'Courier'
  }

  if (wantsSerif) {
    if (wantsBold && wantsItalic) {
      return 'Times-BoldItalic'
    }

    if (wantsBold) {
      return 'Times-Bold'
    }

    if (wantsItalic) {
      return 'Times-Italic'
    }

    return 'Times-Roman'
  }

  if (wantsBold && wantsItalic) {
    return 'Helvetica-BoldOblique'
  }

  if (wantsBold) {
    return 'Helvetica-Bold'
  }

  if (wantsItalic) {
    return 'Helvetica-Oblique'
  }

  return 'Helvetica'
}

function measureTextGlyphCount(text: string) {
  return Array.from(text).length
}

function measureWordSpaceCount(text: string) {
  return Array.from(text).filter((character) => character === ' ').length
}

function formatPdfNumber(value: number) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value
  if (Number.isInteger(rounded)) {
    return String(rounded)
  }

  return rounded.toFixed(3).replace(/\.?0+$/, '')
}

function resolveEditPadding(
  rect: { width: number; height: number },
  fontSize: number,
  compactLayout: boolean,
) {
  if (compactLayout) {
    return {
      horizontal: clampNumber(Math.min(rect.width * 0.02, fontSize * 0.12), 0.75, 3.5),
      vertical: clampNumber(Math.min(rect.height * 0.05, fontSize * 0.08), 0.5, 2.4),
    }
  }

  const sharedPadding = clampNumber(Math.min(rect.width, rect.height) * 0.08, 8, 16)
  return {
    horizontal: sharedPadding,
    vertical: sharedPadding,
  }
}

function resolveTextBlockHeight(lineCount: number, lineHeight: number, textHeight: number) {
  if (lineCount <= 0) {
    return 0
  }

  return textHeight + Math.max(0, lineCount - 1) * lineHeight
}

function resolveCenteredTextBlockY(options: {
  rectY: number
  rectHeight: number
  lineCount: number
  lineHeight: number
  textHeight: number
}) {
  const blockHeight = resolveTextBlockHeight(options.lineCount, options.lineHeight, options.textHeight)
  return options.rectY + Math.max(0, (options.rectHeight - blockHeight) / 2)
}

function encodePdfContentString(value: string) {
  const bytes = new Uint8Array(value.length)

  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff
  }

  return bytes
}

function decodePdfContentBytes(bytes: Uint8Array) {
  let content = ''

  for (let index = 0; index < bytes.length; index += 1) {
    content += String.fromCharCode(bytes[index])
  }

  return content
}

function isPdfWhitespace(character: string) {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t' || character === '\f'
}

function isPdfDelimiter(character: string) {
  return (
    character === '(' ||
    character === ')' ||
    character === '<' ||
    character === '>' ||
    character === '[' ||
    character === ']' ||
    character === '{' ||
    character === '}' ||
    character === '/' ||
    character === '%'
  )
}

function skipPdfWhitespaceAndComments(content: string, startIndex: number) {
  let index = startIndex

  while (index < content.length) {
    if (content[index] === '%') {
      index += 1
      while (index < content.length && content[index] !== '\n' && content[index] !== '\r') {
        index += 1
      }
      continue
    }

    if (!isPdfWhitespace(content[index])) {
      break
    }

    index += 1
  }

  return index
}

function readLiteralStringToken(content: string, start: number): ParsedContentToken | null {
  let index = start + 1
  let nesting = 1
  let escaped = false

  while (index < content.length) {
    const character = content[index]

    if (!escaped) {
      if (character === '\\') {
        escaped = true
      } else if (character === '(') {
        nesting += 1
      } else if (character === ')') {
        nesting -= 1
        if (nesting === 0) {
          return {
            kind: 'string',
            raw: content.slice(start, index + 1),
            start,
            end: index + 1,
          }
        }
      }
    } else {
      escaped = false
    }

    index += 1
  }

  return null
}

function readHexStringToken(content: string, start: number): ParsedContentToken | null {
  let index = start + 1

  while (index < content.length && content[index] !== '>') {
    index += 1
  }

  if (index >= content.length) {
    return null
  }

  return {
    kind: 'hex',
    raw: content.slice(start, index + 1),
    start,
    end: index + 1,
  }
}

function readArrayToken(content: string, start: number): ParsedContentToken | null {
  let index = start + 1
  let depth = 1

  while (index < content.length) {
    const character = content[index]

    if (character === '%') {
      index = skipPdfWhitespaceAndComments(content, index)
      continue
    }

    if (character === '(') {
      const token = readLiteralStringToken(content, index)
      if (!token) {
        return null
      }
      index = token.end
      continue
    }

    if (character === '<' && content[index + 1] !== '<') {
      const token = readHexStringToken(content, index)
      if (!token) {
        return null
      }
      index = token.end
      continue
    }

    if (character === '<' && content[index + 1] === '<') {
      return {
        kind: 'unsupported',
        raw: '<<',
        start,
        end: index + 2,
      }
    }

    if (character === '[') {
      depth += 1
      index += 1
      continue
    }

    if (character === ']') {
      depth -= 1
      index += 1

      if (depth === 0) {
        return {
          kind: 'array',
          raw: content.slice(start, index),
          start,
          end: index,
        }
      }

      continue
    }

    index += 1
  }

  return null
}

function readNextContentToken(content: string, startIndex: number): ParsedContentToken | null {
  const start = skipPdfWhitespaceAndComments(content, startIndex)

  if (start >= content.length) {
    return null
  }

  const character = content[start]

  if (character === '(') {
    return readLiteralStringToken(content, start)
  }

  if (character === '<') {
    if (content[start + 1] === '<') {
      return {
        kind: 'unsupported',
        raw: '<<',
        start,
        end: start + 2,
      }
    }

    return readHexStringToken(content, start)
  }

  if (character === '>') {
    if (content[start + 1] === '>') {
      return {
        kind: 'unsupported',
        raw: '>>',
        start,
        end: start + 2,
      }
    }

    return null
  }

  if (character === '[') {
    return readArrayToken(content, start)
  }

  if (character === '/') {
    let end = start + 1
    while (end < content.length && !isPdfWhitespace(content[end]) && !isPdfDelimiter(content[end])) {
      end += 1
    }

    return {
      kind: 'name',
      raw: content.slice(start, end),
      start,
      end,
    }
  }

  let end = start
  while (end < content.length && !isPdfWhitespace(content[end]) && !isPdfDelimiter(content[end])) {
    end += 1
  }

  const raw = content.slice(start, end)
  if (/^[+\-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return {
      kind: 'number',
      raw,
      start,
      end,
      value: Number(raw),
    }
  }

  return {
    kind: 'word',
    raw,
    start,
    end,
  }
}

function resolveStandardFontName(baseFontName: string) {
  const normalizedBaseFontName = baseFontName.replace(/^[A-Z]{6}\+/, '')

  switch (normalizedBaseFontName) {
    case 'Courier':
    case 'Courier-Bold':
    case 'Courier-Oblique':
    case 'Courier-BoldOblique':
    case 'Helvetica':
    case 'Helvetica-Bold':
    case 'Helvetica-Oblique':
    case 'Helvetica-BoldOblique':
    case 'Times-Roman':
    case 'Times-Bold':
    case 'Times-Italic':
    case 'Times-BoldItalic':
    case 'Symbol':
    case 'ZapfDingbats':
      return normalizedBaseFontName
    default:
      return null
  }
}

function decodeTextOperand(
  token: TextOperandToken,
  pdfLib: Awaited<ReturnType<typeof getPdfLib>>,
) {
  if (token.kind === 'hex') {
    return pdfLib.PDFHexString.of(token.raw.slice(1, -1)).decodeText()
  }

  return pdfLib.PDFString.of(token.raw.slice(1, -1)).decodeText()
}

function parseAdjustedTextArrayToken(token: ArrayToken): Array<TextOperandToken | NumberToken> | null {
  const inner = token.raw.slice(1, -1)
  const segments: Array<TextOperandToken | NumberToken> = []
  let cursor = 0

  while (true) {
    const segment = readNextContentToken(inner, cursor)
    if (!segment) {
      break
    }

    cursor = segment.end

    if (segment.kind === 'string' || segment.kind === 'hex' || segment.kind === 'number') {
      segments.push(segment)
      continue
    }

    return null
  }

  return segments
}

type ResolvedTextShowCandidate = {
  token: TextOperandToken | ArrayToken
  operatorEnd: number
  decodedText: string
  operatorName: string
  segments: Array<TextOperandToken | NumberToken> | null
  replacementRaw: (replacementHex: string) => string
}

function measureDisplayedTextAdvance(
  text: string,
  font: {
    widthOfTextAtSize: (text: string, size: number) => number
  },
  options: {
    fontSize: number
    charSpacing: number
    wordSpacing: number
    horizontalScale: number
  },
) {
  const glyphAdvance = font.widthOfTextAtSize(text, options.fontSize)
  const spacingAdvance = measureTextGlyphCount(text) * options.charSpacing + measureWordSpaceCount(text) * options.wordSpacing
  return (glyphAdvance + spacingAdvance) * options.horizontalScale
}

function measureCandidateAdvance(
  candidate: ResolvedTextShowCandidate,
  font: {
    widthOfTextAtSize: (text: string, size: number) => number
  },
  options: {
    fontSize: number
    charSpacing: number
    wordSpacing: number
    horizontalScale: number
  },
  pdfLib: Awaited<ReturnType<typeof getPdfLib>>,
) {
  if (!candidate.segments) {
    return measureDisplayedTextAdvance(candidate.decodedText, font, options)
  }

  let advance = 0

  for (const segment of candidate.segments) {
    if (segment.kind === 'number') {
      advance -= (segment.value / 1000) * options.fontSize * options.horizontalScale
      continue
    }

    advance += measureDisplayedTextAdvance(decodeTextOperand(segment, pdfLib), font, options)
  }

  return advance
}

function resolveTrailingTextAdjustment(
  originalAdvance: number,
  replacementAdvance: number,
  options: {
    fontSize: number
    horizontalScale: number
  },
) {
  const delta = replacementAdvance - originalAdvance
  if (Math.abs(delta) < 0.01 || options.fontSize <= 0 || options.horizontalScale <= 0) {
    return null
  }

  return (delta / (options.fontSize * options.horizontalScale)) * 1000
}

function resolveTextShowCandidate(
  operatorName: string,
  operatorEnd: number,
  operands: ParsedContentToken[],
  pdfLib: Awaited<ReturnType<typeof getPdfLib>>,
): ResolvedTextShowCandidate | null {
  const operand = operands.at(-1)

  if (
    (operatorName === 'Tj' || operatorName === "'" || operatorName === '"') &&
    operand &&
    (operand.kind === 'string' || operand.kind === 'hex')
  ) {
    return {
      token: operand,
      operatorEnd,
      decodedText: decodeTextOperand(operand, pdfLib),
      operatorName,
      segments: null,
      replacementRaw: (replacementHex: string) => replacementHex,
    }
  }

  if (operatorName === 'TJ' && operand?.kind === 'array') {
    const segments = parseAdjustedTextArrayToken(operand)
    if (!segments) {
      return null
    }

    return {
      token: operand,
      operatorEnd,
      decodedText: segments
        .filter((segment): segment is TextOperandToken => segment.kind === 'string' || segment.kind === 'hex')
        .map((segment) => decodeTextOperand(segment, pdfLib))
        .join(''),
      operatorName,
      segments,
      replacementRaw: (replacementHex: string) => `[${replacementHex}]`,
    }
  }

  return null
}

async function attemptContentStreamTextReplacement(
  document: Awaited<ReturnType<typeof loadDocument>>,
  options: {
    pageIndex: number
    targetText: string
    targetOccurrence: number
    replacementText: string
    widthPercent: number
    fontSize: number
  },
) {
  const pdfLib = await getPdfLib()
  const { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFRawStream, StandardFontEmbedder, decodePDFRawStream } = pdfLib
  const page = document.getPage(options.pageIndex)
  const context = page.node.context
  const rawContents = page.node.get(PDFName.Contents)
  const resolvedContents = context.lookup(rawContents)

  if (!(resolvedContents instanceof PDFArray) && !(resolvedContents instanceof PDFStream)) {
    return false
  }

  const resources = page.node.Resources()
  const fontDictionary = resources?.lookupMaybe(PDFName.Font, PDFDict)
  const standardFonts = new Map<
    string,
    {
      embedder: {
        encodeText: (text: string) => { toString: () => string }
        widthOfTextAtSize: (text: string, size: number) => number
      }
    }
  >()

  for (const [key, value] of fontDictionary?.entries() ?? []) {
    const font = context.lookupMaybe(value, PDFDict)
    const baseFont = font?.lookupMaybe(PDFName.of('BaseFont'), PDFName)
    const standardFontName = baseFont ? resolveStandardFontName(baseFont.decodeText()) : null

    if (!font || !standardFontName) {
      continue
    }

    standardFonts.set(key.decodeText(), {
      embedder: StandardFontEmbedder.for(standardFontName as never),
    })
  }

  if (standardFonts.size === 0) {
    return false
  }

  const { width: pageWidth } = page.getSize()
  const availableWidth = Math.max(24, pageWidth * (options.widthPercent / 100))
  const normalizedTarget = normalizeTextForMatch(options.targetText)
  let matchedTargetIndex = 0

  const tryRewriteContentStream = (stream: any) => {
    let contentBytes: Uint8Array

    try {
      if (stream instanceof PDFRawStream) {
        contentBytes = decodePDFRawStream(stream).decode()
      } else {
        const unencoded = (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents
        contentBytes = typeof unencoded === 'function' ? unencoded.call(stream) : stream.getContents()
      }
    } catch {
      return null
    }

    const content = decodePdfContentBytes(contentBytes)
    let cursor = 0
    let currentFontKey: string | null = null
    let currentFontSize = options.fontSize
    let currentCharacterSpacing = 0
    let currentWordSpacing = 0
    let currentHorizontalScale = 1
    let operands: ParsedContentToken[] = []
    let pendingSequence: ResolvedTextShowCandidate[] = []

    const tryReplaceCandidates = (candidates: typeof pendingSequence) => {
      if (candidates.length === 0) {
        return undefined
      }

      const combinedText = candidates.map((candidate) => candidate.decodedText).join('')
      if (normalizeTextForMatch(combinedText) !== normalizedTarget) {
        return undefined
      }

      if (matchedTargetIndex !== options.targetOccurrence) {
        matchedTargetIndex += 1
        return undefined
      }

      const font = currentFontKey ? standardFonts.get(currentFontKey) : null
      if (!font) {
        return null
      }

      let replacementHex: string
      try {
        replacementHex = font.embedder.encodeText(options.replacementText).toString()
      } catch {
        return null
      }

      const textState = {
        fontSize: currentFontSize,
        charSpacing: currentCharacterSpacing,
        wordSpacing: currentWordSpacing,
        horizontalScale: currentHorizontalScale,
      }
      const originalAdvance = candidates.reduce(
        (total, candidate) => total + measureCandidateAdvance(candidate, font.embedder, textState, pdfLib),
        0,
      )
      const replacementAdvance = measureDisplayedTextAdvance(options.replacementText, font.embedder, textState)
      if (replacementAdvance > availableWidth + Math.max(4, currentFontSize * 0.35)) {
        return null
      }

      const trailingAdjustment = resolveTrailingTextAdjustment(originalAdvance, replacementAdvance, {
        fontSize: currentFontSize,
        horizontalScale: currentHorizontalScale,
      })
      const replacementTjRaw = `[${replacementHex}${
        trailingAdjustment === null ? '' : ` ${formatPdfNumber(trailingAdjustment)}`
      }] TJ`

      if (candidates.length === 1) {
        const [candidate] = candidates
        if (trailingAdjustment === null || (candidate.operatorName !== 'Tj' && candidate.operatorName !== 'TJ')) {
          return `${content.slice(0, candidate.token.start)}${candidate.replacementRaw(replacementHex)}${content.slice(candidate.token.end)}`
        }

        return `${content.slice(0, candidate.token.start)}${replacementTjRaw}${content.slice(candidate.operatorEnd)}`
      }

      const first = candidates[0]
      const last = candidates[candidates.length - 1]
      return `${content.slice(0, first.token.start)}${replacementTjRaw}${content.slice(last.operatorEnd)}`
    }

    const flushPendingSequence = () => {
      const result = tryReplaceCandidates(pendingSequence)
      pendingSequence = []
      return result
    }

    const tryReplacePendingSequencePrefixes = () => {
      for (let prefixLength = pendingSequence.length; prefixLength >= 1; prefixLength -= 1) {
        const result = tryReplaceCandidates(pendingSequence.slice(0, prefixLength))
        if (result === null || typeof result === 'string') {
          return result
        }
      }

      return undefined
    }

    while (true) {
      const token = readNextContentToken(content, cursor)
      if (!token) {
        break
      }

      cursor = token.end

      if (token.kind === 'unsupported') {
        return null
      }

      if (token.kind !== 'word') {
        operands.push(token)
        continue
      }

      if (token.raw !== 'Tj' && token.raw !== 'TJ') {
        const sequenceResult = flushPendingSequence()
        if (sequenceResult === null || typeof sequenceResult === 'string') {
          return sequenceResult
        }
      }

      if (token.raw === 'BI') {
        return null
      }

      if (token.raw === 'Tf') {
        const fontSizeToken = operands.at(-1)
        const fontNameToken = operands.at(-2)

        currentFontKey = fontNameToken?.kind === 'name' ? pdfLib.PDFName.of(fontNameToken.raw.slice(1)).decodeText() : null
        currentFontSize = fontSizeToken?.kind === 'number' ? fontSizeToken.value : currentFontSize
        operands = []
        continue
      }

      if (token.raw === 'Tc') {
        const spacingToken = operands.at(-1)
        currentCharacterSpacing = spacingToken?.kind === 'number' ? spacingToken.value : currentCharacterSpacing
        operands = []
        continue
      }

      if (token.raw === 'Tw') {
        const spacingToken = operands.at(-1)
        currentWordSpacing = spacingToken?.kind === 'number' ? spacingToken.value : currentWordSpacing
        operands = []
        continue
      }

      if (token.raw === 'Tz') {
        const scalingToken = operands.at(-1)
        currentHorizontalScale =
          scalingToken?.kind === 'number' ? clampNumber(scalingToken.value / 100, 0.01, 10) : currentHorizontalScale
        operands = []
        continue
      }

      if (token.raw === '"') {
        const characterSpacingToken = operands.at(-2)
        const wordSpacingToken = operands.at(-3)

        currentCharacterSpacing =
          characterSpacingToken?.kind === 'number' ? characterSpacingToken.value : currentCharacterSpacing
        currentWordSpacing = wordSpacingToken?.kind === 'number' ? wordSpacingToken.value : currentWordSpacing
      }

      const candidate = resolveTextShowCandidate(token.raw, token.end, operands, pdfLib)
      if (candidate && (candidate.operatorName === 'Tj' || candidate.operatorName === 'TJ')) {
        pendingSequence.push(candidate)
        const prefixResult = tryReplacePendingSequencePrefixes()
        if (prefixResult === null || typeof prefixResult === 'string') {
          return prefixResult
        }
        operands = []
        continue
      }

      if (candidate) {
        const candidateResult = tryReplaceCandidates([candidate])
        if (candidateResult === null || typeof candidateResult === 'string') {
          return candidateResult
        }
      }

      operands = []
    }

    const finalSequenceResult = flushPendingSequence()
    if (finalSequenceResult === null || typeof finalSequenceResult === 'string') {
      return finalSequenceResult
    }

    return null
  }

  const commitRewrittenStream = (originalToken: unknown, stream: any, rewrittenContent: string) => {
    const replacementStream = context.flateStream(encodePdfContentString(rewrittenContent))
    const filterName = PDFName.of('Filter')
    const decodeParmsName = PDFName.of('DecodeParms')

    for (const [key, value] of stream.dict.entries()) {
      if (key === PDFName.Length || key === filterName || key === decodeParmsName) {
        continue
      }

      replacementStream.dict.set(key, value)
    }

    if (originalToken instanceof PDFRef) {
      context.assign(originalToken, replacementStream)
      return
    }

    if (resolvedContents instanceof PDFArray) {
      const index = resolvedContents.indexOf(originalToken as Parameters<typeof resolvedContents.indexOf>[0])
      if (index !== undefined) {
        resolvedContents.set(index, replacementStream)
      }
      return
    }

    page.node.set(PDFName.Contents, replacementStream)
  }

  if (resolvedContents instanceof PDFArray) {
    for (const token of resolvedContents.asArray()) {
      const stream = context.lookupMaybe(token, PDFStream)
      if (!stream) {
        continue
      }

      const rewrittenContent = tryRewriteContentStream(stream)
      if (!rewrittenContent) {
        continue
      }

      commitRewrittenStream(token, stream, rewrittenContent)
      return true
    }

    return false
  }

  const rewrittenContent = tryRewriteContentStream(resolvedContents)
  if (!rewrittenContent) {
    return false
  }

  commitRewrittenStream(rawContents, resolvedContents, rewrittenContent)
  return true
}

export async function mergeDocuments(buffers: Uint8Array[]) {
  const { PDFDocument } = await getPdfLib()
  const merged = await PDFDocument.create()

  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer.slice(), { updateMetadata: false })
    await appendCopiedPages(merged, source, source.getPageIndices())
  }

  return merged.save()
}

export async function insertDocumentAfterPage(
  bytes: Uint8Array,
  insertedBytes: Uint8Array,
  afterPageIndex: number,
) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const inserted = await loadDocument(insertedBytes)
  const result = await PDFDocument.create()
  const pageCount = source.getPageCount()
  const insertIndex = clampNumber(afterPageIndex, 0, pageCount - 1)

  await appendCopiedPages(
    result,
    source,
    Array.from({ length: insertIndex + 1 }, (_, index) => index),
  )
  await appendCopiedPages(result, inserted, inserted.getPageIndices())
  await appendCopiedPages(
    result,
    source,
    Array.from({ length: pageCount - insertIndex - 1 }, (_, index) => insertIndex + index + 1),
  )

  return result.save()
}

export async function rotatePageInDocument(bytes: Uint8Array, pageIndex: number, delta: number) {
  const { degrees } = await getPdfLib()
  const document = await loadDocument(bytes)
  const page = document.getPage(pageIndex)
  const nextRotation = (page.getRotation().angle + delta + 360) % 360
  page.setRotation(degrees(nextRotation))
  return saveDocument(document)
}

export async function movePageInDocument(bytes: Uint8Array, sourceIndex: number, targetIndex: number) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const reordered = await PDFDocument.create()
  const pageOrder = Array.from({ length: source.getPageCount() }, (_, index) => index)
  const [movedPage] = pageOrder.splice(sourceIndex, 1)
  pageOrder.splice(targetIndex, 0, movedPage)

  const pages = await reordered.copyPages(source, pageOrder)
  for (const page of pages) {
    reordered.addPage(page)
  }

  return reordered.save()
}

export async function extractPagesFromDocument(bytes: Uint8Array, pageIndexes: number[]) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const extracted = await PDFDocument.create()
  const pages = await extracted.copyPages(source, pageIndexes)

  for (const page of pages) {
    extracted.addPage(page)
  }

  return extracted.save()
}

export async function deletePageFromDocument(bytes: Uint8Array, pageIndex: number) {
  const document = await loadDocument(bytes)

  if (document.getPageCount() <= 1) {
    throw new Error('A PDF must keep at least one page.')
  }

  document.removePage(pageIndex)
  return saveDocument(document)
}

export async function duplicatePageInDocument(bytes: Uint8Array, pageIndex: number) {
  const { PDFDocument } = await getPdfLib()
  const source = await loadDocument(bytes)
  const duplicated = await PDFDocument.create()
  const order = Array.from({ length: source.getPageCount() }, (_, index) => index)
  order.splice(pageIndex + 1, 0, pageIndex)

  const pages = await duplicated.copyPages(source, order)
  for (const page of pages) {
    duplicated.addPage(page)
  }

  return duplicated.save()
}

export async function insertBlankPageAfterCurrent(bytes: Uint8Array, pageIndex: number) {
  const document = await loadDocument(bytes)
  const page = document.getPage(pageIndex)
  const { width, height } = page.getSize()
  document.insertPage(pageIndex + 1, [width, height])
  return saveDocument(document)
}

export async function splitDocumentIntoSinglePages(bytes: Uint8Array) {
  const document = await loadDocument(bytes)
  const segments: Uint8Array[] = []

  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    segments.push(await extractPagesFromDocument(bytes, [pageIndex]))
  }

  return segments
}

export async function readMetadataFromDocument(bytes: Uint8Array): Promise<PdfMetadataDraft> {
  const document = await loadDocument(bytes)
  const keywords = normalizeKeywordsForDraft(document.getKeywords())

  return {
    title: document.getTitle() ?? '',
    author: document.getAuthor() ?? '',
    subject: document.getSubject() ?? '',
    keywords,
    creator: document.getCreator() ?? '',
    producer: document.getProducer() ?? '',
  }
}

export async function applyMetadataToDocument(bytes: Uint8Array, metadata: PdfMetadataDraft) {
  const document = await loadDocument(bytes)
  const keywords = metadata.keywords
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  document.setTitle(metadata.title.trim())
  document.setAuthor(metadata.author.trim())
  document.setSubject(metadata.subject.trim())
  document.setKeywords(keywords)
  document.setCreator(metadata.creator.trim())
  document.setProducer(metadata.producer.trim())

  return saveDocument(document)
}

export async function addTextWatermarkToDocument(
  bytes: Uint8Array,
  options: {
    text: string
    pageIndexes: number[]
    position: WatermarkPosition
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(StandardFonts.HelveticaBold)
  const text = options.text.trim()

  if (!text) {
    throw new Error('Enter watermark text before applying it.')
  }

  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const size = clampNumber(Math.min(width, height) * 0.08, 26, 68)
    const textWidth = font.widthOfTextAtSize(text, size)
    const position = resolveOverlayPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth,
      textHeight: size,
      position: options.position,
    })

    page.drawText(text, {
      x: position.x,
      y: position.y,
      size,
      font,
      color: rgb(0.73, 0.77, 0.84),
    })
  }

  return saveDocument(document)
}

export async function addFreeTextBlockToDocument(
  bytes: Uint8Array,
  options: {
    text: string
    pageIndexes: number[]
    xPercent: number
    yPercent: number
    widthPercent: number
    heightPercent: number
    fontSize: number
    alignment: TextEditAlignment
    paperBacking: boolean
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(StandardFonts.Helvetica)
  const text = options.text.trim()

  if (!text) {
    throw new Error('Enter text before placing a text block.')
  }

  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const fontSize = clampNumber(options.fontSize, 8, 72)

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const rect = resolveRelativeEditRect({
      pageWidth: width,
      pageHeight: height,
      xPercent: options.xPercent,
      yPercent: options.yPercent,
      widthPercent: options.widthPercent,
      heightPercent: options.heightPercent,
    })
    const padding = clampNumber(Math.min(rect.width, rect.height) * 0.08, 8, 16)
    const maxTextWidth = Math.max(36, rect.width - padding * 2)
    const lineHeight = fontSize * 1.24
    const maxLines = Math.max(1, Math.floor((rect.height - padding * 2 + fontSize * 0.2) / lineHeight))
    const lines = wrapTextToWidth(text, font, fontSize, maxTextWidth, maxLines)

    if (options.paperBacking) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: rgb(0.99, 0.99, 0.98),
        opacity: 0.94,
        borderColor: rgb(0.77, 0.8, 0.84),
        borderWidth: 0.8,
        borderOpacity: 0.95,
      })
    }

    for (const [lineIndex, line] of lines.entries()) {
      const textWidth = font.widthOfTextAtSize(line, fontSize)
      page.drawText(line, {
        x: resolveAlignedTextX({
          rectX: rect.x,
          rectWidth: rect.width,
          padding,
          textWidth,
          alignment: options.alignment,
        }),
        y: rect.y + rect.height - padding - fontSize - lineIndex * lineHeight,
        size: fontSize,
        font,
        color: rgb(0.12, 0.14, 0.18),
      })
    }
  }

  return saveDocument(document)
}

export async function replaceRegionWithTextInDocument(
  bytes: Uint8Array,
  options: {
    text: string
    pageIndexes: number[]
    xPercent: number
    yPercent: number
    widthPercent: number
    heightPercent: number
    fontSize: number
    alignment: TextEditAlignment
    autoFit?: boolean
    compactLayout?: boolean
    fontFamily?: string | null
    baselinePercent?: number | null
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(
    (StandardFonts as Record<string, string>)[resolveClosestStandardFontName(options.fontFamily)] ?? StandardFonts.Helvetica,
  )
  const text = options.text.trim()
  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const baseFontSize = clampNumber(options.fontSize, 8, 72)
  const compactLayout = options.compactLayout ?? true

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const rect = resolveRelativeEditRect({
      pageWidth: width,
      pageHeight: height,
      xPercent: options.xPercent,
      yPercent: options.yPercent,
      widthPercent: options.widthPercent,
      heightPercent: options.heightPercent,
    })
    const useBaselineAnchoring = compactLayout && typeof options.baselinePercent === 'number'
    const padding = useBaselineAnchoring
      ? {
          horizontal: 0,
          vertical: 0,
        }
      : resolveEditPadding(rect, baseFontSize, compactLayout)
    const whiteoutBleed = compactLayout
      ? clampNumber(Math.min(baseFontSize * 0.16, Math.min(rect.width, rect.height) * 0.05), 0.6, 2.2)
      : 0

    page.drawRectangle({
      x: Math.max(0, rect.x - whiteoutBleed),
      y: Math.max(0, rect.y - whiteoutBleed / 2),
      width: Math.min(width - Math.max(0, rect.x - whiteoutBleed), rect.width + whiteoutBleed * 2),
      height: Math.min(height - Math.max(0, rect.y - whiteoutBleed / 2), rect.height + whiteoutBleed),
      color: rgb(1, 1, 1),
      opacity: 1,
      ...(compactLayout
        ? {}
        : {
            borderColor: rgb(0.86, 0.88, 0.91),
            borderWidth: 0.6,
            borderOpacity: 0.85,
          }),
    })

    if (!text) {
      continue
    }

    const contentX = rect.x + padding.horizontal
    const contentY = rect.y + padding.vertical
    const contentWidth = Math.max(24, rect.width - padding.horizontal * 2)
    const contentHeight = Math.max(12, rect.height - padding.vertical * 2)
    const targetTextHeight = Math.max(6, resolveTextHeightAtSize(font, baseFontSize))
    const heightMatchedFontSize = clampNumber(
      resolveFontSizeForTargetTextHeight(font, targetTextHeight, baseFontSize),
      8,
      72,
    )
    const requestedFontSize = useBaselineAnchoring ? heightMatchedFontSize : baseFontSize
    const { fontSize, lines, lineHeight, textHeight } = resolveFittedTextLayout({
      text,
      font,
      requestedSize: requestedFontSize,
      maxTextWidth: contentWidth,
      maxTextHeight: contentHeight,
      autoFit: options.autoFit ?? false,
      preferSingleLine: compactLayout,
      lineHeightMultiplier: compactLayout ? 1.1 : 1.18,
    })
    const fallbackBlockBottomY = resolveCenteredTextBlockY({
      rectY: contentY,
      rectHeight: contentHeight,
      lineCount: lines.length,
      lineHeight,
      textHeight,
    })
    const baselineY =
      useBaselineAnchoring && lines.length === 1
        ? clampNumber(
            height - height * ((options.baselinePercent ?? 0) / 100),
            rect.y + textHeight * 0.72,
            rect.y + rect.height - Math.max(0.4, whiteoutBleed),
          )
        : null

    for (const [lineIndex, line] of lines.entries()) {
      const textWidth = font.widthOfTextAtSize(line, fontSize)
      page.drawText(line, {
        x: resolveAlignedTextX({
          rectX: contentX,
          rectWidth: contentWidth,
          padding: 0,
          textWidth,
          alignment: options.alignment,
        }),
        y: baselineY ?? fallbackBlockBottomY + (lines.length - lineIndex - 1) * lineHeight,
        size: fontSize,
        font,
        color: rgb(0.08, 0.1, 0.12),
      })
    }
  }

  return saveDocument(document)
}

export async function replaceTargetedTextInDocument(
  bytes: Uint8Array,
  options: {
    targetText: string
    replacementText: string
    pageIndex: number
    targetOccurrence?: number
    xPercent: number
    yPercent: number
    widthPercent: number
    heightPercent: number
    fontSize: number
    alignment: TextEditAlignment
    fontFamily?: string | null
    baselinePercent?: number | null
  },
): Promise<TargetedTextReplacementResult> {
  const replacementText = options.replacementText.trim()

  if (!replacementText) {
    throw new Error('Enter replacement text before editing the selected page text.')
  }

  const document = await loadDocument(bytes)
  const replacedInContentStream = await attemptContentStreamTextReplacement(document, {
    pageIndex: options.pageIndex,
    targetText: options.targetText,
    targetOccurrence: options.targetOccurrence ?? 0,
    replacementText,
    widthPercent: options.widthPercent,
    fontSize: options.fontSize,
  })

  if (replacedInContentStream) {
    return {
      bytes: await saveDocument(document),
      strategy: 'content-stream',
    }
  }

  return {
    bytes: await replaceRegionWithTextInDocument(bytes, {
      text: replacementText,
      pageIndexes: [options.pageIndex],
      xPercent: options.xPercent,
      yPercent: options.yPercent,
      widthPercent: options.widthPercent,
      heightPercent: options.heightPercent,
      fontSize: options.fontSize,
      alignment: options.alignment,
      autoFit: true,
      compactLayout: true,
      fontFamily: options.fontFamily,
      baselinePercent: options.baselinePercent,
    }),
    strategy: 'overlay',
  }
}

function resolveFittedTextLayout(options: {
  text: string
  font: LayoutFontMetrics
  requestedSize: number
  maxTextWidth: number
  maxTextHeight: number
  autoFit: boolean
  preferSingleLine?: boolean
  lineHeightMultiplier?: number
}) {
  const lineHeightMultiplier = options.lineHeightMultiplier ?? 1.12
  let fontSize = options.requestedSize

  while (fontSize >= 8) {
    const textHeight = resolveTextHeightAtSize(options.font, fontSize)

    if (options.preferSingleLine && !options.text.replace(/\r\n/g, '\n').includes('\n')) {
      const singleLine = options.text.replace(/\s+/g, ' ').trim()
      if (singleLine) {
        const singleLineWidth = options.font.widthOfTextAtSize(singleLine, fontSize)
        if (singleLineWidth <= options.maxTextWidth && textHeight <= options.maxTextHeight) {
          return {
            fontSize,
            lines: [singleLine],
            lineHeight: Math.max(textHeight * 1.04, fontSize * 1.06),
            textHeight,
          }
        }
      }
    }

    const lineHeight = Math.max(textHeight * 1.04, fontSize * lineHeightMultiplier)
    const maxLines = Math.max(1, Math.floor((options.maxTextHeight - textHeight) / lineHeight) + 1)
    const lines = wrapTextToWidth(options.text, options.font, fontSize, options.maxTextWidth, maxLines)
    const requiredHeight = resolveTextBlockHeight(lines.length, lineHeight, textHeight)

    if (!options.autoFit || requiredHeight <= options.maxTextHeight || fontSize <= 8) {
      return { fontSize, lines, lineHeight, textHeight }
    }

    fontSize -= 1
  }

  const textHeight = resolveTextHeightAtSize(options.font, 8)
  const lineHeight = Math.max(textHeight * 1.04, 8 * lineHeightMultiplier)
  const maxLines = Math.max(1, Math.floor((options.maxTextHeight - textHeight) / lineHeight) + 1)
  return {
    fontSize: 8,
    lines: wrapTextToWidth(options.text, options.font, 8, options.maxTextWidth, maxLines),
    lineHeight,
    textHeight,
  }
}

export async function addImageStampToDocument(
  bytes: Uint8Array,
  imageBytes: Uint8Array,
  options: {
    pageIndexes: number[]
    position: WatermarkPosition
  },
) {
  const document = await loadDocument(bytes)
  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const image = await embedSupportedImage(document, imageBytes)

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const maxWidth = width * 0.26
    const maxHeight = height * 0.18
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)
    const dimensions = image.scale(scale)
    const position = resolveOverlayPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth: dimensions.width,
      textHeight: dimensions.height,
      position: options.position,
    })

    page.drawImage(image, {
      x: position.x,
      y: position.y,
      width: dimensions.width,
      height: dimensions.height,
    })
  }

  return saveDocument(document)
}

export async function addAttachmentToDocument(
  bytes: Uint8Array,
  attachmentBytes: Uint8Array,
  options: {
    name: string
    description?: string
  },
) {
  const { AFRelationship } = await getPdfLib()
  const document = await loadDocument(bytes)
  const name = options.name.trim()

  if (!name) {
    throw new Error('Choose a file name before attaching a file.')
  }

  await document.attach(attachmentBytes, name, {
    mimeType: inferAttachmentMimeType(name),
    description: options.description?.trim() || undefined,
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Data,
  })

  return saveDocument(document)
}

export async function addReviewNoteToDocument(
  bytes: Uint8Array,
  options: {
    title: string
    body: string
    pageIndexes: number[]
    position: WatermarkPosition
    tone: ReviewNoteTone
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const titleFont = await document.embedFont(StandardFonts.HelveticaBold)
  const bodyFont = await document.embedFont(StandardFonts.Helvetica)
  const title = options.title.trim() || 'Review Note'
  const body = options.body.trim()

  if (!body) {
    throw new Error('Enter note text before adding a review note.')
  }

  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const tone = resolveReviewTone(options.tone)

  for (const pageIndex of pageIndexes) {
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const boxWidth = clampNumber(width * 0.36, 186, 272)
    const titleSize = clampNumber(Math.min(width, height) * 0.026, 12, 17)
    const bodySize = clampNumber(Math.min(width, height) * 0.021, 10, 14)
    const innerPadding = clampNumber(boxWidth * 0.06, 12, 16)
    const contentWidth = Math.max(96, boxWidth - innerPadding * 2)
    const bodyLines = wrapTextToWidth(body, bodyFont, bodySize, contentWidth, 6)
    const lineHeight = bodySize * 1.24
    const bodyHeight = Math.max(bodySize, bodyLines.length * lineHeight)
    const boxHeight = innerPadding * 2 + titleSize + 8 + bodyHeight
    const position = resolveOverlayPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth: boxWidth,
      textHeight: boxHeight,
      position: options.position,
    })

    page.drawRectangle({
      x: position.x,
      y: position.y,
      width: boxWidth,
      height: boxHeight,
      color: rgb(tone.fill[0], tone.fill[1], tone.fill[2]),
      opacity: 0.92,
      borderColor: rgb(tone.border[0], tone.border[1], tone.border[2]),
      borderWidth: 1.5,
      borderOpacity: 0.98,
    })

    page.drawText(title, {
      x: position.x + innerPadding,
      y: position.y + boxHeight - innerPadding - titleSize,
      size: titleSize,
      font: titleFont,
      color: rgb(tone.title[0], tone.title[1], tone.title[2]),
    })

    for (const [lineIndex, line] of bodyLines.entries()) {
      page.drawText(line, {
        x: position.x + innerPadding,
        y: position.y + boxHeight - innerPadding - titleSize - 8 - bodySize - lineIndex * lineHeight,
        size: bodySize,
        font: bodyFont,
        color: rgb(tone.body[0], tone.body[1], tone.body[2]),
      })
    }
  }

  return saveDocument(document)
}

export async function addPageNumbersToDocument(
  bytes: Uint8Array,
  options: {
    startNumber: number
    pageIndexes: number[]
    position: PageNumberPosition
  },
) {
  const { StandardFonts, rgb } = await getPdfLib()
  const document = await loadDocument(bytes)
  const font = await document.embedFont(StandardFonts.Helvetica)
  const pageIndexes = normalizePageIndexes(options.pageIndexes, document.getPageCount())
  const startNumber = Math.max(1, Math.floor(options.startNumber))

  for (const [offset, pageIndex] of pageIndexes.entries()) {
    const label = String(startNumber + offset)
    const page = document.getPage(pageIndex)
    const { width, height } = page.getSize()
    const size = clampNumber(Math.min(width, height) * 0.022, 11, 16)
    const textWidth = font.widthOfTextAtSize(label, size)
    const position = resolvePageNumberPosition({
      pageWidth: width,
      pageHeight: height,
      textWidth,
      textHeight: size,
      position: options.position,
    })

    page.drawText(label, {
      x: position.x,
      y: position.y,
      size,
      font,
      color: rgb(0.41, 0.45, 0.54),
    })
  }

  return saveDocument(document)
}

async function embedSupportedImage(
  document: Awaited<ReturnType<typeof loadDocument>>,
  bytes: Uint8Array,
) {
  if (isPng(bytes)) {
    return document.embedPng(bytes)
  }

  if (isJpeg(bytes)) {
    return document.embedJpg(bytes)
  }

  throw new Error('Only PNG and JPEG image stamps are supported right now.')
}

function isPng(bytes: Uint8Array) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function inferAttachmentMimeType(fileName: string) {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''

  switch (extension) {
    case 'txt':
      return 'text/plain'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'pdf':
      return 'application/pdf'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'zip':
      return 'application/zip'
    case 'doc':
      return 'application/msword'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'ppt':
      return 'application/vnd.ms-powerpoint'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    default:
      return 'application/octet-stream'
  }
}

function wrapTextToWidth(
  text: string,
  font: LayoutFontMetrics,
  size: number,
  maxWidth: number,
  maxLines: number,
) {
  const lines: string[] = []

  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      continue
    }

    let currentLine = ''
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word
      if (!currentLine || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        currentLine = candidate
      } else {
        lines.push(currentLine)
        currentLine = word
      }
    }

    if (currentLine) {
      lines.push(currentLine)
    }
  }

  if (lines.length <= maxLines) {
    return lines
  }

  const visibleLines = lines.slice(0, maxLines)
  const overflowText = [visibleLines[maxLines - 1], ...lines.slice(maxLines)].join(' ')
  visibleLines[maxLines - 1] = ellipsizeText(overflowText, font, size, maxWidth)
  return visibleLines
}

function ellipsizeText(
  text: string,
  font: LayoutFontMetrics,
  size: number,
  maxWidth: number,
) {
  const normalized = text.trim()
  if (!normalized) {
    return '...'
  }

  let candidate = normalized
  while (candidate.length > 1 && font.widthOfTextAtSize(`${candidate}...`, size) > maxWidth) {
    candidate = candidate.slice(0, -1).trimEnd()
  }

  return candidate === normalized ? candidate : `${candidate}...`
}

function resolveReviewTone(tone: ReviewNoteTone) {
  switch (tone) {
    case 'blue':
      return {
        fill: [0.12, 0.2, 0.33],
        border: [0.43, 0.66, 0.95],
        title: [0.9, 0.95, 1],
        body: [0.84, 0.9, 0.98],
      }
    case 'green':
      return {
        fill: [0.1, 0.22, 0.18],
        border: [0.43, 0.79, 0.61],
        title: [0.92, 0.98, 0.94],
        body: [0.84, 0.95, 0.88],
      }
    case 'rose':
      return {
        fill: [0.28, 0.16, 0.2],
        border: [0.93, 0.57, 0.67],
        title: [1, 0.93, 0.95],
        body: [0.97, 0.86, 0.89],
      }
    case 'amber':
    default:
      return {
        fill: [0.29, 0.2, 0.08],
        border: [0.95, 0.74, 0.34],
        title: [1, 0.96, 0.88],
        body: [0.98, 0.91, 0.78],
      }
  }
}

function normalizeKeywordsForDraft(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  if (normalized.includes(',')) {
    return normalized
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .join(', ')
}
