import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filenameExtension,
  filenameStem,
  filenameTemplateHasTokens,
  filenameTemplateValuesFromTrack,
  guessFilenamePattern,
  parseFilenameTemplate,
  renderFilenameTemplate,
  TAG_WORKSHOP_FILENAME_PRESETS
} from './tagWorkshopFilenames.ts'
import type { Track } from '../types/music.ts'

const values = {
  title: 'Song: Title',
  artist: 'Artist / Guest',
  album: 'Album',
  albumArtist: 'Album Artist',
  genre: 'Pop',
  year: 2024,
  track: 3,
  disc: 1
}

test('renders template placeholders with padding and keeps the audio extension', () => {
  assert.equal(
    renderFilenameTemplate('{track:02} - {artist} - {title}', values, '.flac'),
    '03 - Artist, Guest - Song_ Title.flac'
  )
  assert.equal(renderFilenameTemplate('{year} {album}', values, 'mp3'), '2024 Album.mp3')
  assert.equal(renderFilenameTemplate('{disc:03}-{track:02}', values, '.wav'), '001-03.wav')
})

test('sanitizes invalid characters, reserved names, trailing dots, and empty results', () => {
  assert.equal(renderFilenameTemplate('{title}', { title: 'a<b>c:d"e/f\\g|h?i*j' }, '.mp3'), 'a_b_c_d_e_f_g_h_i_j.mp3')
  assert.equal(renderFilenameTemplate('{title}', { title: 'CON' }, '.mp3'), '_CON.mp3')
  assert.equal(renderFilenameTemplate('{title}.', { title: 'Name' }, '.mp3'), 'Name.mp3')
  assert.equal(renderFilenameTemplate('{title}', {}, '.mp3'), '未命名.mp3')
  assert.equal(renderFilenameTemplate('{title}', { title: 'x'.repeat(200) }, '.mp3').length, 154)
})

test('parses the supported filename patterns', () => {
  assert.deepEqual(parseFilenameTemplate('{artist} - {title}', 'Artist - Song'), {
    artist: 'Artist',
    title: 'Song'
  })
  assert.deepEqual(parseFilenameTemplate('{track:02} - {artist} - {title}', '03 - Artist - Song'), {
    track: '03',
    artist: 'Artist',
    title: 'Song'
  })
  assert.deepEqual(
    parseFilenameTemplate('{artist} - {album} - {track:02} - {title}', 'Artist - Album - 03 - Song'),
    { artist: 'Artist', album: 'Album', track: '03', title: 'Song' }
  )
  assert.equal(parseFilenameTemplate('{artist} - {title}', 'No separator'), null)
  assert.equal(parseFilenameTemplate('plain', 'plain'), null)
  assert.deepEqual(parseFilenameTemplate('{artist} - {title}', '  Artist   -   Song  '), {
    artist: 'Artist',
    title: 'Song'
  })
})

test('guesses the pattern from a filename stem', () => {
  assert.equal(guessFilenamePattern('03 - Artist - Song'), '{track:02} - {artist} - {title}')
  assert.equal(
    guessFilenamePattern('Artist - Album - 03 - Song'),
    '{artist} - {album} - {track:02} - {title}'
  )
  assert.equal(guessFilenamePattern('Artist - Song'), '{artist} - {title}')
  assert.equal(guessFilenamePattern('Song'), null)
  assert.equal(filenameTemplateHasTokens('{artist} - {title}'), true)
  assert.equal(filenameTemplateHasTokens('plain name'), false)
})

test('splits stems and extensions', () => {
  assert.equal(filenameStem('Artist - Song.flac'), 'Artist - Song')
  assert.equal(filenameStem('no extension'), 'no extension')
  assert.equal(filenameExtension('Artist - Song.flac'), '.flac')
  assert.equal(filenameExtension('no extension'), '')
})

test('builds template values from track metadata', () => {
  const track: Track = {
    id: 'track-1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Album Artist',
    genre: 'Pop',
    releaseDate: '2024-05-01',
    trackNumber: 3,
    discNumber: 2,
    filePath: 'F:\\music\\Artist - Song.flac',
    fileName: 'Artist - Song.flac',
    duration: 200,
    size: 1,
    cover: null,
    lyrics: null
  }
  assert.deepEqual(filenameTemplateValuesFromTrack(track), {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Album Artist',
    genre: 'Pop',
    year: 2024,
    track: 3,
    disc: 2
  })
})

test('every built-in preset renders a filename', () => {
  for (const preset of TAG_WORKSHOP_FILENAME_PRESETS) {
    const fileName = renderFilenameTemplate(preset.template, values, '.mp3')
    assert.match(fileName, /\.mp3$/)
    assert.ok(filenameStem(fileName).length > 0)
  }
})
