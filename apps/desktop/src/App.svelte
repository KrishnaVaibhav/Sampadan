<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'

  import { fetchOcrStatus, runOcrForBlob, runOcrPdfForBlob } from './lib/ocr/ocr-client'
  import { type PdfProxy, loadPdfProxy } from './lib/pdf-engine'
  import {
    applyMetadataToDocument,
    deletePageFromDocument,
    duplicatePageInDocument,
    extractPagesFromDocument,
    insertBlankPageAfterCurrent,
    mergeDocuments,
    movePageInDocument,
    readMetadataFromDocument,
    rotatePageInDocument,
    splitDocumentIntoSinglePages,
  } from './lib/operations/pdf-document'
  import {
    base64ToBytes,
    blobToBase64,
    bytesToBase64,
    clamp,
    fileNameFromPath,
    formatBytes,
    joinPath,
    parsePageSelection,
    withExtension,
    withoutExtension,
  } from './lib/pdf-utils'
  import { loadRecentPaths, rememberRecentPath } from './lib/session/recent-files'
  import type {
    LoadedPdfPayload,
    OcrStatusPayload,
    PageThumbnail,
    PdfFlags,
    PdfMetadataDraft,
    PdfTrustReport,
    WorkspaceDocument,
  } from './lib/types'
  import { extractDocumentText, generatePageThumbnails, renderPdfPageToCanvas } from './lib/viewer/pdf-viewer'

  const emptyFlags: PdfFlags = {
    encrypted: false,
    signed: false,
    hasForms: false,
    hasXfa: false,
    hasJavascript: false,
    hasAttachments: false,
    tagged: false,
    linearized: false,
    likelyScanned: false,
    mixedContent: false,
  }

  const emptyMetadata = (): PdfMetadataDraft => ({
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
  })

  let viewerCanvas: HTMLCanvasElement | null = null
  let viewerPane: HTMLDivElement | null = null
  let pdfProxy: PdfProxy | null = null
  let workspace: WorkspaceDocument | null = null
  let currentPage = 1
  let zoom = 1.1
  let busy = false
  let status = 'Choose a PDF to start a private local session.'
  let statusTone: 'idle' | 'busy' | 'error' = 'idle'
  let lastError: string | null = null
  let recentPaths: string[] = []
  let renderToken = 0
  let thumbnailToken = 0
  let metadataToken = 0
  let thumbnails: PageThumbnail[] = []
  let rangeExpression = '1'
  let metadataDraft = emptyMetadata()
  let metadataDirty = false
  let dragSourcePage: number | null = null
  let dropTargetPage: number | null = null
  let ocrStatus: OcrStatusPayload | null = null
  let ocrLanguage = 'eng'
  let ocrPreview = ''
  let ocrPreviewLabel = 'No OCR text yet'
  let ocrLastDurationMs: number | null = null

  $: pageItems = workspace ? Array.from({ length: workspace.pageCount }, (_, index) => index + 1) : []
  $: currentZoomLabel = `${Math.round(zoom * 100)}%`
  $: thumbnailMap = new Map(thumbnails.map((thumbnail) => [thumbnail.pageNumber, thumbnail]))
  $: ocrAvailableLanguages = ocrStatus?.languages ?? []
  $: ocrReady = ocrStatus?.available ?? false
  $: signatureSummaries = workspace?.trustReport.signatures ?? []
  $: signatureValidationRuntime = workspace?.trustReport.signatureValidationRuntime ?? null
  $: attachmentSummaries = workspace?.trustReport.attachments ?? []
  $: encryptionSummary = workspace?.trustReport.encryption ?? null
  $: trustRecommendations = workspace?.trustReport.recommendations ?? []
  $: inspectorFlags = workspace
    ? [
        { label: 'Encrypted', active: workspace.flags.encrypted },
        { label: 'Signed', active: workspace.flags.signed },
        { label: 'Forms', active: workspace.flags.hasForms },
        { label: 'XFA', active: workspace.flags.hasXfa },
        { label: 'JavaScript', active: workspace.flags.hasJavascript },
        { label: 'Attachments', active: workspace.flags.hasAttachments },
        { label: 'Tagged', active: workspace.flags.tagged },
        { label: 'Linearized', active: workspace.flags.linearized },
        { label: 'Likely scanned', active: workspace.flags.likelyScanned },
        { label: 'Mixed content', active: workspace.flags.mixedContent },
      ]
    : []

  onMount(() => {
    recentPaths = loadRecentPaths()
    void refreshOcrStatus()

    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey

      if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openPdfFlow()
      }

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveWorkspace(event.shiftKey)
      }

      if (!modifier && workspace && event.key === 'ArrowLeft') {
        event.preventDefault()
        void goToPage(currentPage - 1)
      }

      if (!modifier && workspace && event.key === 'ArrowRight') {
        event.preventDefault()
        void goToPage(currentPage + 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      void pdfProxy?.destroy()
    }
  })

  async function openPdfFlow() {
    if (busy) return

    const selection = await openDialog({
      multiple: false,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    const [path] = normalizeSelection(selection)
    if (!path) return

    await openPdfByPath(path)
  }

  async function openPdfByPath(path: string, preferredPage = 1) {
    busy = true
    statusTone = 'busy'
    status = `Opening ${fileNameFromPath(path)}`
    lastError = null

    try {
      const payload = await invoke<LoadedPdfPayload>('load_pdf', { path })
      recentPaths = rememberRecentPath(recentPaths, path)
      await loadPayload(payload, {
        current: preferredPage,
        modified: false,
        source: 'disk',
      })
      statusTone = 'idle'
      status = `Loaded ${payload.fileName}`
    } catch (error) {
      reportError(error, `Failed to open ${fileNameFromPath(path)}`)
    } finally {
      busy = false
    }
  }

  async function mergeAdditionalPdfs() {
    if (busy) return

    const selection = await openDialog({
      multiple: true,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    const paths = normalizeSelection(selection)
    if (paths.length === 0) return

    busy = true
    statusTone = 'busy'
    status = `Merging ${paths.length} PDF${paths.length > 1 ? 's' : ''}`
    lastError = null

    try {
      const buffers: Uint8Array[] = workspace ? [workspace.bytes] : []
      for (const path of paths) {
        const payload = await invoke<LoadedPdfPayload>('load_pdf', { path })
        buffers.push(base64ToBytes(payload.bytesBase64))
      }

      const mergedBytes = await mergeDocuments(buffers)
      await commitGeneratedPdf(mergedBytes, {
        fileName: workspace ? workspace.fileName : 'merged.pdf',
        current: workspace ? currentPage : 1,
      })
      statusTone = 'idle'
      status = `Merged ${paths.length} PDF${paths.length > 1 ? 's' : ''}`
    } catch (error) {
      reportError(error, 'Failed to merge PDFs')
    } finally {
      busy = false
    }
  }

  async function rotateCurrentPage(delta: number) {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: delta > 0 ? 'Rotating page right' : 'Rotating page left',
      successStatus: `Rotated page ${currentPage}`,
      errorStatus: 'Failed to rotate the current page',
      nextCurrentPage: currentPage,
      mutate: () => rotatePageInDocument(currentWorkspace.bytes, currentPage - 1, delta),
    })
  }

  async function moveCurrentPage(offset: number) {
    if (!workspace || busy) return

    const sourceIndex = currentPage - 1
    const targetIndex = clamp(sourceIndex + offset, 0, workspace.pageCount - 1)
    if (sourceIndex === targetIndex) return

    await movePageTo(currentPage, targetIndex + 1)
  }

  async function movePageTo(sourcePageNumber: number, targetPageNumber: number) {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    const sourceIndex = sourcePageNumber - 1
    const targetIndex = targetPageNumber - 1
    if (sourceIndex === targetIndex) return

    await runDocumentMutation({
      workingStatus: `Reordering page ${sourcePageNumber}`,
      successStatus: `Moved page to position ${targetPageNumber}`,
      errorStatus: 'Failed to reorder pages',
      nextCurrentPage: targetPageNumber,
      mutate: () => movePageInDocument(currentWorkspace.bytes, sourceIndex, targetIndex),
    })
  }

  async function duplicateCurrentPage() {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: `Duplicating page ${currentPage}`,
      successStatus: `Duplicated page ${currentPage}`,
      errorStatus: 'Failed to duplicate the current page',
      nextCurrentPage: currentPage + 1,
      mutate: () => duplicatePageInDocument(currentWorkspace.bytes, currentPage - 1),
    })
  }

  async function deleteCurrentPage() {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: `Deleting page ${currentPage}`,
      successStatus: `Deleted page ${currentPage}`,
      errorStatus: 'Failed to delete the current page',
      nextCurrentPage: Math.min(currentPage, currentWorkspace.pageCount - 1),
      mutate: () => deletePageFromDocument(currentWorkspace.bytes, currentPage - 1),
    })
  }

  async function insertBlankAfterCurrentPage() {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: `Adding blank page after ${currentPage}`,
      successStatus: `Inserted blank page after ${currentPage}`,
      errorStatus: 'Failed to insert a blank page',
      nextCurrentPage: currentPage + 1,
      mutate: () => insertBlankPageAfterCurrent(currentWorkspace.bytes, currentPage - 1),
    })
  }

  async function extractCurrentPage() {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: `Extracting page ${currentPage}`,
      successStatus: `Extracted page ${currentPage}`,
      errorStatus: 'Failed to extract the current page',
      nextCurrentPage: 1,
      fileName: `${withoutExtension(currentWorkspace.fileName)}-page-${String(currentPage).padStart(3, '0')}.pdf`,
      mutate: () => extractPagesFromDocument(currentWorkspace.bytes, [currentPage - 1]),
    })
  }

  async function extractSelectedRange() {
    if (!workspace || busy) return
    const currentWorkspace = workspace

    let pages: number[] = []
    try {
      pages = parsePageSelection(rangeExpression, currentWorkspace.pageCount)
    } catch (error) {
      reportError(error, 'Invalid page range')
      return
    }

    await runDocumentMutation({
      workingStatus: `Extracting pages ${rangeExpression}`,
      successStatus: `Extracted pages ${rangeExpression}`,
      errorStatus: 'Failed to extract the selected range',
      nextCurrentPage: 1,
      fileName: `${withoutExtension(currentWorkspace.fileName)}-range.pdf`,
      mutate: () => extractPagesFromDocument(currentWorkspace.bytes, pages.map((pageNumber) => pageNumber - 1)),
    })
  }

  async function splitIntoSinglePageFiles() {
    if (!workspace || busy) return

    const selection = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose output folder',
    })
    const [directory] = normalizeSelection(selection)
    if (!directory) return

    busy = true
    statusTone = 'busy'
    status = `Splitting ${workspace.pageCount} pages`
    lastError = null

    try {
      const segments = await splitDocumentIntoSinglePages(workspace.bytes)

      for (let index = 0; index < segments.length; index += 1) {
        const fileName = `${withoutExtension(workspace.fileName)}-page-${String(index + 1).padStart(3, '0')}.pdf`
        await invoke('save_file_bytes', {
          path: joinPath(directory, fileName),
          bytesBase64: bytesToBase64(segments[index]),
        })
      }

      statusTone = 'idle'
      status = `Created ${segments.length} single-page PDFs`
    } catch (error) {
      reportError(error, 'Failed to split the PDF into single pages')
    } finally {
      busy = false
    }
  }

  async function saveWorkspace(saveAs = false) {
    if (!workspace || busy) return

    busy = true
    statusTone = 'busy'
    status = saveAs ? 'Preparing Save As' : 'Saving document'
    lastError = null

    try {
      let targetPath = workspace.path

      if (saveAs || !targetPath) {
        targetPath = await saveDialog({
          defaultPath: workspace.path ?? workspace.fileName,
          filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
        })
      }

      if (!targetPath) {
        statusTone = 'idle'
        status = 'Save cancelled'
        return
      }

      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: bytesToBase64(workspace.bytes),
      })

      await openPdfByPath(targetPath, currentPage)
      statusTone = 'idle'
      status = `Saved ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to save the PDF')
    } finally {
      busy = false
    }
  }

  async function exportCurrentPagePng() {
    if (!workspace || !pdfProxy || busy) return

    busy = true
    statusTone = 'busy'
    status = `Exporting page ${currentPage} as PNG`
    lastError = null

    try {
      const canvas = document.createElement('canvas')
      await renderPdfPageToCanvas(pdfProxy, currentPage, Math.max(zoom, 2), canvas)
      const blob = await canvasToBlob(canvas)
      const targetPath = await saveDialog({
        defaultPath: `${withoutExtension(workspace.fileName)}-page-${String(currentPage).padStart(3, '0')}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      })

      if (!targetPath) {
        statusTone = 'idle'
        status = 'PNG export cancelled'
        return
      }

      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: await blobToBase64(blob),
      })

      statusTone = 'idle'
      status = `Exported ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to export the current page')
    } finally {
      busy = false
    }
  }

  async function exportAllPagesPng() {
    if (!workspace || !pdfProxy || busy) return

    const selection = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose output folder',
    })
    const [directory] = normalizeSelection(selection)
    if (!directory) return

    busy = true
    statusTone = 'busy'
    status = `Exporting ${workspace.pageCount} pages as PNG`
    lastError = null

    try {
      for (let pageNumber = 1; pageNumber <= workspace.pageCount; pageNumber += 1) {
        const canvas = document.createElement('canvas')
        await renderPdfPageToCanvas(pdfProxy, pageNumber, 2, canvas)
        const blob = await canvasToBlob(canvas)
        const fileName = `${withoutExtension(workspace.fileName)}-page-${String(pageNumber).padStart(3, '0')}.png`

        await invoke('save_file_bytes', {
          path: joinPath(directory, fileName),
          bytesBase64: await blobToBase64(blob),
        })
      }

      statusTone = 'idle'
      status = `Exported ${workspace.pageCount} page PNGs`
    } catch (error) {
      reportError(error, 'Failed to export page PNGs')
    } finally {
      busy = false
    }
  }

  async function exportDocumentTextToFile() {
    if (!workspace || !pdfProxy || busy) return

    busy = true
    statusTone = 'busy'
    status = 'Extracting document text'
    lastError = null

    try {
      const text = await extractDocumentText(pdfProxy)
      const targetPath = await saveDialog({
        defaultPath: `${withoutExtension(workspace.fileName)}.txt`,
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      })

      if (!targetPath) {
        statusTone = 'idle'
        status = 'Text export cancelled'
        return
      }

      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: bytesToBase64(new TextEncoder().encode(text)),
      })

      statusTone = 'idle'
      status = `Exported ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to export document text')
    } finally {
      busy = false
    }
  }

  async function exportTrustReport() {
    if (!workspace || busy) return

    busy = true
    statusTone = 'busy'
    status = 'Preparing trust report export'
    lastError = null

    try {
      const targetPath = await saveDialog({
        defaultPath: `${withoutExtension(workspace.fileName)}-trust-report.json`,
        filters: [{ name: 'JSON file', extensions: ['json'] }],
      })

      if (!targetPath) {
        statusTone = 'idle'
        status = 'Trust report export cancelled'
        return
      }

      const report = JSON.stringify(buildTrustReportPayload(workspace), null, 2)
      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: bytesToBase64(new TextEncoder().encode(report)),
      })

      statusTone = 'idle'
      status = `Exported ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to export the trust report')
    } finally {
      busy = false
    }
  }

  async function refreshOcrStatus() {
    try {
      const nextStatus = await fetchOcrStatus()
      ocrStatus = nextStatus

      if (
        !ocrLanguage.trim() ||
        (nextStatus.recommendedLanguage && !nextStatus.languages.includes(ocrLanguage))
      ) {
        ocrLanguage = nextStatus.recommendedLanguage ?? 'eng'
      }
    } catch (error) {
      ocrStatus = {
        available: false,
        binaryPath: null,
        version: null,
        languages: [],
        recommendedLanguage: 'eng',
        missingReason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function ocrCurrentPage() {
    if (!workspace || !pdfProxy || busy) return

    const language = resolveOcrLanguage()
    if (!ocrReady) {
      reportError(ocrStatus?.missingReason ?? 'Install Tesseract to enable local OCR.', 'OCR is unavailable')
      return
    }

    busy = true
    statusTone = 'busy'
    status = `Running OCR on page ${currentPage}`
    lastError = null

    try {
      const blob = await renderPageBlob(currentPage, getOcrRenderScale())
      const result = await runOcrForBlob(blob, {
        language,
        sourceLabel: `${workspace.fileName} page ${currentPage}`,
      })

      ocrLanguage = result.language
      ocrLastDurationMs = result.durationMs
      ocrPreviewLabel = `OCR preview for page ${currentPage}`
      ocrPreview = buildOcrPreview([{ pageNumber: currentPage, text: result.text }])
      statusTone = 'idle'
      status = `OCR complete for page ${currentPage}`
    } catch (error) {
      reportError(error, 'Failed to OCR the current page')
    } finally {
      busy = false
    }
  }

  async function ocrWholeDocument() {
    if (!workspace || !pdfProxy || busy) return

    const language = resolveOcrLanguage()
    if (!ocrReady) {
      reportError(ocrStatus?.missingReason ?? 'Install Tesseract to enable local OCR.', 'OCR is unavailable')
      return
    }

    busy = true
    statusTone = 'busy'
    status = `Running OCR on ${workspace.pageCount} pages`
    lastError = null

    try {
      const results: Array<{ pageNumber: number; text: string }> = []

      for (let pageNumber = 1; pageNumber <= workspace.pageCount; pageNumber += 1) {
        status = `Running OCR on page ${pageNumber} of ${workspace.pageCount}`

        const blob = await renderPageBlob(pageNumber, getOcrRenderScale())
        const result = await runOcrForBlob(blob, {
          language,
          sourceLabel: `${workspace.fileName} page ${pageNumber}`,
        })

        results.push({
          pageNumber,
          text: result.text,
        })

        ocrLanguage = result.language
        ocrLastDurationMs = result.durationMs
        ocrPreviewLabel = `OCR preview for ${results.length} of ${workspace.pageCount} pages`
        ocrPreview = buildOcrPreview(results)
        await tick()
      }

      statusTone = 'idle'
      status = `OCR complete for ${workspace.pageCount} pages`
    } catch (error) {
      reportError(error, 'Failed to OCR the full document')
    } finally {
      busy = false
    }
  }

  async function exportOcrPreviewToFile() {
    if (!workspace || !ocrPreview || busy) return

    busy = true
    statusTone = 'busy'
    status = 'Preparing OCR text export'
    lastError = null

    try {
      const targetPath = await saveDialog({
        defaultPath: `${withoutExtension(workspace.fileName)}-ocr.txt`,
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      })

      if (!targetPath) {
        statusTone = 'idle'
        status = 'OCR text export cancelled'
        return
      }

      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: bytesToBase64(new TextEncoder().encode(ocrPreview)),
      })

      statusTone = 'idle'
      status = `Exported ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to export OCR text')
    } finally {
      busy = false
    }
  }

  async function createSearchableCopy() {
    if (!workspace || !pdfProxy || busy) return

    const language = resolveOcrLanguage()
    if (!ocrReady) {
      reportError(ocrStatus?.missingReason ?? 'Install Tesseract to enable local OCR.', 'OCR is unavailable')
      return
    }

    busy = true
    statusTone = 'busy'
    status = `Creating searchable PDF from ${workspace.pageCount} pages`
    lastError = null

    try {
      const searchablePages: Uint8Array[] = []

      for (let pageNumber = 1; pageNumber <= workspace.pageCount; pageNumber += 1) {
        status = `Creating searchable page ${pageNumber} of ${workspace.pageCount}`

        const blob = await renderPageBlob(pageNumber, getOcrRenderScale())
        const result = await runOcrPdfForBlob(blob, {
          language,
          sourceLabel: `${workspace.fileName} searchable page ${pageNumber}`,
        })

        searchablePages.push(base64ToBytes(result.bytesBase64))
        ocrLanguage = result.language
        ocrLastDurationMs = result.durationMs
        ocrPreviewLabel = `Searchable OCR generation ${pageNumber}/${workspace.pageCount}`
        await tick()
      }

      const mergedBytes = await mergeDocuments(searchablePages)
      await commitGeneratedPdf(mergedBytes, {
        fileName: `${withoutExtension(workspace.fileName)}-searchable.pdf`,
        current: currentPage,
      })

      statusTone = 'idle'
      status = `Created searchable copy for ${workspace.fileName}`
    } catch (error) {
      reportError(error, 'Failed to create a searchable PDF copy')
    } finally {
      busy = false
    }
  }

  async function applyMetadata() {
    if (!workspace || busy || !metadataDirty) return
    const currentWorkspace = workspace

    const applied = await runDocumentMutation({
      workingStatus: 'Applying document metadata',
      successStatus: 'Updated PDF metadata',
      errorStatus: 'Failed to update document metadata',
      nextCurrentPage: currentPage,
      mutate: () => applyMetadataToDocument(currentWorkspace.bytes, metadataDraft),
    })

    if (applied) {
      metadataDirty = false
    }
  }

  async function runDocumentMutation(options: {
    workingStatus: string
    successStatus: string
    errorStatus: string
    nextCurrentPage: number
    fileName?: string
    mutate: () => Promise<Uint8Array>
  }): Promise<boolean> {
    if (!workspace || busy) return false

    busy = true
    statusTone = 'busy'
    status = options.workingStatus
    lastError = null

    try {
      const bytes = await options.mutate()
      await commitGeneratedPdf(bytes, {
        fileName: options.fileName ?? workspace.fileName,
        current: options.nextCurrentPage,
      })
      statusTone = 'idle'
      status = options.successStatus
      return true
    } catch (error) {
      reportError(error, options.errorStatus)
      return false
    } finally {
      busy = false
    }
  }

  async function goToPage(pageNumber: number) {
    if (!workspace) return

    currentPage = clamp(pageNumber, 1, workspace.pageCount)
    await renderCurrentPage()
  }

  async function zoomBy(step: number) {
    zoom = clamp(zoom + step, 0.45, 3.5)
    await renderCurrentPage()
  }

  async function fitToPane() {
    if (!workspace || !pdfProxy || !viewerPane) return

    const page = await pdfProxy.getPage(currentPage)
    const baseViewport = page.getViewport({ scale: 1 })
    const availableWidth = Math.max(viewerPane.clientWidth - 48, 320)

    zoom = clamp(availableWidth / baseViewport.width, 0.45, 3.5)
    await tick()
    await renderCurrentPage()
  }

  async function renderCurrentPage() {
    if (!workspace || !viewerCanvas || !pdfProxy) return

    const token = ++renderToken
    await renderPdfPageToCanvas(pdfProxy, currentPage, zoom, viewerCanvas)

    if (token !== renderToken) {
      return
    }
  }

  async function commitGeneratedPdf(
    bytes: Uint8Array,
    options: {
      fileName: string
      current: number
    },
  ) {
    const payload = await invoke<LoadedPdfPayload>('inspect_pdf_bytes', {
      fileName: options.fileName,
      bytesBase64: bytesToBase64(bytes),
    })

    await loadPayload(payload, {
      current: options.current,
      modified: true,
      source: 'generated',
      path: null,
    })
  }

  async function loadPayload(
    payload: LoadedPdfPayload,
    options: {
      current?: number
      modified?: boolean
      source?: 'disk' | 'generated'
      path?: string | null
    } = {},
  ) {
    const bytes = base64ToBytes(payload.bytesBase64)
    const nextProxy = await loadPdfProxy(bytes.slice())

    if (pdfProxy) {
      await pdfProxy.destroy()
    }

    pdfProxy = nextProxy
    workspace = {
      path: options.path ?? payload.path,
      fileName: payload.fileName,
      version: payload.version,
      byteLength: payload.size,
      bytes,
      pageCount: nextProxy.numPages,
      flags: payload.flags,
      trustReport: payload.trustReport,
      modified: options.modified ?? false,
      source: options.source ?? (payload.path ? 'disk' : 'generated'),
    }

    currentPage = clamp(options.current ?? 1, 1, nextProxy.numPages)
    rangeExpression = String(currentPage)
    thumbnails = []
    metadataDraft = emptyMetadata()
    metadataDirty = false
    ocrPreview = ''
    ocrPreviewLabel = 'No OCR text yet'
    ocrLastDurationMs = null
    await tick()
    await renderCurrentPage()
    void refreshWorkspaceContext(nextProxy, bytes)
  }

  async function refreshWorkspaceContext(proxy: PdfProxy, bytes: Uint8Array) {
    const nextMetadataToken = ++metadataToken
    const nextThumbnailToken = ++thumbnailToken

    try {
      const metadata = await readMetadataFromDocument(bytes)
      if (nextMetadataToken === metadataToken) {
        metadataDraft = metadata
        metadataDirty = false
      }
    } catch {
      if (nextMetadataToken === metadataToken) {
        metadataDraft = emptyMetadata()
        metadataDirty = false
      }
    }

    try {
      const nextThumbnails = await generatePageThumbnails(proxy)
      if (nextThumbnailToken === thumbnailToken) {
        thumbnails = nextThumbnails
      }
    } catch {
      if (nextThumbnailToken === thumbnailToken) {
        thumbnails = []
      }
    }
  }

  function updateMetadataField(field: keyof PdfMetadataDraft, value: string) {
    metadataDraft = {
      ...metadataDraft,
      [field]: value,
    }
    metadataDirty = true
  }

  function handlePageDragStart(pageNumber: number, event: DragEvent) {
    dragSourcePage = pageNumber
    dropTargetPage = null
    event.dataTransfer?.setData('text/plain', String(pageNumber))
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
    }
  }

  function handlePageDragEnter(pageNumber: number) {
    if (dragSourcePage && dragSourcePage !== pageNumber) {
      dropTargetPage = pageNumber
    }
  }

  function handlePageDragOver(event: DragEvent) {
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
  }

  async function handlePageDrop(pageNumber: number, event: DragEvent) {
    event.preventDefault()
    const source = Number(event.dataTransfer?.getData('text/plain') ?? dragSourcePage)
    clearDragState()

    if (!source || source === pageNumber) return
    await movePageTo(source, pageNumber)
  }

  function clearDragState() {
    dragSourcePage = null
    dropTargetPage = null
  }

  function resolveOcrLanguage() {
    const candidate = ocrLanguage.trim()
    if (candidate) {
      return candidate
    }

    return ocrStatus?.recommendedLanguage ?? 'eng'
  }

  function formatSignatureIntegrityLabel(status: string) {
    switch (status) {
      case 'verified':
        return 'Verified locally'
      case 'failed':
        return 'Verification failed'
      case 'unsupported':
        return 'Unsupported format'
      case 'unavailable':
        return 'Validator unavailable'
      case 'missing-data':
        return 'Missing signature data'
      default:
        return 'Not checked'
    }
  }

  function formatCertificateTrustLabel(status: string) {
    switch (status) {
      case 'trusted':
        return 'Trusted by local CA store'
      case 'self-signed':
        return 'Self-signed or local root missing'
      case 'untrusted':
        return 'Not trusted by local CA store'
      case 'unavailable':
        return 'Trust check unavailable'
      case 'missing-data':
        return 'No certificate chain'
      default:
        return 'Not checked'
    }
  }

  function buildTrustReportPayload(document: WorkspaceDocument): {
    fileName: string
    path: string | null
    version: string
    pageCount: number
    source: WorkspaceDocument['source']
    modified: boolean
    flags: PdfFlags
    trustReport: PdfTrustReport
    exportedAt: string
  } {
    return {
      fileName: document.fileName,
      path: document.path,
      version: document.version,
      pageCount: document.pageCount,
      source: document.source,
      modified: document.modified,
      flags: document.flags,
      trustReport: document.trustReport,
      exportedAt: new Date().toISOString(),
    }
  }

  function getOcrRenderScale() {
    const outputScale = window.devicePixelRatio || 1
    return 300 / 72 / outputScale
  }

  function buildOcrPreview(results: Array<{ pageNumber: number; text: string }>) {
    return results
      .map(({ pageNumber, text }) => {
        const normalized = text.trim()
        return `Page ${pageNumber}\n${normalized || '[No text detected]'}`
      })
      .join('\n\n')
  }

  async function renderPageBlob(pageNumber: number, scale: number) {
    if (!pdfProxy) {
      throw new Error('Open a PDF before running OCR.')
    }

    const canvas = document.createElement('canvas')
    await renderPdfPageToCanvas(pdfProxy, pageNumber, scale, canvas)
    return canvasToBlob(canvas)
  }

  function normalizeSelection(selection: string | string[] | null): string[] {
    if (!selection) return []
    return Array.isArray(selection) ? selection : [selection]
  }

  async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to produce PNG output'))
          return
        }

        resolve(blob)
      }, 'image/png')
    })
  }

  function reportError(error: unknown, fallback: string) {
    const detail = error instanceof Error ? error.message : String(error)
    statusTone = 'error'
    status = fallback
    lastError = detail
  }
