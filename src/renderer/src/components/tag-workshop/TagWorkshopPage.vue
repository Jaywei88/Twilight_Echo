<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import { formatDuration } from '@renderer/components/song-list/formatDuration'
import { syncPluginProviders, useMediaProviders } from '@renderer/providers'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useTagWorkshopLaunch } from '@renderer/stores/useTagWorkshopLaunch'
import type { Track } from '@renderer/types/music'
import {
  buildMetadataMatchCandidates,
  buildMetadataSearchQueries,
  type MetadataMatchCandidate
} from '@renderer/utils/musicMetadataMatching'
import type { UnifiedSearchResult } from '@renderer/utils/unifiedMusicSearch'
import {
  BATCH_MATCH_CONCURRENCY,
  buildMatchedTagPatch,
  DEFAULT_TAG_MATCH_FIELDS,
  forEachWithConcurrency,
  hasMatchedTagPatch,
  mergeMetadataMatchCandidates,
  shouldAutoApplyMatch,
  TAG_MATCH_FIELD_DEFINITIONS,
  type TagMatchField
} from '@renderer/utils/tagWorkshopBatchMatch'
import {
  hasTagPatch,
  successfulTagPaths,
  summarizeTagWriteResults,
  tagPatchFromWorkshopForm,
  tagWritePathKey,
  toDuplicateReviewGroups,
  validateTagCoverFile,
  type DuplicateReviewGroup
} from '@renderer/utils/localLibraryTagManagement.ts'
import {
  filenameExtension,
  filenameStem,
  filenameTemplateHasTokens,
  filenameTemplateValuesFromTrack,
  guessFilenamePattern,
  parseFilenameTemplate,
  renderFilenameTemplate,
  TAG_WORKSHOP_FILENAME_PRESETS,
  type FilenameTemplateKey,
  type FilenameTemplateValues
} from '@renderer/utils/tagWorkshopFilenames'
import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagPatch,
  LocalLibraryTagSnapshot,
  LocalLibraryTagWriteProgress
} from '../../../../shared/localLibraryTags.ts'
import type { LocalLibraryRenameItemResult } from '../../../../shared/localLibraryRename.ts'
import { MUSIC_TAG_WORKSHOP_MAX_ITEMS } from '../../../../shared/musicTagWorkshop.ts'

type BatchMatchStatus = 'pending' | 'applied' | 'review' | 'noMatch' | 'failed'

interface BatchMatchTrackResult {
  trackId: string
  filePath: string
  fileName: string
  title: string
  artist: string
  status: BatchMatchStatus
  candidates: MetadataMatchCandidate[]
  patch?: LocalLibraryTagPatch
  candidateLabel?: string
  message?: string
}

type FieldKey =
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'genre'
  | 'composer'
  | 'comment'
  | 'lyrics'
  | 'track'
  | 'trackCount'
  | 'disc'
  | 'discCount'
  | 'year'

interface FieldDefinition {
  key: FieldKey
  label: string
  type: 'text' | 'number' | 'textarea'
  placeholder?: string
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  { key: 'title', label: '标题', type: 'text' },
  { key: 'artist', label: '艺术家', type: 'text' },
  { key: 'album', label: '专辑', type: 'text' },
  { key: 'albumArtist', label: '专辑艺术家', type: 'text' },
  { key: 'genre', label: '流派', type: 'text' },
  { key: 'composer', label: '作曲（用分号分隔）', type: 'text' },
  { key: 'track', label: '曲目号', type: 'number' },
  { key: 'trackCount', label: '曲目总数', type: 'number' },
  { key: 'disc', label: '碟号', type: 'number' },
  { key: 'discCount', label: '碟总数', type: 'number' },
  { key: 'year', label: '年份', type: 'number' },
  { key: 'comment', label: '备注', type: 'text' },
  { key: 'lyrics', label: '歌词', type: 'textarea' }
]
const FIELD_KEYS = FIELD_DEFINITIONS.map((field) => field.key)
const NUMERIC_FIELDS = new Set<FieldKey>(['track', 'trackCount', 'disc', 'discCount', 'year'])
const PAGE_SIZE = 100

const musicStore = useMusicStore()
const playerStore = usePlayerStore()
const mediaProviders = useMediaProviders()
const query = ref('')
const page = ref(1)
const selectedIds = ref(new Set<string>())
const selectionError = ref('')

const editableTracks = computed(() =>
  musicStore.tracks.value.filter((track) => track.filePath && !track.subTrack && !track.cueRange)
)
const filteredTracks = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase('zh-CN')
  if (!keyword) return editableTracks.value
  return editableTracks.value.filter((track) =>
    `${track.title} ${track.artist} ${track.album} ${track.filePath}`
      .toLocaleLowerCase('zh-CN')
      .includes(keyword)
  )
})
const pageCount = computed(() => Math.max(1, Math.ceil(filteredTracks.value.length / PAGE_SIZE)))
const visibleTracks = computed(() =>
  filteredTracks.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE)
)
const selectedTracks = computed(() =>
  [...selectedIds.value]
    .map((id) => musicStore.getTrackById(id))
    .filter((track): track is Track => {
      if (!track?.filePath || track.subTrack || track.cueRange) return false
      return true
    })
)
const singleTrack = computed(() =>
  selectedTracks.value.length === 1 ? selectedTracks.value[0] : null
)
const hiddenCueCount = computed(
  () => musicStore.tracks.value.filter((track) => track.subTrack || track.cueRange).length
)

const { pendingPaths: tagWorkshopPendingPaths, consumePendingPaths } = useTagWorkshopLaunch()
const pendingLaunchPaths = ref<string[]>([])

function applyPendingLaunchSelection(): void {
  if (pendingLaunchPaths.value.length === 0) return
  const keys = new Set(pendingLaunchPaths.value.map((filePath) => tagWritePathKey(filePath)))
  const matches = editableTracks.value.filter((track) => keys.has(tagWritePathKey(track.filePath)))
  if (matches.length === 0) {
    if (musicStore.tracks.value.length === 0) return
    pendingLaunchPaths.value = []
    selectionError.value = '所选歌曲不在可编辑的本地曲库中'
    return
  }
  selectedIds.value = new Set(
    matches.slice(0, MUSIC_TAG_WORKSHOP_MAX_ITEMS).map((track) => track.id)
  )
  const firstMatch = matches[0]
  const index = filteredTracks.value.findIndex((track) => track.id === firstMatch.id)
  if (index >= 0) page.value = Math.floor(index / PAGE_SIZE) + 1
  pendingLaunchPaths.value = []
  selectionError.value =
    matches.length > MUSIC_TAG_WORKSHOP_MAX_ITEMS
      ? `一次最多编辑 ${MUSIC_TAG_WORKSHOP_MAX_ITEMS} 首歌曲`
      : ''
}

watch(
  tagWorkshopPendingPaths,
  (filePaths) => {
    if (filePaths.length === 0) return
    pendingLaunchPaths.value = consumePendingPaths()
    applyPendingLaunchSelection()
  },
  { immediate: true }
)
watch(editableTracks, applyPendingLaunchSelection)

function blankValues(): Record<FieldKey, string> {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, ''])) as Record<FieldKey, string>
}
function blankIncluded(): Record<FieldKey, boolean> {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, false])) as Record<FieldKey, boolean>
}

const fieldValues = reactive(blankValues())
const fieldIncluded = reactive(blankIncluded())
const snapshot = shallowRef<LocalLibraryTagSnapshot | null>(null)
const reading = ref(false)
const readError = ref('')
const coverPreview = ref<string | null>(null)
const coverDraft = ref<Uint8Array | null | undefined>(undefined)
const coverDirty = ref(false)
const coverError = ref('')
const formError = ref('')
const notice = ref('')
const busy = ref(false)
const operationId = ref<string | null>(null)
const progress = shallowRef<LocalLibraryTagWriteProgress | null>(null)
const cancelRequested = ref(false)
const results = shallowRef<LocalLibraryTagOperationResult[]>([])
const restoreArmed = ref(false)
const restoring = ref(false)
let removeProgressListener: (() => void) | undefined
let readRequest = 0

