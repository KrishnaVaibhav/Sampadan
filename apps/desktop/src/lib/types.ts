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
  integrityStatus: 'not-checked' | 'verified' | 'failed' | 'unsupported' | 'unavailable' | 'missing-data'
  integrityMessage: string | null
  certificateTrustStatus: 'not-checked' | 'trusted' | 'self-signed' | 'untrusted' | 'unavailable' | 'missing-data'
  certificateTrustMessage: string | null
  certificates: PdfCertificateSummary[]
  notes: string[]
}

export interface PdfCertificateSummary {
  subject: string | null
  subjectCommonName: string | null
  issuer: string | null
  issuerCommonName: string | null
  serialNumber: string | null
  notBefore: string | null
  notAfter: string | null
  sha256Fingerprint: string | null
  validityStatus: 'current' | 'expired-or-not-current' | string
  selfSigned: boolean
  notes: string[]
}

export interface PdfSignatureValidationRuntime {
  available: boolean
  binaryPath: string | null
  version: string | null
  missingReason: string | null
}

export interface PdfAttachmentSummary {
  fileName: string | null
  description: string | null
  relationship: string | null
  embedded: boolean
  notes: string[]
}

export interface ExtractedPdfAttachmentPayload {
  fileName: string
  description: string | null
  relationship: string | null
  bytesBase64: string
  notes: string[]
}

export interface PdfEncryptionSummary {
  encrypted: boolean
  handler: string | null
  algorithm: string | null
  version: number | null
  revision: number | null
  keyLengthBits: number | null
  permissions: number | null
  streamFilter: string | null
  stringFilter: string | null
  encryptMetadata: boolean | null
  notes: string[]
}

export interface PdfTrustReport {
  signatureCount: number
  signatures: PdfSignatureSummary[]
  signatureValidationRuntime: PdfSignatureValidationRuntime | null
  attachmentCount: number
  attachments: PdfAttachmentSummary[]
  encryption: PdfEncryptionSummary
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

export interface LoadedFileBytesPayload {
  fileName: string
  bytesBase64: string
}

export type PdfProtectionPrintAccess = 'none' | 'low' | 'full'
export type PdfProtectionModifyAccess = 'none' | 'assembly' | 'form' | 'annotate' | 'all'

export interface PdfProtectionOptionsPayload {
  userPassword: string | null
  ownerPassword: string
  print: PdfProtectionPrintAccess
  modify: PdfProtectionModifyAccess
  allowExtract: boolean
  encryptMetadata: boolean
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

export interface QpdfStatusPayload {
  available: boolean
  binaryPath: string | null
  version: string | null
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
