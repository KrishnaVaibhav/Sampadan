export interface PdfFlags {
  encrypted: boolean
  signed: boolean
  hasForms: boolean
  hasXfa: boolean
  hasJavascript: boolean
  hasAttachments: boolean
  tagged: boolean
  linearized: boolean
  likelyScanned: boolean
  mixedContent: boolean
}

export interface PdfSignatureSummary {
  fieldName: string | null
  signerName: string | null
  reason: string | null
  location: string | null
  contactInfo: string | null
  modificationTime: string | null
  filter: string | null
  subFilter: string | null
  byteRange: number[] | null
  coversWholeDocument: boolean
  isTimestamp: boolean
  docMdp: boolean
  notes: string[]
}

export interface PdfTrustReport {
  signatureCount: number
  signatures: PdfSignatureSummary[]
  recommendations: string[]
}

export interface LoadedPdfPayload {
  path: string | null
  fileName: string
  size: number
  version: string
  bytesBase64: string
  flags: PdfFlags
  trustReport: PdfTrustReport
}

export interface PdfMetadataDraft {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
}

export interface PageThumbnail {
  pageNumber: number
  dataUrl: string
  width: number
  height: number
}

export interface OcrStatusPayload {
  available: boolean
  binaryPath: string | null
  version: string | null
  languages: string[]
  recommendedLanguage: string | null
  missingReason: string | null
}

export interface OcrTextResultPayload {
  language: string
  text: string
  durationMs: number
  sourceLabel: string
}

export interface OcrPdfResultPayload {
  language: string
  bytesBase64: string
  durationMs: number
  sourceLabel: string
}

export interface WorkspaceDocument {
  path: string | null
  fileName: string
  version: string
  byteLength: number
  bytes: Uint8Array
  pageCount: number
  flags: PdfFlags
  trustReport: PdfTrustReport
  modified: boolean
  source: 'disk' | 'generated'
}
