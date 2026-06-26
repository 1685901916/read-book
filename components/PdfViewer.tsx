'use client'

import { useEffect, useRef, useState } from 'react'
import type { TocItem } from '@/types'
import { loadPdf, TextLayer, type PdfDoc } from '@/lib/pdfjs'
import type { ViewerApi, LocationInfo } from './EpubViewer'

// PDF 目录项的最小结构（pdfjs getOutline 返回的形状，只取用到的字段）
interface PdfOutline { title?: string; dest?: unknown; items?: PdfOutline[] }

interface PdfViewerProps {
  data: ArrayBuffer | null
  initialLocation?: string | null // `page:N`
  savedWords?: string[]
  apiRef?: React.MutableRefObject<ViewerApi | null>
  onWordSelect: (word: string, sentence: string, rect: DOMRect) => void
  onSentenceSelect: (sentence: string, rect: DOMRect) => void
  onRelocated?: (cfi: string, progress: number | null) => void
  onLocationInfo?: (info: LocationInfo) => void
  onToc?: (toc: TocItem[]) => void
}

const MAX_OUTPUT_SCALE = 2
const MAX_CANVAS_PIXELS = 8_000_000

function getSafeOutputScale(width: number, height: number) {
  let outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE)
  const pixels = width * height * outputScale * outputScale
  if (pixels > MAX_CANVAS_PIXELS) {
    outputScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(width * height, 1))
  }
  return Math.max(0.2, outputScale)
}

function pageErrorNode(doc: Document, page: number) {
  const el = doc.createElement('div')
  el.dataset.pdfError = 'true'
  el.className = 'h-full flex items-center justify-center px-8 text-center text-sm text-amber-700'
  el.textContent = `第 ${page} 页渲染失败。请尝试刷新，或换一个浏览器/降低页面缩放后重试。`
  return el
}

// 解析续读/书签定位字符串 `page:N` → 页码
function parsePage(loc: string | null | undefined): number | null {
  if (!loc) return null
  const m = /^page:(\d+)$/.exec(loc)
  if (m) return Number(m[1])
  const n = Number(loc)
  return Number.isFinite(n) && n > 0 ? n : null
}

