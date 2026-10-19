import assert from 'node:assert/strict'
import test from 'node:test'
import type { MetadataMatchCandidate } from './musicMetadataMatching.ts'
import {
  BATCH_MATCH_CONCURRENCY,
  buildMatchedTagPatch,
  DEFAULT_TAG_MATCH_FIELDS,
  forEachWithConcurrency,
  hasMatchedTagPatch,
  shouldAutoApplyMatch,
  type TagMatchField
} from './tagWorkshopBatchMatch.ts'

function candidate(
  overrides: Partial<MetadataMatchCandidate['track']> = {}
): MetadataMatchCandidate {
  return {
    confidence: 'high',
    score: 96,
    providerId: 'ncm',
    sourceLabel: 'ncm',
    fills: { cover: true, lyrics: true, translatedLyrics: false, metadata: true },
    track: {
      id: 'ncm:42',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Breakfast at Tiffany’s',
      albumArtist: 'Henry Mancini',
      releaseDate: '1961-10-05',
      genre: 'Jazz',
      trackNumber: 2,
      discNumber: 1,
      filePath: 'ncm:42',
      fileName: 'Moon River',
      duration: 181,
      size: 0,
      cover: 'https://cover.example/moon.jpg',
      lyrics: null,
      source: 'ncm',
      ...overrides
    }
  }
}

test('batch match patch writes only the selected tag types', () => {
  const fields = new Set<TagMatchField>(['title', 'artist', 'year'])
  assert.deepEqual(buildMatchedTagPatch(candidate(), fields), {
    title: 'Moon River',
    artist: 'Audrey',
    year: 1961
  })
})

test('batch match patch fills album, genre, track and disc on request', () => {
  const fields = new Set<TagMatchField>(['album', 'albumArtist', 'genre', 'track', 'disc'])
  assert.deepEqual(buildMatchedTagPatch(candidate(), fields), {
    album: 'Breakfast at Tiffany’s',
    albumArtist: 'Henry Mancini',
    genre: 'Jazz',
    track: 2,
    disc: 1
  })
})

test('batch match patch skips empty values and invalid numeric metadata', () => {
  const fields = new Set<TagMatchField>(['title', 'album', 'genre', 'year', 'track', 'disc'])
  const patch = buildMatchedTagPatch(
    candidate({
      title: '   ',
      album: '',
      genre: null,
      releaseDate: 'unknown',
      trackNumber: 0,
      discNumber: undefined
    }),
    fields
  )
  assert.deepEqual(patch, {})
  assert.equal(hasMatchedTagPatch(patch), false)
})

test('batch match patch includes cover bytes and lyrics only when provided', () => {
  const fields = new Set<TagMatchField>(['cover', 'lyrics'])
  assert.deepEqual(buildMatchedTagPatch(candidate(), fields), {})
  const coverData = new Uint8Array([1, 2, 3])
  assert.deepEqual(
    buildMatchedTagPatch(candidate(), fields, {
      coverData,
      lyrics: '  [00:00.00]Moon River  '
    }),
    { coverData, lyrics: '[00:00.00]Moon River' }
  )
})

test('high-confidence and strong medium matches apply without confirmation', () => {
  assert.equal(shouldAutoApplyMatch(candidate()), true)
  assert.equal(shouldAutoApplyMatch({ ...candidate(), confidence: 'medium', score: 81 }), true)
  assert.equal(shouldAutoApplyMatch({ ...candidate(), confidence: 'medium', score: 79 }), false)
})

test('default batch match selection covers common metadata, cover and lyrics', () => {
  for (const field of ['title', 'artist', 'album', 'genre', 'year', 'cover', 'lyrics'] as const) {
    assert.equal(DEFAULT_TAG_MATCH_FIELDS.has(field), true, field)
  }
  assert.equal(DEFAULT_TAG_MATCH_FIELDS.has('track'), false)
  assert.equal(DEFAULT_TAG_MATCH_FIELDS.has('disc'), false)
})

test('batch matching keeps the MusicTag-style twelve searches in flight', async () => {
  const tasks = Array.from({ length: 30 }, (_, index) => index)
  const started: number[] = []
  let active = 0
  let peak = 0
  await forEachWithConcurrency(tasks, BATCH_MATCH_CONCURRENCY, async (task) => {
    active += 1
    peak = Math.max(peak, active)
    started.push(task)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
  })
  assert.equal(BATCH_MATCH_CONCURRENCY, 12)
  assert.equal(peak, 12)
  assert.deepEqual(
    [...started].sort((left, right) => left - right),
    tasks
  )
})

test('bounded concurrency stops scheduling once the run is aborted', async () => {
  const controller = new AbortController()
  const started: number[] = []
  await forEachWithConcurrency(
    Array.from({ length: 30 }, (_, index) => index),
    4,
    async (task) => {
      started.push(task)
      if (task === 2) controller.abort()
      await Promise.resolve()
    },
    controller.signal
  )
  assert.equal(started.includes(29), false)
  assert.ok(started.length < 30)
})