</script>

<svelte:head>
  <title>Sampadan</title>
</svelte:head>

<div class="shell">
  <aside class="rail">
    <div class="brand card compact-card">
      <span class="eyebrow">Private Local PDF Workstation</span>
      <h1>Sampadan</h1>
      <p>Viewer-first local PDF editing, OCR, and trust inspection with on-device processing.</p>
    </div>

    <section class="card actions compact-card">
      <div class="section-head">
        <h2>Session</h2>
        <span class:busy-pill={busy} class="status-pill">{busy ? 'Busy' : 'Ready'}</span>
      </div>
      <div class="stack-actions">
        <button data-testid="open-pdf-button" on:click={openPdfFlow} disabled={busy}>Open PDF</button>
        <button on:click={mergeAdditionalPdfs} disabled={busy}>Merge PDFs</button>
        <button data-testid="save-pdf-button" on:click={() => saveWorkspace(false)} disabled={busy || !workspace}>Save</button>
        <button on:click={() => saveWorkspace(true)} disabled={busy || !workspace}>Save As</button>
        <button on:click={exportDocumentTextToFile} disabled={busy || !workspace}>Export Text</button>
        <button on:click={exportTrustReport} disabled={busy || !workspace}>Export Trust Report</button>
      </div>
    </section>

    <details class="card dock-panel page-tools" open>
      <summary class="dock-summary">
        <span>Document Tools</span>
        <small>{workspace ? `${workspace.pageCount} pages` : 'Idle'}</small>
      </summary>
      <div class="dock-body">
        <label class="field">
          <span class="field-label">Range</span>
          <input
            class="field-input"
            bind:value={rangeExpression}
            disabled={!workspace || busy}
            placeholder="1-3, 5, 8-10"
          />
        </label>
        <div class="tool-grid">
          <button on:click={extractSelectedRange} disabled={busy || !workspace}>Extract Range</button>
          <button on:click={splitIntoSinglePageFiles} disabled={busy || !workspace}>Split To Folder</button>
          <button on:click={duplicateCurrentPage} disabled={busy || !workspace}>Duplicate Page</button>
          <button on:click={deleteCurrentPage} disabled={busy || !workspace}>Delete Page</button>
          <button on:click={insertBlankAfterCurrentPage} disabled={busy || !workspace}>Blank After</button>
          <button on:click={exportAllPagesPng} disabled={busy || !workspace}>All Pages PNG</button>
        </div>
      </div>
    </details>

    <details class="card dock-panel recent-list">
      <summary class="dock-summary">
        <span>Recent Files</span>
        <small>{recentPaths.length}</small>
      </summary>
      <div class="dock-body">
        {#if recentPaths.length > 0}
          {#each recentPaths as path}
            <button class="recent-entry" on:click={() => openPdfByPath(path)} disabled={busy}>
              <strong>{fileNameFromPath(path)}</strong>
              <span>{path}</span>
            </button>
          {/each}
        {:else}
          <p class="muted">Recent files will appear here after your first local session.</p>
        {/if}
      </div>
    </details>
  </aside>

  <main class="workspace">
    <header class="topbar card compact-card">
      <div class="topbar-copy">
        <span class="eyebrow">Viewer Focus</span>
        <h2>{workspace ? workspace.fileName : 'No PDF loaded'}</h2>
      </div>
      <div class="topbar-pills">
        <span class={`pill tone-${statusTone}`}>{status}</span>
        {#if workspace}
          <span class="pill">{currentPage}/{workspace.pageCount} pages</span>
          <span class="pill">{formatBytes(workspace.byteLength)}</span>
          <span class="pill">PDF {workspace.version}</span>
          <span class:modified-pill={workspace.modified} class="pill">
            {workspace.modified ? 'Unsaved changes' : 'Saved state'}
          </span>
        {/if}
      </div>
    </header>

    <section class="toolbar card compact-card">
      <div class="toolbar-group">
        <button on:click={() => goToPage(currentPage - 1)} disabled={busy || !workspace}>Prev</button>
        <button on:click={() => goToPage(currentPage + 1)} disabled={busy || !workspace}>Next</button>
      </div>

      <div class="toolbar-group">
        <button on:click={() => zoomBy(-0.15)} disabled={busy || !workspace}>-</button>
        <button on:click={() => zoomBy(0.15)} disabled={busy || !workspace}>+</button>
        <button on:click={fitToPane} disabled={busy || !workspace}>Fit Width</button>
        <span class="zoom-pill">{currentZoomLabel}</span>
      </div>

      <div class="toolbar-group">
        <button on:click={() => rotateCurrentPage(-90)} disabled={busy || !workspace}>Rotate Left</button>
        <button on:click={() => rotateCurrentPage(90)} disabled={busy || !workspace}>Rotate Right</button>
        <button on:click={() => moveCurrentPage(-1)} disabled={busy || !workspace}>Move Left</button>
        <button on:click={() => moveCurrentPage(1)} disabled={busy || !workspace}>Move Right</button>
      </div>

      <div class="toolbar-group toolbar-group-strong">
        <button on:click={extractCurrentPage} disabled={busy || !workspace}>Extract Page</button>
        <button on:click={exportCurrentPagePng} disabled={busy || !workspace}>Export PNG</button>
      </div>
    </section>

    <section class="viewer-stage">
      <section class="card page-strip compact-card">
        <div class="section-head">
          <h2>Pages</h2>
          <span>{workspace ? thumbnails.length : 0}</span>
        </div>
        {#if workspace}
          <div class="page-list">
            {#each pageItems as pageNumber}
              {@const thumbnail = thumbnailMap.get(pageNumber)}
              <button
                class:active={pageNumber === currentPage}
                class:drag-source={pageNumber === dragSourcePage}
                class:drop-target={pageNumber === dropTargetPage}
                class="page-chip"
                draggable={workspace.pageCount > 1}
                on:click={() => goToPage(pageNumber)}
                on:dragstart={(event) => handlePageDragStart(pageNumber, event)}
                on:dragenter={() => handlePageDragEnter(pageNumber)}
                on:dragover={handlePageDragOver}
                on:drop={(event) => handlePageDrop(pageNumber, event)}
                on:dragend={clearDragState}
                aria-pressed={pageNumber === currentPage}
              >
                {#if thumbnail}
                  <img class="page-thumb" src={thumbnail.dataUrl} alt={`Page ${pageNumber}`} />
                {:else}
                  <div class="page-thumb placeholder-thumb">Page {pageNumber}</div>
                {/if}
                <div class="page-chip-body">
                  <span>Page {pageNumber}</span>
                  <strong>{pageNumber === currentPage ? 'Active' : 'Drag to reorder'}</strong>
                </div>
              </button>
            {/each}
          </div>
        {:else}
          <p class="muted">Open a PDF to inspect thumbnails and drag pages into a new order.</p>
        {/if}
      </section>

      <section class="card viewer-shell hero-viewer" data-testid="viewer-shell">
        <div class="section-head">
          <h2>Viewer</h2>
          <span>{workspace ? `Page ${currentPage} of ${workspace.pageCount}` : 'Idle'}</span>
        </div>

        {#if workspace}
          <div class="viewer-pane" bind:this={viewerPane}>
            <canvas bind:this={viewerCanvas}></canvas>
          </div>
        {:else}
          <div class="empty-state">
            <span class="eyebrow">Local first</span>
            <h3>Open a PDF to start editing.</h3>
            <p>Sampadan keeps the document on-device for viewing, editing, OCR, and export.</p>
            <button on:click={openPdfFlow}>Open a PDF</button>
          </div>
        {/if}
      </section>
    </section>

    <details class="card utility-panel inspector-panel" open={Boolean(workspace && (workspace.flags.signed || workspace.flags.encrypted || workspace.flags.hasAttachments))}>
      <summary class="dock-summary">
        <span>Inspector</span>
        <small>{workspace ? workspace.source : 'No file'}</small>
      </summary>
      <div class="dock-body inspector">
        {#if workspace}
          <div class="inspector-block">
            <span class="meta-label">Document</span>
            <strong>{workspace.fileName}</strong>
            <span class="muted">{workspace.path ?? 'Generated in memory'}</span>
          </div>

          <div class="inspector-block">
            <div class="section-head compact-head">
              <h3>Metadata</h3>
              <span class:modified-pill={metadataDirty} class="pill">
                {metadataDirty ? 'Changed' : 'Synced'}
              </span>
            </div>
            <div class="field-grid">
              <label class="field">
                <span class="field-label">Title</span>
                <input
                  class="field-input"
                  value={metadataDraft.title}
                  on:input={(event) => updateMetadataField('title', event.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="field-label">Author</span>
                <input
                  class="field-input"
                  value={metadataDraft.author}
                  on:input={(event) => updateMetadataField('author', event.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="field-label">Subject</span>
                <input
                  class="field-input"
                  value={metadataDraft.subject}
                  on:input={(event) => updateMetadataField('subject', event.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="field-label">Keywords</span>
                <input
                  class="field-input"
                  value={metadataDraft.keywords}
                  on:input={(event) => updateMetadataField('keywords', event.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="field-label">Creator</span>
                <input
                  class="field-input"
                  value={metadataDraft.creator}
                  on:input={(event) => updateMetadataField('creator', event.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="field-label">Producer</span>
                <input
                  class="field-input"
                  value={metadataDraft.producer}
                  on:input={(event) => updateMetadataField('producer', event.currentTarget.value)}
                />
              </label>
            </div>
            <button on:click={applyMetadata} disabled={busy || !metadataDirty}>Apply Metadata</button>
          </div>

          <div class="inspector-block">
            <span class="meta-label">Suggested exports</span>
            <div class="export-list">
              <span>{withExtension(workspace.fileName, '.pdf')}</span>
              <span>{`${withoutExtension(workspace.fileName)}-searchable.pdf`}</span>
              <span>{withExtension(workspace.fileName, '.png')}</span>
              <span>{withExtension(workspace.fileName, '.txt')}</span>
              <span>{`${withoutExtension(workspace.fileName)}-ocr.txt`}</span>
              <span>{`${withoutExtension(workspace.fileName)}-trust-report.json`}</span>
              <span>{withExtension(workspace.fileName, '.docx')} planned</span>
            </div>
          </div>

          <div class="inspector-block">
            <span class="meta-label">Signals</span>
            <div class="flag-grid">
              {#each inspectorFlags as flag}
                <span class:active-flag={flag.active} class="flag-chip">
                  {flag.label}
                </span>
              {/each}
            </div>
          </div>

          <div class="inspector-block">
            <span class="meta-label">Trust Report</span>
            <strong>
              {#if workspace.trustReport.signatureCount > 0}
                {workspace.trustReport.signatureCount} signature{workspace.trustReport.signatureCount === 1 ? '' : 's'} detected
              {:else}
                No parsed signatures
              {/if}
            </strong>
            <div class="stack-list">
              {#each trustRecommendations as recommendation}
                <span>{recommendation}</span>
              {/each}
            </div>
          </div>

          {#if signatureValidationRuntime}
            <div class="inspector-block">
              <span class="meta-label">Signature Validation</span>
              <strong>{signatureValidationRuntime.available ? 'OpenSSL detected' : 'OpenSSL unavailable'}</strong>
              <div class="stack-list">
                <span class="muted">
                  {signatureValidationRuntime.binaryPath ?? signatureValidationRuntime.missingReason ?? 'Validator state unavailable'}
                </span>
                {#if signatureValidationRuntime.version}
                  <span>{signatureValidationRuntime.version}</span>
                {/if}
              </div>
            </div>
          {/if}

          {#if encryptionSummary?.encrypted}
            <div class="inspector-block">
              <span class="meta-label">Encryption</span>
              <strong>{encryptionSummary.algorithm ?? 'Encrypted PDF'}</strong>
              <div class="stack-list">
                {#if encryptionSummary.handler}
                  <span>Handler: {encryptionSummary.handler}</span>
                {/if}
                {#if encryptionSummary.version !== null}
                  <span>V: {encryptionSummary.version}</span>
                {/if}
                {#if encryptionSummary.revision !== null}
                  <span>R: {encryptionSummary.revision}</span>
                {/if}
                {#if encryptionSummary.keyLengthBits !== null}
                  <span>Key length: {encryptionSummary.keyLengthBits} bits</span>
                {/if}
                {#if encryptionSummary.permissions !== null}
                  <span>Permissions: {encryptionSummary.permissions}</span>
                {/if}
                {#if encryptionSummary.streamFilter}
                  <span>Stream filter: {encryptionSummary.streamFilter}</span>
                {/if}
                {#if encryptionSummary.stringFilter}
                  <span>String filter: {encryptionSummary.stringFilter}</span>
                {/if}
                {#if encryptionSummary.encryptMetadata !== null}
                  <span>Encrypt metadata: {encryptionSummary.encryptMetadata ? 'yes' : 'no'}</span>
                {/if}
                {#each encryptionSummary.notes as note}
                  <span>{note}</span>
                {/each}
              </div>
            </div>
          {/if}

          {#if attachmentSummaries.length > 0}
            <div class="inspector-block">
              <span class="meta-label">Attachments</span>
              <strong>{attachmentSummaries.length} embedded file{attachmentSummaries.length === 1 ? '' : 's'}</strong>
              {#each attachmentSummaries as attachment}
                <div class="stack-list attachment-entry">
                  <span>{attachment.fileName ?? 'Unnamed attachment'}</span>
                  {#if attachment.description}
                    <span>Description: {attachment.description}</span>
                  {/if}
                  {#if attachment.relationship}
                    <span>Relationship: {attachment.relationship}</span>
                  {/if}
                  <span>{attachment.embedded ? 'Embedded file stream present' : 'Reference only'}</span>
                  {#each attachment.notes as note}
                    <span>{note}</span>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}

          {#if signatureSummaries.length > 0}
            {#each signatureSummaries as signature, index}
              <div class="inspector-block">
                <span class="meta-label">Signature {index + 1}</span>
                <strong>{signature.fieldName ?? signature.signerName ?? 'Unnamed signature'}</strong>
                <div class="stack-list">
                  {#if signature.signerName}
                    <span>Signer: {signature.signerName}</span>
                  {/if}
                  {#if signature.filter}
                    <span>Filter: {signature.filter}</span>
                  {/if}
                  {#if signature.subFilter}
                    <span>SubFilter: {signature.subFilter}</span>
                  {/if}
                  {#if signature.modificationTime}
                    <span>Signed at: {signature.modificationTime}</span>
                  {/if}
                  {#if signature.reason}
                    <span>Reason: {signature.reason}</span>
                  {/if}
                  {#if signature.location}
                    <span>Location: {signature.location}</span>
                  {/if}
                  {#if signature.contactInfo}
                    <span>Contact: {signature.contactInfo}</span>
                  {/if}
                  {#if signature.byteRange}
                    <span>ByteRange: {signature.byteRange.join(', ')}</span>
                  {/if}
                  <span>Integrity: {formatSignatureIntegrityLabel(signature.integrityStatus)}</span>
                  {#if signature.integrityMessage}
                    <span>{signature.integrityMessage}</span>
                  {/if}
                  <span>Certificate trust: {formatCertificateTrustLabel(signature.certificateTrustStatus)}</span>
                  {#if signature.certificateTrustMessage}
                    <span>{signature.certificateTrustMessage}</span>
                  {/if}
                  <span>
                    Coverage: {signature.coversWholeDocument ? 'covers final file bytes' : 'partial or stale coverage'}
                  </span>
                  {#if signature.isTimestamp}
                    <span>Type: timestamp signature</span>
                  {/if}
                  {#if signature.docMdp}
                    <span>DocMDP: certification policy present</span>
                  {/if}
                  {#if signature.certificates.length > 0}
                    <span>
                      Certificate chain: {signature.certificates.length} certificate{signature.certificates.length === 1 ? '' : 's'}
                    </span>
                    {#each signature.certificates as certificate, certificateIndex}
                      <div class="stack-list attachment-entry">
                        <span>
                          Certificate {certificateIndex + 1}: {certificate.subjectCommonName ?? certificate.subject ?? 'Unnamed certificate'}
                        </span>
                        {#if certificate.subject}
                          <span>Subject: {certificate.subject}</span>
                        {/if}
                        {#if certificate.issuer}
                          <span>Issuer: {certificate.issuer}</span>
                        {/if}
                        {#if certificate.serialNumber}
                          <span>Serial: {certificate.serialNumber}</span>
                        {/if}
                        <span>Validity: {certificate.validityStatus}</span>
                        {#if certificate.notBefore}
                          <span>Not before: {certificate.notBefore}</span>
                        {/if}
                        {#if certificate.notAfter}
                          <span>Not after: {certificate.notAfter}</span>
                        {/if}
                        {#if certificate.sha256Fingerprint}
                          <span>SHA-256: {certificate.sha256Fingerprint}</span>
                        {/if}
                        <span>{certificate.selfSigned ? 'Self-signed or self-issued' : 'Issued by a distinct certificate authority'}</span>
                        {#each certificate.notes as note}
                          <span>{note}</span>
                        {/each}
                      </div>
                    {/each}
                  {/if}
                  {#each signature.notes as note}
                    <span>{note}</span>
                  {/each}
                </div>
              </div>
            {/each}
          {/if}

          <div class="inspector-block">
            <span class="meta-label">Pipeline status</span>
            <div class="stack-list">
              <span>Viewer: PDF.js</span>
              <span>Edits: pdf-lib operation layer</span>
              <span>File IO: Rust + Tauri</span>
              <span>OCR: {ocrReady ? `Tesseract ${ocrStatus?.version ?? 'ready'}` : 'Install local Tesseract'}</span>
              <span>Searchable OCR PDF: local generated copy</span>
              <span>
                Trust: structural analysis plus local OpenSSL-backed detached signature verification when available
              </span>
            </div>
          </div>
        {:else}
          <div class="inspector-block">
            <span class="meta-label">Signals</span>
            <div class="flag-grid">
              {#each Object.keys(emptyFlags) as key}
                <span class="flag-chip">{key}</span>
              {/each}
            </div>
          </div>
          <p class="muted">Document classification and metadata editing will appear here after load.</p>
        {/if}
      </div>
    </details>

    <details class="card utility-panel ocr-panel">
      <summary class="dock-summary">
        <span>OCR Workbench</span>
        <small>{ocrReady ? 'Ready' : 'Unavailable'}</small>
      </summary>
      <div class="dock-body ocr-layout">
        <div class="ocr-controls">
          <p class="muted">OCR stays on-device through the local Tesseract runtime.</p>

          <div class="inspector-block">
            <span class="meta-label">Runtime</span>
            {#if ocrStatus}
              <strong>{ocrReady ? 'Tesseract detected' : 'OCR runtime not available'}</strong>
              <span class="muted">{ocrStatus.binaryPath ?? ocrStatus.missingReason ?? 'Unknown OCR state'}</span>
              <span class="muted">
                {#if ocrReady}
                  {ocrStatus.version ?? 'Version unknown'} - {ocrAvailableLanguages.length} language{ocrAvailableLanguages.length === 1 ? '' : 's'}
                {:else}
                  Install Tesseract locally to enable page and full-document OCR.
                {/if}
              </span>
            {:else}
              <strong>Checking OCR runtime</strong>
              <span class="muted">Sampadan is probing the local device for Tesseract.</span>
            {/if}
          </div>

          <label class="field">
            <span class="field-label">OCR Language</span>
            <input
              class="field-input"
              bind:value={ocrLanguage}
              list="ocr-language-list"
              placeholder="eng or eng+hin"
              disabled={busy}
            />
          </label>
          <datalist id="ocr-language-list">
            {#each ocrAvailableLanguages as language}
              <option value={language}></option>
            {/each}
          </datalist>

          <div class="tool-grid ocr-actions">
            <button on:click={refreshOcrStatus} disabled={busy}>Refresh OCR</button>
            <button data-testid="ocr-page-button" on:click={ocrCurrentPage} disabled={busy || !workspace || !ocrReady}>OCR Page</button>
            <button on:click={ocrWholeDocument} disabled={busy || !workspace || !ocrReady}>OCR Document</button>
            <button data-testid="searchable-pdf-button" on:click={createSearchableCopy} disabled={busy || !workspace || !ocrReady}>
              Searchable PDF
            </button>
            <button on:click={exportOcrPreviewToFile} disabled={busy || !workspace || !ocrPreview}>
              Export OCR Text
            </button>
          </div>
        </div>

        <div class="ocr-preview-shell">
          <div class="section-head compact-head">
            <h3>{ocrPreviewLabel}</h3>
            <span class="pill">
              {#if ocrLastDurationMs !== null}
                Last page {ocrLastDurationMs} ms
              {:else}
                Idle
              {/if}
            </span>
          </div>
          <textarea
            class="ocr-preview"
            readonly
            value={ocrPreview || 'Run OCR on the current page or the full document to preview extracted text here.'}
          ></textarea>
        </div>
      </div>
    </details>

    {#if lastError}
      <section class="card error-panel">
        <strong>Last error</strong>
        <p>{lastError}</p>
      </section>
    {/if}
  </main>
</div>
