export interface LocalLibraryTagPatch {
  title?: string | null
  artist?: string | null
  album?: string | null
  albumArtist?: string | null
  track?: number | null
  trackCount?: number | null
  disc?: number | null
  discCount?: number | null
  year?: number | null
  genre?: string | null
  composer?: string | null
  comment?: string | null
  lyrics?: string | null
  coverData?: Uint8Array | null
}

export interface LocalLibraryTagWriteItem extends LocalLibraryTagPatch {
  filePath: string
}

export interface LocalLibraryTagWriteRequest {
  items: LocalLibraryTagWriteItem[]
  operationId?: string
}

export interface LocalLibraryTagRestoreRequest {
  filePaths?: string[]
  fromJournal?: boolean
}

export interface LocalLibraryTagFailure {
  filePath: string
  message: string
}

export type LocalLibraryTagOperationStatus = 'success' | 'failed' | 'rolledBack' | 'notAttempted'

export interface LocalLibraryTagOperationResult {
  filePath: string
  status: LocalLibraryTagOperationStatus
  message?: string
}

export interface LocalLibraryTagWriteResult {
  items: LocalLibraryTagOperationResult[]
  operationId?: string
  cancelled?: boolean
}

export interface LocalLibraryTagRestoreResult {
  items: LocalLibraryTagOperationResult[]
}

export interface LocalLibraryTagReadRequest {
  filePaths: string[]
  includeCover?: boolean
}

export interface LocalLibraryTagSnapshot {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  track: number | null
  trackCount: number | null
  disc: number | null
  discCount: number | null
  year: number | null
  genre: string | null
  composer: string | null
  comment: string | null
  lyrics: string | null
  hasCover: boolean
  coverMimeType: string | null
  coverData?: Uint8Array
}

export interface LocalLibraryTagReadItem {
  filePath: string
  tags?: LocalLibraryTagSnapshot
  message?: string
}

export interface LocalLibraryTagReadResult {
  items: LocalLibraryTagReadItem[]
}

export interface LocalLibraryTagWriteProgress {
  operationId: string
  current: number
  total: number
  filePath: string
}

export interface LocalLibraryTagCancelRequest {
  operationId: string
}
