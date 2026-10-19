import type { LocalLibraryTagPatch } from '../../../shared/localLibraryTags.ts'
import type { MetadataMatchCandidate } from './musicMetadataMatching'

export type TagMatchField =
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'genre'
  | 'year'
  | 'track'
  | 'disc'
  | 'cover'
  | 'lyrics'

export const TAG_MATCH_FIELD_DEFINITIONS: ReadonlyArray<{
  key: TagMatchField
  label: string
}> = [
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺术家' },
  { key: 'album', label: '专辑' },
  { key: 'albumArtist', label: '专辑艺术家' },
  { key: 'genre', label: '流派' },
  { key: 'year', label: '年份' },
  { key: 'track', label: '曲目号' },
  { key: 'disc', label: '碟号' },
  { key: 'cover', label: '封面' },
  { key: 'lyrics', label: '歌词' }
]

export const DEFAULT_TAG_MATCH_FIELDS: ReadonlySet<TagMatchField> = new Set<TagMatchField>([
  'title',
  'artist',
  'album',
  'genre',
  'year',
  'cover',
  'lyrics'
])

// MusicTag 的自动匹配默认同时开 12 个搜索线程（AutoMatchTagsWebSearchThreadCount）。
export const BATCH_MATCH_CONCURRENCY = 12

export interface MatchedTagExtras {
  coverData?: Uint8Array | null
  lyrics?: string | null
}

export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length))
  let cursor = 0
  const run = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, run))
}

export function buildMatchedTagPatch(
  candidate: MetadataMatchCandidate,
  fields: ReadonlySet<TagMatchField>,
  extras: MatchedTagExtras = {}
): LocalLibraryTagPatch {
  const source = candidate.track
  const patch: LocalLibraryTagPatch = {}
  const text = (value: string | null | undefined): string | null => {
    const trimmed = (value ?? '').trim()
    return trimmed ? trimmed : null
  }
  if (fields.has('title')) {
    const value = text(source.title)
    if (value) patch.title = value
  }
  if (fields.has('artist')) {
    const value = text(source.artist)
    if (value) patch.artist = value
  }
  if (fields.has('album')) {
    const value = text(source.album)
    if (value) patch.album = value
  }
  if (fields.has('albumArtist')) {
    const value = text(source.albumArtist)
    if (value) patch.albumArtist = value
  }
  if (fields.has('genre')) {
    const value = text(source.genre)
    if (value) patch.genre = value
  }
  if (fields.has('year')) {
    const year = Number(source.releaseDate?.slice(0, 4))
    if (Number.isInteger(year) && year > 0) patch.year = year
  }
  if (fields.has('track') && isPositiveInteger(source.trackNumber)) {
    patch.track = source.trackNumber
  }
  if (fields.has('disc') && isPositiveInteger(source.discNumber)) {
    patch.disc = source.discNumber
  }
  if (fields.has('cover') && extras.coverData && extras.coverData.length > 0) {
    patch.coverData = extras.coverData
  }
  if (fields.has('lyrics')) {
    const value = text(extras.lyrics)
    if (value) patch.lyrics = value
  }
  return patch
}

export function hasMatchedTagPatch(patch: LocalLibraryTagPatch): boolean {
  return Object.keys(patch).length > 0
}

export const AUTO_APPLY_MIN_SCORE = 80

export function shouldAutoApplyMatch(candidate: MetadataMatchCandidate): boolean {
  return candidate.score >= AUTO_APPLY_MIN_SCORE
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