const matchFieldIncluded = reactive(
  Object.fromEntries(
    TAG_MATCH_FIELD_DEFINITIONS.map((field) => [field.key, DEFAULT_TAG_MATCH_FIELDS.has(field.key)])
  ) as Record<TagMatchField, boolean>
)
const batchMatching = ref(false)
const batchWriting = ref(false)
const batchMatchDone = ref(false)
const batchMatchError = ref('')
const batchMatchNotice = ref('')
const batchMatchProgress = reactive({ current: 0, total: 0, label: '' })
const batchResults = ref<BatchMatchTrackResult[]>([])
const applyingReviewKey = ref('')
let batchMatchRun = 0
let batchMatchAbort: AbortController | null = null

const tagPattern = ref('{artist} - {title}')
const tagPatternError = ref('')
const tagPatternNotice = ref('')
const renameTemplate = ref('{artist} - {title}')
const renameError = ref('')
const renameNotice = ref('')
const renaming = ref(false)
const renameArmed = ref(false)
const renameResults = shallowRef<LocalLibraryRenameItemResult[]>([])
const TAG_TOKEN_HINT = '{title} {artist} {album} {albumArtist} {genre} {year} {track:02} {disc:02}'

const duplicateChecking = ref(false)
const duplicateChecked = ref(false)
const duplicateError = ref('')
const duplicateGroups = shallowRef<DuplicateReviewGroup[]>([])
const duplicateSelectionSignature = ref('')

const resultSummary = computed(() => summarizeTagWriteResults(results.value))
const failedResults = computed(() =>
  results.value.filter((result) => result.status !== 'success').slice(0, 20)
)
const progressPercent = computed(() => {
  const value = progress.value
  if (!value || value.total <= 0) return 0
  return Math.round((value.current / value.total) * 100)
})
const selectionLabel = computed(() => {
  if (selectedTracks.value.length === 0) return '未选择歌曲'
  if (selectedTracks.value.length === 1) return `正在编辑：${singleTrack.value?.title ?? ''}`
  return `批量编辑 ${selectedTracks.value.length} 首歌曲`
})
const selectedPathKeys = computed(
  () => new Set(selectedTracks.value.map((track) => tagWritePathKey(track.filePath)))
)
const duplicateStale = computed(
  () =>
    duplicateChecked.value &&
    duplicateSelectionSignature.value !== [...selectedPathKeys.value].sort().join('|')
)
const progressFileName = computed(() => {
  const filePath = progress.value?.filePath
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
})
const selectedMatchFields = computed(
  () =>
    new Set(
      TAG_MATCH_FIELD_DEFINITIONS.map((field) => field.key).filter((key) => matchFieldIncluded[key])
    )
)
const matchFieldCount = computed(() => selectedMatchFields.value.size)
const reviewEntries = computed(() =>
  batchResults.value.filter((entry) => entry.status === 'review')
)
const appliedEntries = computed(() =>
  batchResults.value.filter((entry) => entry.status === 'applied')
)
const unmatchedEntries = computed(() =>
  batchResults.value.filter((entry) => entry.status === 'noMatch')
)
const failedMatchEntries = computed(() =>
  batchResults.value.filter((entry) => entry.status === 'failed')
)

const patchPreview = computed(() => {
  const built = buildPatch()
  if (built.error) return []
  const rows: Array<{ label: string; value: string }> = []
  for (const field of FIELD_DEFINITIONS) {
    const value = built.patch[field.key]
    if (value === undefined) continue
    rows.push({
      label: field.label,
      value: value === null ? '清除' : String(value)
    })
  }
  if (built.patch.coverData !== undefined) {
    rows.push({ label: '封面', value: built.patch.coverData === null ? '移除' : '替换' })
  }
  return rows
})
const canWrite = computed(
  () =>
    !busy.value &&
    selectedTracks.value.length > 0 &&
    patchPreview.value.length > 0 &&
    !formError.value
)
const renameTemplateValid = computed(() => filenameTemplateHasTokens(renameTemplate.value))
const renamePreview = computed(() => {
  if (!renameTemplateValid.value) return []
  return selectedTracks.value.map((track) => {
    const currentName = trackFileName(track)
    const extension = filenameExtension(currentName)
    const fileName = renderFilenameTemplate(
      renameTemplate.value,
      renameValuesForTrack(track),
      extension
    )
    return { track, currentName, fileName, changed: fileName !== currentName }
  })
})
const renameDuplicateNames = computed(() => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const row of renamePreview.value) {
    const key = row.fileName.toLocaleLowerCase('en-US')
    if (seen.has(key)) duplicates.add(row.fileName)
    seen.add(key)
  }
  return duplicates
})
const renameChangedRows = computed(() => renamePreview.value.filter((row) => row.changed))
const renameBlocked = computed(
  () =>
    busy.value ||
    renaming.value ||
    !renameTemplateValid.value ||
    renameDuplicateNames.value.size > 0 ||
    renameChangedRows.value.length === 0
)

watch(query, () => {
  page.value = 1
})
watch(pageCount, () => {
  if (page.value > pageCount.value) page.value = pageCount.value
})
watch(renameTemplate, () => {
  renameArmed.value = false
  renameError.value = ''
  renameNotice.value = ''
})
watch(selectedIds, () => {
  renameArmed.value = false
  renameError.value = ''
  renameNotice.value = ''
  renameResults.value = []
  resetBatchMatch()
})
watch(
  () => singleTrack.value?.id,
  () => {
    void loadSelectedSnapshot()
  },
  { immediate: true }
)
watch(
  () => selectedTracks.value.length,
  () => {
    if (selectedTracks.value.length !== 1) resetEditor()
  }
)

function resetEditor(): void {
  snapshot.value = null
  Object.assign(fieldValues, blankValues())
  Object.assign(fieldIncluded, blankIncluded())
  resetCover()
  resetBatchMatch()
  resetFilenameTools()
  readError.value = ''
  formError.value = ''
  results.value = []
  progress.value = null
  restoreArmed.value = false
}

function resetFilenameTools(): void {
  tagPattern.value = '{artist} - {title}'
  tagPatternError.value = ''
  tagPatternNotice.value = ''
  renameTemplate.value = '{artist} - {title}'
  renameError.value = ''
  renameNotice.value = ''
  renaming.value = false
  renameArmed.value = false
  renameResults.value = []
}

function resetBatchMatch(): void {
  batchMatchAbort?.abort()
  batchMatchAbort = null
  batchMatchRun += 1
  batchMatching.value = false
  batchWriting.value = false
  batchMatchDone.value = false
  batchMatchError.value = ''
  batchMatchNotice.value = ''
  batchResults.value = []
  applyingReviewKey.value = ''
  batchMatchProgress.current = 0
  batchMatchProgress.total = 0
  batchMatchProgress.label = ''
}

function resetCover(): void {
  coverDraft.value = undefined
  coverDirty.value = false
  coverError.value = ''
  coverPreview.value = null
}

function resetDuplicates(): void {
  duplicateChecking.value = false
  duplicateChecked.value = false
  duplicateError.value = ''
  duplicateGroups.value = []
  duplicateSelectionSignature.value = ''
}

function applySnapshot(tags: LocalLibraryTagSnapshot): void {
  for (const key of FIELD_KEYS) {
    const value = tags[key]
    fieldValues[key] = value === null || value === undefined ? '' : String(value)
    fieldIncluded[key] = true
  }
  coverDraft.value = undefined
  coverDirty.value = false
  coverPreview.value =
    tags.coverData && tags.coverMimeType ? bytesToDataUrl(tags.coverData, tags.coverMimeType) : null
}

async function loadSelectedSnapshot({
  preserveMatchState = false
}: { preserveMatchState?: boolean } = {}): Promise<void> {
  const track = singleTrack.value
  if (!preserveMatchState) {
    resetEditor()
    resetDuplicates()
  }
  if (!track) return
  readError.value = ''
  tagPattern.value =
    guessFilenamePattern(filenameStem(trackFileName(track))) ?? '{artist} - {title}'
  const request = ++readRequest
  reading.value = true
  try {
    const result = await window.api.library.readTags({
      filePaths: [track.filePath],
      includeCover: true
    })
    if (request !== readRequest) return
    const item = result.items[0]
    if (item?.tags) {
      snapshot.value = item.tags
      applySnapshot(item.tags)
    } else {
      readError.value = item?.message ?? '无法读取文件标签'
    }
  } catch (error) {
    if (request !== readRequest) return
    readError.value = error instanceof Error ? error.message : '无法读取文件标签'
  } finally {
    if (request === readRequest) reading.value = false
  }
}

