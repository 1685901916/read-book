'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useLiveQuery } from 'dexie-react-hooks'
import WordPopup from '@/components/WordPopup'
import AnalysisPanel from '@/components/AnalysisPanel'
import VocabPanel from '@/components/VocabPanel'
import ReaderDrawer from '@/components/ReaderDrawer'
import ApiKeyDialog from '@/components/ApiKeyDialog'
import { lookupWord, analyzeSentence } from '@/lib/deepseek'
import { db, saveLocation, saveWord, saveSentence, addBookmark, deleteBookmark } from '@/lib/db'
import type { WordPopupState, AnalysisState, Book, TocItem } from '@/types'
import type { ViewerApi, LocationInfo } from '@/components/EpubViewer'

const EpubViewer = dynamic(() => import('@/components/EpubViewer'), { ssr: false })
const PdfViewer = dynamic(() => import('@/components/PdfViewer'), { ssr: false })
const MdViewer = dynamic(() => import('@/components/MdViewer'), { ssr: false })

// 字体偏好（仅对 epub 有效，pdf 是固定版式）。value 为空串 = 跟随原书自带字体。
const FONT_OPTIONS = [
  { label: '原书', value: '' },
  { label: '衬线', value: 'Georgia, "Times New Roman", serif' },
  { label: '无衬线', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
]
const DESKTOP_TOOLS_PANEL_QUERY = '(min-width: 1600px)'
const FS_KEY = 'reader_font_size'
const FF_KEY = 'reader_font_family'

export default function ReadPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const [book, setBook] = useState<Book | null>(null)
  const [epubData, setEpubData] = useState<ArrayBuffer | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [popup, setPopup] = useState<WordPopupState | null>(null)
  const [analyses, setAnalyses] = useState<AnalysisState[]>([])
  const [showVocab, setShowVocab] = useState(false)
  const [showToolsPanel, setShowToolsPanel] = useState(false)
  const [toc, setToc] = useState<TocItem[]>([])
  const [loc, setLoc] = useState<LocationInfo | null>(null)
  const [drawer, setDrawer] = useState<'toc' | 'bookmarks' | null>(null)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [fontSize, setFontSize] = useState(100)
  const [fontFamily, setFontFamily] = useState('')
  const [showFontMenu, setShowFontMenu] = useState(false)
  const locationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewerApi = useRef<ViewerApi | null>(null)

  // 载入保存过的字体偏好（所有书共用同一套，解决「每本书字号字体不一致」）
  // 必须延到客户端读 localStorage，避免 SSR 水合不一致，故在 effect 里 setState。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const s = Number(localStorage.getItem(FS_KEY))
    if (s) setFontSize(s)
    const f = localStorage.getItem(FF_KEY)
    if (f !== null) setFontFamily(f)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const changeFontSize = useCallback((next: number) => {
    const v = Math.min(200, Math.max(80, next))
    setFontSize(v)
    localStorage.setItem(FS_KEY, String(v))
  }, [])

  const changeFontFamily = useCallback((v: string) => {
    setFontFamily(v)
    localStorage.setItem(FF_KEY, v)
  }, [])

  const savedWords = useLiveQuery(
    () => db.words.toArray().then(ws => ws.map(w => w.word)),
    [],
    [] as string[]
  )
  const wordCount = useLiveQuery(() => db.words.count(), [], 0)
  const bookmarks = useLiveQuery(
    () => db.bookmarks.where('bookId').equals(bookId).reverse().sortBy('createdAt'),
    [bookId],
    []
  )

  // 当前视口是否落在某个已存书签上（百分比落在视口范围内，或 CFI 精确匹配）
  const activeBookmarkId = useMemo(() => {
    if (!loc) return null
    const match = bookmarks?.find(b => {
      if (
        b.percentage != null &&
        loc.startPercentage != null &&
        loc.endPercentage != null
      ) {
        return b.percentage >= loc.startPercentage - 0.003 && b.percentage <= loc.endPercentage + 0.003
      }
      return b.cfi === loc.startCfi
    })
    return match?.id ?? null
  }, [loc, bookmarks])

  useEffect(() => {
    let cancelled = false
    db.books.get(bookId).then(async record => {
      if (cancelled) return
      if (!record) {
        setNotFound(true)
        return
      }
      setBook(record)
      const buffer = await record.file.arrayBuffer()
      if (!cancelled) setEpubData(buffer)
    })
    return () => { cancelled = true }
  }, [bookId])

  const toggleBookmark = useCallback(async () => {
    if (activeBookmarkId) {
      await deleteBookmark(activeBookmarkId)
      return
    }
    const cur = viewerApi.current?.getCurrent()
    if (!cur?.cfi) return
    await addBookmark({
      bookId,
      cfi: cur.cfi,
      chapter: cur.chapter,
      excerpt: cur.excerpt,
      percentage: cur.percentage,
    })
  }, [activeBookmarkId, bookId])

  const handleRelocated = useCallback((cfi: string, progress: number | null) => {
    if (locationTimer.current) clearTimeout(locationTimer.current)
    locationTimer.current = setTimeout(() => {
      saveLocation(bookId, cfi, progress)
    }, 800)
  }, [bookId])

  const handleWordSelect = useCallback(async (word: string, sentence: string, rect: DOMRect) => {
    setPopup({ word, meaning: '', sentence, position: { x: rect.left + rect.width / 2, y: rect.top } })

    try {
      const { meaning, error } = await lookupWord(word, sentence)
      if (error === 'no_key') {
        setPopup(prev => (prev?.word === word ? { ...prev, meaning: '请先配置 API Key' } : prev))
        setShowKeyDialog(true)
        return
      }
      // 上游/网络失败：等同原来的 catch 分支
      if (error) {
        setPopup(prev => (prev?.word === word ? { ...prev, meaning: '查询失败' } : prev))
        return
      }
      setPopup(prev => (prev?.word === word ? { ...prev, meaning } : prev))
    } catch {
      setPopup(prev => (prev?.word === word ? { ...prev, meaning: '查询失败' } : prev))
    }
  }, [])

  const handleSentenceSelect = useCallback(async (sentence: string) => {
    setPopup(null)
    setAnalyses(prev => [{ sentence, result: null, loading: true }, ...prev])

    try {
      const { result, error } = await analyzeSentence(sentence)
      if (error === 'no_key') {
        setAnalyses(prev => prev.filter(a => !(a.sentence === sentence && a.loading)))
        setShowKeyDialog(true)
        return
      }
      // 上游/网络失败：等同原来的 catch 分支，仅撤掉 loading
      if (error) {
        setAnalyses(prev => {
          const next = [...prev]
          const idx = next.findIndex(a => a.sentence === sentence && a.loading)
          if (idx !== -1) next[idx] = { ...next[idx], loading: false }
          return next
        })
        return
      }
      setAnalyses(prev => {
        const next = [...prev]
        const idx = next.findIndex(a => a.sentence === sentence && a.loading)
        if (idx !== -1) next[idx] = { sentence, result, loading: false }
        return next
      })
      // 拆解过的句子自动入库，进入复习队列
      const record = await db.books.get(bookId)
      if (result?.structure || result?.translation) {
        await saveSentence({
          sentence,
          analysis: result,
          bookId,
          bookTitle: record?.title ?? '',
        })
      }
    } catch {
      setAnalyses(prev => {
        const next = [...prev]
        const idx = next.findIndex(a => a.sentence === sentence && a.loading)
        if (idx !== -1) next[idx] = { ...next[idx], loading: false }
        return next
      })
    }
  }, [bookId])

  const handleSaveWord = useCallback(async () => {
    if (!popup || !popup.meaning) return
    await saveWord({
      display: popup.word,
      meaning: popup.meaning,
      sentence: popup.sentence,
      bookId,
      bookTitle: book?.title ?? '',
    })
    setPopup(null)
  }, [popup, bookId, book])

  const openAnalysisPanel = useCallback(() => {
    setShowVocab(false)
    setShowToolsPanel(true)
  }, [])

  const toggleVocabPanel = useCallback(() => {
    setShowVocab(v => !v)
    if (typeof window === 'undefined' || !window.matchMedia(DESKTOP_TOOLS_PANEL_QUERY).matches) {
      setShowToolsPanel(true)
    }
  }, [])

  const renderDesktopToolsPanel = () => (
    <>
      <div className={showVocab ? 'flex-1 min-h-0 border-b border-amber-100' : 'flex-1 min-h-0'}>
        <AnalysisPanel items={analyses} onClear={() => setAnalyses([])} />
      </div>
      {showVocab && (
        <div className="flex-1 min-h-0">
          <VocabPanel onClose={() => setShowVocab(false)} />
        </div>
      )}
    </>
  )

  if (notFound) {
    return (
      <main className="min-h-screen bg-[#F7F2E9] flex flex-col items-center justify-center gap-4">
        <p className="text-amber-700">没有找到这本书</p>
        <Link href="/" className="text-sm text-amber-600 underline">回到书架</Link>
      </main>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#F7F2E9] overflow-hidden">
      {/* Top bar */}
      <header className="h-12 bg-[#F7F2E9]/90 backdrop-blur border-b border-amber-100 flex items-center px-3 sm:px-5 gap-2 sm:gap-4 shrink-0 z-40">
        <Link href="/" className="inline-flex h-11 items-center rounded-full px-2 text-amber-700 hover:text-amber-900 hover:bg-amber-100 text-sm transition-colors shrink-0">
          ← 书架
        </Link>
        <button
          onClick={() => setDrawer(d => (d === 'toc' ? null : 'toc'))}
          className="inline-flex h-11 items-center rounded-full px-2 text-sm text-amber-700 hover:text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
        >
          目录
        </button>
        <button
          onClick={() => setDrawer(d => (d === 'bookmarks' ? null : 'bookmarks'))}
          className="inline-flex h-11 items-center rounded-full px-2 text-sm text-amber-700 hover:text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
        >
          书签 {(bookmarks?.length ?? 0) > 0 && <span className="text-amber-400">{bookmarks?.length}</span>}
        </button>
        {book?.format !== 'pdf' && (
          <div className="relative shrink-0">
            <button
              onClick={() => setShowFontMenu(v => !v)}
              title="字体与字号"
              aria-label="字体与字号"
              className="inline-flex h-11 min-w-11 items-center justify-center rounded-full px-2 text-amber-700 hover:text-amber-900 hover:bg-amber-100 transition-colors text-sm font-semibold"
            >
              Aa
            </button>
            {showFontMenu && (
              <>
                {/* 点击其他地方关闭菜单 */}
                <div className="fixed inset-0 z-40" onClick={() => setShowFontMenu(false)} />
                <div className="absolute left-0 top-9 z-50 w-60 rounded-xl bg-white shadow-xl border border-amber-100 p-4">
                  <p className="text-xs font-semibold text-amber-900 mb-2">字号</p>
                  <div className="flex items-center justify-between gap-2 mb-4">
                    <button
                      onClick={() => changeFontSize(fontSize - 10)}
                      className="w-9 h-9 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm transition-colors"
                    >
                      A-
                    </button>
                    <span className="text-sm text-gray-700 tabular-nums">{fontSize}%</span>
                    <button
                      onClick={() => changeFontSize(fontSize + 10)}
                      className="w-9 h-9 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 text-lg transition-colors"
                    >
                      A+
                    </button>
                  </div>
                  <p className="text-xs font-semibold text-amber-900 mb-2">字体</p>
                  <div className="flex gap-1">
                    {FONT_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => changeFontFamily(opt.value)}
                        className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${
                          fontFamily === opt.value
                            ? 'bg-amber-600 text-white'
                            : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        <span className="text-sm font-semibold text-amber-900 truncate max-w-[28vw] sm:max-w-xs ml-1">{book?.title}</span>
        <span className="text-xs text-amber-400 hidden min-[1600px]:block">
          双击单词查意思 · 划选句子拆结构
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={openAnalysisPanel}
            className="inline-flex h-11 items-center min-[1600px]:hidden text-xs px-3 rounded-full text-amber-700 hover:text-amber-900 bg-amber-100 hover:bg-amber-200 transition-colors"
          >
            分析
          </button>
          <button
            onClick={() => setShowKeyDialog(true)}
            title="配置 API Key"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-amber-700 hover:text-amber-900 hover:bg-amber-100 transition-colors"
            aria-label="配置 API Key"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={toggleVocabPanel}
            className={`inline-flex h-11 items-center text-xs px-3 rounded-full transition-colors ${
              showVocab
                ? 'bg-amber-600 text-white hover:bg-amber-700'
                : 'text-amber-700 hover:text-amber-900 bg-amber-100 hover:bg-amber-200'
            }`}
          >
            生词本 {wordCount > 0 && wordCount}
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden relative">
        <div className="flex-1 min-w-0 overflow-hidden relative">
          {epubData &&
            (book?.format === 'pdf' ? (
              <PdfViewer
                data={epubData}
                initialLocation={book?.location}
                savedWords={savedWords}
                apiRef={viewerApi}
                onWordSelect={handleWordSelect}
                onSentenceSelect={handleSentenceSelect}
                onRelocated={handleRelocated}
                onLocationInfo={setLoc}
                onToc={setToc}
              />
            ) : book?.format === 'md' ? (
              <MdViewer
                data={epubData}
                initialLocation={book?.location}
                savedWords={savedWords}
                apiRef={viewerApi}
                onWordSelect={handleWordSelect}
                onSentenceSelect={handleSentenceSelect}
                onRelocated={handleRelocated}
                onLocationInfo={setLoc}
                onToc={setToc}
                fontSize={fontSize}
                fontFamily={fontFamily}
              />
            ) : (
              <EpubViewer
                data={epubData}
                initialLocation={book?.location}
                savedWords={savedWords}
                apiRef={viewerApi}
                onWordSelect={handleWordSelect}
                onSentenceSelect={handleSentenceSelect}
                onRelocated={handleRelocated}
                onLocationInfo={setLoc}
                onToc={setToc}
                fontSize={fontSize}
                fontFamily={fontFamily}
              />
            ))}

          {/* 书签星标：悬浮在阅读区右上角 */}
          {epubData && (
            <button
              onClick={toggleBookmark}
              title={activeBookmarkId ? '取消此处书签' : '把当前位置加入书签'}
              className="absolute top-3 right-3 z-20 w-11 h-11 flex items-center justify-center rounded-full bg-white/80 hover:bg-white shadow transition-all"
              aria-label="书签"
            >
              <svg
                viewBox="0 0 24 24"
                className={`w-5 h-5 transition-colors ${
                  activeBookmarkId ? 'text-amber-600' : 'text-gray-300'
                }`}
                fill={activeBookmarkId ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </div>

        {/* 超宽桌面才常驻侧栏；Pad/普通笔记本用浮层，避免压缩 PDF 阅读区。 */}
        <div className="hidden min-[1600px]:flex w-96 shrink-0 border-l border-amber-100 z-30 flex-col">
          {renderDesktopToolsPanel()}
        </div>
      </div>

      {showToolsPanel && (
        <div className="fixed inset-0 z-50 min-[1600px]:hidden">
          <button
            type="button"
            aria-label="关闭分析面板"
            onClick={() => setShowToolsPanel(false)}
            className="absolute inset-0 bg-black/20 animate-[drawerFadeIn_150ms_ease-out]"
          />
          <aside className="absolute right-0 top-0 bottom-0 w-[88vw] max-w-[420px] bg-white shadow-2xl border-l border-amber-100 flex flex-col">
            <div className="h-12 px-4 border-b border-amber-100 bg-[#F7F2E9] flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowVocab(false)}
                className={`h-11 px-3 rounded-full text-sm font-semibold transition-colors ${
                  showVocab
                    ? 'text-amber-700 hover:bg-amber-100'
                    : 'bg-amber-600 text-white'
                }`}
              >
                分析
              </button>
              <button
                onClick={() => setShowVocab(true)}
                className={`h-11 px-3 rounded-full text-sm font-semibold transition-colors ${
                  showVocab
                    ? 'bg-amber-600 text-white'
                    : 'text-amber-700 hover:bg-amber-100'
                }`}
              >
                生词 {wordCount > 0 && wordCount}
              </button>
              <button
                onClick={() => setShowToolsPanel(false)}
                className="ml-auto h-11 w-11 text-gray-300 hover:text-gray-600 text-xl leading-none transition-colors"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              {showVocab ? (
                <VocabPanel onClose={() => setShowVocab(false)} />
              ) : (
                <AnalysisPanel items={analyses} onClear={() => setAnalyses([])} />
              )}
            </div>
          </aside>
        </div>
      )}

      {popup && (
        <WordPopup
          word={popup.word}
          meaning={popup.meaning}
          position={popup.position}
          onClose={() => setPopup(null)}
          onSave={handleSaveWord}
        />
      )}

      <ApiKeyDialog open={showKeyDialog} onClose={() => setShowKeyDialog(false)} />

      {drawer && (
        <ReaderDrawer
          tab={drawer}
          toc={toc}
          bookmarks={bookmarks ?? []}
          currentHref={loc?.href ?? ''}
          onTabChange={setDrawer}
          onGoTo={target => viewerApi.current?.goTo(target)}
          onDeleteBookmark={id => deleteBookmark(id)}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  )
}
