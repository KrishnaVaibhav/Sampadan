import { cleanup } from '@testing-library/svelte'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

Object.defineProperty(window, 'devicePixelRatio', {
  configurable: true,
  value: 1,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({})
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  configurable: true,
  value: () => 'data:image/jpeg;base64,ZmFrZQ=='
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  configurable: true,
  value(callback: BlobCallback) {
    callback(new Blob(['fake-image'], { type: 'image/png' }))
  }
})
