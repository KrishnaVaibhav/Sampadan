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
