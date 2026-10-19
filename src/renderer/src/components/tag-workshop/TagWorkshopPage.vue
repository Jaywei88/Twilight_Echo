<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import type { Track } from '@renderer/types/music'
import {
  hasTagPatch,
  successfulTagPaths,
  summarizeTagWriteResults,
  tagPatchFromWorkshopForm,
  tagWritePathKey,
  validateTagCoverFile
} from '@renderer/utils/localLibraryTagManagement.ts'
import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagPatch,
  LocalLibraryTagSnapshot,
  LocalLibraryTagWriteProgress
} from '../../../../shared/localLibraryTags.ts'
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

watch(query, () => {
  page.value = 1
})
watch(pageCount, () => {
  if (page.value > pageCount.value) page.value = pageCount.value
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
  readError.value = ''
  formError.value = ''
  results.value = []
  progress.value = null
  restoreArmed.value = false
}

function resetCover(): void {
  coverDraft.value = undefined
  coverDirty.value = false
  coverError.value = ''
  coverPreview.value = null
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
  if (!track) return
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
}

function onFieldInput(key: FieldKey): void {
  if (!fieldIncluded[key]) fieldIncluded[key] = true
  formError.value = ''
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
                <span>
                  {{ progress ? `正在写入 ${progress.current} / ${progress.total}` : '准备写入…' }}
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
                {{ restoreArmed ? '再次点击确认还原' : '从恢复日志还原' }}
              </button>
            </div>
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
