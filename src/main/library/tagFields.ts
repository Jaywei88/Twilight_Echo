import type { Tag } from 'node-taglib-sharp'
import type { LocalLibraryTagSnapshot } from '../../shared/localLibraryTags.ts'
import type { TagReadOptions, TagWriteInput } from './tagWriteService.ts'
import { loadTaglib } from './taglib.ts'

const MAX_TAG_READ_COVER_BYTES = 8 * 1024 * 1024

export function emptyTagSnapshot(): LocalLibraryTagSnapshot {
  return {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    track: null,
    trackCount: null,
    disc: null,
    discCount: null,
    year: null,
    genre: null,
    composer: null,
    comment: null,
    lyrics: null,
    hasCover: false,
    coverMimeType: null
  }
}

export function snapshotFromTag(
  tag: Tag,
  options: TagReadOptions = {}
): LocalLibraryTagSnapshot {
  const { PictureType } = loadTaglib()
  const pictures = tag.pictures
  const picture =
    pictures.find((candidate) => candidate.type === PictureType.FrontCover) ?? pictures[0]
  return {
    title: optionalText(tag.title),
    artist: optionalText(tag.performers[0]),
    album: optionalText(tag.album),
    albumArtist: optionalText(tag.albumArtists[0]),
    track: optionalPositiveNumber(tag.track),
    trackCount: optionalPositiveNumber(tag.trackCount),
    disc: optionalPositiveNumber(tag.disc),
    discCount: optionalPositiveNumber(tag.discCount),
    year: optionalPositiveNumber(tag.year),
    genre: optionalText(tag.genres[0]),
    composer: optionalText(tag.composers.join('; ')),
    comment: optionalText(tag.comment),
    lyrics: optionalText(tag.lyrics),
    hasCover: Boolean(picture),
    coverMimeType: picture?.mimeType ? picture.mimeType : null,
    ...(options.includeCover && picture && picture.data.length <= MAX_TAG_READ_COVER_BYTES
      ? { coverData: picture.data.toByteArray() }
      : {})
  }
}

export function applyTagInput(tag: Tag, input: TagWriteInput): void {
  const { ByteVector, Picture, PictureType } = loadTaglib()
  if (input.title !== undefined) tag.title = input.title ?? ''
  if (input.artist !== undefined) {
    tag.performers = input.artist ? [input.artist] : []
  }
  if (input.album !== undefined) tag.album = input.album ?? ''
  if (input.albumArtist !== undefined) {
    tag.albumArtists = input.albumArtist ? [input.albumArtist] : []
  }
  if (input.track !== undefined) tag.track = input.track ?? 0
  if (input.trackCount !== undefined) tag.trackCount = input.trackCount ?? 0
  if (input.disc !== undefined) tag.disc = input.disc ?? 0
  if (input.discCount !== undefined) tag.discCount = input.discCount ?? 0
  if (input.year !== undefined) tag.year = input.year ?? 0
  if (input.genre !== undefined) tag.genres = input.genre ? [input.genre] : []
  if (input.composer !== undefined) tag.composers = splitTagValues(input.composer)
  if (input.comment !== undefined) tag.comment = input.comment ?? ''
  if (input.lyrics !== undefined) tag.lyrics = input.lyrics ?? ''
  if (input.coverData === null) {
    tag.pictures = []
  } else if (input.coverData && input.coverMimeType) {
    tag.pictures = [
      Picture.fromFullData(
        ByteVector.fromByteArray(input.coverData),
        PictureType.FrontCover,
        input.coverMimeType,
        ''
      )
    ]
  }
}

function splitTagValues(value: string | null): string[] {
  if (!value) return []
  return value
    .split(/[;；\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function optionalText(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function optionalPositiveNumber(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
