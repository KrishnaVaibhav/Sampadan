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