// 从选区在其所属文字层中提取完整句子（文字层无段落结构，以整层文本为界扫断句）
function extractSentence(range: Range): string {
  const node = range.startContainer
  const layer = (node.nodeType === 3 ? node.parentElement : (node as Element))?.closest?.(
    '.textLayer'
  )
  if (!layer) return (node.textContent ?? '').replace(/\s+/g, ' ').trim()

  let offset = 0
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let cur: Node | null
  while ((cur = walker.nextNode())) {
    if (cur === node) {
      offset += range.startOffset
      break
    }
    offset += cur.textContent?.length ?? 0
  }

  const text = layer.textContent ?? ''
  let start = 0
  for (let i = offset - 2; i >= 0; i--) {
    if (/[.!?]/.test(text[i]) && /[\s"'”’)\]]/.test(text[i + 1] ?? ' ')) {
      start = i + 1
      break
    }
  }
  let end = text.length
  for (let i = offset; i < text.length - 1; i++) {
    if (/[.!?]/.test(text[i]) && /[\s"'”’)\]]/.test(text[i + 1] ?? ' ')) {
      end = i + 1
      break
    }
  }
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

// 给文字层中的生词加淡色高亮（幂等：跳过已包裹节点）
function applyHighlights(root: HTMLElement, words: Set<string>) {
  if (!words.size) return
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('.hl-saved')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  let cur: Node | null
  while ((cur = walker.nextNode())) targets.push(cur as Text)

  const tokenRe = /[A-Za-z][A-Za-z''-]*/g
  for (const textNode of targets) {
    const text = textNode.textContent ?? ''
    let match: RegExpExecArray | null
    const hits: { start: number; end: number }[] = []
    tokenRe.lastIndex = 0
    while ((match = tokenRe.exec(text))) {
      if (words.has(match[0].toLowerCase())) {
        hits.push({ start: match.index, end: match.index + match[0].length })
      }
    }
    if (!hits.length) continue

    const frag = doc.createDocumentFragment()
    let pos = 0
    for (const { start, end } of hits) {
      if (start > pos) frag.appendChild(doc.createTextNode(text.slice(pos, start)))
      const span = doc.createElement('span')
      span.className = 'hl-saved'
      span.textContent = text.slice(start, end)
      span.style.backgroundColor = 'rgba(245, 158, 11, 0.28)'
      span.style.borderRadius = '2px'
      frag.appendChild(span)
      pos = end
    }
    if (pos < text.length) frag.appendChild(doc.createTextNode(text.slice(pos)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
}

export default function PdfViewer({
  data,
  initialLocation,
  savedWords,
  apiRef,
  onWordSelect,
  onSentenceSelect,
  onRelocated,
  onLocationInfo,
  onToc,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const lastPageRef = useRef(1)
  const savedWordsRef = useRef<Set<string>>(new Set(savedWords ?? []))
  // 已渲染页面的文字层，供生词高亮更新时复用
  const textLayersRef = useRef<Map<number, HTMLElement>>(new Map())

  // 回调放进 ref，避免身份变化触发整本重渲染（在 effect 中更新，不在渲染期写 ref）
  const cbRef = useRef({ onWordSelect, onSentenceSelect, onRelocated, onLocationInfo, onToc })
  useEffect(() => {
    cbRef.current = { onWordSelect, onSentenceSelect, onRelocated, onLocationInfo, onToc }
  })

  useEffect(() => {
    lastPageRef.current = parsePage(initialLocation) ?? 1
  }, [data, initialLocation])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof window === 'undefined') return

    const updateWidth = () => {
      const next = Math.round(scroller.clientWidth)
      setContainerWidth(prev => (Math.abs(prev - next) > 4 ? next : prev))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }

    const ro = new ResizeObserver(updateWidth)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [])

  // 生词表变化时，给已渲染的文字层补高亮
  useEffect(() => {
    savedWordsRef.current = new Set(savedWords ?? [])
    for (const layer of textLayersRef.current.values()) {
      applyHighlights(layer, savedWordsRef.current)
    }
  }, [savedWords])

  useEffect(() => {
    if (
      !scrollRef.current ||
      !pagesRef.current ||
      typeof window === 'undefined' ||
      !data ||
      !containerWidth
    ) return

    const scroller = scrollRef.current
    const pagesEl = pagesRef.current
    setLoadError(null)
    let pdf: PdfDoc | null = null
    let cancelled = false
    let io: IntersectionObserver | null = null
    let rafId = 0
    let sentenceTimer: ReturnType<typeof setTimeout> | null = null
    const wrappers = new Map<number, HTMLDivElement>()
    const rendered = new Set<number>()
    const renderTasks = new Map<number, { promise: Promise<void>; cancel: () => void }>()
    // 捕获 ref 当前值，cleanup 用这个稳定引用（满足 react-hooks/exhaustive-deps）
    const textLayers = textLayersRef.current
    textLayers.clear()

    let numPages = 0
    let scale = 1
    let baseW = 0
    let baseH = 0
    let outlinePages: { page: number; title: string }[] = [] // 升序，用于定位当前章节

    const PAGE_GAP = 16
    const current = { page: 1 }

    const pctRange = (page: number): [number, number] =>
      numPages > 0 ? [(page - 1) / numPages, page / numPages] : [0, 0]

    const chapterOf = (page: number): string => {
      let title = ''
      for (const o of outlinePages) {
        if (o.page <= page) title = o.title
        else break
      }
      return title
    }

    const emitLocation = (page: number) => {
      lastPageRef.current = page
      const [sp, ep] = pctRange(page)
      cbRef.current.onRelocated?.(`page:${page}`, ep)
      cbRef.current.onLocationInfo?.({
        startCfi: `page:${page}`,
        chapter: chapterOf(page),
        href: `page:${page}`,
        startPercentage: sp,
        endPercentage: ep,
      })
    }

    // 计算当前视口顶部所在页
    const updateCurrentPage = () => {
      const top = scroller.scrollTop
      let best = 1
      for (const [n, w] of wrappers) {
        if (w.offsetTop - PAGE_GAP <= top + 4) best = n
        else break
      }
      if (best !== current.page) {
        current.page = best
        emitLocation(best)
      }
    }

    const onScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        updateCurrentPage()
      })
    }

    const renderPage = async (n: number) => {
      if (rendered.has(n) || cancelled || !pdf) return
      rendered.add(n)
      try {
        const page = await pdf.getPage(n)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const wrapper = wrappers.get(n)
        if (!wrapper) return
        wrapper.style.height = `${Math.floor(viewport.height)}px`

        const canvas = document.createElement('canvas')
        const outputScale = getSafeOutputScale(viewport.width, viewport.height)
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        canvas.style.backgroundColor = '#fff'
        canvas.className = 'block'
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) throw new Error('Canvas 2D context is unavailable')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        const textLayerDiv = document.createElement('div')
        textLayerDiv.className = 'textLayer'
        textLayerDiv.style.setProperty('--scale-factor', String(scale))
        textLayerDiv.style.setProperty('--total-scale-factor', String(scale))

        wrapper.replaceChildren(canvas, textLayerDiv)

        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
        const task = page.render({ canvas, viewport, transform, background: '#fff' })
        renderTasks.set(n, task)
        await task.promise
        if (cancelled) return

        try {
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport,
          })
          await textLayer.render()
          if (cancelled) return
          applyHighlights(textLayerDiv, savedWordsRef.current)
          textLayers.set(n, textLayerDiv)
        } catch (err) {
          console.warn(`PDF text layer render failed on page ${n}`, err)
        }
        page.cleanup()
      } catch (err) {
        if (!cancelled) {
          console.error(`PDF page ${n} render failed`, err)
          const wrapper = wrappers.get(n)
          wrapper?.replaceChildren(pageErrorNode(scroller.ownerDocument, n))
        }
        rendered.delete(n) // 失败允许重试
      }
    }

    const buildOutline = async () => {
      if (!pdf) return
      const doc = pdf
      try {
        const outline = await doc.getOutline()
        if (!outline?.length || cancelled) return

        const destToPage = async (dest: unknown): Promise<number | null> => {
          try {
            let explicit = dest
            if (typeof dest === 'string') explicit = await doc.getDestination(dest)
            if (!Array.isArray(explicit) || !explicit[0]) return null
            const idx = await doc.getPageIndex(explicit[0])
            return idx + 1
          } catch {
            return null
          }
        }

        const flat: TocItem[] = []
        const pageMap: { page: number; title: string }[] = []
        const walk = async (items: PdfOutline[], depth: number) => {
          for (const it of items ?? []) {
            const page = await destToPage(it.dest)
            const label = (it.title ?? '').trim()
            flat.push({ label, href: page ? `page:${page}` : '', depth })
            if (page) pageMap.push({ page, title: label })
            if (it.items?.length) await walk(it.items, depth + 1)
          }
        }
        await walk(outline, 0)
        if (cancelled) return
        outlinePages = pageMap.sort((a, b) => a.page - b.page)
        cbRef.current.onToc?.(flat)
      } catch {
        // 没有目录不影响阅读
      }
    }

    const scrollToPage = (n: number) => {
      const w = wrappers.get(n)
      if (w) scroller.scrollTop = w.offsetTop - PAGE_GAP
    }

    const init = async () => {
      pdf = await loadPdf(data)
      if (cancelled) return
      numPages = pdf.numPages

      const first = await pdf.getPage(1)
      const base = first.getViewport({ scale: 1 })
      baseW = base.width
      baseH = base.height
      const pagePadding =
        scroller.clientWidth < 640 ? 16 : scroller.clientWidth < 1400 ? 32 : 48
      const avail = Math.max(280, scroller.clientWidth - pagePadding) // 留出左右内边距
      scale = Math.min(avail / baseW, 2.5)
      first.cleanup()

      const estH = Math.floor(baseH * scale)
      const cssW = Math.floor(baseW * scale)

      // 先铺占位，保证滚动高度稳定，再懒渲染
      const frag = document.createDocumentFragment()
      for (let n = 1; n <= numPages; n++) {
        const w = document.createElement('div')
        w.className = 'pdf-page relative mx-auto bg-white shadow-sm'
        w.style.width = `${cssW}px`
        w.style.height = `${estH}px`
        w.style.marginBottom = `${PAGE_GAP}px`
        w.dataset.page = String(n)
        wrappers.set(n, w)
        frag.appendChild(w)
      }
      pagesEl.replaceChildren(frag)

      io = new IntersectionObserver(
        entries => {
          for (const e of entries) {
            if (e.isIntersecting) {
              const n = Number((e.target as HTMLElement).dataset.page)
              renderPage(n)
            }
          }
        },
        { root: scroller, rootMargin: '300% 0px' }
      )
      for (const w of wrappers.values()) io.observe(w)

      // 命令式 API
      if (apiRef) {
        apiRef.current = {
          goTo: (target: string) => {
            const p = parsePage(target)
            if (p) scrollToPage(p)
          },
          getCurrent: () => {
            const page = current.page
            const layer = textLayers.get(page)
            const excerpt = (layer?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)
            const [sp] = pctRange(page)
            return { cfi: `page:${page}`, chapter: chapterOf(page), excerpt, percentage: sp }
          },
        }
      }

      buildOutline()

      // 续读定位
      const startPage = lastPageRef.current > 1 ? lastPageRef.current : parsePage(initialLocation)
      if (startPage && startPage > 1) {
        requestAnimationFrame(() => {
          if (!cancelled) scrollToPage(startPage)
          current.page = startPage
          emitLocation(startPage)
        })
      } else {
        emitLocation(1)
      }
      scroller.addEventListener('scroll', onScroll, { passive: true })
    }

    // 选区 → 查词 / 拆句
    const onPointerUp = () => {
      const sel = scroller.ownerDocument.getSelection()
      const text = sel?.toString().trim()
      if (!sel || !text || text.length < 2) return
      const range = sel.getRangeAt(0)
      if (!scroller.contains(range.commonAncestorContainer)) return
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return

      const wordCount = text.split(/\s+/).length
      if (wordCount <= 2) {
        const sentence = extractSentence(range)
        cbRef.current.onWordSelect(text, sentence, rect)
      } else {
        if (sentenceTimer) clearTimeout(sentenceTimer)
        sentenceTimer = setTimeout(() => cbRef.current.onSentenceSelect(text, rect), 600)
      }
    }
    scroller.addEventListener('pointerup', onPointerUp)

    init().catch(err => {
      if (!cancelled) {
        console.error('PDF load failed', err)
        setLoadError('PDF 加载失败。请确认文件有效，或换一个浏览器重试。')
      }
    })

    return () => {
      cancelled = true
      if (rafId) cancelAnimationFrame(rafId)
      if (sentenceTimer) clearTimeout(sentenceTimer)
      io?.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('pointerup', onPointerUp)
      for (const t of renderTasks.values()) {
        try {
          t.cancel()
        } catch {
          /* noop */
        }
      }
      textLayers.clear()
      if (apiRef) apiRef.current = null
      pagesEl.replaceChildren()
      if (pdf) pdf.loadingTask.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, containerWidth])

  return (
    <div ref={scrollRef} className="w-full h-full overflow-auto bg-[#ece5d8]">
      {loadError && (
        <div className="m-4 rounded-xl bg-white border border-amber-200 px-5 py-4 text-sm text-amber-800 shadow-sm">
          {loadError}
        </div>
      )}
      <div ref={pagesRef} className="py-4" />
    </div>
  )
}