function toggleTrack(track: Track): void {
  selectionError.value = ''
  const next = new Set(selectedIds.value)
  if (next.has(track.id)) {
    next.delete(track.id)
  } else {
    if (next.size >= MUSIC_TAG_WORKSHOP_MAX_ITEMS) {
      selectionError.value = `一次最多编辑 ${MUSIC_TAG_WORKSHOP_MAX_ITEMS} 首歌曲`
      return
    }
    next.add(track.id)
  }
  selectedIds.value = next
}

function selectVisible(): void {
  selectionError.value = ''
  const next = new Set(selectedIds.value)
  for (const track of visibleTracks.value) {
    if (next.size >= MUSIC_TAG_WORKSHOP_MAX_ITEMS) break
    next.add(track.id)
  }
  if (filteredTracks.value.length + next.size > MUSIC_TAG_WORKSHOP_MAX_ITEMS) {
    selectionError.value = `一次最多编辑 ${MUSIC_TAG_WORKSHOP_MAX_ITEMS} 首歌曲`
  }
  selectedIds.value = next
}

function clearSelection(): void {
  selectedIds.value = new Set()
  selectionError.value = ''
  resetDuplicates()
}

function onFieldInput(key: FieldKey): void {
  if (!fieldIncluded[key]) fieldIncluded[key] = true
  formError.value = ''
  renameArmed.value = false
}

function buildPatch(): { patch: LocalLibraryTagPatch; error: string } {
  const values: Partial<Record<keyof LocalLibraryTagPatch, unknown>> = {}
  for (const field of FIELD_DEFINITIONS) {
    if (!fieldIncluded[field.key]) continue
    const raw = fieldValues[field.key].trim()
    if (NUMERIC_FIELDS.has(field.key)) {
      if (!raw) {
        values[field.key] = null
        continue
      }
      if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) {
        return { patch: {}, error: `${field.label}必须是 1-9999 的整数` }
      }
      values[field.key] = Number(raw)
    } else {
      values[field.key] = raw || null
    }
  }
  if (coverDirty.value) values.coverData = coverDraft.value ?? null
  const patch = tagPatchFromWorkshopForm(values)
  if (!hasTagPatch(patch)) return { patch, error: '请至少选择一个要写入的字段' }
  return { patch, error: '' }
}

async function onCoverInput(event: Event): Promise<void> {
  coverError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const validation = validateTagCoverFile(file)
  if (validation) {
    coverError.value = validation
    input.value = ''
    return
  }
  try {
    const data = new Uint8Array(await file.arrayBuffer())
    coverDraft.value = data
    coverDirty.value = true
    coverPreview.value = bytesToDataUrl(data, file.type)
  } catch {
    coverError.value = '无法读取封面文件'
  } finally {
    input.value = ''
  }
}

function removeCover(): void {
  coverDraft.value = null
  coverDirty.value = true
  coverPreview.value = null
  coverError.value = ''
}

function discardCoverDraft(): void {
  coverDirty.value = false
  coverDraft.value = undefined
  coverError.value = ''
  coverPreview.value =
    snapshot.value?.coverData && snapshot.value.coverMimeType
      ? bytesToDataUrl(snapshot.value.coverData, snapshot.value.coverMimeType)
      : null
}

function candidateKey(candidate: MetadataMatchCandidate): string {
  return `${candidate.providerId}:${candidate.track.id}`
}

function isAppliedMatch(entry: BatchMatchTrackResult): boolean {
  return entry.status === 'applied'
}

interface MatchedTagExtras {
  coverData?: Uint8Array
  lyrics?: string
}

async function loadMatchedExtras(
  candidate: MetadataMatchCandidate,
  fields: ReadonlySet<TagMatchField>,
  signal?: AbortSignal
): Promise<MatchedTagExtras> {
  const extras: MatchedTagExtras = {}
  const tasks: Array<Promise<void>> = []
  if (fields.has('cover') && candidate.track.cover) {
    tasks.push(
      (async () => {
        try {
          const cover = await window.api.data.readCoverBytes(
            candidate.track.cover ?? '',
            candidate.track.coverSource
          )
          if (cover?.data.length) extras.coverData = cover.data
        } catch {
          // Metadata still applies when the cover cannot be fetched.
        }
      })()
    )
  }
  if (fields.has('lyrics')) {
    tasks.push(
      (async () => {
        try {
          const lyrics = await mediaProviders.resolveLyrics(candidate.track, {
            timeoutMs: 10_000,
            signal
          })
          const text = lyrics.lyrics || lyrics.translatedLyrics || lyrics.wordLyrics || ''
          if (text.trim()) extras.lyrics = text
        } catch {
          // Metadata still applies when lyrics cannot be fetched.
        }
      })()
    )
  }
  await Promise.all(tasks)
  return extras
}

async function buildPatchForMatch(
  candidate: MetadataMatchCandidate,
  fields: ReadonlySet<TagMatchField>,
  signal?: AbortSignal
): Promise<LocalLibraryTagPatch> {
  const extras = await loadMatchedExtras(candidate, fields, signal)
  return buildMatchedTagPatch(candidate, fields, extras)
}

function batchSummaryText(): string {
  const applied = appliedEntries.value.length
  const review = reviewEntries.value.length
  const unmatched = unmatchedEntries.value.length
  const failed = failedMatchEntries.value.length
  const parts: string[] = []
  if (applied > 0) parts.push(`已自动写入 ${applied} 首`)
  if (review > 0) parts.push(`${review} 首需确认`)
  if (unmatched > 0) parts.push(`${unmatched} 首未找到匹配`)
  if (failed > 0) parts.push(`${failed} 首失败`)
  return parts.length > 0 ? `${parts.join(' · ')}。` : '没有需要处理的歌曲。'
}

const BATCH_MATCH_PROVIDER_TIMEOUT_MS = 6_000
const BATCH_MATCH_ITUNES_TIMEOUT_MS = 6_000

function cancelBatchMatch(): void {
  batchMatchAbort?.abort()
}

