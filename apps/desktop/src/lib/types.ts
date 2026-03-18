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

export interface LoadedPdfPayload {
  path: string | null
  fileName: string
  size: number
  version: string
  bytesBase64: string
  flags: PdfFlags
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

export interface WorkspaceDocument {
  path: string | null
  fileName: string
  version: string
  byteLength: number
  bytes: Uint8Array
  pageCount: number
  flags: PdfFlags
  modified: boolean
  source: 'disk' | 'generated'
}
