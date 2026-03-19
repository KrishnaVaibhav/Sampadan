<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'

  import { fetchOcrStatus, runOcrForBlob, runOcrPdfForBlob } from './lib/ocr/ocr-client'
  import {
    buildDocxExport,
    buildHtmlExport,
    buildMarkdownExport,
    buildStructuredJsonExport,
  } from './lib/conversion/document-export'
  import { type PdfProxy, loadPdfProxy } from './lib/pdf-engine'
  import {
    applyFormFieldValuesToDocument,
    flattenFormFieldsInDocument,
    readFormFieldsFromDocument,
  } from './lib/operations/pdf-forms'
  import {
    addStickyNoteAnnotationToDocument,
    addTextMarkupAnnotationToDocument,
    type PdfMarkupAnnotationKind,
    removeAnnotationFromDocument,
    updateAnnotationInDocument,
  } from './lib/operations/pdf-annotations'
  import {
    addAttachmentToDocument,
    addFreeTextBlockToDocument,
    addReviewNoteToDocument,
    addPageNumbersToDocument,
    addImageStampToDocument,
    addTextWatermarkToDocument,
    applyMetadataToDocument,
    deletePageFromDocument,
    duplicatePageInDocument,
    extractPagesFromDocument,
    insertBlankPageAfterCurrent,
    insertDocumentAfterPage,
    mergeDocuments,
    movePageInDocument,
    readMetadataFromDocument,
    replaceRegionWithTextInDocument,
    replaceTargetedTextInDocument,
    rotatePageInDocument,
    splitDocumentIntoSinglePages,
  } from './lib/operations/pdf-document'
  import type {
    PageNumberPosition,
    ReviewNoteTone,
    TextEditAlignment,
    WatermarkPosition,
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
    ExtractedPdfAttachmentPayload,
    LoadedFileBytesPayload,
    LoadedPdfPayload,
    OcrStatusPayload,
    PageThumbnail,
    PdfFormField,
    PdfFormFieldValue,
    PdfPageAnnotationOverlay,
    PdfPageTextSpan,
    PdfFlags,
    PdfMetadataDraft,
    PdfProtectionModifyAccess,
    PdfProtectionOptionsPayload,
    PdfProtectionPrintAccess,
    PdfTrustReport,
    QpdfStatusPayload,
    WorkspaceDocument,
  } from './lib/types'
  import {
    extractDocumentText,
    extractDocumentTextLayout,
    extractDocumentTextPages,
    extractPageAnnotations,
    extractPageTextSpans,
    generatePageThumbnails,
    renderPdfPageToCanvas,
  } from './lib/viewer/pdf-viewer'

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

  const editScopeOptions = [
    { value: 'current', label: 'Current page' },
    { value: 'all', label: 'All pages' },
  ] as const

  const watermarkPositionOptions: Array<{ value: WatermarkPosition; label: string }> = [
    { value: 'center', label: 'Center' },
    { value: 'top-left', label: 'Top left' },
    { value: 'top-right', label: 'Top right' },
    { value: 'bottom-left', label: 'Bottom left' },
    { value: 'bottom-right', label: 'Bottom right' },
  ]

  const pageNumberPositionOptions: Array<{ value: PageNumberPosition; label: string }> = [
    { value: 'footer-center', label: 'Footer center' },
    { value: 'footer-right', label: 'Footer right' },
    { value: 'footer-left', label: 'Footer left' },
    { value: 'header-right', label: 'Header right' },
    { value: 'header-center', label: 'Header center' },
    { value: 'header-left', label: 'Header left' },
  ]

  const reviewToneOptions: Array<{ value: ReviewNoteTone; label: string }> = [
    { value: 'amber', label: 'Amber' },
    { value: 'blue', label: 'Blue' },
    { value: 'green', label: 'Green' },
    { value: 'rose', label: 'Rose' },
  ]

  const reviewToneRgbMap: Record<ReviewNoteTone, [number, number, number]> = {
    amber: [245, 189, 71],
    blue: [74, 145, 230],
    green: [61, 168, 110],
    rose: [219, 107, 133],
  }

  const textEditAlignmentOptions: Array<{ value: TextEditAlignment; label: string }> = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right', label: 'Right' },
  ]

  const protectionPrintOptions: Array<{ value: PdfProtectionPrintAccess; label: string }> = [
    { value: 'full', label: 'Full printing' },
    { value: 'low', label: 'Low-res printing' },
    { value: 'none', label: 'No printing' },
  ]

  const protectionModifyOptions: Array<{ value: PdfProtectionModifyAccess; label: string }> = [
    { value: 'annotate', label: 'Comments and forms' },
    { value: 'form', label: 'Forms and signing' },
    { value: 'assembly', label: 'Assembly only' },
    { value: 'all', label: 'All edits' },
    { value: 'none', label: 'No edits' },
  ]

  type PendingEncryptedPdf = {
    payload: LoadedPdfPayload
    current: number
    modified: boolean
    source: 'disk' | 'generated'
    path: string | null
  }

  type TextTargetRegionHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

  type TextTargetRegion = {
    xPercent: number
    yPercent: number
    widthPercent: number
    heightPercent: number
    fontSize: number
  }

  type TextTargetDragSession = {
    handle: TextTargetRegionHandle
    startClientX: number
    startClientY: number
    surfaceWidth: number
    surfaceHeight: number
    startRegion: TextTargetRegion
  }

  type TextTargetSelectionGrip = 'start' | 'end'

  type TextTargetGripDragSession = {
    grip: TextTargetSelectionGrip
    surfaceLeft: number
    surfaceTop: number
    surfaceWidth: number
    surfaceHeight: number
  }

  type TextTargetSweepSession = {
    pointerId: number
  }

  type TextTargetOccurrenceMatch = {
    occurrenceIndex: number
    startIndex: number
    endIndex: number
  }

  type TextSearchScope = 'page' | 'document'

  type DocumentTextSearchResult = {
    id: string
    pageNumber: number
    pageIndex: number
    startIndex: number
    endIndex: number
    occurrenceIndex: number
    text: string
    xPercent: number
    yPercent: number
    widthPercent: number
    heightPercent: number
    fontSize: number
  }

  type SelectedTextTarget = PdfPageTextSpan & {
    spanIds: string[]
  }

  const textTargetRegionHandles: TextTargetRegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  let viewerCanvas: HTMLCanvasElement | null = null
  let viewerPane: HTMLDivElement | null = null
  let viewerSurface: HTMLDivElement | null = null
  let pdfProxy: PdfProxy | null = null
  let workspace: WorkspaceDocument | null = null
  let renderedPageWidth = 0
  let renderedPageHeight = 0
  let pendingEncryptedPdf: PendingEncryptedPdf | null = null
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
  let formFieldToken = 0
  let textSpanToken = 0
  let annotationToken = 0
  let thumbnails: PageThumbnail[] = []
  let currentPageTextSpans: PdfPageTextSpan[] = []
  let currentPageAnnotations: PdfPageAnnotationOverlay[] = []
  let selectedAnnotationId: string | null = null
  let selectedAnnotation: PdfPageAnnotationOverlay | null = null
  let selectedTextSpanIds: string[] = []
  let selectedTextAnchorId: string | null = null
  let selectedTextSpans: PdfPageTextSpan[] = []
  let selectedTextSpan: SelectedTextTarget | null = null
  let selectedTextStartSpan: PdfPageTextSpan | null = null
  let selectedTextEndSpan: PdfPageTextSpan | null = null
  let textTargetMode = false
  let inlineTextEditorOpen = false
  let inlineTextEditor: HTMLTextAreaElement | null = null
  let textSearchInput: HTMLInputElement | null = null
  let textTargetDragSession: TextTargetDragSession | null = null
  let textTargetGripDragSession: TextTargetGripDragSession | null = null
  let textTargetSweepSession: TextTargetSweepSession | null = null
  let textSearchQuery = ''
  let textSearchReplacement = ''
  let textSearchScope: TextSearchScope = 'page'
  let textSearchCaseSensitive = false
  let textSearchBusy = false
  let textSearchResults: DocumentTextSearchResult[] = []
  let activeTextSearchResultIndex = -1
  let rangeExpression = '1'
  let metadataDraft = emptyMetadata()
  let metadataDirty = false
  let formFields: PdfFormField[] = []
  let formDrafts: Record<string, PdfFormFieldValue> = {}
  let formFieldsLoading = false
  let formDirty = false
  let flattenFormsOnApply = false
  let attachmentDescriptionDraft = ''
  let editScope: 'current' | 'all' = 'current'
  let watermarkText = 'CONFIDENTIAL'
  let watermarkPosition: WatermarkPosition = 'center'
  let reviewNoteTitle = 'Review Note'
  let reviewNoteBody = ''
  let reviewNoteTone: ReviewNoteTone = 'amber'
  let pageNumberStart = '1'
  let pageNumberPosition: PageNumberPosition = 'footer-center'
  let textEditContent = 'Edited text'
  let textEditX = '12'
  let textEditY = '14'
  let textEditWidth = '46'
  let textEditHeight = '16'
  let textEditFontSize = '16'
  let textEditAlignment: TextEditAlignment = 'left'
  let textEditPaperBacking = true
  let dragSourcePage: number | null = null
  let dropTargetPage: number | null = null
  let ocrStatus: OcrStatusPayload | null = null
  let ocrLanguage = 'eng'
  let ocrPreview = ''
  let ocrPreviewLabel = 'No OCR text yet'
  let ocrLastDurationMs: number | null = null
  let qpdfStatus: QpdfStatusPayload | null = null
  let protectionUserPassword = ''
  let protectionOwnerPassword = ''
  let protectionPrint: PdfProtectionPrintAccess = 'full'
  let protectionModify: PdfProtectionModifyAccess = 'annotate'
  let protectionAllowExtract = true
  let protectionEncryptMetadata = true

  $: pageItems = workspace ? Array.from({ length: workspace.pageCount }, (_, index) => index + 1) : []
  $: currentZoomLabel = `${Math.round(zoom * 100)}%`
  $: activeDocumentName = workspace?.fileName ?? pendingEncryptedPdf?.payload.fileName ?? 'No PDF loaded'
  $: viewerStatusLabel = workspace ? `Page ${currentPage} of ${workspace.pageCount}` : pendingEncryptedPdf ? 'Locked until unlocked' : 'Idle'
  $: selectedAnnotation = currentPageAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
  $: selectedTextSpans = currentPageTextSpans.filter((span) => selectedTextSpanIds.includes(span.id))
  $: selectedTextSpan = buildSelectedTextTarget(selectedTextSpans)
  $: selectedTextStartSpan = selectedTextSpans[0] ?? null
  $: selectedTextEndSpan = selectedTextSpans.at(-1) ?? null
  $: activeTextSearchResult =
    activeTextSearchResultIndex >= 0 && activeTextSearchResultIndex < textSearchResults.length
      ? textSearchResults[activeTextSearchResultIndex]
      : null
  $: currentPageTextSearchResults = textSearchResults.filter((result) => result.pageNumber === currentPage)
  $: if (selectedTextAnchorId && !currentPageTextSpans.some((span) => span.id === selectedTextAnchorId)) {
    selectedTextAnchorId = null
  }
  $: if (!selectedTextSpan && inlineTextEditorOpen) {
    inlineTextEditorOpen = false
  }
  $: thumbnailMap = new Map(thumbnails.map((thumbnail) => [thumbnail.pageNumber, thumbnail]))
  $: ocrAvailableLanguages = ocrStatus?.languages ?? []
  $: ocrReady = ocrStatus?.available ?? false
  $: qpdfReady = qpdfStatus?.available ?? false
  $: signatureSummaries = workspace?.trustReport.signatures ?? []
  $: signatureValidationRuntime = workspace?.trustReport.signatureValidationRuntime ?? null
  $: attachmentSummaries = workspace?.trustReport.attachments ?? []
  $: encryptionSummary = workspace?.trustReport.encryption ?? null
  $: trustRecommendations = workspace?.trustReport.recommendations ?? []
  $: editableFormFields = formFields.filter((field) => field.editable)
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
    void refreshQpdfStatus()

    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      const textInputTarget = isTextInputTarget(event.target)

      if (textTargetMode && workspace && modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void focusTextSearchField()
        return
      }

      if (textTargetMode && inlineTextEditorOpen && selectedTextSpan && event.key === 'Escape') {
        event.preventDefault()
        clearSelectedTextTarget()
        return
      }

      if (textTargetMode && inlineTextEditorOpen && selectedTextSpan && modifier && event.key === 'Enter') {
        event.preventDefault()
        void replaceSelectedTextTarget()
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && modifier && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        void replaceAllSelectedTextMatches()
        return
      }

      if (textTargetMode && textSearchResults.length > 0 && !textInputTarget && event.key === 'F3') {
        event.preventDefault()
        void jumpToTextSearchResult(event.shiftKey ? -1 : 1)
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.key === 'F3') {
        event.preventDefault()
        void jumpToMatchingTextOccurrence(event.shiftKey ? -1 : 1)
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.altKey && event.key === 'Backspace') {
        event.preventDefault()
        resetSelectedTextEditContent()
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        void selectCurrentTextLine()
        return
      }

      if (textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        void selectAllTextTargets()
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        event.shiftKey ? resizeSelectedTextRegion(-1, 0) : nudgeSelectedTextRegion(-0.6, 0)
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        event.shiftKey ? resizeSelectedTextRegion(1, 0) : nudgeSelectedTextRegion(0.6, 0)
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.altKey && event.key === 'ArrowUp') {
        event.preventDefault()
        event.shiftKey ? resizeSelectedTextRegion(0, -0.6) : nudgeSelectedTextRegion(0, -0.6)
        return
      }

      if (textTargetMode && selectedTextSpan && !textInputTarget && event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        event.shiftKey ? resizeSelectedTextRegion(0, 0.6) : nudgeSelectedTextRegion(0, 0.6)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'Home') {
        event.preventDefault()
        void jumpTextTargetSelection('start', event.shiftKey)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'End') {
        event.preventDefault()
        void jumpTextTargetSelection('end', event.shiftKey)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'Tab') {
        event.preventDefault()
        void moveTextTargetSelection(event.shiftKey ? -1 : 1, false)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowUp') {
        event.preventDefault()
        void selectAdjacentTextLine(-1, event.shiftKey)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowDown') {
        event.preventDefault()
        void selectAdjacentTextLine(1, event.shiftKey)
        return
      }

      if (modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowLeft') {
        event.preventDefault()
        void jumpToTextLineBoundary('start', event.shiftKey)
        return
      }

      if (modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowRight') {
        event.preventDefault()
        void jumpToTextLineBoundary('end', event.shiftKey)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowLeft') {
        event.preventDefault()
        void moveTextTargetSelection(-1, event.shiftKey)
        return
      }

      if (!modifier && textTargetMode && currentPageTextSpans.length > 0 && !textInputTarget && event.key === 'ArrowRight') {
        event.preventDefault()
        void moveTextTargetSelection(1, event.shiftKey)
        return
      }

      if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openPdfFlow()
      }

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveWorkspace(event.shiftKey)
      }

      if (!modifier && workspace && !textInputTarget && event.key === 'ArrowLeft') {
        event.preventDefault()
        void goToPage(currentPage - 1)
      }

      if (!modifier && workspace && !textInputTarget && event.key === 'ArrowRight') {
        event.preventDefault()
        void goToPage(currentPage + 1)
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (textTargetGripDragSession) {
        event.preventDefault()
        void updateDraggedTextTargetGrip(event.clientX, event.clientY)
        return
      }

      if (!textTargetDragSession) return

      event.preventDefault()
      updateDraggedTextTargetRegion(event.clientX, event.clientY)
    }

    const handlePointerUp = () => {
      if (!textTargetDragSession && !textTargetGripDragSession && !textTargetSweepSession) return
      textTargetDragSession = null
      textTargetGripDragSession = null
      textTargetSweepSession = null
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
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

      if (payload.flags.encrypted) {
        await stageEncryptedPdf(payload, {
          current: preferredPage,
          modified: false,
          source: 'disk',
          path,
        })
        return
      }

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
        buffers.push(await resolveEditableBytes(payload, `merging ${payload.fileName}`))
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

  async function insertPdfAfterCurrentPage() {
    if (!workspace || busy) return

    const selection = await openDialog({
      multiple: false,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    const [path] = normalizeSelection(selection)
    if (!path) return

    const currentWorkspace = workspace
    busy = true
    statusTone = 'busy'
    status = `Inserting ${fileNameFromPath(path)} after page ${currentPage}`
    lastError = null

    try {
      const payload = await invoke<LoadedPdfPayload>('load_pdf', { path })
      recentPaths = rememberRecentPath(recentPaths, path)
      const nextBytes = await insertDocumentAfterPage(
        currentWorkspace.bytes,
        await resolveEditableBytes(payload, `inserting ${payload.fileName}`),
        currentPage - 1,
      )

      await commitGeneratedPdf(nextBytes, {
        fileName: currentWorkspace.fileName,
        current: Math.min(currentPage + 1, currentWorkspace.pageCount + 1),
      })

      statusTone = 'idle'
      status = `Inserted ${payload.fileName} after page ${currentPage}`
    } catch (error) {
      reportError(error, 'Failed to insert the selected PDF')
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

  async function exportDocumentMarkdown() {
    await exportConvertedDocument({
      formatLabel: 'Markdown',
      extension: 'md',
      workingStatus: 'Converting PDF text to Markdown',
      cancelStatus: 'Markdown export cancelled',
      errorStatus: 'Failed to export Markdown',
      saveFilterName: 'Markdown file',
      buildBytes: (pages) => buildMarkdownExport(workspace!.fileName, pages),
    })
  }

  async function exportDocumentHtml() {
    await exportConvertedDocument({
      formatLabel: 'HTML',
      extension: 'html',
      workingStatus: 'Converting PDF text to HTML',
      cancelStatus: 'HTML export cancelled',
      errorStatus: 'Failed to export HTML',
      saveFilterName: 'HTML file',
      useLayout: true,
      buildBytes: (pages, layoutPages) => buildHtmlExport(workspace!.fileName, pages, layoutPages),
    })
  }

  async function exportDocumentDocx() {
    await exportConvertedDocument({
      formatLabel: 'DOCX',
      extension: 'docx',
      workingStatus: 'Converting PDF text to DOCX',
      cancelStatus: 'DOCX export cancelled',
      errorStatus: 'Failed to export DOCX',
      saveFilterName: 'Word document',
      useLayout: true,
      buildBytes: (pages, layoutPages) => buildDocxExport(workspace!.fileName, pages, layoutPages),
    })
  }

  async function exportDocumentStructuredJson() {
    await exportConvertedDocument({
      formatLabel: 'structured JSON',
      extension: 'json',
      workingStatus: 'Converting PDF text to structured JSON',
      cancelStatus: 'Structured JSON export cancelled',
      errorStatus: 'Failed to export structured JSON',
      saveFilterName: 'Structured JSON file',
      useLayout: true,
      defaultFileName: `${withoutExtension(workspace!.fileName)}-structured.json`,
      buildBytes: (pages, layoutPages) => buildStructuredJsonExport(workspace!.fileName, pages, layoutPages),
    })
  }

  async function exportConvertedDocument(options: {
    formatLabel: string
    extension: string
    workingStatus: string
    cancelStatus: string
    errorStatus: string
    saveFilterName: string
    useLayout?: boolean
    defaultFileName?: string
    buildBytes: (pages: string[], layoutPages?: Awaited<ReturnType<typeof extractDocumentTextLayout>>) => Uint8Array | Promise<Uint8Array>
  }) {
    if (!workspace || !pdfProxy || busy) return

    busy = true
    statusTone = 'busy'
    status = options.workingStatus
    lastError = null

    try {
      const pages = await extractDocumentTextPages(pdfProxy)
      const layoutPages = options.useLayout ? await extractDocumentTextLayout(pdfProxy) : undefined
      const targetPath = await saveDialog({
        defaultPath: options.defaultFileName ?? withExtension(workspace.fileName, options.extension),
        filters: [{ name: options.saveFilterName, extensions: [options.extension] }],
      })

      if (!targetPath) {
        statusTone = 'idle'
        status = options.cancelStatus
        return
      }

      const bytes = await options.buildBytes(pages, layoutPages)
      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: bytesToBase64(bytes),
      })

      statusTone = 'idle'
      status = `Exported ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, options.errorStatus)
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

  async function exportEmbeddedAttachments() {
    if (!workspace || busy || attachmentSummaries.length === 0) return

    const selection = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose attachment export folder',
    })
    const [directory] = normalizeSelection(selection)
    if (!directory) return

    busy = true
    statusTone = 'busy'
    status = `Exporting ${attachmentSummaries.length} attachment${attachmentSummaries.length === 1 ? '' : 's'}`
    lastError = null

    try {
      const attachments = await invoke<ExtractedPdfAttachmentPayload[]>('extract_pdf_attachments', {
        bytesBase64: bytesToBase64(workspace.bytes),
      })

      if (attachments.length === 0) {
        throw new Error('No extractable embedded attachments were returned.')
      }

      for (const [index, attachment] of attachments.entries()) {
        const fileName = attachment.fileName.trim() || `attachment-${String(index + 1).padStart(3, '0')}.bin`
        await invoke('save_file_bytes', {
          path: joinPath(directory, fileName),
          bytesBase64: attachment.bytesBase64,
        })
      }

      statusTone = 'idle'
      status = `Exported ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`
    } catch (error) {
      reportError(error, 'Failed to export embedded attachments')
    } finally {
      busy = false
    }
  }

  async function attachEmbeddedFile() {
    if (!workspace || busy) return

    const selection = await openDialog({
      multiple: false,
    })
    const [path] = normalizeSelection(selection)
    if (!path) return

    const currentWorkspace = workspace
    const fileName = fileNameFromPath(path)

    busy = true
    statusTone = 'busy'
    status = `Attaching ${fileName}`
    lastError = null

    try {
      const attachmentFile = await invoke<LoadedFileBytesPayload>('load_file_bytes', { path })
      const attachmentBytes = base64ToBytes(attachmentFile.bytesBase64)
      const nextBytes = await addAttachmentToDocument(currentWorkspace.bytes, attachmentBytes, {
        name: attachmentFile.fileName,
        description: attachmentDescriptionDraft,
      })

      await commitGeneratedPdf(nextBytes, {
        fileName: currentWorkspace.fileName,
        current: currentPage,
      })

      attachmentDescriptionDraft = ''
      statusTone = 'idle'
      status = `Attached ${attachmentFile.fileName} to ${currentWorkspace.fileName}`
    } catch (error) {
      reportError(error, 'Failed to attach the selected file')
    } finally {
      busy = false
    }
  }

  async function placeImageStamp() {
    if (!workspace || busy) return

    const selection = await openDialog({
      multiple: false,
      filters: [{ name: 'Image files', extensions: ['png', 'jpg', 'jpeg'] }],
    })
    const [path] = normalizeSelection(selection)
    if (!path) return

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    busy = true
    statusTone = 'busy'
    status = `Placing image stamp on ${scopeLabel}`
    lastError = null

    try {
      const imageFile = await invoke<LoadedFileBytesPayload>('load_file_bytes', { path })
      const imageBytes = base64ToBytes(imageFile.bytesBase64)
      const nextBytes = await addImageStampToDocument(currentWorkspace.bytes, imageBytes, {
        pageIndexes,
        position: watermarkPosition,
      })

      await commitGeneratedPdf(nextBytes, {
        fileName: currentWorkspace.fileName,
        current: currentPage,
      })

      statusTone = 'idle'
      status = `Placed image stamp on ${scopeLabel}`
    } catch (error) {
      reportError(error, 'Failed to place the image stamp')
    } finally {
      busy = false
    }
  }

  async function refreshQpdfStatus() {
    try {
      qpdfStatus = await invoke<QpdfStatusPayload>('get_qpdf_status')
    } catch (error) {
      qpdfStatus = {
        available: false,
        binaryPath: null,
        version: null,
        missingReason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function saveProtectedCopy() {
    if (!workspace || busy) return

    if (!qpdfReady) {
      reportError(qpdfStatus?.missingReason ?? 'Install qpdf to save protected PDF copies.', 'Protection is unavailable')
      return
    }

    const ownerPassword = protectionOwnerPassword.trim()
    const userPassword = protectionUserPassword.trim()

    if (!ownerPassword) {
      reportError(new Error('Enter an owner password before saving a protected copy.'), 'Owner password required')
      return
    }

    if (userPassword && userPassword === ownerPassword) {
      reportError(new Error('Use different open and owner passwords to avoid weak PDF protection.'), 'Insecure protection settings')
      return
    }

    const targetPath = await saveDialog({
      defaultPath: `${withoutExtension(workspace.fileName)}-protected.pdf`,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    if (!targetPath) {
      statusTone = 'idle'
      status = 'Protected copy export cancelled'
      lastError = null
      return
    }

    const options: PdfProtectionOptionsPayload = {
      userPassword: userPassword || null,
      ownerPassword,
      print: protectionPrint,
      modify: protectionModify,
      allowExtract: protectionAllowExtract,
      encryptMetadata: protectionEncryptMetadata,
    }

    busy = true
    statusTone = 'busy'
    status = `Creating protected copy for ${workspace.fileName}`
    lastError = null

    try {
      const protectedPayload = await invoke<LoadedPdfPayload>('protect_pdf_bytes', {
        fileName: fileNameFromPath(targetPath),
        bytesBase64: bytesToBase64(workspace.bytes),
        options,
      })

      await invoke('save_file_bytes', {
        path: targetPath,
        bytesBase64: protectedPayload.bytesBase64,
      })

      statusTone = 'idle'
      status = `Saved protected copy as ${fileNameFromPath(targetPath)}`
    } catch (error) {
      reportError(error, 'Failed to save the protected PDF copy')
    } finally {
      busy = false
    }
  }

  async function unlockPendingPdf() {
    if (!pendingEncryptedPdf || busy) return

    if (!qpdfReady) {
      reportError(qpdfStatus?.missingReason ?? 'Install qpdf to unlock encrypted PDFs.', 'Unlock is unavailable')
      return
    }

    const locked = pendingEncryptedPdf
    busy = true
    statusTone = 'busy'
    status = `Unlocking ${locked.payload.fileName}`
    lastError = null

    try {
      const unlockedPayload = await invoke<LoadedPdfPayload>('decrypt_pdf_bytes', {
        fileName: locked.payload.fileName,
        bytesBase64: locked.payload.bytesBase64,
        password: protectionUserPassword,
      })

      await loadPayload(unlockedPayload, {
        current: locked.current,
        modified: locked.modified,
        source: locked.source,
        path: locked.path,
      })

      statusTone = 'idle'
      status = `Unlocked ${locked.payload.fileName}`
    } catch (error) {
      reportError(error, `Failed to unlock ${locked.payload.fileName}`)
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

  async function applyFormFieldValues() {
    if (!workspace || busy || workspace.flags.hasXfa || formFields.length === 0) return
    const currentWorkspace = workspace

    const updates = formFields
      .filter((field) => field.editable)
      .map((field) => ({
        name: field.name,
        kind: field.kind,
        value: cloneFormFieldValue(getFormFieldDraftValue(field)),
      }))

    if (updates.length === 0) {
      reportError(new Error('No editable AcroForm fields were found in this document.'), 'No editable form fields')
      return
    }

    const applied = await runDocumentMutation({
      workingStatus: flattenFormsOnApply ? 'Applying and flattening form fields' : 'Applying form field values',
      successStatus: flattenFormsOnApply ? 'Applied and flattened form fields' : 'Applied form field values',
      errorStatus: 'Failed to apply the form field values',
      nextCurrentPage: currentPage,
      mutate: () =>
        applyFormFieldValuesToDocument(currentWorkspace.bytes, updates, {
          flatten: flattenFormsOnApply,
        }),
    })

    if (applied) {
      formDirty = false
    }
  }

  async function flattenFormFields() {
    if (!workspace || busy || workspace.flags.hasXfa || formFields.length === 0) return
    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: 'Flattening form fields into page content',
      successStatus: 'Flattened form fields',
      errorStatus: 'Failed to flatten the form fields',
      nextCurrentPage: currentPage,
      mutate: () => flattenFormFieldsInDocument(currentWorkspace.bytes),
    })
  }

  async function applyWatermark() {
    if (!workspace || busy) return

    const text = watermarkText.trim()
    if (!text) {
      reportError(new Error('Enter watermark text before applying it.'), 'Watermark text is required')
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Applying watermark to ${scopeLabel}`,
      successStatus: `Applied watermark to ${scopeLabel}`,
      errorStatus: 'Failed to apply the text watermark',
      nextCurrentPage: currentPage,
      mutate: () =>
        addTextWatermarkToDocument(currentWorkspace.bytes, {
          text,
          pageIndexes,
          position: watermarkPosition,
        }),
    })
  }

  async function addPageNumbers() {
    if (!workspace || busy) return

    const startNumber = parsePositiveInteger(pageNumberStart, 'Starting page number')
    if (startNumber === null) {
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Adding page numbers to ${scopeLabel}`,
      successStatus: `Added page numbers to ${scopeLabel}`,
      errorStatus: 'Failed to add page numbers',
      nextCurrentPage: currentPage,
      mutate: () =>
        addPageNumbersToDocument(currentWorkspace.bytes, {
          startNumber,
          pageIndexes,
          position: pageNumberPosition,
        }),
    })
  }

  async function addReviewNote() {
    if (!workspace || busy) return

    const body = reviewNoteBody.trim()
    if (!body) {
      reportError(new Error('Enter note text before adding a review note.'), 'Review note text is required')
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Adding review note to ${scopeLabel}`,
      successStatus: `Added review note to ${scopeLabel}`,
      errorStatus: 'Failed to add the review note',
      nextCurrentPage: currentPage,
      mutate: () =>
        addReviewNoteToDocument(currentWorkspace.bytes, {
          title: reviewNoteTitle,
          body,
          pageIndexes,
          position: watermarkPosition,
          tone: reviewNoteTone,
        }),
    })
  }

  async function addStickyNoteAnnotation() {
    if (!workspace || busy) return

    const contents = reviewNoteBody.trim()
    if (!contents) {
      reportError(new Error('Enter note text before adding a sticky note annotation.'), 'Sticky note text is required')
      return
    }

    const noteAnchor = resolveStickyNoteAnchor()
    if (!noteAnchor) {
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Adding sticky note annotation to ${scopeLabel}`,
      successStatus: `Added sticky note annotation to ${scopeLabel}`,
      errorStatus: 'Failed to add the sticky note annotation',
      nextCurrentPage: currentPage,
      mutate: () =>
        addStickyNoteAnnotationToDocument(currentWorkspace.bytes, {
          title: reviewNoteTitle,
          contents,
          pageIndexes,
          xPercent: noteAnchor.xPercent,
          yPercent: noteAnchor.yPercent,
          tone: reviewNoteTone,
        }),
    })
  }

  async function placeTextBlock() {
    if (!workspace || busy) return

    const text = textEditContent.trim()
    if (!text) {
      reportError(new Error('Enter text before placing a text block.'), 'Edit text is required')
      return
    }

    const layout = resolveTextEditLayout()
    if (!layout) {
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Placing text block on ${scopeLabel}`,
      successStatus: `Placed text block on ${scopeLabel}`,
      errorStatus: 'Failed to place the text block',
      nextCurrentPage: currentPage,
      mutate: () =>
        addFreeTextBlockToDocument(currentWorkspace.bytes, {
          text,
          pageIndexes,
          ...layout,
          paperBacking: textEditPaperBacking,
        }),
    })
  }

  async function whiteoutAndReplace() {
    if (!workspace || busy) return

    const layout = resolveTextEditLayout()
    if (!layout) {
      return
    }

    const currentWorkspace = workspace
    const pageIndexes = resolveEditPageIndexes(currentWorkspace)
    const scopeLabel = formatEditScopeLabel(currentWorkspace)

    await runDocumentMutation({
      workingStatus: `Replacing region on ${scopeLabel}`,
      successStatus: `Replaced region on ${scopeLabel}`,
      errorStatus: 'Failed to replace the selected region',
      nextCurrentPage: currentPage,
      mutate: () =>
        replaceRegionWithTextInDocument(currentWorkspace.bytes, {
          text: textEditContent,
          pageIndexes,
          ...layout,
          autoFit: true,
        }),
    })
  }

  async function replaceSelectedTextTarget() {
    if (!workspace || busy || !selectedTextSpan) return

    const replacementText = textEditContent.trim()
    if (!replacementText) {
      reportError(new Error('Enter replacement text before editing the selected page text.'), 'Replacement text is required')
      return
    }

    const currentWorkspace = workspace
    const targetRegion = resolveSelectedTextTargetRegion()
    if (!targetRegion) {
      return
    }
    const selectedTextOccurrence = resolveSelectedTextOccurrence()

    busy = true
    statusTone = 'busy'
    status = `Replacing selected text on page ${currentPage}`
    lastError = null

    try {
      const result = await replaceTargetedTextInDocument(currentWorkspace.bytes, {
        targetText: selectedTextSpan.text,
        replacementText,
        pageIndex: currentPage - 1,
        targetOccurrence: selectedTextOccurrence,
        xPercent: targetRegion.xPercent,
        yPercent: targetRegion.yPercent,
        widthPercent: targetRegion.widthPercent,
        heightPercent: targetRegion.heightPercent,
        fontSize: targetRegion.fontSize,
        alignment: textEditAlignment,
      })

      await commitGeneratedPdf(result.bytes, {
        fileName: currentWorkspace.fileName,
        current: currentPage,
      })
      inlineTextEditorOpen = false

      statusTone = 'idle'
      status =
        result.strategy === 'content-stream'
          ? `Replaced selected text on page ${currentPage}`
          : `Replaced selected text on page ${currentPage} with visual fallback`
    } catch (error) {
      reportError(error, 'Failed to replace the selected page text')
    } finally {
      busy = false
    }
  }

  async function replaceAllSelectedTextMatches() {
    if (!workspace || busy || !selectedTextSpan) return

    const replacementText = textEditContent.trim()
    if (!replacementText) {
      reportError(new Error('Enter replacement text before editing the selected page text.'), 'Replacement text is required')
      return
    }

    const normalizedTargetText = selectedTextSpan.text.replace(/\s+/g, ' ').trim().toLowerCase()
    const normalizedReplacementText = replacementText.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalizedTargetText && normalizedReplacementText.includes(normalizedTargetText)) {
      reportError(
        new Error('Replace all requires replacement text that does not contain the selected match text.'),
        'Replace all would create ambiguous repeated matches',
      )
      return
    }

    const matches = resolveMatchingSelectedTextOccurrences()
    if (matches.length === 0) {
      reportError(new Error('No matching occurrences are available for replacement.'), 'No matching occurrences found')
      return
    }

    const currentWorkspace = workspace
    let workingBytes = currentWorkspace.bytes
    let contentStreamReplacements = 0
    let overlayReplacements = 0

    busy = true
    statusTone = 'busy'
    status = `Replacing ${matches.length} matching text occurrence${matches.length === 1 ? '' : 's'} on page ${currentPage}`
    lastError = null

    try {
      for (const match of [...matches].reverse()) {
        const matchSpans = currentPageTextSpans.slice(match.startIndex, match.endIndex + 1)
        const matchTarget = buildSelectedTextTarget(matchSpans)
        if (!matchTarget) {
          continue
        }

        const result = await replaceTargetedTextInDocument(workingBytes, {
          targetText: selectedTextSpan.text,
          replacementText,
          pageIndex: currentPage - 1,
          targetOccurrence: match.occurrenceIndex,
          xPercent: matchTarget.xPercent,
          yPercent: matchTarget.yPercent,
          widthPercent: matchTarget.widthPercent,
          heightPercent: matchTarget.heightPercent,
          fontSize: matchTarget.fontSize,
          alignment: textEditAlignment,
        })

        workingBytes = result.bytes
        if (result.strategy === 'content-stream') {
          contentStreamReplacements += 1
        } else {
          overlayReplacements += 1
        }
      }

      await commitGeneratedPdf(workingBytes, {
        fileName: currentWorkspace.fileName,
        current: currentPage,
      })
      inlineTextEditorOpen = false

      const replacementCount = contentStreamReplacements + overlayReplacements
      statusTone = 'idle'
      status =
        overlayReplacements === 0
          ? `Replaced ${replacementCount} matching occurrence${replacementCount === 1 ? '' : 's'} on page ${currentPage}`
          : contentStreamReplacements === 0
            ? `Replaced ${replacementCount} matching occurrence${replacementCount === 1 ? '' : 's'} on page ${currentPage} with visual fallback`
            : `Replaced ${replacementCount} matching occurrence${replacementCount === 1 ? '' : 's'} on page ${currentPage} with mixed rewrite and fallback`
    } catch (error) {
      reportError(error, 'Failed to replace all matching page text')
    } finally {
      busy = false
    }
  }

  async function addSelectedTextMarkup(kind: PdfMarkupAnnotationKind) {
    if (!workspace || busy || !selectedTextSpan) return

    const currentWorkspace = workspace
    const targetRegion = resolveSelectedTextTargetRegion()
    if (!targetRegion) {
      return
    }
    const kindLabel = kind === 'strikeout' ? 'strikeout' : kind

    await runDocumentMutation({
      workingStatus: `Adding ${kindLabel} annotation to page ${currentPage}`,
      successStatus: `Added ${kindLabel} annotation to page ${currentPage}`,
      errorStatus: `Failed to add the ${kindLabel} annotation`,
      nextCurrentPage: currentPage,
      mutate: () =>
        addTextMarkupAnnotationToDocument(currentWorkspace.bytes, {
          kind,
          pageIndex: currentPage - 1,
          xPercent: targetRegion.xPercent,
          yPercent: targetRegion.yPercent,
          widthPercent: targetRegion.widthPercent,
          heightPercent: targetRegion.heightPercent,
          title: reviewNoteTitle.trim() || 'Sampadan',
          contents: reviewNoteBody.trim(),
        }),
    })
  }

  async function removeSelectedAnnotation() {
    if (!selectedAnnotation) return
    await removeAnnotation(selectedAnnotation)
  }

  async function updateSelectedAnnotation() {
    if (!workspace || busy || !selectedAnnotation) return

    const currentWorkspace = workspace

    await runDocumentMutation({
      workingStatus: `Updating selected annotation on page ${currentPage}`,
      successStatus: `Updated selected annotation on page ${currentPage}`,
      errorStatus: 'Failed to update the selected annotation',
      nextCurrentPage: currentPage,
      mutate: () =>
        updateAnnotationInDocument(currentWorkspace.bytes, {
          pageIndex: currentPage - 1,
          annotationId: selectedAnnotation.id,
          title: reviewNoteTitle,
          contents: reviewNoteBody,
          tone: selectedAnnotation.kind === 'text' ? reviewNoteTone : undefined,
        }),
    })
  }

  async function removeAnnotation(annotation: PdfPageAnnotationOverlay) {
    if (!workspace || busy) return

    const currentWorkspace = workspace
    const label =
      annotation.kind === 'strikeout'
        ? 'strikeout annotation'
        : annotation.kind === 'underline'
          ? 'underline annotation'
          : annotation.kind === 'highlight'
            ? 'highlight annotation'
            : 'sticky note annotation'

    await runDocumentMutation({
      workingStatus: `Removing ${label} from page ${currentPage}`,
      successStatus: `Removed ${label} from page ${currentPage}`,
      errorStatus: `Failed to remove the selected ${label}`,
      nextCurrentPage: currentPage,
      mutate: () =>
        removeAnnotationFromDocument(currentWorkspace.bytes, {
          pageIndex: currentPage - 1,
          annotationId: annotation.id,
        }),
    })
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
    const pageNumber = currentPage
    const pageScale = zoom
    await renderPdfPageToCanvas(pdfProxy, currentPage, zoom, viewerCanvas)
    renderedPageWidth = Number.parseFloat(viewerCanvas.style.width) || viewerCanvas.clientWidth || viewerCanvas.width
    renderedPageHeight = Number.parseFloat(viewerCanvas.style.height) || viewerCanvas.clientHeight || viewerCanvas.height

    if (token !== renderToken) {
      return
    }

    void refreshCurrentPageTextTargets(pageNumber, pageScale, token)
    void refreshCurrentPageAnnotations(pageNumber, pageScale, token)
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
    pendingEncryptedPdf = null
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
    currentPageTextSpans = []
    currentPageAnnotations = []
    selectedAnnotationId = null
    selectedTextSpanIds = []
    selectedTextAnchorId = null
    clearTextSearchState({ clearQuery: true, clearReplacement: true })
    renderedPageWidth = 0
    renderedPageHeight = 0
    metadataDraft = emptyMetadata()
    metadataDirty = false
    formFields = []
    formDrafts = {}
    formFieldsLoading = false
    formDirty = false
    flattenFormsOnApply = false
    ocrPreview = ''
    ocrPreviewLabel = 'No OCR text yet'
    ocrLastDurationMs = null
    await tick()
    await renderCurrentPage()
    void refreshWorkspaceContext(nextProxy, bytes)
  }

  async function clearWorkspaceSession() {
    if (pdfProxy) {
      await pdfProxy.destroy()
      pdfProxy = null
    }

    workspace = null
    currentPage = 1
    rangeExpression = '1'
    thumbnails = []
    currentPageTextSpans = []
    currentPageAnnotations = []
    selectedAnnotationId = null
    selectedTextSpanIds = []
    selectedTextAnchorId = null
    clearTextSearchState({ clearQuery: true, clearReplacement: true })
    renderedPageWidth = 0
    renderedPageHeight = 0
    metadataDraft = emptyMetadata()
    metadataDirty = false
    formFields = []
    formDrafts = {}
    formFieldsLoading = false
    formDirty = false
    flattenFormsOnApply = false
    ocrPreview = ''
    ocrPreviewLabel = 'No OCR text yet'
    ocrLastDurationMs = null
    dragSourcePage = null
    dropTargetPage = null
  }

  async function stageEncryptedPdf(
    payload: LoadedPdfPayload,
    options: {
      current?: number
      modified?: boolean
      source?: 'disk' | 'generated'
      path?: string | null
    } = {},
  ) {
    await clearWorkspaceSession()
    pendingEncryptedPdf = {
      payload,
      current: Math.max(1, options.current ?? 1),
      modified: options.modified ?? false,
      source: options.source ?? (payload.path ? 'disk' : 'generated'),
      path: options.path ?? payload.path,
    }
    statusTone = 'idle'
    status = qpdfReady
      ? `Encrypted PDF detected. Unlock ${payload.fileName} to continue.`
      : `Encrypted PDF detected in ${payload.fileName}. Install qpdf to unlock it locally.`
    lastError = null
  }

  async function resolveEditableBytes(payload: LoadedPdfPayload, contextLabel: string) {
    if (!payload.flags.encrypted) {
      return base64ToBytes(payload.bytesBase64)
    }

    if (!qpdfReady) {
      throw new Error(`Install qpdf locally to unlock encrypted PDFs before ${contextLabel}.`)
    }

    const unlockedPayload = await invoke<LoadedPdfPayload>('decrypt_pdf_bytes', {
      fileName: payload.fileName,
      bytesBase64: payload.bytesBase64,
      password: protectionUserPassword,
    })

    return base64ToBytes(unlockedPayload.bytesBase64)
  }

  async function refreshWorkspaceContext(proxy: PdfProxy, bytes: Uint8Array) {
    const nextMetadataToken = ++metadataToken
    const nextThumbnailToken = ++thumbnailToken
    const nextFormFieldToken = ++formFieldToken

    if (workspace?.flags.hasForms && !workspace.flags.hasXfa) {
      formFieldsLoading = true
    } else {
      formFieldsLoading = false
      hydrateFormFields([])
    }

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

    if (!workspace?.flags.hasForms || workspace.flags.hasXfa) {
      return
    }

    try {
      const nextFormFields = await readFormFieldsFromDocument(bytes)
      if (nextFormFieldToken === formFieldToken) {
        hydrateFormFields(nextFormFields)
        formFieldsLoading = false
      }
    } catch {
      if (nextFormFieldToken === formFieldToken) {
        hydrateFormFields([])
        formFieldsLoading = false
      }
    }
  }

  async function refreshCurrentPageTextTargets(pageNumber: number, scale: number, renderId: number) {
    if (!pdfProxy || !workspace) {
      currentPageTextSpans = []
      selectedTextSpanIds = []
      selectedTextAnchorId = null
      return
    }

    const nextTextSpanToken = ++textSpanToken

    try {
      const spans = await extractPageTextSpans(pdfProxy, pageNumber, scale)
      if (renderId !== renderToken || nextTextSpanToken !== textSpanToken || pageNumber !== currentPage) {
        return
      }

      currentPageTextSpans = spans
      if (!selectedTextSpanIds.every((id) => spans.some((span) => span.id === id))) {
        selectedTextSpanIds = []
        selectedTextAnchorId = null
      }
    } catch {
      if (nextTextSpanToken === textSpanToken) {
        currentPageTextSpans = []
        selectedTextSpanIds = []
        selectedTextAnchorId = null
      }
    }
  }

  async function refreshCurrentPageAnnotations(pageNumber: number, scale: number, renderId: number) {
    if (!pdfProxy || !workspace) {
      currentPageAnnotations = []
      selectedAnnotationId = null
      return
    }

    const nextAnnotationToken = ++annotationToken

    try {
      const annotations = await extractPageAnnotations(pdfProxy, pageNumber, scale)
      if (
        renderId !== renderToken ||
        nextAnnotationToken !== annotationToken ||
        pageNumber !== currentPage
      ) {
        return
      }

      currentPageAnnotations = annotations
      if (!annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
        selectedAnnotationId = null
      }
    } catch {
      if (nextAnnotationToken === annotationToken) {
        currentPageAnnotations = []
        selectedAnnotationId = null
      }
    }
  }

  function cloneFormFieldValue(value: PdfFormFieldValue): PdfFormFieldValue {
    return Array.isArray(value) ? [...value] : value
  }

  function normalizeFormFieldValueForCompare(field: PdfFormField, value: PdfFormFieldValue) {
    if (field.kind === 'checkbox') {
      return value === true ? '1' : '0'
    }

    if (field.multiSelect) {
      const values = Array.isArray(value)
        ? [...value]
        : typeof value === 'string' && value.trim().length > 0
          ? [value]
          : []
      return values.sort((left, right) => left.localeCompare(right)).join('\u0000')
    }

    if (typeof value === 'string') {
      return value
    }

    return ''
  }

  function buildFormDrafts(fields: PdfFormField[]) {
    const drafts: Record<string, PdfFormFieldValue> = {}

    for (const field of fields) {
      drafts[field.name] = cloneFormFieldValue(field.value)
    }

    return drafts
  }

  function hydrateFormFields(fields: PdfFormField[]) {
    formFields = fields
    formDrafts = buildFormDrafts(fields)
    formDirty = false
  }

  function recomputeFormDirty(nextDrafts: Record<string, PdfFormFieldValue>) {
    formDirty = formFields.some(
      (field) =>
        normalizeFormFieldValueForCompare(field, field.value) !==
        normalizeFormFieldValueForCompare(field, nextDrafts[field.name] ?? null),
    )
  }

  function setFormFieldDraft(fieldName: string, value: PdfFormFieldValue) {
    const nextDrafts = {
      ...formDrafts,
      [fieldName]: cloneFormFieldValue(value),
    }

    formDrafts = nextDrafts
    recomputeFormDirty(nextDrafts)
  }

  function getFormFieldDraftValue(field: PdfFormField) {
    return formDrafts[field.name] ?? cloneFormFieldValue(field.value)
  }

  function getSingleFormFieldDraftValue(field: PdfFormField) {
    const draftValue = getFormFieldDraftValue(field)

    if (typeof draftValue === 'string') {
      return draftValue
    }

    if (Array.isArray(draftValue)) {
      return draftValue[0] ?? ''
    }

    return ''
  }

  function getCheckboxFormFieldDraftValue(field: PdfFormField) {
    return getFormFieldDraftValue(field) === true
  }

  function getMultiSelectFormFieldDraftValue(field: PdfFormField) {
    const draftValue = getFormFieldDraftValue(field)

    if (Array.isArray(draftValue)) {
      return draftValue
    }

    if (typeof draftValue === 'string' && draftValue.trim().length > 0) {
      return [draftValue]
    }

    return []
  }

  function formatFormFieldKind(kind: PdfFormField['kind'], multiSelect: boolean) {
    switch (kind) {
      case 'text':
        return 'Text'
      case 'checkbox':
        return 'Checkbox'
      case 'radio':
        return 'Radio'
      case 'dropdown':
        return multiSelect ? 'Multi-select' : 'Dropdown'
      case 'option-list':
        return multiSelect ? 'Multi-list' : 'List'
      case 'signature':
        return 'Signature'
      case 'button':
        return 'Button'
      default:
        return 'Field'
    }
  }

  function formatFormFieldValueSummary(field: PdfFormField) {
    const draftValue = getFormFieldDraftValue(field)

    if (field.kind === 'checkbox') {
      return draftValue === true ? 'Checked' : 'Unchecked'
    }

    if (field.multiSelect) {
      const values = getMultiSelectFormFieldDraftValue(field)
      return values.length > 0 ? values.join(', ') : 'No selection'
    }

    const value = getSingleFormFieldDraftValue(field).trim()
    return value || 'Empty'
  }

  function updateTextFormFieldDraft(field: PdfFormField, value: string) {
    const nextValue =
      field.maxLength !== null && value.length > field.maxLength ? value.slice(0, field.maxLength) : value
    setFormFieldDraft(field.name, nextValue)
  }

  function updateCheckboxFormFieldDraft(field: PdfFormField, checked: boolean) {
    setFormFieldDraft(field.name, checked)
  }

  function updateMultiSelectFormFieldDraft(field: PdfFormField, select: HTMLSelectElement) {
    const values = Array.from(select.selectedOptions, (option) => option.value)
    setFormFieldDraft(field.name, values)
  }

  function resetFormFieldDrafts() {
    hydrateFormFields(formFields)
  }

  function getFormFieldOptionsListId(fieldName: string) {
    return `form-options-${fieldName.replace(/[^a-z0-9_-]/gi, '-')}`
  }

  function updateMetadataField(field: keyof PdfMetadataDraft, value: string) {
    metadataDraft = {
      ...metadataDraft,
      [field]: value,
    }
    metadataDirty = true
  }

  function resolveEditPageIndexes(document: WorkspaceDocument) {
    if (editScope === 'all') {
      return Array.from({ length: document.pageCount }, (_, index) => index)
    }

    return [currentPage - 1]
  }

  function formatEditScopeLabel(document: WorkspaceDocument) {
    if (editScope === 'all') {
      return `${document.pageCount} pages`
    }

    return `page ${currentPage}`
  }

  function parsePositiveInteger(value: string | number, fieldLabel: string) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)

    if (!Number.isFinite(parsed) || parsed < 1) {
      reportError(new Error(`${fieldLabel} must be a whole number greater than zero.`), `Invalid ${fieldLabel.toLowerCase()}`)
      return null
    }

    return parsed
  }

  function parseBoundedNumber(
    value: string | number,
    fieldLabel: string,
    min: number,
    max: number,
  ) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value)

    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      reportError(
        new Error(`${fieldLabel} must be between ${min} and ${max}.`),
        `Invalid ${fieldLabel.toLowerCase()}`,
      )
      return null
    }

    return parsed
  }

  function parseLooseBoundedNumber(value: string | number, min: number, max: number) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
    if (!Number.isFinite(parsed)) {
      return null
    }

    return clamp(parsed, min, max)
  }

  function normalizeTextTargetRegion(region: TextTargetRegion) {
    const widthPercent = clamp(region.widthPercent, 5, 100)
    const heightPercent = clamp(region.heightPercent, 5, 100)

    return {
      xPercent: clamp(region.xPercent, 0, 100 - widthPercent),
      yPercent: clamp(region.yPercent, 0, 100 - heightPercent),
      widthPercent,
      heightPercent,
      fontSize: clamp(region.fontSize, 8, 72),
    } satisfies TextTargetRegion
  }

  function buildSelectedTextTarget(spans: PdfPageTextSpan[]): SelectedTextTarget | null {
    if (spans.length === 0) {
      return null
    }

    const left = Math.min(...spans.map((span) => span.xPercent))
    const top = Math.min(...spans.map((span) => span.yPercent))
    const right = Math.max(...spans.map((span) => span.xPercent + span.widthPercent))
    const bottom = Math.max(...spans.map((span) => span.yPercent + span.heightPercent))

    return {
      id: spans.map((span) => span.id).join('::'),
      pageNumber: spans[0].pageNumber,
      text: spans
        .map((span) => span.text.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      xPercent: left,
      yPercent: top,
      widthPercent: right - left,
      heightPercent: bottom - top,
      fontSize: Math.max(...spans.map((span) => span.fontSize)),
      spanIds: spans.map((span) => span.id),
    }
  }

  function areTextTargetsOnSameLine(reference: PdfPageTextSpan, candidate: PdfPageTextSpan) {
    const lineThreshold = Math.max(0.9, Math.min(reference.heightPercent, candidate.heightPercent) * 0.65)
    return Math.abs(reference.yPercent - candidate.yPercent) <= lineThreshold
  }

  function resolveTextLineBounds(index: number) {
    if (index < 0 || index >= currentPageTextSpans.length) {
      return null
    }

    const reference = currentPageTextSpans[index]
    let start = index
    let end = index

    while (start > 0 && areTextTargetsOnSameLine(reference, currentPageTextSpans[start - 1])) {
      start -= 1
    }

    while (end < currentPageTextSpans.length - 1 && areTextTargetsOnSameLine(reference, currentPageTextSpans[end + 1])) {
      end += 1
    }

    return { start, end }
  }

  function resolveSelectedTextRangeIndices() {
    if (!selectedTextStartSpan || !selectedTextEndSpan) {
      return null
    }

    const startIndex = currentPageTextSpans.findIndex((span) => span.id === selectedTextStartSpan?.id)
    const endIndex = currentPageTextSpans.findIndex((span) => span.id === selectedTextEndSpan?.id)
    if (startIndex < 0 || endIndex < 0) {
      return null
    }

    return {
      startIndex,
      endIndex,
    }
  }

  function measureDistanceToTextSpan(span: PdfPageTextSpan, xPercent: number, yPercent: number) {
    const left = span.xPercent
    const top = span.yPercent
    const right = span.xPercent + span.widthPercent
    const bottom = span.yPercent + span.heightPercent

    const deltaX = xPercent < left ? left - xPercent : xPercent > right ? xPercent - right : 0
    const deltaY = yPercent < top ? top - yPercent : yPercent > bottom ? yPercent - bottom : 0
    const outsideDistance = Math.hypot(deltaX, deltaY)
    const centerX = left + span.widthPercent / 2
    const centerY = top + span.heightPercent / 2
    const centerDistance = Math.hypot(xPercent - centerX, (yPercent - centerY) * 1.1)

    return outsideDistance === 0 ? centerDistance * 0.05 : outsideDistance + centerDistance * 0.05
  }

  function findNearestTextTargetIndexAtSurfacePoint(xPercent: number, yPercent: number) {
    if (currentPageTextSpans.length === 0) {
      return -1
    }

    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY

    currentPageTextSpans.forEach((span, index) => {
      const distance = measureDistanceToTextSpan(span, xPercent, yPercent)
      if (distance < closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    })

    return closestIndex
  }

  function snapCoordinateToTextTargets(value: number, candidates: number[], threshold: number) {
    let snappedValue = value
    let closestDistance = threshold + Number.EPSILON

    for (const candidate of candidates) {
      const distance = Math.abs(candidate - value)
      if (distance <= closestDistance) {
        snappedValue = candidate
        closestDistance = distance
      }
    }

    return snappedValue
  }

  function snapTextTargetRegion(region: TextTargetRegion, handle: TextTargetRegionHandle) {
    const normalizedRegion = normalizeTextTargetRegion(region)
    if (currentPageTextSpans.length === 0) {
      return normalizedRegion
    }

    const xBoundaries = Array.from(
      new Set(
        currentPageTextSpans
          .flatMap((span) => [span.xPercent, span.xPercent + span.widthPercent])
          .map((value) => Number(value.toFixed(2))),
      ),
    )
    const yBoundaries = Array.from(
      new Set(
        currentPageTextSpans
          .flatMap((span) => [span.yPercent, span.yPercent + span.heightPercent])
          .map((value) => Number(value.toFixed(2))),
      ),
    )
    const snapThreshold = handle === 'move' ? 0.85 : 1.15

    if (handle === 'move') {
      return normalizeTextTargetRegion({
        ...normalizedRegion,
        xPercent: snapCoordinateToTextTargets(normalizedRegion.xPercent, xBoundaries, snapThreshold),
        yPercent: snapCoordinateToTextTargets(normalizedRegion.yPercent, yBoundaries, snapThreshold),
      })
    }

    let left = normalizedRegion.xPercent
    let top = normalizedRegion.yPercent
    let right = normalizedRegion.xPercent + normalizedRegion.widthPercent
    let bottom = normalizedRegion.yPercent + normalizedRegion.heightPercent

    if (handle.includes('w')) {
      left = snapCoordinateToTextTargets(left, xBoundaries, snapThreshold)
    }

    if (handle.includes('e')) {
      right = snapCoordinateToTextTargets(right, xBoundaries, snapThreshold)
    }

    if (handle.includes('n')) {
      top = snapCoordinateToTextTargets(top, yBoundaries, snapThreshold)
    }

    if (handle.includes('s')) {
      bottom = snapCoordinateToTextTargets(bottom, yBoundaries, snapThreshold)
    }

    return normalizeTextTargetRegion({
      xPercent: left,
      yPercent: top,
      widthPercent: right - left,
      heightPercent: bottom - top,
      fontSize: normalizedRegion.fontSize,
    })
  }

  function applyTextEditRegion(region: TextTargetRegion) {
    const normalizedRegion = normalizeTextTargetRegion(region)
    textEditX = normalizedRegion.xPercent.toFixed(2)
    textEditY = normalizedRegion.yPercent.toFixed(2)
    textEditWidth = normalizedRegion.widthPercent.toFixed(2)
    textEditHeight = normalizedRegion.heightPercent.toFixed(2)
    textEditFontSize = Math.round(normalizedRegion.fontSize).toString()
  }

  function resolveSelectedTextTargetRegionPreview() {
    if (!selectedTextSpan) {
      return null
    }

    return normalizeTextTargetRegion({
      xPercent: parseLooseBoundedNumber(textEditX, 0, 95) ?? selectedTextSpan.xPercent,
      yPercent: parseLooseBoundedNumber(textEditY, 0, 95) ?? selectedTextSpan.yPercent,
      widthPercent: parseLooseBoundedNumber(textEditWidth, 5, 100) ?? Math.max(selectedTextSpan.widthPercent, 5),
      heightPercent: parseLooseBoundedNumber(textEditHeight, 5, 100) ?? Math.max(selectedTextSpan.heightPercent, 5),
      fontSize: parseLooseBoundedNumber(textEditFontSize, 8, 72) ?? selectedTextSpan.fontSize,
    })
  }

  function resolveSelectedTextTargetRegion() {
    if (!selectedTextSpan) {
      return null
    }

    const xPercent = parseBoundedNumber(textEditX, 'Edit X', 0, 95)
    const yPercent = parseBoundedNumber(textEditY, 'Edit Y', 0, 95)
    const widthPercent = parseBoundedNumber(textEditWidth, 'Edit width', 5, 100)
    const heightPercent = parseBoundedNumber(textEditHeight, 'Edit height', 5, 100)
    const fontSize = parseBoundedNumber(textEditFontSize, 'Edit font size', 8, 72)

    if (
      xPercent === null ||
      yPercent === null ||
      widthPercent === null ||
      heightPercent === null ||
      fontSize === null
    ) {
      return null
    }

    return normalizeTextTargetRegion({
      xPercent,
      yPercent,
      widthPercent,
      heightPercent,
      fontSize,
    })
  }

  function normalizeTextTargetSequenceText(spans: PdfPageTextSpan[]) {
    return spans
      .map((span) => span.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function clearTextSearchState(options: { clearQuery?: boolean; clearReplacement?: boolean } = {}) {
    textSearchBusy = false
    textSearchResults = []
    activeTextSearchResultIndex = -1

    if (options.clearQuery ?? false) {
      textSearchQuery = ''
    }

    if (options.clearReplacement ?? false) {
      textSearchReplacement = ''
    }
  }

  function normalizeTextSearchValue(value: string, caseSensitive = false) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return caseSensitive ? normalized : normalized.toLowerCase()
  }

  function resolveTextSearchOccurrences(
    spans: PdfPageTextSpan[],
    query: string,
    caseSensitive: boolean,
  ) {
    const normalizedQuery = normalizeTextSearchValue(query, caseSensitive)
    if (!normalizedQuery) {
      return []
    }

    const normalizedSpanTexts = spans.map((span) => normalizeTextSearchValue(span.text, caseSensitive))
    const matches: TextTargetOccurrenceMatch[] = []

    for (let startIndex = 0; startIndex < spans.length; startIndex += 1) {
      const firstSegment = normalizedSpanTexts[startIndex]
      if (!firstSegment || !normalizedQuery.startsWith(firstSegment)) {
        continue
      }

      const parts: string[] = []
      for (let endIndex = startIndex; endIndex < spans.length; endIndex += 1) {
        const segment = normalizedSpanTexts[endIndex]
        if (!segment) {
          break
        }

        parts.push(segment)
        const candidate = parts.join(' ')
        if (candidate === normalizedQuery) {
          matches.push({
            occurrenceIndex: matches.length,
            startIndex,
            endIndex,
          })
          break
        }

        if (candidate.length >= normalizedQuery.length || !normalizedQuery.startsWith(candidate)) {
          break
        }
      }
    }

    return matches
  }

  async function resolveTextSearchPageSpans(pageNumber: number) {
    if (!pdfProxy) {
      return []
    }

    if (pageNumber === currentPage && currentPageTextSpans.length > 0) {
      return currentPageTextSpans
    }

    return extractPageTextSpans(pdfProxy, pageNumber, zoom)
  }

  function buildDocumentTextSearchResult(
    pageNumber: number,
    match: TextTargetOccurrenceMatch,
    spans: PdfPageTextSpan[],
  ) {
    const matchTarget = buildSelectedTextTarget(spans.slice(match.startIndex, match.endIndex + 1))
    if (!matchTarget) {
      return null
    }

    return {
      id: `search-${pageNumber}-${match.occurrenceIndex}-${match.startIndex}-${match.endIndex}`,
      pageNumber,
      pageIndex: pageNumber - 1,
      startIndex: match.startIndex,
      endIndex: match.endIndex,
      occurrenceIndex: match.occurrenceIndex,
      text: matchTarget.text,
      xPercent: matchTarget.xPercent,
      yPercent: matchTarget.yPercent,
      widthPercent: matchTarget.widthPercent,
      heightPercent: matchTarget.heightPercent,
      fontSize: matchTarget.fontSize,
    } satisfies DocumentTextSearchResult
  }

  function resolvePreferredTextSearchResultIndex(
    results: DocumentTextSearchResult[],
    previousActiveId: string | null,
  ) {
    if (results.length === 0) {
      return -1
    }

    if (previousActiveId) {
      const previousIndex = results.findIndex((result) => result.id === previousActiveId)
      if (previousIndex >= 0) {
        return previousIndex
      }
    }

    const currentPageIndex = results.findIndex((result) => result.pageNumber === currentPage)
    if (currentPageIndex >= 0) {
      return currentPageIndex
    }

    return 0
  }

  async function focusTextSearchField() {
    if (!workspace) {
      return
    }

    textTargetMode = true
    await tick()
    textSearchInput?.focus()
    textSearchInput?.select()
  }

  async function activateTextSearchResult(index: number, options: { focusEditor?: boolean } = {}) {
    if (!workspace || !pdfProxy || index < 0 || index >= textSearchResults.length) {
      return
    }

    const result = textSearchResults[index]
    textTargetMode = true

    if (currentPage !== result.pageNumber) {
      await goToPage(result.pageNumber)
    }

    const spans = await extractPageTextSpans(pdfProxy, result.pageNumber, zoom)
    if (currentPage !== result.pageNumber) {
      return
    }

    currentPageTextSpans = spans
    if (result.endIndex >= spans.length) {
      await runTextSearch({ preserveActive: false, focusActive: false })
      return
    }

    activeTextSearchResultIndex = index
    await applySelectedTextRange(result.startIndex, result.endIndex, {
      focusEditor: options.focusEditor ?? false,
    })
  }

  async function jumpToTextSearchResult(direction: -1 | 1) {
    if (textSearchResults.length === 0) {
      return
    }

    const baseIndex = activeTextSearchResultIndex >= 0 ? activeTextSearchResultIndex : direction > 0 ? -1 : 0
    const nextIndex = (baseIndex + direction + textSearchResults.length) % textSearchResults.length
    await activateTextSearchResult(nextIndex, { focusEditor: false })
  }

  async function runTextSearch(options: { preserveActive?: boolean; focusActive?: boolean } = {}) {
    if (!workspace || !pdfProxy || textSearchBusy) {
      return
    }

    const normalizedQuery = normalizeTextSearchValue(textSearchQuery, textSearchCaseSensitive)
    if (!normalizedQuery) {
      clearTextSearchState()
      statusTone = 'idle'
      status = 'Cleared text search results'
      return
    }

    const previousActiveId = options.preserveActive === false ? null : activeTextSearchResult?.id ?? null
    const pageNumbers =
      textSearchScope === 'document'
        ? Array.from({ length: workspace.pageCount }, (_, index) => index + 1)
        : [currentPage]

    textSearchBusy = true
    statusTone = 'busy'
    status =
      textSearchScope === 'document'
        ? `Searching ${workspace.pageCount} pages for exact text`
        : `Searching page ${currentPage} for exact text`
    lastError = null

    try {
      const results: DocumentTextSearchResult[] = []

      for (const pageNumber of pageNumbers) {
        const spans = await resolveTextSearchPageSpans(pageNumber)
        const matches = resolveTextSearchOccurrences(spans, textSearchQuery, textSearchCaseSensitive)
        for (const match of matches) {
          const result = buildDocumentTextSearchResult(pageNumber, match, spans)
          if (result) {
            results.push(result)
          }
        }
      }

      textSearchResults = results
      activeTextSearchResultIndex = resolvePreferredTextSearchResultIndex(results, previousActiveId)

      if (results.length === 0) {
        statusTone = 'idle'
        status = 'No exact text matches found'
        return
      }

      statusTone = 'idle'
      status =
        textSearchScope === 'document'
          ? `Found ${results.length} exact text result${results.length === 1 ? '' : 's'} across the document`
          : `Found ${results.length} exact text result${results.length === 1 ? '' : 's'} on page ${currentPage}`

      if ((options.focusActive ?? true) && activeTextSearchResultIndex >= 0) {
        await activateTextSearchResult(activeTextSearchResultIndex, { focusEditor: false })
      }
    } catch (error) {
      reportError(error, 'Failed to search PDF text')
    } finally {
      textSearchBusy = false
    }
  }

  async function replaceActiveTextSearchResult() {
    if (!workspace || busy || textSearchBusy || activeTextSearchResultIndex < 0) {
      return
    }

    const replacementText = textSearchReplacement.trim()
    if (!replacementText) {
      reportError(new Error('Enter replacement text before replacing search results.'), 'Replacement text is required')
      return
    }

    await activateTextSearchResult(activeTextSearchResultIndex, { focusEditor: false })
    if (!selectedTextSpan) {
      reportError(new Error('Select an active search result before replacing it.'), 'No active search result selected')
      return
    }

    const currentWorkspace = workspace
    const currentResult = textSearchResults[activeTextSearchResultIndex]
    const targetRegion = resolveSelectedTextTargetRegion()
    if (!currentResult || !targetRegion) {
      return
    }

    busy = true
    statusTone = 'busy'
    status = `Replacing search result on page ${currentResult.pageNumber}`
    lastError = null

    try {
      const result = await replaceTargetedTextInDocument(currentWorkspace.bytes, {
        targetText: currentResult.text,
        replacementText,
        pageIndex: currentResult.pageIndex,
        targetOccurrence: currentResult.occurrenceIndex,
        xPercent: targetRegion.xPercent,
        yPercent: targetRegion.yPercent,
        widthPercent: targetRegion.widthPercent,
        heightPercent: targetRegion.heightPercent,
        fontSize: targetRegion.fontSize,
        alignment: textEditAlignment,
      })

      await commitGeneratedPdf(result.bytes, {
        fileName: currentWorkspace.fileName,
        current: currentResult.pageNumber,
      })
      await runTextSearch({ preserveActive: false, focusActive: false })

      statusTone = 'idle'
      status =
        result.strategy === 'content-stream'
          ? `Replaced search result on page ${currentResult.pageNumber}`
          : `Replaced search result on page ${currentResult.pageNumber} with visual fallback`
    } catch (error) {
      reportError(error, 'Failed to replace the active search result')
    } finally {
      busy = false
    }
  }

  async function replaceAllTextSearchResults() {
    if (!workspace || busy || textSearchBusy || textSearchResults.length === 0) {
      return
    }

    const replacementText = textSearchReplacement.trim()
    if (!replacementText) {
      reportError(new Error('Enter replacement text before replacing search results.'), 'Replacement text is required')
      return
    }

    const normalizedQuery = normalizeTextSearchValue(textSearchQuery, textSearchCaseSensitive)
    const normalizedReplacement = normalizeTextSearchValue(textSearchReplacement, textSearchCaseSensitive)
    if (normalizedQuery && normalizedReplacement.includes(normalizedQuery)) {
      reportError(
        new Error('Replace all requires replacement text that does not contain the current find text.'),
        'Replace all would create ambiguous repeated matches',
      )
      return
    }

    const currentWorkspace = workspace
    const results = [...textSearchResults].sort(
      (left, right) => right.pageIndex - left.pageIndex || right.occurrenceIndex - left.occurrenceIndex,
    )
    let workingBytes = currentWorkspace.bytes
    let contentStreamReplacements = 0
    let overlayReplacements = 0

    busy = true
    statusTone = 'busy'
    status = `Replacing ${results.length} exact text result${results.length === 1 ? '' : 's'}`
    lastError = null

    try {
      for (const result of results) {
        const replacement = await replaceTargetedTextInDocument(workingBytes, {
          targetText: result.text,
          replacementText,
          pageIndex: result.pageIndex,
          targetOccurrence: result.occurrenceIndex,
          xPercent: result.xPercent,
          yPercent: result.yPercent,
          widthPercent: result.widthPercent,
          heightPercent: result.heightPercent,
          fontSize: result.fontSize,
          alignment: textEditAlignment,
        })

        workingBytes = replacement.bytes
        if (replacement.strategy === 'content-stream') {
          contentStreamReplacements += 1
        } else {
          overlayReplacements += 1
        }
      }

      await commitGeneratedPdf(workingBytes, {
        fileName: currentWorkspace.fileName,
        current: currentPage,
      })
      await runTextSearch({ preserveActive: false, focusActive: false })

      const replacementCount = contentStreamReplacements + overlayReplacements
      statusTone = 'idle'
      status =
        overlayReplacements === 0
          ? `Replaced ${replacementCount} exact text result${replacementCount === 1 ? '' : 's'}`
          : contentStreamReplacements === 0
            ? `Replaced ${replacementCount} exact text result${replacementCount === 1 ? '' : 's'} with visual fallback`
            : `Replaced ${replacementCount} exact text result${replacementCount === 1 ? '' : 's'} with mixed rewrite and fallback`
    } catch (error) {
      reportError(error, 'Failed to replace all search results')
    } finally {
      busy = false
    }
  }

  function handleTextSearchQueryKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    void runTextSearch({ preserveActive: false, focusActive: true })
  }

  function handleTextSearchReplacementKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    void replaceActiveTextSearchResult()
  }

  function resolveMatchingSelectedTextOccurrences() {
    if (!selectedTextSpan || selectedTextSpan.spanIds.length === 0) {
      return []
    }

    const selectedSequenceLength = selectedTextSpan.spanIds.length
    const selectedSequenceText = normalizeTextTargetSequenceText(selectedTextSpans)
    const matches: TextTargetOccurrenceMatch[] = []

    for (let index = 0; index <= currentPageTextSpans.length - selectedSequenceLength; index += 1) {
      const sequence = currentPageTextSpans.slice(index, index + selectedSequenceLength)
      const sequenceText = normalizeTextTargetSequenceText(sequence)

      if (sequenceText !== selectedSequenceText) {
        continue
      }

      matches.push({
        occurrenceIndex: matches.length,
        startIndex: index,
        endIndex: index + selectedSequenceLength - 1,
      })
    }

    return matches
  }

  function resolveSelectedTextOccurrence() {
    if (!selectedTextSpan || selectedTextSpan.spanIds.length === 0) {
      return 0
    }

    for (const match of resolveMatchingSelectedTextOccurrences()) {
      const sequence = currentPageTextSpans.slice(match.startIndex, match.endIndex + 1)
      const isActiveSelection = sequence.every((span, sequenceIndex) => span.id === selectedTextSpan.spanIds[sequenceIndex])
      if (isActiveSelection) {
        return match.occurrenceIndex
      }
    }

    return 0
  }

  async function jumpToMatchingTextOccurrence(direction: -1 | 1) {
    const matches = resolveMatchingSelectedTextOccurrences()
    if (!selectedTextSpan || matches.length === 0) {
      return
    }

    const selectedOccurrenceIndex = resolveSelectedTextOccurrence()
    const nextOccurrenceIndex = (selectedOccurrenceIndex + direction + matches.length) % matches.length
    const match = matches[nextOccurrenceIndex]
    if (!match) {
      return
    }

    await applySelectedTextRange(match.startIndex, match.endIndex, { focusEditor: false })
  }

  function isTextInputTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return false
    }

    const tagName = target.tagName.toUpperCase()
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable
  }

  function resolveTextEditLayout() {
    const xPercent = parseBoundedNumber(textEditX, 'Edit X', 0, 95)
    const yPercent = parseBoundedNumber(textEditY, 'Edit Y', 0, 95)
    const widthPercent = parseBoundedNumber(textEditWidth, 'Edit width', 5, 100)
    const heightPercent = parseBoundedNumber(textEditHeight, 'Edit height', 5, 100)
    const fontSize = parseBoundedNumber(textEditFontSize, 'Edit font size', 8, 72)

    if (
      xPercent === null ||
      yPercent === null ||
      widthPercent === null ||
      heightPercent === null ||
      fontSize === null
    ) {
      return null
    }

    const region = normalizeTextTargetRegion({
      xPercent,
      yPercent,
      widthPercent,
      heightPercent,
      fontSize,
    })

    return {
      ...region,
      alignment: textEditAlignment,
    }
  }

  function resolveStickyNoteAnchor() {
    const selectedRegion = resolveSelectedTextTargetRegionPreview()
    if (selectedRegion) {
      return {
        xPercent: clamp(selectedRegion.xPercent + selectedRegion.widthPercent + 1.2, 0, 96),
        yPercent: clamp(selectedRegion.yPercent, 0, 96),
      }
    }

    const layout = resolveTextEditLayout()
    if (!layout) {
      return null
    }

    return {
      xPercent: layout.xPercent,
      yPercent: layout.yPercent,
    }
  }

  function formatAnnotationTooltip(annotation: PdfPageAnnotationOverlay) {
    const kindLabel =
      annotation.kind === 'strikeout'
        ? 'Strikeout annotation'
        : annotation.kind === 'underline'
          ? 'Underline annotation'
          : annotation.kind === 'highlight'
            ? 'Highlight annotation'
            : 'Sticky note annotation'

    if (annotation.title && annotation.contents) {
      return `${kindLabel}: ${annotation.title} - ${annotation.contents}`
    }

    if (annotation.contents) {
      return `${kindLabel}: ${annotation.contents}`
    }

    if (annotation.title) {
      return `${kindLabel}: ${annotation.title}`
    }

    return kindLabel
  }

  function toggleTextTargetMode() {
    textTargetMode = !textTargetMode
    if (!textTargetMode) {
      clearSelectedTextTarget()
    }
  }

  function clearSelectedTextTarget() {
    selectedTextSpanIds = []
    selectedTextAnchorId = null
    inlineTextEditorOpen = false
    textTargetDragSession = null
    textTargetGripDragSession = null
    textTargetSweepSession = null
  }

  async function applySelectedTextRange(anchorIndex: number, extentIndex: number, options: { focusEditor?: boolean } = {}) {
    if (anchorIndex < 0 || extentIndex < 0 || currentPageTextSpans.length === 0) {
      return
    }

    const clampedAnchorIndex = clamp(anchorIndex, 0, currentPageTextSpans.length - 1)
    const clampedExtentIndex = clamp(extentIndex, 0, currentPageTextSpans.length - 1)
    const start = Math.min(clampedAnchorIndex, clampedExtentIndex)
    const end = Math.max(clampedAnchorIndex, clampedExtentIndex)
    const nextSelection = currentPageTextSpans.slice(start, end + 1)
    const nextTarget = buildSelectedTextTarget(nextSelection)

    if (!nextTarget) {
      return
    }

    selectedTextAnchorId = currentPageTextSpans[clampedAnchorIndex]?.id ?? null
    selectedTextSpanIds = nextSelection.map((candidate) => candidate.id)
    inlineTextEditorOpen = true
    textEditContent = nextTarget.text
    applyTextEditRegion({
      xPercent: nextTarget.xPercent,
      yPercent: nextTarget.yPercent,
      widthPercent: Math.max(nextTarget.widthPercent, 5),
      heightPercent: Math.max(nextTarget.heightPercent, 5),
      fontSize: nextTarget.fontSize,
    })
    textEditAlignment = 'left'

    const matchingSearchResultIndex = textSearchResults.findIndex(
      (result) =>
        result.pageNumber === currentPage && result.startIndex === start && result.endIndex === end,
    )
    if (matchingSearchResultIndex >= 0) {
      activeTextSearchResultIndex = matchingSearchResultIndex
    } else if (activeTextSearchResult?.pageNumber === currentPage) {
      activeTextSearchResultIndex = -1
    }

    if (options.focusEditor ?? true) {
      await tick()
      inlineTextEditor?.focus()
      inlineTextEditor?.select()
    }
  }

  function resolveSelectedTextExtentId() {
    if (selectedTextSpanIds.length === 0) {
      return null
    }

    if (!selectedTextAnchorId || selectedTextSpanIds.length === 1) {
      return selectedTextSpanIds.at(-1) ?? null
    }

    return selectedTextSpanIds[0] === selectedTextAnchorId
      ? (selectedTextSpanIds.at(-1) ?? selectedTextAnchorId)
      : selectedTextSpanIds[0]
  }

  async function moveTextTargetSelection(direction: -1 | 1, extendSelection: boolean) {
    if (currentPageTextSpans.length === 0) {
      return
    }

    if (selectedTextSpanIds.length === 0 || !selectedTextSpan) {
      const initialIndex = direction > 0 ? 0 : currentPageTextSpans.length - 1
      await applySelectedTextRange(initialIndex, initialIndex, { focusEditor: false })
      return
    }

    const anchorId = selectedTextAnchorId ?? selectedTextSpanIds[0]
    const extentId = resolveSelectedTextExtentId() ?? anchorId
    const anchorIndex = currentPageTextSpans.findIndex((span) => span.id === anchorId)
    const extentIndex = currentPageTextSpans.findIndex((span) => span.id === extentId)

    if (anchorIndex < 0 || extentIndex < 0) {
      return
    }

    const nextIndex = clamp(extentIndex + direction, 0, currentPageTextSpans.length - 1)
    if (!extendSelection) {
      if (nextIndex === extentIndex && selectedTextSpanIds.length === 1) {
        return
      }

      await applySelectedTextRange(nextIndex, nextIndex, { focusEditor: false })
      return
    }

    if (nextIndex === extentIndex) {
      return
    }

    await applySelectedTextRange(anchorIndex, nextIndex, { focusEditor: false })
  }

  async function jumpTextTargetSelection(destination: 'start' | 'end', extendSelection: boolean) {
    if (currentPageTextSpans.length === 0) {
      return
    }

    const targetIndex = destination === 'start' ? 0 : currentPageTextSpans.length - 1
    if (selectedTextSpanIds.length === 0 || !selectedTextSpan || !extendSelection) {
      await applySelectedTextRange(targetIndex, targetIndex, { focusEditor: false })
      return
    }

    const anchorId = selectedTextAnchorId ?? selectedTextSpanIds[0]
    const anchorIndex = currentPageTextSpans.findIndex((span) => span.id === anchorId)
    if (anchorIndex < 0) {
      await applySelectedTextRange(targetIndex, targetIndex, { focusEditor: false })
      return
    }

    await applySelectedTextRange(anchorIndex, targetIndex, { focusEditor: false })
  }

  async function jumpToTextLineBoundary(boundary: 'start' | 'end', extendSelection: boolean) {
    if (currentPageTextSpans.length === 0) {
      return
    }

    if (!selectedTextSpan) {
      const fallbackIndex = boundary === 'start' ? 0 : currentPageTextSpans.length - 1
      await applySelectedTextRange(fallbackIndex, fallbackIndex, { focusEditor: false })
      return
    }

    const range = resolveSelectedTextRangeIndices()
    if (!range) {
      return
    }

    if (!extendSelection) {
      const boundarySourceIndex = boundary === 'start' ? range.startIndex : range.endIndex
      const lineBounds = resolveTextLineBounds(boundarySourceIndex)
      if (!lineBounds) {
        return
      }

      const targetIndex = boundary === 'start' ? lineBounds.start : lineBounds.end
      await applySelectedTextRange(targetIndex, targetIndex, { focusEditor: false })
      return
    }

    if (boundary === 'start') {
      const lineBounds = resolveTextLineBounds(range.startIndex)
      if (!lineBounds) {
        return
      }

      await applySelectedTextRange(range.endIndex, lineBounds.start, { focusEditor: false })
      return
    }

    const lineBounds = resolveTextLineBounds(range.endIndex)
    if (!lineBounds) {
      return
    }

    await applySelectedTextRange(range.startIndex, lineBounds.end, { focusEditor: false })
  }

  async function selectAllTextTargets() {
    if (currentPageTextSpans.length === 0) {
      return
    }

    await applySelectedTextRange(0, currentPageTextSpans.length - 1, { focusEditor: false })
  }

  async function selectCurrentTextLine() {
    if (currentPageTextSpans.length === 0) {
      return
    }

    const targetIndex = selectedTextStartSpan
      ? currentPageTextSpans.findIndex((span) => span.id === selectedTextStartSpan?.id)
      : 0
    const lineBounds = resolveTextLineBounds(targetIndex)
    if (!lineBounds) {
      return
    }

    await applySelectedTextRange(lineBounds.start, lineBounds.end, { focusEditor: false })
  }

  async function selectAdjacentTextLine(direction: -1 | 1, extendSelection: boolean) {
    if (currentPageTextSpans.length === 0) {
      return
    }

    if (!selectedTextSpan) {
      const fallbackIndex = direction > 0 ? 0 : currentPageTextSpans.length - 1
      const lineBounds = resolveTextLineBounds(fallbackIndex)
      if (!lineBounds) {
        return
      }

      await applySelectedTextRange(lineBounds.start, lineBounds.end, { focusEditor: false })
      return
    }

    const range = resolveSelectedTextRangeIndices()
    if (!range) {
      return
    }

    if (!extendSelection) {
      const sourceIndex = direction < 0 ? range.startIndex : range.endIndex
      const sourceLine = resolveTextLineBounds(sourceIndex)
      if (!sourceLine) {
        return
      }

      const candidateIndex = direction < 0 ? sourceLine.start - 1 : sourceLine.end + 1
      const candidateLine = resolveTextLineBounds(candidateIndex)
      if (!candidateLine) {
        return
      }

      await applySelectedTextRange(candidateLine.start, candidateLine.end, { focusEditor: false })
      return
    }

    if (direction < 0) {
      const previousLine = resolveTextLineBounds(range.startIndex - 1)
      if (!previousLine) {
        return
      }

      await applySelectedTextRange(range.endIndex, previousLine.start, { focusEditor: false })
      return
    }

    const nextLine = resolveTextLineBounds(range.endIndex + 1)
    if (!nextLine) {
      return
    }

    await applySelectedTextRange(range.startIndex, nextLine.end, { focusEditor: false })
  }

  function resetSelectedTextEditContent() {
    if (!selectedTextSpan) {
      return
    }

    textEditContent = selectedTextSpan.text
  }

  function nudgeSelectedTextRegion(deltaXPercent: number, deltaYPercent: number) {
    const selectedRegion = resolveSelectedTextTargetRegionPreview()
    if (!selectedRegion) {
      return
    }

    applyTextEditRegion({
      ...selectedRegion,
      xPercent: selectedRegion.xPercent + deltaXPercent,
      yPercent: selectedRegion.yPercent + deltaYPercent,
    })
  }

  function resizeSelectedTextRegion(deltaWidthPercent: number, deltaHeightPercent: number) {
    const selectedRegion = resolveSelectedTextTargetRegionPreview()
    if (!selectedRegion) {
      return
    }

    applyTextEditRegion({
      ...selectedRegion,
      widthPercent: selectedRegion.widthPercent + deltaWidthPercent,
      heightPercent: selectedRegion.heightPercent + deltaHeightPercent,
    })
  }

  function resetSelectedTextRegion() {
    if (!selectedTextSpan) {
      return
    }

    applyTextEditRegion({
      xPercent: selectedTextSpan.xPercent,
      yPercent: selectedTextSpan.yPercent,
      widthPercent: Math.max(selectedTextSpan.widthPercent, 5),
      heightPercent: Math.max(selectedTextSpan.heightPercent, 5),
      fontSize: selectedTextSpan.fontSize,
    })
  }

  function selectAnnotation(annotation: PdfPageAnnotationOverlay) {
    selectedAnnotationId = annotation.id
    reviewNoteTitle = annotation.title?.trim() || 'Review Note'
    reviewNoteBody = annotation.contents
    if (annotation.kind === 'text') {
      reviewNoteTone = resolveReviewToneForAnnotation(annotation)
    }
  }

  function clearSelectedAnnotation() {
    selectedAnnotationId = null
  }

  function resolveReviewToneForAnnotation(annotation: PdfPageAnnotationOverlay): ReviewNoteTone {
    const rgbMatch = annotation.colorCss.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i)
    if (!rgbMatch) {
      return reviewNoteTone
    }

    const color = rgbMatch.slice(1).map((value) => Number.parseInt(value, 10))
    if (color.some((value) => !Number.isFinite(value))) {
      return reviewNoteTone
    }

    let closestTone: ReviewNoteTone = reviewNoteTone
    let closestDistance = Number.POSITIVE_INFINITY

    for (const [tone, target] of Object.entries(reviewToneRgbMap) as Array<[ReviewNoteTone, [number, number, number]]>) {
      const distance = Math.sqrt(
        Math.pow(color[0] - target[0], 2) + Math.pow(color[1] - target[1], 2) + Math.pow(color[2] - target[2], 2),
      )

      if (distance < closestDistance) {
        closestDistance = distance
        closestTone = tone
      }
    }

    return closestTone
  }

  async function selectTextTarget(
    span: PdfPageTextSpan,
    options: { focusEditor?: boolean; extendSelection?: boolean } = {},
  ) {
    const spanIndex = currentPageTextSpans.findIndex((candidate) => candidate.id === span.id)
    if (spanIndex < 0) {
      return
    }

    let nextSelection = [span]
    if (options.extendSelection && selectedTextAnchorId) {
      const anchorIndex = currentPageTextSpans.findIndex((candidate) => candidate.id === selectedTextAnchorId)
      if (anchorIndex >= 0) {
        const start = Math.min(anchorIndex, spanIndex)
        const end = Math.max(anchorIndex, spanIndex)
        nextSelection = currentPageTextSpans.slice(start, end + 1)
      } else {
        selectedTextAnchorId = span.id
      }
    } else {
      nextSelection = [span]
    }

    const extentSpan = nextSelection.at(-1) ?? span
    await applySelectedTextRange(
      selectedTextAnchorId && options.extendSelection
        ? currentPageTextSpans.findIndex((candidate) => candidate.id === selectedTextAnchorId)
        : spanIndex,
      currentPageTextSpans.findIndex((candidate) => candidate.id === extentSpan.id),
      { focusEditor: options.focusEditor },
    )
  }

  async function handleTextTargetPointerDown(span: PdfPageTextSpan, event: PointerEvent) {
    if (busy || event.button !== 0) {
      return
    }

    textTargetSweepSession = {
      pointerId: event.pointerId,
    }

    await selectTextTarget(span, {
      extendSelection: event.shiftKey,
      focusEditor: false,
    })
  }

  async function handleTextTargetPointerEnter(span: PdfPageTextSpan, event: PointerEvent) {
    if (!textTargetSweepSession || textTargetSweepSession.pointerId !== event.pointerId) {
      return
    }

    await selectTextTarget(span, {
      extendSelection: true,
      focusEditor: false,
    })
  }

  async function handleTextTargetDoubleClick(span: PdfPageTextSpan) {
    const spanIndex = currentPageTextSpans.findIndex((candidate) => candidate.id === span.id)
    if (spanIndex < 0) {
      return
    }

    const lineBounds = resolveTextLineBounds(spanIndex)
    if (!lineBounds) {
      return
    }

    await applySelectedTextRange(lineBounds.start, lineBounds.end, { focusEditor: true })
  }

  function resolveTextTargetSelectionGripPosition(grip: TextTargetSelectionGrip) {
    const gripSpan = grip === 'start' ? selectedTextStartSpan : selectedTextEndSpan
    if (!gripSpan) {
      return null
    }

    const xPercent = grip === 'start' ? gripSpan.xPercent : gripSpan.xPercent + gripSpan.widthPercent
    const yPercent = gripSpan.yPercent + gripSpan.heightPercent

    return {
      xPercent: clamp(xPercent, 0, 100),
      yPercent: clamp(yPercent, 0, 100),
    }
  }

  function resolveInlineTextEditorPosition() {
    const selectedRegion = resolveSelectedTextTargetRegionPreview()
    if (!selectedRegion) {
      return null
    }

    const cardWidthPercent = 26
    const shouldPlaceRight = selectedRegion.xPercent + selectedRegion.widthPercent + cardWidthPercent <= 98
    const xPercent = shouldPlaceRight
      ? clamp(selectedRegion.xPercent + selectedRegion.widthPercent + 1.4, 2, 98 - cardWidthPercent)
      : clamp(selectedRegion.xPercent - cardWidthPercent - 1.4, 2, 98 - cardWidthPercent)

    return {
      xPercent,
      yPercent: clamp(selectedRegion.yPercent - 1.2, 1.5, 84),
    }
  }

  function startTextTargetRegionDrag(handle: TextTargetRegionHandle, event: PointerEvent) {
    if (busy || !selectedTextSpan || !viewerSurface) {
      return
    }

    const startRegion = resolveSelectedTextTargetRegionPreview()
    if (!startRegion) {
      return
    }

    const surfaceBounds = viewerSurface.getBoundingClientRect()
    if (surfaceBounds.width <= 0 || surfaceBounds.height <= 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    textTargetDragSession = {
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      surfaceWidth: surfaceBounds.width,
      surfaceHeight: surfaceBounds.height,
      startRegion,
    }
  }

  function startTextTargetSelectionGripDrag(grip: TextTargetSelectionGrip, event: PointerEvent) {
    if (busy || !selectedTextSpan || !viewerSurface) {
      return
    }

    const surfaceBounds = viewerSurface.getBoundingClientRect()
    if (surfaceBounds.width <= 0 || surfaceBounds.height <= 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    textTargetGripDragSession = {
      grip,
      surfaceLeft: surfaceBounds.left,
      surfaceTop: surfaceBounds.top,
      surfaceWidth: surfaceBounds.width,
      surfaceHeight: surfaceBounds.height,
    }
  }

  async function updateDraggedTextTargetGrip(clientX: number, clientY: number) {
    if (!textTargetGripDragSession) {
      return
    }

    const selectionRange = resolveSelectedTextRangeIndices()
    if (!selectionRange) {
      return
    }

    const { grip, surfaceLeft, surfaceTop, surfaceWidth, surfaceHeight } = textTargetGripDragSession
    const xPercent = clamp(((clientX - surfaceLeft) / surfaceWidth) * 100, 0, 100)
    const yPercent = clamp(((clientY - surfaceTop) / surfaceHeight) * 100, 0, 100)
    const nearestIndex = findNearestTextTargetIndexAtSurfacePoint(xPercent, yPercent)
    if (nearestIndex < 0) {
      return
    }

    if (grip === 'start') {
      const nextStartIndex = Math.min(nearestIndex, selectionRange.endIndex)
      if (nextStartIndex === selectionRange.startIndex) {
        return
      }

      await applySelectedTextRange(selectionRange.endIndex, nextStartIndex, { focusEditor: false })
      return
    }

    const nextEndIndex = Math.max(nearestIndex, selectionRange.startIndex)
    if (nextEndIndex === selectionRange.endIndex) {
      return
    }

    await applySelectedTextRange(selectionRange.startIndex, nextEndIndex, { focusEditor: false })
  }

  function updateDraggedTextTargetRegion(clientX: number, clientY: number) {
    if (!textTargetDragSession) {
      return
    }

    const minimumWidth = 5
    const minimumHeight = 5
    const { handle, startClientX, startClientY, surfaceWidth, surfaceHeight, startRegion } = textTargetDragSession
    const deltaXPercent = ((clientX - startClientX) / surfaceWidth) * 100
    const deltaYPercent = ((clientY - startClientY) / surfaceHeight) * 100

    if (handle === 'move') {
      applyTextEditRegion(
        snapTextTargetRegion(
          {
        xPercent: clamp(startRegion.xPercent + deltaXPercent, 0, 100 - startRegion.widthPercent),
        yPercent: clamp(startRegion.yPercent + deltaYPercent, 0, 100 - startRegion.heightPercent),
        widthPercent: startRegion.widthPercent,
        heightPercent: startRegion.heightPercent,
        fontSize: startRegion.fontSize,
          },
          handle,
        ),
      )
      return
    }

    let left = startRegion.xPercent
    let top = startRegion.yPercent
    let right = startRegion.xPercent + startRegion.widthPercent
    let bottom = startRegion.yPercent + startRegion.heightPercent

    if (handle.includes('w')) {
      left += deltaXPercent
    }

    if (handle.includes('e')) {
      right += deltaXPercent
    }

    if (handle.includes('n')) {
      top += deltaYPercent
    }

    if (handle.includes('s')) {
      bottom += deltaYPercent
    }

    if (handle.includes('w')) {
      left = clamp(left, 0, right - minimumWidth)
    }

    if (handle.includes('e')) {
      right = clamp(right, left + minimumWidth, 100)
    }

    if (handle.includes('n')) {
      top = clamp(top, 0, bottom - minimumHeight)
    }

    if (handle.includes('s')) {
      bottom = clamp(bottom, top + minimumHeight, 100)
    }

    applyTextEditRegion(
      snapTextTargetRegion(
        {
          xPercent: left,
          yPercent: top,
          widthPercent: right - left,
          heightPercent: bottom - top,
          fontSize: startRegion.fontSize,
        },
        handle,
      ),
    )
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
          <button data-testid="insert-pdf-button" on:click={insertPdfAfterCurrentPage} disabled={busy || !workspace}>Insert PDF After</button>
          <button on:click={duplicateCurrentPage} disabled={busy || !workspace}>Duplicate Page</button>
          <button on:click={deleteCurrentPage} disabled={busy || !workspace}>Delete Page</button>
          <button on:click={insertBlankAfterCurrentPage} disabled={busy || !workspace}>Blank After</button>
          <button on:click={exportAllPagesPng} disabled={busy || !workspace}>All Pages PNG</button>
        </div>
      </div>
    </details>

    <details class="card dock-panel convert-panel" open={Boolean(workspace)}>
      <summary class="dock-summary">
        <span>Convert</span>
        <small>{workspace ? 'Ready' : 'Idle'}</small>
      </summary>
      <div class="dock-body">
        <p class="muted panel-note">Generate local text-first and structured exports from the current PDF session.</p>
        <div class="tool-grid">
          <button on:click={exportDocumentTextToFile} disabled={busy || !workspace}>Export Text</button>
          <button on:click={exportDocumentMarkdown} disabled={busy || !workspace}>Export Markdown</button>
          <button on:click={exportDocumentHtml} disabled={busy || !workspace}>Export HTML</button>
          <button on:click={exportDocumentDocx} disabled={busy || !workspace}>Export DOCX</button>
          <button on:click={exportDocumentStructuredJson} disabled={busy || !workspace}>Export Structured JSON</button>
        </div>
      </div>
    </details>

    <details class="card dock-panel forms-panel" open={Boolean(workspace?.flags.hasForms)}>
      <summary class="dock-summary">
        <span>Forms</span>
        <small>
          {#if workspace?.flags.hasXfa}
            XFA locked
          {:else if formFieldsLoading}
            Reading
          {:else if formFields.length > 0}
            {formFields.length} fields
          {:else if workspace?.flags.hasForms}
            No fields
          {:else}
            Idle
          {/if}
        </small>
      </summary>
      <div class="dock-body">
        {#if workspace?.flags.hasXfa}
          <div class="inspector-block">
            <span class="meta-label">XFA Detected</span>
            <strong>Read-only form package</strong>
            <span class="muted">
              This PDF uses XFA or a hybrid form package. Sampadan keeps those forms inspect-only for now.
            </span>
          </div>
        {:else if workspace?.flags.hasForms}
          <div class="section-head compact-head">
            <h3>AcroForm Fields</h3>
            <span class:modified-pill={formDirty} class="pill">
              {formDirty ? 'Changed' : 'Synced'}
            </span>
          </div>

          <label class="check-field">
            <input class="check-input" type="checkbox" bind:checked={flattenFormsOnApply} disabled={busy || formFields.length === 0} />
            <span>Flatten after apply</span>
          </label>

          {#if formFieldsLoading}
            <p class="muted">Reading standard AcroForm fields from the current PDF.</p>
          {:else if formFields.length > 0}
            {#each formFields as field}
              <div class="inspector-block form-field-card">
                <div class="section-head compact-head">
                  <h3>{field.label}</h3>
                  <span class="pill">{formatFormFieldKind(field.kind, field.multiSelect)}</span>
                </div>
                <span class="muted">{field.name}</span>

                {#if field.kind === 'checkbox'}
                  <label class="check-field">
                    <input
                      class="check-input"
                      type="checkbox"
                      checked={getCheckboxFormFieldDraftValue(field)}
                      disabled={busy || !field.editable}
                      on:change={(event) => updateCheckboxFormFieldDraft(field, event.currentTarget.checked)}
                    />
                    <span>
                      Form: {field.label}
                      {field.required ? ' (required)' : ''}
                    </span>
                  </label>
                {:else if field.multiSelect}
                  <label class="field">
                    <span class="field-label">Form: {field.label}</span>
                    <select
                      class="field-input form-multiselect"
                      multiple
                      size={Math.min(Math.max(field.options.length, 3), 6)}
                      disabled={busy || !field.editable}
                      on:change={(event) => updateMultiSelectFormFieldDraft(field, event.currentTarget)}
                    >
                      {#each field.options as option}
                        <option value={option} selected={getMultiSelectFormFieldDraftValue(field).includes(option)}>{option}</option>
                      {/each}
                    </select>
                  </label>
                {:else if field.kind === 'radio' || field.kind === 'dropdown' || field.kind === 'option-list'}
                  {#if field.kind === 'dropdown' && field.acceptsCustomText}
                    <label class="field">
                      <span class="field-label">Form: {field.label}</span>
                      <input
                        class="field-input"
                        value={getSingleFormFieldDraftValue(field)}
                        list={getFormFieldOptionsListId(field.name)}
                        disabled={busy || !field.editable}
                        on:input={(event) => updateTextFormFieldDraft(field, event.currentTarget.value)}
                      />
                      <datalist id={getFormFieldOptionsListId(field.name)}>
                        {#each field.options as option}
                          <option value={option}></option>
                        {/each}
                      </datalist>
                    </label>
                  {:else}
                    <label class="field">
                      <span class="field-label">Form: {field.label}</span>
                      <select
                        class="field-input"
                        value={getSingleFormFieldDraftValue(field)}
                        disabled={busy || !field.editable}
                        on:change={(event) => updateTextFormFieldDraft(field, event.currentTarget.value)}
                      >
                        <option value="">No selection</option>
                        {#each field.options as option}
                          <option value={option}>{option}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                {:else}
                  <label class="field">
                    <span class="field-label">Form: {field.label}</span>
                    {#if field.multiline}
                      <textarea
                        class="field-input note-body"
                        value={getSingleFormFieldDraftValue(field)}
                        disabled={busy || !field.editable}
                        on:input={(event) => updateTextFormFieldDraft(field, event.currentTarget.value)}
                      ></textarea>
                    {:else}
                      <input
                        class="field-input"
                        value={getSingleFormFieldDraftValue(field)}
                        disabled={busy || !field.editable}
                        on:input={(event) => updateTextFormFieldDraft(field, event.currentTarget.value)}
                      />
                    {/if}
                  </label>
                {/if}

                <div class="stack-list">
                  <span>Value: {formatFormFieldValueSummary(field)}</span>
                  {#if field.required}
                    <span>Required</span>
                  {/if}
                  {#if field.readOnly}
                    <span>Read-only</span>
                  {/if}
                  {#if field.maxLength !== null}
                    <span>Max length: {field.maxLength}</span>
                  {/if}
                  {#if field.password}
                    <span>Password masking is defined on this field.</span>
                  {/if}
                  {#if field.combed}
                    <span>Combed text layout is enabled.</span>
                  {/if}
                  {#each field.notes as note}
                    <span>{note}</span>
                  {/each}
                </div>
              </div>
            {/each}

            <div class="tool-grid">
              <button
                data-testid="apply-form-values-button"
                on:click={applyFormFieldValues}
                disabled={busy || !workspace || formFields.length === 0 || editableFormFields.length === 0 || !formDirty}
              >
                Apply Form Values
              </button>
              <button
                data-testid="flatten-form-fields-button"
                on:click={flattenFormFields}
                disabled={busy || !workspace || formFields.length === 0}
              >
                Flatten Forms
              </button>
              <button on:click={resetFormFieldDrafts} disabled={busy || !formDirty}>Reset Drafts</button>
            </div>
          {:else}
            <p class="muted">No editable standard AcroForm fields were found in this PDF.</p>
          {/if}
        {:else}
          <p class="muted">Standard AcroForm fields will appear here when a fillable PDF is open.</p>
        {/if}
      </div>
    </details>

    <details class="card dock-panel" open>
      <summary class="dock-summary">
        <span>Page Edit</span>
        <small>{workspace ? (editScope === 'all' ? 'All pages' : `Page ${currentPage}`) : 'Idle'}</small>
      </summary>
      <div class="dock-body">
        <label class="field">
          <span class="field-label">Apply To</span>
          <select class="field-input" bind:value={editScope} disabled={!workspace || busy}>
            {#each editScopeOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span class="field-label">Watermark</span>
          <input
            class="field-input"
            bind:value={watermarkText}
            disabled={!workspace || busy}
            placeholder="CONFIDENTIAL"
          />
        </label>

        <label class="field">
          <span class="field-label">Watermark Position</span>
          <select class="field-input" bind:value={watermarkPosition} disabled={!workspace || busy}>
            {#each watermarkPositionOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <button data-testid="watermark-button" on:click={applyWatermark} disabled={busy || !workspace || !watermarkText.trim()}>
          Apply Watermark
        </button>
        <button data-testid="image-stamp-button" on:click={placeImageStamp} disabled={busy || !workspace}>
          Place Image Stamp
        </button>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">Note Title</span>
            <input
              class="field-input"
              bind:value={reviewNoteTitle}
              disabled={!workspace || busy}
              placeholder="Review Note"
            />
          </label>
          <label class="field">
            <span class="field-label">Note Tone</span>
            <select class="field-input" bind:value={reviewNoteTone} disabled={!workspace || busy}>
              {#each reviewToneOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="field field-span">
            <span class="field-label">Note Text</span>
            <textarea
              class="field-input note-body"
              bind:value={reviewNoteBody}
              disabled={!workspace || busy}
              placeholder="Summarize the issue, revision, or approval note."
            ></textarea>
          </label>
        </div>
        <div class="tool-grid">
          <button
            data-testid="sticky-note-button"
            on:click={addStickyNoteAnnotation}
            disabled={busy || !workspace || !reviewNoteBody.trim()}
          >
            Add Sticky Note
          </button>
          <button
            data-testid="review-note-button"
            on:click={addReviewNote}
            disabled={busy || !workspace || !reviewNoteBody.trim()}
          >
            Add Review Note
          </button>
        </div>

        <div class="inspector-block">
          <span class="meta-label">True Edit</span>
          <span class="muted">
            Use text targeting for existing born-digital content, or manual percentages as the fallback for hard PDFs.
          </span>
        </div>

        <div class="inspector-block">
          <div class="section-head compact-head">
            <h3>Current Page Annotations</h3>
            <span class="pill">{currentPageAnnotations.length}</span>
          </div>
          {#if currentPageAnnotations.length > 0}
            <div class="annotation-list">
              {#each currentPageAnnotations as annotation, index}
                <div
                  class:selected={annotation.id === selectedAnnotationId}
                  class="stack-list attachment-entry annotation-entry"
                >
                  <button
                    class="annotation-select"
                    on:click={() => selectAnnotation(annotation)}
                    aria-label={`Select annotation ${index + 1}`}
                  >
                    <span class="annotation-kind">{annotation.kind === 'text' ? 'Sticky note' : annotation.kind}</span>
                    <span>{annotation.title ?? 'Sampadan'}</span>
                    <span>{annotation.contents || 'No annotation text'}</span>
                  </button>
                  <button
                    class="ghost-button"
                    data-testid={`remove-annotation-button-${index + 1}`}
                    on:click={() => void removeAnnotation(annotation)}
                    disabled={busy}
                    aria-label={`Remove annotation ${index + 1}`}
                  >
                    Remove Annotation
                  </button>
                </div>
              {/each}
            </div>
            <div class="tool-grid">
              <button
                data-testid="update-selected-annotation-button"
                on:click={updateSelectedAnnotation}
                disabled={busy || !workspace || !selectedAnnotation}
              >
                Update Selected Annotation
              </button>
              <button
                data-testid="remove-selected-annotation-button"
                on:click={removeSelectedAnnotation}
                disabled={busy || !workspace || !selectedAnnotation}
              >
                Remove Selected Annotation
              </button>
              <button on:click={clearSelectedAnnotation} disabled={busy || !selectedAnnotation}>Clear Annotation Selection</button>
            </div>
          {:else}
            <span class="muted">No annotations on the current page yet.</span>
          {/if}
        </div>

        <div class="inspector-block">
          <div class="section-head compact-head">
            <h3>Target Existing Text</h3>
            <span class="pill">{currentPageTextSpans.length}</span>
          </div>
          <span class="muted">Turn on direct text edit, click the page text you want, then edit from the inline card.</span>
          <div class="tool-grid">
            <button data-testid="toggle-text-target-button" on:click={toggleTextTargetMode} disabled={busy || !workspace}>
              {textTargetMode ? 'Hide Direct Edit Targets' : 'Direct Text Edit'}
            </button>
            <button
              data-testid="replace-selected-text-button"
              on:click={replaceSelectedTextTarget}
              disabled={busy || !workspace || !selectedTextSpan || !textEditContent.trim()}
            >
              Replace Selected Text
            </button>
          </div>
          <div class="inspector-block">
            <div class="section-head compact-head">
              <h3>Find And Replace</h3>
              <span class="pill">{textSearchResults.length}</span>
            </div>
            <label class="field">
              <span class="field-label">Find Text</span>
              <input
                bind:this={textSearchInput}
                bind:value={textSearchQuery}
                class="field-input"
                data-testid="text-search-query-input"
                type="text"
                placeholder="Find exact text"
                disabled={!workspace || busy || textSearchBusy}
                on:keydown={handleTextSearchQueryKeydown}
              />
            </label>
            <label class="field">
              <span class="field-label">Replace Matches With</span>
              <input
                bind:value={textSearchReplacement}
                class="field-input"
                data-testid="text-search-replacement-input"
                type="text"
                placeholder="Replace matched text"
                disabled={!workspace || busy || textSearchBusy}
                on:keydown={handleTextSearchReplacementKeydown}
              />
            </label>
            <div class="field-grid">
              <label class="field">
                <span class="field-label">Search Scope</span>
                <select
                  class="field-input"
                  bind:value={textSearchScope}
                  data-testid="text-search-scope-select"
                  disabled={!workspace || busy || textSearchBusy}
                >
                  <option value="page">Current page</option>
                  <option value="document">Whole document</option>
                </select>
              </label>
              <label class="check-field">
                <input
                  class="check-input"
                  bind:checked={textSearchCaseSensitive}
                  data-testid="text-search-case-sensitive-checkbox"
                  type="checkbox"
                  disabled={!workspace || busy || textSearchBusy}
                />
                <span>Case sensitive</span>
              </label>
            </div>
            <div class="tool-grid compact-tool-grid">
              <button
                data-testid="text-search-button"
                on:click={() => runTextSearch({ preserveActive: false, focusActive: true })}
                disabled={busy || textSearchBusy || !workspace || !textSearchQuery.trim()}
              >
                Find Text
              </button>
              <button
                data-testid="previous-search-result-button"
                on:click={() => jumpToTextSearchResult(-1)}
                disabled={busy || textSearchBusy || textSearchResults.length === 0}
              >
                Prev Result
              </button>
              <button
                data-testid="next-search-result-button"
                on:click={() => jumpToTextSearchResult(1)}
                disabled={busy || textSearchBusy || textSearchResults.length === 0}
              >
                Next Result
              </button>
              <button
                data-testid="replace-search-result-button"
                on:click={replaceActiveTextSearchResult}
                disabled={busy || textSearchBusy || !workspace || activeTextSearchResultIndex < 0 || !textSearchReplacement.trim()}
              >
                Replace Result
              </button>
              <button
                data-testid="replace-all-search-results-button"
                on:click={replaceAllTextSearchResults}
                disabled={busy || textSearchBusy || !workspace || textSearchResults.length === 0 || !textSearchReplacement.trim()}
              >
                Replace All Results
              </button>
              <button
                data-testid="clear-text-search-button"
                on:click={() => clearTextSearchState({ clearQuery: true, clearReplacement: true })}
                disabled={busy || textSearchBusy || (!textSearchQuery && textSearchResults.length === 0 && !textSearchReplacement)}
              >
                Clear Search
              </button>
            </div>
            {#if textSearchBusy}
              <span class="muted">Searching local page text...</span>
            {:else if textSearchResults.length > 0}
              <div class="stack-list attachment-entry">
                <span>
                  Result {activeTextSearchResultIndex >= 0 ? activeTextSearchResultIndex + 1 : 1} of {textSearchResults.length}
                </span>
                {#if activeTextSearchResult}
                  <span>Page {activeTextSearchResult.pageNumber}: {activeTextSearchResult.text}</span>
                {/if}
                <span class="muted">Cmd/Ctrl+F focuses search. F3 and Shift+F3 move through results.</span>
              </div>
            {:else if textSearchQuery.trim()}
              <span class="muted">No exact contiguous text matches for the current query.</span>
            {:else}
              <span class="muted">Find exact contiguous text on this page or across the full document.</span>
            {/if}
          </div>
          <div class="tool-grid compact-tool-grid">
            <button
              data-testid="select-line-targets-button"
              on:click={selectCurrentTextLine}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Select Line
            </button>
            <button
              data-testid="select-all-targets-button"
              on:click={selectAllTextTargets}
              disabled={busy || !workspace || currentPageTextSpans.length === 0}
            >
              Select All
            </button>
            <button
              data-testid="select-prev-line-button"
              on:click={() => selectAdjacentTextLine(-1, false)}
              disabled={busy || !workspace || currentPageTextSpans.length === 0}
            >
              Prev Line
            </button>
            <button
              data-testid="select-next-line-button"
              on:click={() => selectAdjacentTextLine(1, false)}
              disabled={busy || !workspace || currentPageTextSpans.length === 0}
            >
              Next Line
            </button>
            <button
              data-testid="reset-text-target-region-button"
              on:click={resetSelectedTextRegion}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Reset Bounds
            </button>
            <button
              data-testid="select-line-start-button"
              on:click={() => jumpToTextLineBoundary('start', false)}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Line Start
            </button>
            <button
              data-testid="select-line-end-button"
              on:click={() => jumpToTextLineBoundary('end', false)}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Line End
            </button>
            <button
              data-testid="reset-text-target-text-button"
              on:click={resetSelectedTextEditContent}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Reset Replace Text
            </button>
          </div>
          <div class="tool-grid compact-tool-grid">
            <button
              data-testid="previous-text-match-button"
              on:click={() => jumpToMatchingTextOccurrence(-1)}
              disabled={busy || !workspace || !selectedTextSpan || resolveMatchingSelectedTextOccurrences().length < 2}
            >
              Prev Match
            </button>
            <button
              data-testid="next-text-match-button"
              on:click={() => jumpToMatchingTextOccurrence(1)}
              disabled={busy || !workspace || !selectedTextSpan || resolveMatchingSelectedTextOccurrences().length < 2}
            >
              Next Match
            </button>
            <button
              data-testid="replace-all-text-matches-button"
              on:click={replaceAllSelectedTextMatches}
              disabled={busy || !workspace || !selectedTextSpan || !textEditContent.trim()}
            >
              Replace All Matches
            </button>
          </div>
          <div class="tool-grid compact-tool-grid">
            <button
              data-testid="highlight-selected-text-button"
              on:click={() => addSelectedTextMarkup('highlight')}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Highlight Text
            </button>
            <button
              data-testid="underline-selected-text-button"
              on:click={() => addSelectedTextMarkup('underline')}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Underline Text
            </button>
            <button
              data-testid="strikeout-selected-text-button"
              on:click={() => addSelectedTextMarkup('strikeout')}
              disabled={busy || !workspace || !selectedTextSpan}
            >
              Strike Out Text
            </button>
          </div>
          <span class="muted">
            Drag across words, double-click for a full line, use ArrowUp/Down for lines, Cmd/Ctrl+Arrow for line
            edges, Shift to extend, F3 for match navigation, Cmd/Ctrl+Shift+R for replace-all on the page, Cmd/Ctrl+L
            for a full line, and Alt+Backspace to restore the selected text.
          </span>
          {#if selectedTextSpan}
            {@const textMatchCount = resolveMatchingSelectedTextOccurrences().length || 1}
            {@const textMatchIndex = resolveSelectedTextOccurrence() + 1}
            <div class="stack-list attachment-entry">
              <span>Selected: {selectedTextSpan.text}</span>
              <span>
                Match {textMatchIndex} of {textMatchCount} on page
              </span>
              {#if selectedTextSpan.spanIds.length > 1}
                <span>{selectedTextSpan.spanIds.length} contiguous targets selected</span>
              {/if}
              <span>
                Region: {selectedTextSpan.xPercent.toFixed(1)}%, {selectedTextSpan.yPercent.toFixed(1)}%,
                {selectedTextSpan.widthPercent.toFixed(1)}% x {selectedTextSpan.heightPercent.toFixed(1)}%
              </span>
              <span class="muted">Alt+Arrow nudges the region. Alt+Shift+Arrow resizes it.</span>
              <button class="ghost-button" on:click={clearSelectedTextTarget} disabled={busy}>Clear Selected Text</button>
            </div>
          {:else}
            <span class="muted">No existing page text selected yet.</span>
          {/if}
        </div>

        <label class="field">
          <span class="field-label">Edit Text</span>
          <textarea
            class="field-input note-body"
            bind:value={textEditContent}
            disabled={!workspace || busy}
            placeholder="Type replacement or inserted text here."
          ></textarea>
        </label>

        <div class="field-grid">
          <label class="field">
            <span class="field-label">X %</span>
            <input class="field-input" bind:value={textEditX} type="number" min="0" max="95" step="1" disabled={!workspace || busy} />
          </label>
          <label class="field">
            <span class="field-label">Y %</span>
            <input class="field-input" bind:value={textEditY} type="number" min="0" max="95" step="1" disabled={!workspace || busy} />
          </label>
          <label class="field">
            <span class="field-label">Width %</span>
            <input
              class="field-input"
              bind:value={textEditWidth}
              type="number"
              min="5"
              max="100"
              step="1"
              disabled={!workspace || busy}
            />
          </label>
          <label class="field">
            <span class="field-label">Height %</span>
            <input
              class="field-input"
              bind:value={textEditHeight}
              type="number"
              min="5"
              max="100"
              step="1"
              disabled={!workspace || busy}
            />
          </label>
          <label class="field">
            <span class="field-label">Font Size</span>
            <input
              class="field-input"
              bind:value={textEditFontSize}
              type="number"
              min="8"
              max="72"
              step="1"
              disabled={!workspace || busy}
            />
          </label>
          <label class="field">
            <span class="field-label">Alignment</span>
            <select class="field-input" bind:value={textEditAlignment} disabled={!workspace || busy}>
              {#each textEditAlignmentOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <label class="check-field">
          <input class="check-input" type="checkbox" bind:checked={textEditPaperBacking} disabled={!workspace || busy} />
          <span>Paper backing for inserted text</span>
        </label>

        <div class="tool-grid">
          <button data-testid="text-block-button" on:click={placeTextBlock} disabled={busy || !workspace || !textEditContent.trim()}>
            Place Text Block
          </button>
          <button data-testid="replace-region-button" on:click={whiteoutAndReplace} disabled={busy || !workspace}>
            Whiteout + Replace
          </button>
        </div>

        <label class="field">
          <span class="field-label">Starting Number</span>
          <input
            class="field-input"
            bind:value={pageNumberStart}
            type="number"
            min="1"
            step="1"
            disabled={!workspace || busy}
          />
        </label>

        <label class="field">
          <span class="field-label">Page Number Position</span>
          <select class="field-input" bind:value={pageNumberPosition} disabled={!workspace || busy}>
            {#each pageNumberPositionOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <button data-testid="page-numbers-button" on:click={addPageNumbers} disabled={busy || !workspace}>
          Add Page Numbers
        </button>
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
        <h2>{activeDocumentName}</h2>
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
        {:else if pendingEncryptedPdf}
          <span class="pill">Locked PDF</span>
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
          <div class="page-strip-empty">
            <strong>No pages</strong>
            <span>Open a PDF to load thumbnails.</span>
          </div>
        {/if}
      </section>

      <section class="card viewer-shell hero-viewer" data-testid="viewer-shell">
        <div class="section-head">
          <h2>Viewer</h2>
          <span>{viewerStatusLabel}</span>
        </div>

        {#if workspace}
          <div class="viewer-pane" bind:this={viewerPane}>
            <div
              class="viewer-surface"
              bind:this={viewerSurface}
              data-testid="viewer-surface"
              style:width={renderedPageWidth ? `${renderedPageWidth}px` : undefined}
              style:height={renderedPageHeight ? `${renderedPageHeight}px` : undefined}
            >
              <canvas bind:this={viewerCanvas}></canvas>
              {#if currentPageAnnotations.length > 0}
                <div class="annotation-layer">
                  {#each currentPageAnnotations as annotation}
                    {#if annotation.kind === 'text'}
                      <div
                        class:selected={annotation.id === selectedAnnotationId}
                        class="annotation-note"
                        title={formatAnnotationTooltip(annotation)}
                        style={`left:${annotation.xPercent}%;top:${annotation.yPercent}%;--annotation-color:${annotation.colorCss};`}
                      >
                        <span>!</span>
                      </div>
                    {:else}
                      {#each annotation.quads.length > 0 ? annotation.quads : [annotation] as quad}
                        <div
                          class:selected={annotation.id === selectedAnnotationId}
                          class={`annotation-mark annotation-mark-${annotation.kind}`}
                          title={formatAnnotationTooltip(annotation)}
                          style={`left:${quad.xPercent}%;top:${quad.yPercent}%;width:${Math.max(quad.widthPercent, 0.6)}%;height:${Math.max(quad.heightPercent, 0.4)}%;--annotation-color:${annotation.colorCss};--annotation-opacity:${annotation.opacity};`}
                        ></div>
                      {/each}
                    {/if}
                  {/each}
                </div>
              {/if}
              {#if textTargetMode && currentPageTextSearchResults.length > 0}
                <div class="text-search-layer">
                  {#each currentPageTextSearchResults as result}
                    <div
                      class:active={result.id === activeTextSearchResult?.id}
                      class="text-search-result"
                      style:left={`${result.xPercent}%`}
                      style:top={`${result.yPercent}%`}
                      style:width={`${Math.max(result.widthPercent, 0.8)}%`}
                      style:height={`${Math.max(result.heightPercent, 0.8)}%`}
                    ></div>
                  {/each}
                </div>
              {/if}
              {#if textTargetMode && currentPageTextSpans.length > 0}
                <div class="text-target-layer">
                  {#each currentPageTextSpans as span}
                    <button
                      type="button"
                      class:selected={selectedTextSpanIds.includes(span.id)}
                      class="text-target-hitbox"
                      style:left={`${span.xPercent}%`}
                      style:top={`${span.yPercent}%`}
                      style:width={`${span.widthPercent}%`}
                      style:height={`${Math.max(span.heightPercent, 0.8)}%`}
                      on:pointerdown={(event) => void handleTextTargetPointerDown(span, event)}
                      on:pointerenter={(event) => void handleTextTargetPointerEnter(span, event)}
                      on:click={(event) => void selectTextTarget(span, { extendSelection: event.shiftKey })}
                      on:dblclick={() => void handleTextTargetDoubleClick(span)}
                      aria-label={`Target text: ${span.text}`}
                      title={`Edit text: ${span.text}`}
                    ></button>
                  {/each}
                </div>
              {/if}
              {#if textTargetMode && selectedTextSpan}
                {@const selectedRegion = resolveSelectedTextTargetRegionPreview()}
                {@const startGripPosition = resolveTextTargetSelectionGripPosition('start')}
                {@const endGripPosition = resolveTextTargetSelectionGripPosition('end')}
                {#if selectedRegion}
                  <div class="text-target-selection-layer">
                    {#if startGripPosition}
                      <button
                        type="button"
                        class="text-target-range-grip text-target-range-grip-start"
                        data-testid="text-target-grip-start"
                        aria-label="Adjust selected text start"
                        style:left={`${startGripPosition.xPercent}%`}
                        style:top={`${startGripPosition.yPercent}%`}
                        on:pointerdown|stopPropagation={(event) => startTextTargetSelectionGripDrag('start', event)}
                        disabled={busy}
                      ></button>
                    {/if}
                    {#if endGripPosition}
                      <button
                        type="button"
                        class="text-target-range-grip text-target-range-grip-end"
                        data-testid="text-target-grip-end"
                        aria-label="Adjust selected text end"
                        style:left={`${endGripPosition.xPercent}%`}
                        style:top={`${endGripPosition.yPercent}%`}
                        on:pointerdown|stopPropagation={(event) => startTextTargetSelectionGripDrag('end', event)}
                        disabled={busy}
                      ></button>
                    {/if}
                    <div
                      class="text-target-selection-frame"
                      data-testid="text-target-region-frame"
                      role="button"
                      tabindex="0"
                      aria-label="Move selected text region"
                      style:left={`${selectedRegion.xPercent}%`}
                      style:top={`${selectedRegion.yPercent}%`}
                      style:width={`${selectedRegion.widthPercent}%`}
                      style:height={`${selectedRegion.heightPercent}%`}
                      on:pointerdown={(event) => startTextTargetRegionDrag('move', event)}
                    >
                      {#each textTargetRegionHandles as handle}
                        <button
                          type="button"
                          class={`text-target-handle text-target-handle-${handle}`}
                          data-testid={`text-target-handle-${handle}`}
                          aria-label={`Adjust selected text region ${handle}`}
                          on:pointerdown|stopPropagation={(event) => startTextTargetRegionDrag(handle, event)}
                          disabled={busy}
                        ></button>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/if}
              {#if textTargetMode && inlineTextEditorOpen && selectedTextSpan}
                {@const inlineEditorPosition = resolveInlineTextEditorPosition()}
                {#if inlineEditorPosition}
                  <section
                    class="inline-text-editor"
                    data-testid="inline-text-editor-card"
                    style:left={`${inlineEditorPosition.xPercent}%`}
                    style:top={`${inlineEditorPosition.yPercent}%`}
                  >
                    <div class="inline-text-editor-head">
                      <span class="eyebrow">Direct Text Edit</span>
                      <button
                        type="button"
                        class="ghost-button inline-close-button"
                        data-testid="inline-close-editor-button"
                        on:click={clearSelectedTextTarget}
                        disabled={busy}
                      >
                        Close
                      </button>
                    </div>
                    <strong class="inline-text-editor-source">{selectedTextSpan.text}</strong>
                    <label class="field inline-field">
                      <span class="field-label">Quick Replace Text</span>
                      <textarea
                        bind:this={inlineTextEditor}
                        bind:value={textEditContent}
                        class="field-input inline-textarea"
                        rows="4"
                        disabled={busy}
                      ></textarea>
                    </label>
                    <div class="inline-text-editor-actions">
                      <button
                        type="button"
                        data-testid="inline-replace-button"
                        on:click={replaceSelectedTextTarget}
                        disabled={busy || !textEditContent.trim()}
                      >
                        Replace Here
                      </button>
                      <button type="button" on:click={() => addSelectedTextMarkup('highlight')} disabled={busy}>
                        Highlight Here
                      </button>
                      <button type="button" on:click={() => addSelectedTextMarkup('underline')} disabled={busy}>
                        Underline
                      </button>
                      <button type="button" on:click={() => addSelectedTextMarkup('strikeout')} disabled={busy}>
                        Strike Out
                      </button>
                      <button
                        type="button"
                        data-testid="inline-previous-match-button"
                        on:click={() => jumpToMatchingTextOccurrence(-1)}
                        disabled={busy || resolveMatchingSelectedTextOccurrences().length < 2}
                      >
                        Prev Match
                      </button>
                      <button
                        type="button"
                        data-testid="inline-next-match-button"
                        on:click={() => jumpToMatchingTextOccurrence(1)}
                        disabled={busy || resolveMatchingSelectedTextOccurrences().length < 2}
                      >
                        Next Match
                      </button>
                      <button
                        type="button"
                        data-testid="inline-replace-all-matches-button"
                        on:click={replaceAllSelectedTextMatches}
                        disabled={busy || !textEditContent.trim()}
                      >
                        Replace All
                      </button>
                    </div>
                    <span class="muted inline-hint">
                      Cmd/Ctrl+Enter applies the replacement. F3 navigates matching text. Cmd/Ctrl+Shift+R replaces all
                      page matches. Esc clears the target.
                    </span>
                  </section>
                {/if}
              {/if}
            </div>
          </div>
        {:else}
          <div class="empty-state">
            <span class="eyebrow">Local first</span>
            {#if pendingEncryptedPdf}
              <h3>Unlock the PDF to continue.</h3>
              <p>Sampadan detected PDF encryption and is waiting for a local qpdf unlock step.</p>
              <button on:click={unlockPendingPdf} disabled={busy || !qpdfReady}>Unlock PDF</button>
            {:else}
              <h3>Open a PDF to start editing.</h3>
              <p>Sampadan keeps the document on-device for viewing, editing, OCR, and export.</p>
              <button on:click={openPdfFlow}>Open a PDF</button>
            {/if}
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
              <span>{`${withoutExtension(workspace.fileName)}-protected.pdf`}</span>
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

          <div class="inspector-block">
            <div class="section-head compact-head">
              <h3>Attachments</h3>
              <span class="pill">{attachmentSummaries.length}</span>
            </div>
            <span class="meta-label">Embedded files</span>
            <strong>{attachmentSummaries.length} embedded file{attachmentSummaries.length === 1 ? '' : 's'}</strong>
            <label class="field">
              <span class="field-label">Attachment Description</span>
              <input
                class="field-input"
                bind:value={attachmentDescriptionDraft}
                disabled={busy || !workspace}
                placeholder="Optional note for the embedded file"
              />
            </label>
            <div class="tool-grid">
              <button data-testid="attach-file-button" on:click={attachEmbeddedFile} disabled={busy || !workspace}>
                Attach File
              </button>
              <button on:click={exportEmbeddedAttachments} disabled={busy || !workspace || attachmentSummaries.length === 0}>
                Export Attachments
              </button>
            </div>
            {#if attachmentSummaries.length > 0}
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
            {:else}
              <span class="muted">No embedded files yet.</span>
            {/if}
          </div>

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
              <span>Protection export: {qpdfReady ? `qpdf ${qpdfStatus?.version ?? 'ready'}` : 'Install local qpdf'}</span>
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

    <details class="card utility-panel protection-panel" open={Boolean(workspace || pendingEncryptedPdf)}>
      <summary class="dock-summary">
        <span>Protection</span>
        <small>{qpdfReady ? 'Ready' : 'Unavailable'}</small>
      </summary>
      <div class="dock-body">
        <div class="inspector-block">
          <span class="meta-label">Runtime</span>
          {#if qpdfStatus}
            <strong>{qpdfReady ? 'qpdf detected' : 'qpdf unavailable'}</strong>
            <span class="muted">{qpdfStatus.binaryPath ?? qpdfStatus.missingReason ?? 'Unknown qpdf state'}</span>
            {#if qpdfStatus.version}
              <span class="muted">{qpdfStatus.version}</span>
            {/if}
          {:else}
            <strong>Checking protection runtime</strong>
            <span class="muted">Sampadan is probing the local device for qpdf.</span>
          {/if}
        </div>

        <p class="muted panel-note">
          Save a protected copy without replacing the current viewer session.
        </p>

        {#if pendingEncryptedPdf}
          <div class="inspector-block">
            <span class="meta-label">Unlock Pending</span>
            <strong>{pendingEncryptedPdf.payload.fileName}</strong>
            <div class="stack-list">
              {#if pendingEncryptedPdf.payload.trustReport.encryption.encrypted}
                <span>{pendingEncryptedPdf.payload.trustReport.encryption.algorithm ?? 'Encrypted PDF'}</span>
              {/if}
              <span class="muted">
                Enter the open password if needed, then unlock this PDF locally before editing, OCR, or export.
              </span>
              {#each pendingEncryptedPdf.payload.trustReport.recommendations as recommendation}
                <span class="muted">{recommendation}</span>
              {/each}
            </div>
          </div>
        {/if}

        <div class="field-grid">
          <label class="field">
            <span class="field-label">Open Password</span>
            <input
              class="field-input"
              type="password"
              bind:value={protectionUserPassword}
              placeholder="Optional"
              disabled={busy}
            />
          </label>
          <label class="field">
            <span class="field-label">Owner Password</span>
            <input
              class="field-input"
              type="password"
              bind:value={protectionOwnerPassword}
              placeholder="Required"
              disabled={busy}
            />
          </label>
          <label class="field">
            <span class="field-label">Print Access</span>
            <select class="field-input" bind:value={protectionPrint} disabled={busy}>
              {#each protectionPrintOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Edit Access</span>
            <select class="field-input" bind:value={protectionModify} disabled={busy}>
              {#each protectionModifyOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <label class="check-field">
          <input class="check-input" type="checkbox" bind:checked={protectionAllowExtract} disabled={busy} />
          <span>Allow text and graphic extraction</span>
        </label>
        <label class="check-field">
          <input class="check-input" type="checkbox" bind:checked={protectionEncryptMetadata} disabled={busy} />
          <span>Encrypt metadata in the protected copy</span>
        </label>

        {#if workspace?.flags.signed}
          <p class="muted panel-note">Saving a protected copy will invalidate existing signatures on the new file.</p>
        {/if}

        <div class="tool-grid">
          <button on:click={refreshQpdfStatus} disabled={busy}>Refresh Protection</button>
          <button data-testid="unlock-pdf-button" on:click={unlockPendingPdf} disabled={busy || !pendingEncryptedPdf || !qpdfReady}>
            Unlock PDF
          </button>
          <button
            data-testid="save-protected-copy-button"
            on:click={saveProtectedCopy}
            disabled={busy || !workspace || !qpdfReady}
          >
            Save Protected Copy
          </button>
        </div>
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
