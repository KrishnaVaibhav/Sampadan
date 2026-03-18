<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'

  import { getPdfLib, loadPdfProxy, type PdfProxy } from './lib/pdf-engine'
  import {
    base64ToBytes,
    blobToBase64,
    bytesToBase64,
    clamp,
    fileNameFromPath,
    formatBytes,
    joinPath,
    withExtension,
    withoutExtension,
  } from './lib/pdf-utils'
  import type { LoadedPdfPayload, PdfFlags, WorkspaceDocument } from './lib/types'

  const RECENTS_KEY = 'sampadan.recentPaths'
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

  const roadmap = [
    {
      title: 'Live Local Operations',
      items: [
        'Open PDFs from disk',
        'Navigate and zoom pages',
        'Rotate the active page',
        'Reorder pages left or right',
        'Extract the active page into a new PDF',
        'Merge multiple PDFs locally',
        'Save or Save As',
        'Export page PNGs',
      ],
    },
    {
      title: 'Next Local Features',
      items: [
        'Batch split and range extract',
        'Full-document PNG export',
        'Tesseract OCR jobs',
        'Search index cache',
      ],
    },
    {
      title: 'Advanced PDF Work',
      items: [
        'Annotations and comments',
        'AcroForm editing',
        'Signature validation',
        'PDF/A validation',
        'XFA handling strategy',
      ],
    },
  ]

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

  $: pageItems = workspace ? Array.from({ length: workspace.pageCount }, (_, index) => index + 1) : []
  $: currentZoomLabel = `${Math.round(zoom * 100)}%`
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
    try {
      const stored = localStorage.getItem(RECENTS_KEY)
      if (stored) {
        recentPaths = JSON.parse(stored) as string[]
      }
    } catch {
      recentPaths = []
    }

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
      persistRecentPath(path)
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
      const { PDFDocument } = await getPdfLib()
      const merged = workspace
        ? await PDFDocument.load(workspace.bytes.slice())
        : await PDFDocument.create()

      for (const path of paths) {
        const payload = await invoke<LoadedPdfPayload>('load_pdf', { path })
        const incoming = await PDFDocument.load(base64ToBytes(payload.bytesBase64))
        const pages = await merged.copyPages(incoming, incoming.getPageIndices())
        for (const page of pages) {
          merged.addPage(page)
        }
      }

      const mergedBytes = await merged.save()
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

    busy = true
    statusTone = 'busy'
    status = delta > 0 ? 'Rotating page right' : 'Rotating page left'
    lastError = null

    try {
      const { PDFDocument, degrees } = await getPdfLib()
      const doc = await PDFDocument.load(workspace.bytes.slice())
      const page = doc.getPage(currentPage - 1)
      const nextRotation = (page.getRotation().angle + delta + 360) % 360
      page.setRotation(degrees(nextRotation))

      const bytes = await doc.save()
      await commitGeneratedPdf(bytes, {
        fileName: workspace.fileName,
        current: currentPage,
      })
      statusTone = 'idle'
      status = `Rotated page ${currentPage}`
    } catch (error) {
      reportError(error, 'Failed to rotate the current page')
    } finally {
      busy = false
    }
  }

  async function moveCurrentPage(offset: number) {
    if (!workspace || busy) return

    const sourceIndex = currentPage - 1
    const targetIndex = clamp(sourceIndex + offset, 0, workspace.pageCount - 1)
    if (sourceIndex === targetIndex) return

    busy = true
    statusTone = 'busy'
    status = offset > 0 ? 'Moving page right' : 'Moving page left'
    lastError = null

    try {
      const { PDFDocument } = await getPdfLib()
      const source = await PDFDocument.load(workspace.bytes.slice())
      const reordered = await PDFDocument.create()
      const pageOrder = Array.from({ length: source.getPageCount() }, (_, index) => index)
      const [movedPage] = pageOrder.splice(sourceIndex, 1)
      pageOrder.splice(targetIndex, 0, movedPage)

      const pages = await reordered.copyPages(source, pageOrder)
      for (const page of pages) {
        reordered.addPage(page)
      }

      const bytes = await reordered.save()
      await commitGeneratedPdf(bytes, {
        fileName: workspace.fileName,
        current: targetIndex + 1,
      })
      statusTone = 'idle'
      status = `Moved page to position ${targetIndex + 1}`
    } catch (error) {
      reportError(error, 'Failed to reorder pages')
    } finally {
      busy = false
    }
  }

  async function extractCurrentPage() {
    if (!workspace || busy) return

    busy = true
    statusTone = 'busy'
    status = `Extracting page ${currentPage}`
    lastError = null

    try {
      const { PDFDocument } = await getPdfLib()
      const source = await PDFDocument.load(workspace.bytes.slice())
      const extracted = await PDFDocument.create()
      const [page] = await extracted.copyPages(source, [currentPage - 1])
      extracted.addPage(page)

      const bytes = await extracted.save()
      await commitGeneratedPdf(bytes, {
        fileName: `${withoutExtension(workspace.fileName)}-page-${String(currentPage).padStart(3, '0')}.pdf`,
        current: 1,
      })
      statusTone = 'idle'
      status = `Extracted page ${currentPage}`
    } catch (error) {
      reportError(error, 'Failed to extract the current page')
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
        bytes_base64: bytesToBase64(workspace.bytes),
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
    if (!workspace || busy) return

    busy = true
    statusTone = 'busy'
    status = `Exporting page ${currentPage} as PNG`
    lastError = null

    try {
      const canvas = document.createElement('canvas')
      await renderPageToCanvas(currentPage, Math.max(zoom, 2), canvas)
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
        bytes_base64: await blobToBase64(blob),
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
    status = `Exporting ${workspace.pageCount} pages as PNG`
    lastError = null

    try {
      for (let pageNumber = 1; pageNumber <= workspace.pageCount; pageNumber += 1) {
        const canvas = document.createElement('canvas')
        await renderPageToCanvas(pageNumber, 2, canvas)
        const blob = await canvasToBlob(canvas)
        const fileName = `${withoutExtension(workspace.fileName)}-page-${String(pageNumber).padStart(3, '0')}.png`

        await invoke('save_file_bytes', {
          path: joinPath(directory, fileName),
          bytes_base64: await blobToBase64(blob),
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
    if (!workspace || !viewerCanvas) return
    await renderPageToCanvas(currentPage, zoom, viewerCanvas)
  }

  async function renderPageToCanvas(pageNumber: number, scale: number, canvas: HTMLCanvasElement) {
    if (!pdfProxy) return

    const token = ++renderToken
    const page = await pdfProxy.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const outputScale = window.devicePixelRatio || 1
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('Canvas rendering context is unavailable.')
    }

    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise

    page.cleanup()

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
      file_name: options.fileName,
      bytes_base64: bytesToBase64(bytes),
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
    const nextProxy = await loadPdfProxy(bytes)

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
      modified: options.modified ?? false,
      source: options.source ?? (payload.path ? 'disk' : 'generated'),
    }

    currentPage = clamp(options.current ?? 1, 1, nextProxy.numPages)
    await tick()
    await renderCurrentPage()
  }

  function persistRecentPath(path: string) {
    recentPaths = [path, ...recentPaths.filter((entry) => entry !== path)].slice(0, 7)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recentPaths))
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
    <div class="brand card">
      <span class="eyebrow">Private Local PDF Workstation</span>
      <h1>Sampadan</h1>
      <p>
        Native cross-platform PDF tooling built for local editing, restructuring, export, OCR,
        and signing workflows without sending documents to a server.
      </p>
    </div>

    <section class="card actions">
      <div class="section-head">
        <h2>Session</h2>
        <span class:busy-pill={busy} class="status-pill">{busy ? 'Busy' : 'Ready'}</span>
      </div>
      <button on:click={openPdfFlow} disabled={busy}>Open PDF</button>
      <button on:click={mergeAdditionalPdfs} disabled={busy}>Merge PDFs</button>
      <button on:click={() => saveWorkspace(false)} disabled={busy || !workspace}>Save</button>
      <button on:click={() => saveWorkspace(true)} disabled={busy || !workspace}>Save As</button>
      <button on:click={exportAllPagesPng} disabled={busy || !workspace}>Export All Pages PNG</button>
    </section>

    <section class="card recent-list">
      <div class="section-head">
        <h2>Recent Files</h2>
        <span>{recentPaths.length}</span>
      </div>
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
    </section>

    <section class="card roadmap">
      <div class="section-head">
        <h2>Build Lanes</h2>
        <span>Roadmap</span>
      </div>
      {#each roadmap as lane}
        <div class="roadmap-lane">
          <h3>{lane.title}</h3>
          <ul>
            {#each lane.items as item}
              <li>{item}</li>
            {/each}
          </ul>
        </div>
      {/each}
    </section>
  </aside>

  <main class="workspace">
    <header class="topbar card">
      <div>
        <span class="eyebrow">Current Document</span>
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

    <section class="toolbar card">
      <button on:click={() => goToPage(currentPage - 1)} disabled={busy || !workspace}>Prev</button>
      <button on:click={() => goToPage(currentPage + 1)} disabled={busy || !workspace}>Next</button>
      <button on:click={() => zoomBy(-0.15)} disabled={busy || !workspace}>-</button>
      <button on:click={() => zoomBy(0.15)} disabled={busy || !workspace}>+</button>
      <button on:click={fitToPane} disabled={busy || !workspace}>Fit Width</button>
      <span class="zoom-pill">{currentZoomLabel}</span>
      <button on:click={() => rotateCurrentPage(-90)} disabled={busy || !workspace}>Rotate Left</button>
      <button on:click={() => rotateCurrentPage(90)} disabled={busy || !workspace}>Rotate Right</button>
      <button on:click={() => moveCurrentPage(-1)} disabled={busy || !workspace}>Move Left</button>
      <button on:click={() => moveCurrentPage(1)} disabled={busy || !workspace}>Move Right</button>
      <button on:click={extractCurrentPage} disabled={busy || !workspace}>Extract Page</button>
      <button on:click={exportCurrentPagePng} disabled={busy || !workspace}>Export PNG</button>
    </section>

    <section class="workspace-grid">
      <section class="card page-strip">
        <div class="section-head">
          <h2>Pages</h2>
          <span>{workspace ? workspace.pageCount : 0}</span>
        </div>
        {#if workspace}
          <div class="page-list">
            {#each pageItems as pageNumber}
              <button
                class:active={pageNumber === currentPage}
                class="page-chip"
                on:click={() => goToPage(pageNumber)}
                aria-pressed={pageNumber === currentPage}
              >
                <span>Page</span>
                <strong>{pageNumber}</strong>
              </button>
            {/each}
          </div>
        {:else}
          <p class="muted">Open a PDF to inspect and reorder pages.</p>
        {/if}
      </section>

      <section class="card viewer-shell">
        <div class="section-head">
          <h2>Viewer</h2>
          <span>{workspace ? `Page ${currentPage}` : 'Idle'}</span>
        </div>

        {#if workspace}
          <div class="viewer-pane" bind:this={viewerPane}>
            <canvas bind:this={viewerCanvas}></canvas>
          </div>
        {:else}
          <div class="empty-state">
            <span class="eyebrow">Local first</span>
            <h3>Open a PDF to start editing.</h3>
            <p>
              Sampadan keeps the document on-device and currently supports viewing, merging,
              rotating, page extraction, reordering, and PNG export.
            </p>
            <button on:click={openPdfFlow}>Open a PDF</button>
          </div>
        {/if}
      </section>

      <section class="card inspector">
        <div class="section-head">
          <h2>Inspector</h2>
          <span>{workspace ? workspace.source : 'No file'}</span>
        </div>

        {#if workspace}
          <div class="inspector-block">
            <span class="meta-label">Name</span>
            <strong>{workspace.fileName}</strong>
          </div>
          <div class="inspector-block">
            <span class="meta-label">Location</span>
            <strong>{workspace.path ?? 'Generated in memory'}</strong>
          </div>
          <div class="inspector-block">
            <span class="meta-label">Suggested exports</span>
            <div class="export-list">
              <span>{withExtension(workspace.fileName, '.pdf')}</span>
              <span>{withExtension(workspace.fileName, '.png')}</span>
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
            <span class="meta-label">Pipeline status</span>
            <div class="stack-list">
              <span>Viewer: PDF.js</span>
              <span>Edits: pdf-lib</span>
              <span>File IO: Rust + Tauri</span>
              <span>OCR/Signatures: queued for next milestone</span>
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
          <p class="muted">Document classification will appear here after a PDF is loaded.</p>
        {/if}
      </section>
    </section>

    {#if lastError}
      <section class="card error-panel">
        <strong>Last error</strong>
        <p>{lastError}</p>
      </section>
    {/if}
  </main>
</div>