async function runBatchMatch(): Promise<void> {
  if (batchMatching.value || busy.value) return
  const tracks = [...selectedTracks.value]
  if (tracks.length === 0) return
  const fields = selectedMatchFields.value
  if (fields.size === 0) {
    batchMatchError.value = '请至少选择一种标签类型'
    return
  }
  resetBatchMatch()
  const run = batchMatchRun
  const controller = new AbortController()
  batchMatchAbort = controller
  batchMatching.value = true
  batchMatchProgress.total = tracks.length
  batchMatchProgress.current = 0
  batchMatchProgress.label = ''
  batchMatchError.value = ''
  batchMatchNotice.value = ''
  const slots: Array<BatchMatchTrackResult | undefined> = new Array(tracks.length)
  let searched = 0
  const searchCache = new Map<string, Promise<UnifiedSearchResult>>()
  const searchBatchQuery = (
    query: string,
    options?: { itunesOnly?: boolean }
  ): Promise<UnifiedSearchResult> => {
    const key = `${options?.itunesOnly ? 'itunes' : 'primary'}\u0000${query.normalize('NFKC').trim().toLowerCase()}`
    const cached = searchCache.get(key)
    if (cached) return cached
    // MusicTag 的策略：网易云、QQ、酷我并行；iTunes 配额有限，只在前三者
    // 都没有候选时作为最后回退，避免批量匹配把 Search API 配额打满。
    const request = options?.itunesOnly
      ? mediaProviders.searchAllSongs({
          query,
          localTracks: [],
          limit: 20,
          offset: 0,
          signal: controller.signal,
          includeMetadataOnly: true,
          providerIds: ['itunes'],
          providerTimeoutMs: BATCH_MATCH_ITUNES_TIMEOUT_MS
        })
      : mediaProviders.searchAllSongs({
          query,
          localTracks: [],
          limit: 20,
          offset: 0,
          signal: controller.signal,
          includeMetadataOnly: true,
          excludeProviderIds: ['itunes'],
          providerTimeoutMs: BATCH_MATCH_PROVIDER_TIMEOUT_MS
        })
    searchCache.set(key, request)
    // 只合并同一时刻发出的相同查询（500 首里大量同专辑回退）；请求结束
    // 立即释放，后续歌曲仍能重新搜索。
    const release = (): void => {
      if (searchCache.get(key) === request) searchCache.delete(key)
    }
    void request.then(release, release)
    return request
  }
  try {
    await syncPluginProviders()
    if (run !== batchMatchRun) return
    await forEachWithConcurrency(
      tracks,
      BATCH_MATCH_CONCURRENCY,
      async (track, index) => {
        if (run !== batchMatchRun) return
        batchMatchProgress.label = trackFileName(track)
        const base: Omit<BatchMatchTrackResult, 'status'> = {
          trackId: track.id,
          filePath: track.filePath,
          fileName: trackFileName(track),
          title: track.title,
          artist: track.artist,
          candidates: []
        }
        try {
          const searchQueries = buildMetadataSearchQueries(track)
          if (searchQueries.length === 0) throw new Error('缺少可搜索的标题')
          let candidates: MetadataMatchCandidate[] = []
          for (const searchQuery of searchQueries) {
            // 已经找到可自动应用的候选就不再消耗回退查询。
            if (candidates.some(shouldAutoApplyMatch)) break
            const search = await searchBatchQuery(searchQuery)
            if (controller.signal.aborted || run !== batchMatchRun) return
            candidates = mergeMetadataMatchCandidates(
              candidates,
              buildMetadataMatchCandidates(
                track,
                search.items.map((item) => item.track)
              )
            )
          }
          if (candidates.length === 0 && searchQueries[0]) {
            const fallback = await searchBatchQuery(searchQueries[0], { itunesOnly: true })
            if (controller.signal.aborted || run !== batchMatchRun) return
            candidates = mergeMetadataMatchCandidates(
              candidates,
              buildMetadataMatchCandidates(
                track,
                fallback.items.map((item) => item.track)
              )
            )
          }
          if (candidates.length === 0) {
            slots[index] = { ...base, status: 'noMatch' }
            return
          }
          const top = candidates[0]
          slots[index] = shouldAutoApplyMatch(top)
            ? { ...base, status: 'pending', candidates, candidateLabel: top.sourceLabel }
            : { ...base, status: 'review', candidates }
        } catch (error) {
          if (controller.signal.aborted || run !== batchMatchRun) return
          slots[index] = {
            ...base,
            status: 'failed',
            message: error instanceof Error ? error.message : '在线匹配失败'
          }
        } finally {
          if (!controller.signal.aborted && run === batchMatchRun) {
            searched += 1
            batchMatchProgress.current = searched
          }
        }
      },
      controller.signal
    )
    if (run !== batchMatchRun) return

    // 搜索与封面/歌词补全分开：补全再慢也不会占住搜索线程。
    const automatic = slots.filter(
      (entry): entry is BatchMatchTrackResult => entry?.status === 'pending'
    )
    if (automatic.length > 0) {
      batchMatchProgress.current = 0
      batchMatchProgress.total = automatic.length
      batchMatchProgress.label = '补全封面与歌词'
      let enriched = 0
      await forEachWithConcurrency(
        automatic,
        BATCH_MATCH_CONCURRENCY,
        async (entry) => {
          if (run !== batchMatchRun) return
          batchMatchProgress.label = entry.fileName
          try {
            const patch = await buildPatchForMatch(entry.candidates[0], fields, controller.signal)
            if (controller.signal.aborted || run !== batchMatchRun) return
            if (hasMatchedTagPatch(patch)) {
              entry.patch = patch
            } else {
              entry.status = 'review'
              entry.message = '最高置信度结果没有可用的所选标签'
            }
          } catch (error) {
            if (controller.signal.aborted || run !== batchMatchRun) return
            entry.status = 'review'
            entry.message = error instanceof Error ? error.message : '无法补全封面或歌词'
          } finally {
            if (!controller.signal.aborted && run === batchMatchRun) {
              enriched += 1
              batchMatchProgress.current = enriched
            }
          }
        },
        controller.signal
      )
    }
    if (run !== batchMatchRun) return
    batchResults.value = slots.filter((entry): entry is BatchMatchTrackResult => Boolean(entry))
    batchMatchDone.value = true
    if (controller.signal.aborted) {
      batchMatchNotice.value = `匹配已停止，已完成 ${batchResults.value.length} / ${tracks.length} 首。`
      return
    }
    const pendingEntries = batchResults.value.filter((entry) => entry.status === 'pending')
    if (pendingEntries.length > 0) await writeBatchMatchEntries(pendingEntries)
    if (run !== batchMatchRun) return
    batchMatchNotice.value = batchSummaryText()
  } catch (error) {
    if (run === batchMatchRun) {
      batchMatchError.value = error instanceof Error ? error.message : '在线匹配失败'
      batchMatchDone.value = true
    }
  } finally {
    if (run === batchMatchRun) {
      batchMatching.value = false
      batchMatchAbort = null
    }
  }
}

function writeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

async function writeBatchMatchEntries(
  entries: BatchMatchTrackResult[],
  reviewed = false
): Promise<void> {
  if (entries.length === 0) return
  batchWriting.value = true
  busy.value = true
  cancelRequested.value = false
  progress.value = null
  results.value = []
  batchMatchError.value = ''
  const id = crypto.randomUUID()
  operationId.value = id
  try {
    const result = await window.api.library.writeTags({
      operationId: id,
      items: entries.map((entry) => ({ filePath: entry.filePath, ...(entry.patch ?? {}) }))
    })
    results.value = result.items
    const byPath = new Map(entries.map((entry) => [tagWritePathKey(entry.filePath), entry]))
    for (const item of result.items) {
      const entry = byPath.get(tagWritePathKey(item.filePath))
      if (!entry) continue
      if (item.status === 'success') {
        entry.status = 'applied'
        entry.message = undefined
        await syncBatchEntryLibrary(entry)
      } else {
        entry.status = reviewed ? 'review' : 'failed'
        entry.message = item.message ?? '写入失败'
      }
    }
    for (const entry of entries) {
      if (entry.status === 'pending') {
        entry.status = reviewed ? 'review' : 'failed'
        entry.message = '文件未写入'
      }
    }
    if (
      singleTrack.value &&
      entries.some((entry) => entry.trackId === singleTrack.value?.id && entry.status === 'applied')
    ) {
      await loadSelectedSnapshot({ preserveMatchState: true })
    }
  } catch (error) {
    const message = writeErrorMessage(error, '标签写入失败')
    for (const entry of entries) {
      entry.status = reviewed ? 'review' : 'failed'
      entry.message = message
    }
    batchMatchError.value = message
  } finally {
    batchWriting.value = false
    busy.value = false
    operationId.value = null
    progress.value = null
  }
}

async function syncBatchEntryLibrary(entry: BatchMatchTrackResult): Promise<void> {
  const patch = entry.patch
  if (!patch) return
  const { coverData, ...tagPatch } = patch
  musicStore.applyLocalTagWrite([entry.filePath], tagPatch)
  if (coverData) {
    const handle = await window.api.data.cacheCover(coverData).catch(() => null)
    musicStore.applyLocalCover([entry.filePath], handle)
  }
}

async function applyReviewedMatch(
  entry: BatchMatchTrackResult,
  candidate: MetadataMatchCandidate
): Promise<void> {
  if (busy.value || batchMatching.value) return
  const fields = selectedMatchFields.value
  if (fields.size === 0) {
    batchMatchError.value = '请至少选择一种标签类型'
    return
  }
  const key = candidateKey(candidate)
  applyingReviewKey.value = key
  batchMatchError.value = ''
  batchMatchNotice.value = ''
  try {
    const patch = await buildPatchForMatch(candidate, fields)
    if (!hasMatchedTagPatch(patch)) throw new Error('这条结果没有可用的所选标签')
    entry.patch = patch
    entry.candidateLabel = candidate.sourceLabel
    entry.message = undefined
    entry.status = 'pending'
    await writeBatchMatchEntries([entry], true)
    if (isAppliedMatch(entry)) {
      batchMatchNotice.value = `已写入《${entry.title || entry.fileName}》。`
    }
  } catch (error) {
    entry.status = 'review'
    entry.message = writeErrorMessage(error, '无法应用这条匹配')
    batchMatchNotice.value = batchSummaryText()
  } finally {
    if (applyingReviewKey.value === key) applyingReviewKey.value = ''
  }
}

