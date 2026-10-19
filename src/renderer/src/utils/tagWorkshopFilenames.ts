import type { Track } from '../types/music'

export type FilenameTemplateKey =
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'genre'
  | 'year'
  | 'track'
  | 'disc'

export type FilenameTemplateValues = Partial<Record<FilenameTemplateKey, string | number | null>>

export const TAG_WORKSHOP_FILENAME_PRESETS: Array<{ label: string; template: string }> = [
  { label: '艺术家 - 标题', template: '{artist} - {title}' },
  { label: '音轨号 - 艺术家 - 标题', template: '{track:02} - {artist} - {title}' },
  { label: '艺术家 - 专辑 - 音轨号 - 标题', template: '{artist} - {album} - {track:02} - {title}' },
  { label: '标题', template: '{title}' }
]

const TOKEN_PATTERN = /\{(title|artist|album|albumArtist|genre|year|track|disc)(?::(\d{1,2}))?\}/g
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const MAX_FILENAME_STEM_LENGTH = 150
const AUDIO_EXTENSION = /\.[a-z0-9]{1,8}$/i

export function renderFilenameTemplate(
  template: string,
  values: FilenameTemplateValues,
  extension: string
): string {
  const stem = template.replace(TOKEN_PATTERN, (_match, key: FilenameTemplateKey, padding?: string) =>
    formatTemplateValue(key, values[key], padding)
  )
  return `${sanitizeFilenameStem(stem) || '未命名'}${normalizeExtension(extension)}`
}

export function parseFilenameTemplate(
  pattern: string,
  stem: string
): Partial<Record<FilenameTemplateKey, string>> | null {
  const matches = [...pattern.matchAll(TOKEN_PATTERN)]
  if (matches.length === 0) return null
  let expression = '^'
  let cursor = 0
  const groups: FilenameTemplateKey[] = []
  for (const match of matches) {
    const literal = pattern.slice(cursor, match.index)
    expression += escapeRegExp(literal).replace(/ +/g, '\\s+')
    groups.push(match[1] as FilenameTemplateKey)
    expression += captureForToken(match[1] as FilenameTemplateKey)
    cursor = (match.index ?? 0) + match[0].length
  }
  expression += escapeRegExp(pattern.slice(cursor)).replace(/ +/g, '\\s+')
  expression += '$'
  let matched: RegExpExecArray | null
  try {
    matched = new RegExp(expression, 'i').exec(stem.trim())
  } catch {
    return null
  }
  if (!matched) return null
  const result: Partial<Record<FilenameTemplateKey, string>> = {}
  for (const [index, key] of groups.entries()) {
    const value = (matched[index + 1] ?? '').trim()
    if (value && result[key] === undefined) result[key] = value
  }
  return result
}

export function filenameTemplateValuesFromTrack(
  track: Track
): FilenameTemplateValues {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    genre: track.genre,
    year: track.releaseDate ? Number(track.releaseDate.slice(0, 4)) || null : null,
    track: track.trackNumber,
    disc: track.discNumber
  }
}

export function guessFilenamePattern(stem: string): string | null {
  const candidates = [
    '{track:02} - {artist} - {title}',
    '{artist} - {album} - {track:02} - {title}',
    '{artist} - {title}'
  ]
  for (const template of candidates) {
    if (parseFilenameTemplate(template, stem)) return template
  }
  return null
}

export function filenameTemplateHasTokens(template: string): boolean {
  return new RegExp(TOKEN_PATTERN.source).test(template)
}

export function filenameStem(fileName: string): string {
  return fileName.replace(AUDIO_EXTENSION, '')
}

export function filenameExtension(fileName: string): string {
  return AUDIO_EXTENSION.exec(fileName)?.[0] ?? ''
}

function formatTemplateValue(
  key: FilenameTemplateKey,
  value: string | number | null | undefined,
  padding: string | undefined
): string {
  if (value === null || value === undefined) return ''
  let text = String(value).trim()
  if (!text) return ''
  if (key === 'artist' || key === 'albumArtist') {
    text = text.replace(/\s*[/、;]\s*/g, ', ')
  }
  if (key === 'track' || key === 'disc' || key === 'year') {
    if (/^\d+$/.test(text) && padding) text = text.padStart(Math.min(4, Number(padding)), '0')
  }
  return sanitizeSegment(text)
}

function sanitizeSegment(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVALID_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeFilenameStem(value: string): string {
  let stem = sanitizeSegment(value)
    .replace(/^[-_.\s]+|[-_.\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (stem.length > MAX_FILENAME_STEM_LENGTH) stem = stem.slice(0, MAX_FILENAME_STEM_LENGTH).trim()
  stem = stem.replace(/[. ]+$/g, '')
  if (RESERVED_FILENAME.test(stem)) stem = `_${stem}`
  return stem
}

function normalizeExtension(extension: string): string {
  const value = extension.trim()
  if (!value) return ''
  return value.startsWith('.') ? value : `.${value}`
}

function captureForToken(key: FilenameTemplateKey): string {
  if (key === 'year') return '(\\d{4})'
  if (key === 'track' || key === 'disc') return '(\\d{1,4})'
  return '(.+?)'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
