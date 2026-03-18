import { invoke } from '@tauri-apps/api/core'

import { blobToBase64 } from '../pdf-utils'
import type { OcrPdfResultPayload, OcrStatusPayload, OcrTextResultPayload } from '../types'

export function fetchOcrStatus(): Promise<OcrStatusPayload> {
  return invoke<OcrStatusPayload>('get_ocr_status')
}

export async function runOcrForBlob(
  blob: Blob,
  options: {
    language?: string
    sourceLabel?: string
  } = {},
): Promise<OcrTextResultPayload> {
  return invoke<OcrTextResultPayload>('run_ocr_image', {
    bytes_base64: await blobToBase64(blob),
    language: options.language?.trim() ? options.language.trim() : null,
    source_label: options.sourceLabel ?? null,
  })
}

export async function runOcrPdfForBlob(
  blob: Blob,
  options: {
    language?: string
    sourceLabel?: string
  } = {},
): Promise<OcrPdfResultPayload> {
  return invoke<OcrPdfResultPayload>('run_ocr_pdf', {
    bytes_base64: await blobToBase64(blob),
    language: options.language?.trim() ? options.language.trim() : null,
    source_label: options.sourceLabel ?? null,
  })
}
