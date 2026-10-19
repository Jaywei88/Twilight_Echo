import assert from 'node:assert/strict'
import test from 'node:test'
import type { MetadataMatchCandidate } from './musicMetadataMatching.ts'
import {
  buildMatchedTagPatch,
  DEFAULT_TAG_MATCH_FIELDS,
  hasMatchedTagPatch,
  shouldAutoApplyMatch,
  type TagMatchField
} from './tagWorkshopBatchMatch.ts'

function candidate(overrides: Partial<MetadataMatchCandidate['track']> = {}): MetadataMatchCandidate {
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
