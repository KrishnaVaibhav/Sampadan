export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'))
        return
      }

      resolve(result.split(',')[1] ?? '')
    }

    reader.readAsDataURL(blob)
  })
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`

  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}

export function withoutExtension(fileName: string): string {
  const parts = fileName.split('.')
  if (parts.length <= 1) return fileName
  parts.pop()
  return parts.join('.')
}

export function withExtension(fileName: string, extension: string): string {
  const normalized = extension.startsWith('.') ? extension : `.${extension}`
  return `${withoutExtension(fileName)}${normalized}`
}

export function joinPath(directory: string, fileName: string): string {
  const separator = directory.includes('\\') ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${fileName}`
}

export function parsePageSelection(expression: string, pageCount: number): number[] {
  const tokens = expression
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    throw new Error('Enter one or more pages, for example 1-3, 5, 8-10.')
  }

  const pages = new Set<number>()

  for (const token of tokens) {
    const single = token.match(/^(\d+)$/)
    if (single) {
      const value = Number(single[1])
      assertPageBounds(value, pageCount)
      pages.add(value)
      continue
    }

    const range = token.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      assertPageBounds(start, pageCount)
      assertPageBounds(end, pageCount)

      const lower = Math.min(start, end)
      const upper = Math.max(start, end)
      for (let value = lower; value <= upper; value += 1) {
        pages.add(value)
      }
      continue
    }

    throw new Error(`Invalid page selection token "${token}". Use values like 2 or 4-9.`)
  }

  return [...pages].sort((left, right) => left - right)
}

function assertPageBounds(pageNumber: number, pageCount: number) {
  if (pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(`Page ${pageNumber} is outside this document. Valid pages are 1-${pageCount}.`)
  }
}
