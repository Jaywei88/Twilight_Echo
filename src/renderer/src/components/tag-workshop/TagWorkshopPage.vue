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
  type MetadataMatchCandidate
} from '@renderer/utils/musicMetadataMatching'
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
const singleTrack = computed(() => (selectedTracks.value.length === 1 ? selectedTracks.value[0] : null))
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

const matchQuery = ref('')
const matching = ref(false)
const matchSearched = ref(false)
const matchError = ref('')
const matchNotice = ref('')
const matchCandidates = shallowRef<MetadataMatchCandidate[]>([])
const applyingCoverKey = ref('')
const applyingLyricsKey = ref('')
let matchRequest = 0
let matchAbort: AbortController | null = null

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
  resetMatch()
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

function resetMatch(): void {
  matchAbort?.abort()
  matchAbort = null
  matchRequest += 1
  matching.value = false
  matchSearched.value = false
  matchError.value = ''
  matchNotice.value = ''
  matchCandidates.value = []
  applyingCoverKey.value = ''
  applyingLyricsKey.value = ''
  matchQuery.value = ''
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
    tags.coverData && tags.coverMimeType
      ? bytesToDataUrl(tags.coverData, tags.coverMimeType)
      : null
}

async function loadSelectedSnapshot(): Promise<void> {
  const track = singleTrack.value
  resetEditor()
  resetDuplicates()
  if (!track) return
  matchQuery.value = [track.title, track.artist].filter(Boolean).join(' ')
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

function candidateKey(candidate: MetadataMatchCandidate): string {
  return `${candidate.providerId}:${candidate.track.id}`
}

async function searchOnlineMatches(): Promise<void> {
  const track = singleTrack.value
  if (!track || busy.value || matching.value) return
  const keyword = matchQuery.value.trim() || [track.title, track.artist].filter(Boolean).join(' ')
  if (!keyword) return
  matchAbort?.abort()
  const controller = new AbortController()
  matchAbort = controller
  const request = ++matchRequest
  matching.value = true
  matchError.value = ''
  matchNotice.value = ''
  matchSearched.value = false
  matchCandidates.value = []
  try {
    await syncPluginProviders()
    const result = await mediaProviders.searchAllSongs({
      query: keyword,
      localTracks: [],
      limit: 40,
      offset: 0,
      signal: controller.signal
    })
    if (request !== matchRequest) return
    const candidates = buildMetadataMatchCandidates(
      track,
      result.items.map((item) => item.track)
    )
    matchCandidates.value = candidates.slice(0, 30)
    matchSearched.value = true
    if (candidates.length === 0) matchNotice.value = '没有找到标题与艺术家都可信的在线匹配'
  } catch (error) {
    if (request !== matchRequest || controller.signal.aborted) return
    matchError.value = error instanceof Error ? error.message : '在线匹配失败'
  } finally {
    if (request === matchRequest) {
      matching.value = false
      matchAbort = null
    }
  }
}

function applyCandidateMetadata(candidate: MetadataMatchCandidate): void {
  if (busy.value) return
  const source = candidate.track
  let applied = 0
  const textFields: Array<[FieldKey, string | null | undefined]> = [
    ['title', source.title],
    ['artist', source.artist],
    ['album', source.album],
    ['albumArtist', source.albumArtist],
    ['genre', source.genre ?? undefined]
  ]
  for (const [key, value] of textFields) {
    const text = (value ?? '').trim()
    if (!text) continue
    fieldValues[key] = text
    fieldIncluded[key] = true
    applied += 1
  }
  const numericFields: Array<[FieldKey, number | undefined]> = [
    ['track', source.trackNumber],
    ['disc', source.discNumber]
  ]
  for (const [key, value] of numericFields) {
    if (!Number.isInteger(value) || !value || value <= 0) continue
    fieldValues[key] = String(value)
    fieldIncluded[key] = true
    applied += 1
  }
  const year = Number(source.releaseDate?.slice(0, 4) ?? '')
  if (Number.isInteger(year) && year > 0) {
    fieldValues.year = String(year)
    fieldIncluded.year = true
    applied += 1
  }
  renameArmed.value = false
  matchNotice.value =
    applied > 0
      ? `已从 ${candidate.sourceLabel} 填入 ${applied} 个字段，确认后点击写入。`
      : '这条匹配没有可用的元数据字段'
}

async function applyCandidateCover(candidate: MetadataMatchCandidate): Promise<void> {
  if (busy.value) return
  if (!candidate.track.cover) {
    matchError.value = '这条匹配没有可用的封面'
    return
  }
  const key = candidateKey(candidate)
  applyingCoverKey.value = key
  matchError.value = ''
  matchNotice.value = ''
  try {
    const cover = await window.api.data.readCoverBytes(
      candidate.track.cover ?? '',
      candidate.track.coverSource
    )
    if (!cover) throw new Error('无法获取这张封面，可能是不受支持的图片格式')
    coverDraft.value = cover.data
    coverDirty.value = true
    coverPreview.value = bytesToDataUrl(cover.data, cover.mimeType)
    coverError.value = ''
    matchNotice.value = `已使用 ${candidate.sourceLabel} 封面，确认后点击写入。`
  } catch (error) {
    matchError.value = error instanceof Error ? error.message : '无法获取在线封面'
  } finally {
    if (applyingCoverKey.value === key) applyingCoverKey.value = ''
  }
}

async function applyCandidateLyrics(candidate: MetadataMatchCandidate): Promise<void> {
  if (busy.value) return
  const key = candidateKey(candidate)
  applyingLyricsKey.value = key
  matchError.value = ''
  matchNotice.value = ''
  try {
    const lyrics = await mediaProviders.resolveLyrics(candidate.track, { timeoutMs: 12_000 })
    const text = lyrics.lyrics || lyrics.translatedLyrics || lyrics.wordLyrics || ''
    if (!text.trim()) throw new Error('音源没有返回可用歌词')
    fieldValues.lyrics = text
    fieldIncluded.lyrics = true
    matchNotice.value = `已获取 ${candidate.sourceLabel} 歌词，确认后点击写入。`
  } catch (error) {
    matchError.value = error instanceof Error ? error.message : '无法获取在线歌词'
  } finally {
    if (applyingLyricsKey.value === key) applyingLyricsKey.value = ''
  }
}

async function applyCandidateAll(candidate: MetadataMatchCandidate): Promise<void> {
  if (busy.value) return
  applyCandidateMetadata(candidate)
  const metadataNotice = matchNotice.value
  const tasks: Array<Promise<void>> = [applyCandidateLyrics(candidate)]
  if (candidate.track.cover) tasks.push(applyCandidateCover(candidate))
  await Promise.all(tasks)
  if (!matchError.value) {
    matchNotice.value = `已从 ${candidate.sourceLabel} 填入在线资料，确认后点击写入。`
  } else {
    matchNotice.value = metadataNotice
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
    formError.value = error instanceof Error ? error.message : '标签写入失败'
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
      restored.length > 0 ? `已从恢复日志还原 ${restored.length} 首歌曲。` : '恢复日志中没有可还原的歌曲。'
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
      failed > 0 ? `已重命名 ${renamed} 首歌曲，失败 ${failed} 首。` : `已重命名 ${renamed} 首歌曲。`
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
      <input v-model="query" type="search" aria-label="筛选歌曲" placeholder="筛选标题、艺术家、专辑或路径…" />
      <button type="button" @click="selectVisible">选择当前页</button>
      <button type="button" :disabled="selectedIds.size === 0" @click="clearSelection">清空选择</button>
      <span class="tag-workshop-toolbar-note">
        第 {{ page }} / {{ pageCount }} 页 · 当前筛选 {{ filteredTracks.length.toLocaleString('zh-CN') }} 首
        <template v-if="hiddenCueCount > 0"> · {{ hiddenCueCount }} 首 CUE 子曲目不可直接编辑</template>
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
            <button type="button" :disabled="page >= pageCount" @click="changePage(1)">下一页</button>
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
          <p>从左侧勾选歌曲后，可在同一处修改标签、封面与歌词。多选时只会写入你勾选“写入”的字段。</p>
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

          <section v-if="singleTrack" class="tag-workshop-match" aria-label="在线匹配">
            <header>
              <div>
                <strong>在线匹配</strong>
                <small>按标题与艺术家从已启用的音源查找元数据、封面与歌词</small>
              </div>
              <div class="tag-workshop-match-search">
                <input
                  v-model="matchQuery"
                  type="search"
                  aria-label="在线匹配关键词"
                  placeholder="标题 艺术家"
                  :disabled="matching || busy"
                  @keydown.enter.prevent="searchOnlineMatches"
                />
                <button type="button" :disabled="matching || busy" @click="searchOnlineMatches">
                  {{ matching ? '匹配中…' : '搜索' }}
                </button>
              </div>
            </header>
            <p v-if="matchError" class="tag-workshop-alert" role="alert">{{ matchError }}</p>
            <p v-else-if="matchNotice" class="tag-workshop-notice" role="status">
              {{ matchNotice }}
            </p>
            <p v-if="!matchSearched && !matching" class="tag-workshop-hint">
              搜索后可将候选的字段、封面和歌词填入下方编辑器，确认无误后再写入文件。
            </p>
            <ul v-if="matchCandidates.length > 0" class="tag-workshop-match-list">
              <li v-for="candidate in matchCandidates" :key="candidateKey(candidate)">
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
                    <span>{{ candidate.confidence === 'high' ? '高置信' : '中置信' }}</span>
                    <span v-if="candidate.fills.cover">封面</span>
                    <span v-if="candidate.fills.lyrics">歌词</span>
                    <span v-if="candidate.fills.metadata">补全元数据</span>
                  </div>
                </div>
                <div class="tag-workshop-match-actions">
                  <button type="button" :disabled="busy" @click="applyCandidateMetadata(candidate)">
                    填入字段
                  </button>
                  <button
                    type="button"
                    :disabled="busy || !candidate.track.cover || Boolean(applyingCoverKey)"
                    @click="applyCandidateCover(candidate)"
                  >
                    {{
                      applyingCoverKey === candidateKey(candidate) ? '获取中…' : '使用封面'
                    }}
                  </button>
                  <button
                    type="button"
                    :disabled="busy || Boolean(applyingLyricsKey)"
                    @click="applyCandidateLyrics(candidate)"
                  >
                    {{
                      applyingLyricsKey === candidateKey(candidate) ? '获取中…' : '使用歌词'
                    }}
                  </button>
                  <button
                    type="button"
                    class="tag-workshop-match-all"
                    :disabled="busy || Boolean(applyingCoverKey) || Boolean(applyingLyricsKey)"
                    @click="applyCandidateAll(candidate)"
                  >
                    全部填入
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="singleTrack" class="tag-workshop-filename-tool" aria-label="从文件名识别标签">
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
            <p v-if="tagPatternError" class="tag-workshop-alert" role="alert">{{ tagPatternError }}</p>
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
                  @click="
                    coverDirty = false;
                    coverDraft = undefined;
                    coverError = '';
                    coverPreview =
                      snapshot?.coverData && snapshot.coverMimeType
                        ? bytesToDataUrl(snapshot.coverData, snapshot.coverMimeType)
                        : null
                  "
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
              <button
                type="button"
                :disabled="renameBlocked"
                @click="renameSelected"
              >
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
            <p v-else-if="renameNotice" class="tag-workshop-notice" role="status">{{ renameNotice }}</p>
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
              <button
                type="button"
                :disabled="duplicateChecking || busy"
                @click="checkDuplicates"
              >
                {{
                  duplicateChecking
                    ? '检查中…'
                    : duplicateChecked
                      ? '重新检查'
                      : '检查所选歌曲'
                }}
              </button>
            </header>
            <p v-if="duplicateError" class="tag-workshop-alert" role="alert">{{ duplicateError }}</p>
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
                      <small>{{ item.artist || '未知艺术家' }} · {{ item.album || '未知专辑' }}</small>
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