async function writeSelected(): Promise<void> {
  const built = buildPatch()
  if (built.error) {
    formError.value = built.error
    return
  }
  const targets = selectedTracks.value
  if (targets.length === 0 || targets.length > MUSIC_TAG_WORKSHOP_MAX_ITEMS) return
  busy.value = true
  cancelRequested.value = false
  formError.value = ''
  notice.value = ''
  results.value = []
  progress.value = null
  const id = crypto.randomUUID()
  operationId.value = id
  try {
    const result = await window.api.library.writeTags({
      operationId: id,
      items: targets.map((track) => ({ filePath: track.filePath, ...built.patch }))
    })
    results.value = result.items
    const successful = successfulTagPaths(result.items)
    const currentPaths = new Set(targets.map((track) => tagWritePathKey(track.filePath)))
    const currentSuccessful = successful.filter((path) => currentPaths.has(tagWritePathKey(path)))
    if (currentSuccessful.length > 0) {
      musicStore.applyLocalTagWrite(currentSuccessful, built.patch)
      if (built.patch.coverData !== undefined) {
        const handle = built.patch.coverData
          ? await window.api.data.cacheCover(built.patch.coverData).catch(() => null)
          : null
        musicStore.applyLocalCover(currentSuccessful, handle)
        if (built.patch.coverData && !handle) {
          formError.value = '封面已写入文件，但曲库缩略图更新失败'
        }
      }
    }
    if (result.cancelled) {
      notice.value = `写入已取消，已完成 ${successful.length} 首。`
    } else if (successful.length === targets.length) {
      notice.value = `已写入 ${successful.length} 首歌曲。`
    }
    if (singleTrack.value && currentSuccessful.includes(singleTrack.value.filePath)) {
      await loadSelectedSnapshot()
    }
  } catch (error) {
    formError.value = writeErrorMessage(error, '标签写入失败')
  } finally {
    busy.value = false
    operationId.value = null
    progress.value = null
  }
}

async function cancelWrite(): Promise<void> {
  const id = operationId.value
  if (!id) return
  cancelRequested.value = true
  await window.api.library.cancelTagWrite(id)
}

async function restoreJournal(): Promise<void> {
  if (!restoreArmed.value) {
    restoreArmed.value = true
    return
  }
  restoring.value = true
  restoreArmed.value = false
  notice.value = ''
  try {
    const result = await window.api.library.restoreTags({ fromJournal: true })
    results.value = result.items
    const restored = successfulTagPaths(result.items)
    notice.value =
      restored.length > 0
        ? `已从恢复日志还原 ${restored.length} 首歌曲。`
        : '恢复日志中没有可还原的歌曲。'
    if (restored.length > 0) {
      try {
        await syncRestoredLibraryTags(restored)
      } catch {
        notice.value += ' 曲库显示未完全刷新，可重新扫描曲库。'
      }
    }
    if (singleTrack.value) await loadSelectedSnapshot()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '无法从恢复日志还原'
  } finally {
    restoring.value = false
  }
}

function changePage(delta: number): void {
  page.value = Math.min(pageCount.value, Math.max(1, page.value + delta))
}

function extensionOf(track: Track): string {
  const match = /\.([^.\\/]+)$/.exec(track.fileName || track.filePath)
  return match ? match[1].toLocaleUpperCase('en-US') : ''
}

function trackFileName(track: Track): string {
  const name = track.fileName?.trim()
  if (name) return name
  const normalized = track.filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function renameValuesForTrack(track: Track): FilenameTemplateValues {
  if (singleTrack.value?.id !== track.id) return filenameTemplateValuesFromTrack(track)
  return {
    title: fieldValues.title,
    artist: fieldValues.artist,
    album: fieldValues.album,
    albumArtist: fieldValues.albumArtist,
    genre: fieldValues.genre,
    year: fieldValues.year,
    track: fieldValues.track,
    disc: fieldValues.disc
  }
}

function useTagPatternPreset(template: string): void {
  tagPattern.value = template
  tagPatternError.value = ''
  tagPatternNotice.value = ''
}

function useRenamePreset(template: string): void {
  renameTemplate.value = template
  renameArmed.value = false
  renameError.value = ''
  renameNotice.value = ''
}

function applyTagsFromFilename(): void {
  const track = singleTrack.value
  if (!track || busy.value) return
  tagPatternError.value = ''
  tagPatternNotice.value = ''
  const parsed = parseFilenameTemplate(tagPattern.value, filenameStem(trackFileName(track)))
  if (!parsed) {
    tagPatternError.value = '文件名不符合当前识别模式'
    return
  }
  let applied = 0
  for (const key of [
    'title',
    'artist',
    'album',
    'albumArtist',
    'genre',
    'year',
    'track',
    'disc'
  ] as FilenameTemplateKey[]) {
    const value = parsed[key]
    if (!value) continue
    if (NUMERIC_FIELDS.has(key) && !/^\d{1,4}$/.test(value)) continue
    fieldValues[key] = value
    fieldIncluded[key] = true
    applied += 1
  }
  if (applied === 0) {
    tagPatternError.value = '当前模式没有解析出可填入的字段'
    return
  }
  tagPatternNotice.value = `已从文件名填入 ${applied} 个字段，确认后点击写入。`
  renameArmed.value = false
}

async function renameSelected(): Promise<void> {
  if (renaming.value || busy.value) return
  if (!renameTemplateValid.value) {
    renameError.value = '重命名模板至少需要包含一个字段占位符'
    return
  }
  if (renameDuplicateNames.value.size > 0) {
    renameError.value = `重命名结果有重复文件名：${[...renameDuplicateNames.value].join('、')}`
    return
  }
  const rows = renamePreview.value.filter((row) => row.changed)
  if (rows.length === 0) {
    renameNotice.value = '按当前模板没有需要改名的歌曲'
    return
  }
  if (!renameArmed.value) {
    renameArmed.value = true
    return
  }
  renameArmed.value = false
  renaming.value = true
  renameError.value = ''
  renameNotice.value = ''
  renameResults.value = []
  try {
    const result = await window.api.library.renameFiles({
      items: rows.map((row) => ({ filePath: row.track.filePath, fileName: row.fileName }))
    })
    renameResults.value = result.items
    let renamed = 0
    let failed = 0
    for (const item of result.items) {
      if (item.status !== 'success' || !item.newFilePath) {
        failed += 1
        continue
      }
      const updated = musicStore.applyLocalRename(item.filePath, item.newFilePath)
      if (!updated) {
        failed += 1
        continue
      }
      playerStore.applyLocalPathChange(item.filePath, item.newFilePath, updated.fileName)
      renamed += 1
    }
    renameNotice.value =
      failed > 0
        ? `已重命名 ${renamed} 首歌曲，失败 ${failed} 首。`
        : `已重命名 ${renamed} 首歌曲。`
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : '重命名失败'
  } finally {
    renaming.value = false
  }
}

async function checkDuplicates(): Promise<void> {
  if (selectedTracks.value.length === 0 || duplicateChecking.value || busy.value) return
  duplicateChecking.value = true
  duplicateError.value = ''
  duplicateChecked.value = false
  duplicateGroups.value = []
  const keys = new Set(selectedPathKeys.value)
  try {
    const result = await window.api.library.detectDuplicates()
    duplicateGroups.value = toDuplicateReviewGroups(result).filter((entry) =>
      entry.group.items.some((item) => keys.has(tagWritePathKey(item.filePath)))
    )
    duplicateSelectionSignature.value = [...keys].sort().join('|')
    duplicateChecked.value = true
  } catch (error) {
    duplicateError.value = error instanceof Error ? error.message : '重复歌曲检查失败'
  } finally {
    duplicateChecking.value = false
  }
}

function isPathSelected(filePath: string): boolean {
  return selectedPathKeys.value.has(tagWritePathKey(filePath))
}

function trackForPath(filePath: string): Track | null {
  const key = tagWritePathKey(filePath)
  return editableTracks.value.find((track) => tagWritePathKey(track.filePath) === key) ?? null
}

function addDuplicateToSelection(filePath: string): void {
  if (busy.value) return
  const track = trackForPath(filePath)
  if (!track || selectedIds.value.has(track.id)) return
  if (selectedIds.value.size >= MUSIC_TAG_WORKSHOP_MAX_ITEMS) {
    selectionError.value = `一次最多编辑 ${MUSIC_TAG_WORKSHOP_MAX_ITEMS} 首歌曲`
    return
  }
  const next = new Set(selectedIds.value)
  next.add(track.id)
  selectedIds.value = next
  selectionError.value = ''
}

function snapshotToPatch(tags: LocalLibraryTagSnapshot): LocalLibraryTagPatch {
  return {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    albumArtist: tags.albumArtist,
    track: tags.track,
    trackCount: tags.trackCount,
    disc: tags.disc,
    discCount: tags.discCount,
    year: tags.year,
    genre: tags.genre,
    composer: tags.composer,
    comment: tags.comment,
    lyrics: tags.lyrics
  }
}

async function syncRestoredLibraryTags(filePaths: readonly string[]): Promise<void> {
  const uniquePaths = [...new Set(filePaths)]
  const chunkSize = 100
  for (let offset = 0; offset < uniquePaths.length; offset += chunkSize) {
    const chunk = uniquePaths.slice(offset, offset + chunkSize)
    const read = await window.api.library.readTags({ filePaths: chunk, includeCover: true })
    const covers: Array<{ filePath: string; handle: string | null }> = []
    for (const item of read.items) {
      if (!item.tags) continue
      musicStore.applyLocalTagWrite([item.filePath], snapshotToPatch(item.tags))
      const handle = item.tags.coverData
        ? await window.api.data.cacheCover(item.tags.coverData).catch(() => null)
        : null
      covers.push({ filePath: item.filePath, handle })
    }
    for (const cover of covers) musicStore.applyLocalCover([cover.filePath], cover.handle)
  }
}

function bytesToDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

onMounted(() => {
  removeProgressListener = window.api.library.onTagWriteProgress((value) => {
    if (value.operationId === operationId.value) progress.value = value
  })
})
onBeforeUnmount(() => {
  removeProgressListener?.()
  removeProgressListener = undefined
})
</script>

<template>
  <section class="tag-workshop-page">
    <header class="tag-workshop-header">
      <div>
        <small>METADATA WORKSHOP</small>
        <h1>标签工作台</h1>
        <p>批量整理本地音乐的标签、封面与歌词，写入前先预览，随时可从恢复日志还原。</p>
      </div>
      <dl class="tag-workshop-stats">
        <div>
          <dt>可编辑歌曲</dt>
          <dd>{{ editableTracks.length.toLocaleString('zh-CN') }}</dd>
        </div>
        <div>
          <dt>已选择</dt>
          <dd>{{ selectedTracks.length.toLocaleString('zh-CN') }}</dd>
        </div>
      </dl>
    </header>

    <div class="tag-workshop-toolbar">
      <input
        v-model="query"
        type="search"
        aria-label="筛选歌曲"
        placeholder="筛选标题、艺术家、专辑或路径…"
      />
      <button type="button" @click="selectVisible">选择当前页</button>
      <button type="button" :disabled="selectedIds.size === 0" @click="clearSelection">
        清空选择
      </button>
      <span class="tag-workshop-toolbar-note">
        第 {{ page }} / {{ pageCount }} 页 · 当前筛选
        {{ filteredTracks.length.toLocaleString('zh-CN') }} 首
        <template v-if="hiddenCueCount > 0">
          · {{ hiddenCueCount }} 首 CUE 子曲目不可直接编辑</template
        >
      </span>
    </div>
    <p v-if="selectionError" class="tag-workshop-alert" role="alert">{{ selectionError }}</p>

    <div class="tag-workshop-layout">
      <section class="tag-workshop-library" aria-label="歌曲列表">
        <header>
          <div>
            <strong>本地曲库</strong>
            <small>每页 {{ PAGE_SIZE }} 首</small>
          </div>
          <div class="tag-workshop-pager">
            <button type="button" :disabled="page <= 1" @click="changePage(-1)">上一页</button>
            <button type="button" :disabled="page >= pageCount" @click="changePage(1)">
              下一页
            </button>
          </div>
        </header>
        <div v-if="visibleTracks.length === 0" class="tag-workshop-empty">
          {{ query ? '没有匹配的歌曲' : '本地曲库还没有歌曲' }}
        </div>
        <ul v-else class="tag-workshop-tracks">
          <li v-for="track in visibleTracks" :key="track.id">
            <label class="tag-workshop-track" :class="{ selected: selectedIds.has(track.id) }">
              <input
                type="checkbox"
                :checked="selectedIds.has(track.id)"
                :aria-label="`选择 ${track.title}`"
                @change="toggleTrack(track)"
              />
              <CoverImg
                class="tag-workshop-cover"
                :cover="track.cover"
                :cover-source="track.coverSource"
                :identity="track.id"
                :alt="`${track.title} 封面`"
              />
              <span class="tag-workshop-track-meta">
                <strong>{{ track.title }}</strong>
                <small>{{ track.artist }} · {{ track.album }}</small>
              </span>
              <span class="tag-workshop-format">{{ extensionOf(track) }}</span>
            </label>
            <button
              v-if="track.subTrack || track.cueRange"
              type="button"
              class="tag-workshop-unsupported"
              disabled
            >
              不可编辑
            </button>
          </li>
        </ul>
      </section>

      <section class="tag-workshop-editor" aria-label="标签编辑器">
        <div v-if="selectedTracks.length === 0" class="tag-workshop-empty large">
          <h2>选择要整理的歌曲</h2>
          <p>
            从左侧勾选歌曲后，可在同一处修改标签、封面与歌词。多选时只会写入你勾选“写入”的字段。
          </p>
        </div>
        <template v-else>
          <header class="tag-workshop-editor-header">
            <div>
              <h2>{{ selectionLabel }}</h2>
              <p v-if="selectedTracks.length > 1">
                多选模式下，字段默认保持不变；在字段右侧勾选“写入”即可统一修改或清空。
              </p>
              <p v-else-if="singleTrack" class="tag-workshop-path">{{ singleTrack.filePath }}</p>
            </div>
            <span v-if="reading" class="tag-workshop-reading" role="status">读取文件中…</span>
          </header>
          <p v-if="readError" class="tag-workshop-alert" role="alert">{{ readError }}</p>

          <section class="tag-workshop-match" aria-label="批量匹配标签">
            <header>
              <div>
                <strong>批量匹配标签</strong>
                <small>为所选歌曲自动查找最高置信度结果，置信度不足时才需要你确认</small>
              </div>
              <button
                type="button"
                :disabled="busy || (!batchMatching && matchFieldCount === 0)"
                @click="batchMatching ? cancelBatchMatch() : runBatchMatch()"
              >
                {{
                  batchWriting
                    ? '写入中…'
                    : batchMatching
                      ? '停止匹配'
                      : batchMatchDone
                        ? '重新匹配'
                        : `匹配 ${selectedTracks.length} 首歌曲`
                }}
              </button>
            </header>
            <div class="tag-workshop-match-fields" role="group" aria-label="要匹配的标签类型">
              <span class="tag-workshop-match-fields-label">匹配内容</span>
              <label v-for="field in TAG_MATCH_FIELD_DEFINITIONS" :key="field.key">
                <input
                  v-model="matchFieldIncluded[field.key]"
                  type="checkbox"
                  :disabled="batchMatching || busy"
                />
                {{ field.label }}
              </label>
            </div>
            <p v-if="batchMatching && !batchWriting" class="tag-workshop-hint" role="status">
              正在匹配 {{ batchMatchProgress.current }} / {{ batchMatchProgress.total }}
              <template v-if="batchMatchProgress.label">
                · {{ batchMatchProgress.label }}
              </template>
            </p>
            <p v-else-if="batchWriting" class="tag-workshop-hint" role="status">
              正在写入自动匹配结果{{ progress ? ` ${progress.current} / ${progress.total}` : '' }}…
            </p>
            <p v-if="batchMatchError" class="tag-workshop-alert" role="alert">
              {{ batchMatchError }}
            </p>
            <p v-if="batchMatchNotice" class="tag-workshop-notice" role="status">
              {{ batchMatchNotice }}
            </p>
            <p v-if="!batchMatching && !batchMatchDone" class="tag-workshop-hint">
              高置信度结果会直接写入所选标签；低置信度结果会列在下方供你挑选。
            </p>

            <section
              v-if="reviewEntries.length > 0"
              class="tag-workshop-match-review"
              aria-label="需要确认的匹配结果"
            >
              <header class="tag-workshop-match-review-head">
                <strong>需要确认 {{ reviewEntries.length }} 首</strong>
                <small>选择一条结果后会立即写入所选标签类型</small>
              </header>
              <article
                v-for="entry in reviewEntries"
                :key="entry.trackId"
                class="tag-workshop-match-review-item"
              >
                <header>
                  <div>
                    <strong>{{ entry.title || entry.fileName }}</strong>
                    <small>{{ entry.artist || '未知艺术家' }} · {{ entry.fileName }}</small>
                  </div>
                  <span v-if="entry.message" class="tag-workshop-match-review-message">
                    {{ entry.message }}
                  </span>
                </header>
                <ul v-if="entry.candidates.length > 0" class="tag-workshop-match-list">
                  <li v-for="candidate in entry.candidates" :key="candidateKey(candidate)">
                    <CoverImg
                      class="tag-workshop-match-cover"
                      :cover="candidate.track.cover"
                      :cover-source="candidate.track.coverSource"
                      :identity="candidate.track.id"
                      :alt="`${candidate.track.title} 匹配封面`"
                    />
                    <div class="tag-workshop-match-meta">
                      <strong>{{ candidate.track.title }}</strong>
                      <small>
                        {{ candidate.track.artist }} · {{ candidate.track.album || '未知专辑' }}
                        <template v-if="candidate.track.duration > 0">
                          · {{ formatDuration(candidate.track.duration) }}
                        </template>
                      </small>
                      <div class="tag-workshop-match-badges">
                        <span>{{ candidate.sourceLabel }}</span>
                        <span>
                          {{ candidate.confidence === 'high' ? '高置信' : '中置信' }}
                          {{ candidate.score }}
                        </span>
                        <span v-if="candidate.track.cover">封面</span>
                        <span v-if="candidate.track.lyrics">歌词</span>
                      </div>
                    </div>
                    <div class="tag-workshop-match-actions">
                      <button
                        type="button"
                        class="tag-workshop-match-all"
                        :disabled="busy || Boolean(applyingReviewKey)"
                        @click="applyReviewedMatch(entry, candidate)"
                      >
                        {{ applyingReviewKey === candidateKey(candidate) ? '应用中…' : '应用这条' }}
                      </button>
                    </div>
                  </li>
                </ul>
                <p v-else class="tag-workshop-hint">
                  没有搜索到可信结果，可调整标题或艺术家后重新匹配。
                </p>
              </article>
            </section>

            <details v-if="appliedEntries.length > 0" class="tag-workshop-match-details">
              <summary>已写入 {{ appliedEntries.length }} 首</summary>
              <ul>
                <li v-for="entry in appliedEntries" :key="entry.trackId">
                  <span>{{ entry.title || entry.fileName }}</span>
                  <small>{{ entry.candidateLabel }}</small>
                </li>
              </ul>
            </details>
            <details v-if="unmatchedEntries.length > 0" class="tag-workshop-match-details">
              <summary>{{ unmatchedEntries.length }} 首未找到匹配</summary>
              <ul>
                <li v-for="entry in unmatchedEntries" :key="entry.trackId">
                  <span>{{ entry.title || entry.fileName }}</span>
                  <small>{{ entry.fileName }}</small>
                </li>
              </ul>
            </details>
            <details v-if="failedMatchEntries.length > 0" class="tag-workshop-match-details">
              <summary>{{ failedMatchEntries.length }} 首匹配或写入失败</summary>
              <ul>
                <li v-for="entry in failedMatchEntries" :key="entry.trackId">
                  <span>{{ entry.title || entry.fileName }}</span>
                  <small>{{ entry.message }}</small>
                </li>
              </ul>
            </details>
          </section>

          <section
            v-if="singleTrack"
            class="tag-workshop-filename-tool"
            aria-label="从文件名识别标签"
          >
            <header>
              <div>
                <strong>从文件名识别标签</strong>
                <small>用占位符描述文件名结构，再把识别结果填入编辑器</small>
              </div>
              <button type="button" :disabled="busy" @click="applyTagsFromFilename">
                从文件名填入
              </button>
            </header>
            <div class="tag-workshop-filename-controls">
              <input
                v-model="tagPattern"
                type="text"
                aria-label="文件名识别模式"
                placeholder="{artist} - {title}"
                :disabled="busy"
              />
            </div>
            <div class="tag-workshop-preset-row">
              <button
                v-for="preset in TAG_WORKSHOP_FILENAME_PRESETS"
                :key="preset.template"
                type="button"
                :disabled="busy"
                @click="useTagPatternPreset(preset.template)"
              >
                {{ preset.label }}
              </button>
              <span class="tag-workshop-token-hint">{{ TAG_TOKEN_HINT }}</span>
            </div>
            <p v-if="tagPatternError" class="tag-workshop-alert" role="alert">
              {{ tagPatternError }}
            </p>
            <p v-else-if="tagPatternNotice" class="tag-workshop-notice" role="status">
              {{ tagPatternNotice }}
            </p>
            <p class="tag-workshop-hint">当前文件名：{{ trackFileName(singleTrack) }}</p>
          </section>

          <div class="tag-workshop-fields">
            <div
              v-for="field in FIELD_DEFINITIONS"
              :key="field.key"
              class="tag-workshop-field"
              :class="{ 'is-textarea': field.type === 'textarea' }"
            >
              <label :for="`tag-field-${field.key}`">{{ field.label }}</label>
              <div class="tag-workshop-field-input">
                <textarea
                  v-if="field.type === 'textarea'"
                  :id="`tag-field-${field.key}`"
                  v-model="fieldValues[field.key]"
                  rows="4"
                  :placeholder="field.placeholder"
                  :disabled="busy"
                  @input="onFieldInput(field.key)"
                />
                <input
                  v-else
                  :id="`tag-field-${field.key}`"
                  v-model="fieldValues[field.key]"
                  :type="field.type"
                  :inputmode="field.type === 'number' ? 'numeric' : undefined"
                  :placeholder="field.placeholder"
                  :disabled="busy"
                  @input="onFieldInput(field.key)"
                />
                <label class="tag-workshop-include">
                  <input
                    v-model="fieldIncluded[field.key]"
                    type="checkbox"
                    :disabled="busy"
                    @change="formError = ''"
                  />
                  写入
                </label>
              </div>
            </div>
          </div>

          <section class="tag-workshop-cover-editor" aria-label="封面">
            <div class="tag-workshop-cover-preview">
              <img v-if="coverPreview" :src="coverPreview" alt="待写入的封面预览" />
              <span v-else>无封面预览</span>
            </div>
            <div>
              <strong>封面</strong>
              <p>支持 PNG / JPEG，最大 8 MiB；写入时会自动识别格式。</p>
              <div class="tag-workshop-cover-actions">
                <label class="tag-workshop-file-button">
                  选择图片
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    :disabled="busy"
                    @change="onCoverInput"
                  />
                </label>
                <button type="button" :disabled="busy" @click="removeCover">移除封面</button>
                <button
                  v-if="coverDirty"
                  type="button"
                  :disabled="busy"
                  @click="discardCoverDraft"
                >
                  撤销封面修改
                </button>
              </div>
              <p v-if="coverError" class="tag-workshop-alert" role="alert">{{ coverError }}</p>
            </div>
          </section>

          <section class="tag-workshop-rename" aria-label="按标签重命名文件">
            <header>
              <div>
                <strong>按标签重命名文件</strong>
                <small>扩展名保持不变，同名歌词、翻译等附属文件会一起移动</small>
              </div>
              <button type="button" :disabled="renameBlocked" @click="renameSelected">
                {{
                  renameArmed
                    ? `再次点击确认重命名 ${renameChangedRows.length} 个文件`
                    : `重命名 ${renameChangedRows.length} 个文件`
                }}
              </button>
            </header>
            <div class="tag-workshop-filename-controls">
              <input
                v-model="renameTemplate"
                type="text"
                aria-label="重命名模板"
                placeholder="{artist} - {title}"
                :disabled="busy || renaming"
              />
            </div>
            <div class="tag-workshop-preset-row">
              <button
                v-for="preset in TAG_WORKSHOP_FILENAME_PRESETS"
                :key="preset.template"
                type="button"
                :disabled="busy || renaming"
                @click="useRenamePreset(preset.template)"
              >
                {{ preset.label }}
              </button>
              <span class="tag-workshop-token-hint">{{ TAG_TOKEN_HINT }}</span>
            </div>
            <p v-if="!renameTemplateValid" class="tag-workshop-alert" role="alert">
              重命名模板至少需要包含一个字段占位符
            </p>
            <p v-else-if="renameDuplicateNames.size > 0" class="tag-workshop-alert" role="alert">
              重命名结果有重复文件名：{{ [...renameDuplicateNames].join('、') }}
            </p>
            <p v-else-if="renameError" class="tag-workshop-alert" role="alert">{{ renameError }}</p>
            <p v-else-if="renameNotice" class="tag-workshop-notice" role="status">
              {{ renameNotice }}
            </p>
            <p v-if="renameArmed" class="tag-workshop-notice" role="status">
              将重命名 {{ renameChangedRows.length }} 个文件，再次点击按钮确认。
            </p>
            <ul v-if="renameChangedRows.length > 0" class="tag-workshop-rename-preview">
              <li
                v-for="row in renameChangedRows"
                :key="row.track.id"
                :class="{ 'is-duplicate': renameDuplicateNames.has(row.fileName) }"
              >
                <span class="tag-workshop-rename-old">{{ row.currentName }}</span>
                <span class="tag-workshop-rename-arrow" aria-hidden="true">→</span>
                <strong>{{ row.fileName }}</strong>
              </li>
            </ul>
            <p v-else class="tag-workshop-hint">按当前模板没有需要改名的歌曲。</p>
            <ul v-if="renameResults.length > 0" class="tag-workshop-rename-results">
              <li v-for="item in renameResults" :key="item.filePath">
                <span>{{ item.filePath }}</span>
                <strong :class="{ 'is-success': item.status === 'success' }">
                  {{ item.status === 'success' ? '已重命名' : (item.message ?? item.status) }}
                </strong>
              </li>
            </ul>
          </section>

          <section class="tag-workshop-duplicates" aria-label="重复歌曲检查">
            <header>
              <div>
                <strong>重复歌曲检查</strong>
                <small>检查所选歌曲是否与其他本地文件重复，重复项可直接加入当前选择</small>
              </div>
              <button type="button" :disabled="duplicateChecking || busy" @click="checkDuplicates">
                {{ duplicateChecking ? '检查中…' : duplicateChecked ? '重新检查' : '检查所选歌曲' }}
              </button>
            </header>
            <p v-if="duplicateError" class="tag-workshop-alert" role="alert">
              {{ duplicateError }}
            </p>
            <p v-else-if="duplicateStale" class="tag-workshop-notice" role="status">
              所选歌曲已变化，可重新检查。
            </p>
            <p
              v-else-if="duplicateChecked && duplicateGroups.length === 0"
              class="tag-workshop-notice"
              role="status"
            >
              未发现与所选歌曲重复的文件。
            </p>
            <ul v-else-if="duplicateGroups.length > 0" class="tag-workshop-duplicate-list">
              <li v-for="entry in duplicateGroups" :key="entry.group.key">
                <header>
                  <strong>{{ entry.label }}</strong>
                  <small>{{ entry.group.items.length }} 个文件</small>
                </header>
                <ul>
                  <li v-for="item in entry.group.items" :key="item.id">
                    <div class="tag-workshop-duplicate-meta">
                      <strong>{{ item.title || '未知标题' }}</strong>
                      <small
                        >{{ item.artist || '未知艺术家' }} · {{ item.album || '未知专辑' }}</small
                      >
                      <small class="tag-workshop-duplicate-path">{{ item.filePath }}</small>
                    </div>
                    <span v-if="isPathSelected(item.filePath)" class="tag-workshop-duplicate-state">
                      已选择
                    </span>
                    <button
                      v-else-if="trackForPath(item.filePath)"
                      type="button"
                      :disabled="busy"
                      @click="addDuplicateToSelection(item.filePath)"
                    >
                      加入选择
                    </button>
                    <span v-else class="tag-workshop-duplicate-state">不在可编辑曲库</span>
                  </li>
                </ul>
              </li>
            </ul>
          </section>

          <section class="tag-workshop-preview" aria-label="写入预览">
            <div class="tag-workshop-preview-header">
              <strong>写入预览</strong>
              <small v-if="selectedTracks.length > 0">
                将应用到 {{ selectedTracks.length.toLocaleString('zh-CN') }} 个文件
              </small>
            </div>
            <p v-if="patchPreview.length === 0" class="tag-workshop-hint">
              勾选字段的“写入”后，这里会显示变更内容。
            </p>
            <ul v-else class="tag-workshop-preview-list">
              <li v-for="row in patchPreview" :key="row.label">
                <span>{{ row.label }}</span>
                <strong>{{ row.value }}</strong>
              </li>
            </ul>
            <p v-if="formError" class="tag-workshop-alert" role="alert">{{ formError }}</p>
            <p v-if="notice" class="tag-workshop-notice" role="status">{{ notice }}</p>

            <div v-if="busy" class="tag-workshop-progress" role="status">
              <div class="tag-workshop-progress-head">
                <span :title="progress?.filePath">
                  {{
                    progress
                      ? `正在写入 ${progress.current} / ${progress.total}${progressFileName ? ` · ${progressFileName}` : ''}`
                      : '准备写入…'
                  }}
                </span>
                <span>{{ progressPercent }}%</span>
              </div>
              <div class="tag-workshop-progress-bar">
                <span :style="{ width: `${progressPercent}%` }" />
              </div>
              <button type="button" :disabled="cancelRequested" @click="cancelWrite">
                {{ cancelRequested ? '正在取消…' : '取消写入' }}
              </button>
            </div>
            <div v-else class="tag-workshop-write-actions">
              <button
                type="button"
                class="tag-workshop-primary"
                :disabled="!canWrite"
                @click="writeSelected"
              >
                写入 {{ selectedTracks.length }} 首歌曲
              </button>
              <button type="button" :disabled="restoring" @click="restoreJournal">
                {{ restoreArmed ? '再次点击确认还原' : '从恢复日志还原到写入前' }}
              </button>
            </div>
            <p class="tag-workshop-hint">
              还原会把最近一次批量写入涉及的文件恢复为写入前备份，并同步刷新曲库中的标签与封面。
            </p>
          </section>

          <section v-if="results.length > 0" class="tag-workshop-results" aria-label="写入结果">
            <header>
              <strong>最近一次结果</strong>
              <small>
                成功 {{ resultSummary.successCount }} · 失败 {{ resultSummary.failedCount }} · 回滚
                {{ resultSummary.rolledBackCount }} · 未处理 {{ resultSummary.notAttemptedCount }}
              </small>
            </header>
            <ul>
              <li v-for="item in failedResults" :key="tagWritePathKey(item.filePath)">
                <span>{{ item.filePath }}</span>
                <strong>{{ item.message ?? item.status }}</strong>
              </li>
            </ul>
            <p v-if="failedResults.length === 0" class="tag-workshop-hint">所有文件均写入成功。</p>
          </section>
        </template>
      </section>
    </div>
  </section>
</template>

<style src="./TagWorkshopPage.css"></style>
