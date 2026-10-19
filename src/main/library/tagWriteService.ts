import { accessSync, constants, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { isDsdFilePath, probeDsdTagWrite, readDsdTags, writeDsdTags } from './dsdTags.ts'
import { applyTagInput, snapshotFromTag } from './tagFields.ts'
import { loadTaglib, type Taglib } from './taglib.ts'
import {
  loadJsonFileWithBackup,
  writeJsonFileAtomic,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'
import type { LocalLibraryTagSnapshot } from '../../shared/localLibraryTags.ts'

const TAG_WRITE_JOURNAL_FILE = 'tag-write-journal.json'
const TAG_WRITE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024
/** TagLib# has no extension mapping for these container aliases. */
const TAGLIB_MIME_OVERRIDES: Record<string, string> = {
  '.alac': 'audio/mp4',
  '.mqa': 'audio/flac'
}

export interface TagWriteInput {
  filePath: string
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
  coverMimeType?: 'image/jpeg' | 'image/png'
}

export interface TagReadOptions {
  includeCover?: boolean
}

export interface TagWriteResult {
  filePath: string
  backupPath: string
}

export type TagWriteJournalEntryStatus =
  | 'pending'
  | 'backedUp'
  | 'written'
  | 'rolledBack'
  | 'failed'

export interface TagWriteJournalEntry extends TagWriteResult {
  status: TagWriteJournalEntryStatus
  error?: string
}

export interface TagWriteJournal {
  version: 2
  state: 'writing' | 'completed' | 'rolledBack' | 'cancelled'
  entries: TagWriteJournalEntry[]
}

export interface TagWriteBatchOptions {
  shouldCancel?: () => boolean
  onProgress?: (progress: { current: number; total: number; filePath: string }) => void
}

export interface TagWriteBatchOutcome {
  entries: TagWriteJournalEntry[]
  cancelled: boolean
}

export class TagWriteBatchError extends Error {
  readonly journal: TagWriteJournal

  constructor(message: string, journal: TagWriteJournal, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TagWriteBatchError'
    this.journal = cloneJournal(journal)
  }
}

const TAG_WRITE_JOURNAL_OPTIONS: JsonFileOptions<TagWriteJournal> = {
  label: 'tag write journal',
  maxBytes: TAG_WRITE_JOURNAL_MAX_BYTES,
  validate: isTagWriteJournal
}

export function tagBackupPath(filePath: string, backupRoot: string): string {
  return join(backupRoot, `${Buffer.from(filePath).toString('base64url')}.bak`)
}

export function getTagWriteJournalPath(backupRoot: string): string {
  return join(backupRoot, TAG_WRITE_JOURNAL_FILE)
}

export function writeTagsWithBackup(input: TagWriteInput, backupRoot: string): TagWriteResult {
  mkdirSync(backupRoot, { recursive: true })
  const result = { filePath: input.filePath, backupPath: tagBackupPath(input.filePath, backupRoot) }
  copyFileSync(input.filePath, result.backupPath)
  try {
    writeTags(input)
    return result
  } catch (error) {
    copyFileSync(result.backupPath, input.filePath)
    throw error
  }
}

export function writeTagsBatchWithRollback(
  inputs: readonly TagWriteInput[],
  backupRoot: string
): TagWriteJournalEntry[] {
  const journal: TagWriteJournal = {
    version: 2,
    state: 'writing',
    entries: inputs.map((input) => ({
      filePath: input.filePath,
      backupPath: tagBackupPath(input.filePath, backupRoot),
      status: 'pending'
    }))
  }
  persistTagWriteJournal(backupRoot, journal)

  try {
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]
      const entry = journal.entries[index]
      try {
        copyFileSync(input.filePath, entry.backupPath)
      } catch (error) {
        entry.status = 'failed'
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'backedUp'
      persistTagWriteJournal(backupRoot, journal)

      try {
        writeTags(input)
      } catch (error) {
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'written'
      persistTagWriteJournal(backupRoot, journal)
    }
    journal.state = 'completed'
    persistTagWriteJournal(backupRoot, journal)
    return cloneJournal(journal).entries
  } catch (error) {
    rollbackJournalEntries(journal, backupRoot)
    journal.state = 'rolledBack'
    persistTagWriteJournal(backupRoot, journal)
    throw new TagWriteBatchError('Tag write batch failed', journal, error)
  }
}

export async function writeTagsBatchWithRollbackAsync(
  inputs: readonly TagWriteInput[],
  backupRoot: string,
  options: TagWriteBatchOptions = {}
): Promise<TagWriteBatchOutcome> {
  const journal: TagWriteJournal = {
    version: 2,
    state: 'writing',
    entries: inputs.map((input) => ({
      filePath: input.filePath,
      backupPath: tagBackupPath(input.filePath, backupRoot),
      status: 'pending'
    }))
  }
  persistTagWriteJournal(backupRoot, journal)

  try {
    for (let index = 0; index < inputs.length; index++) {
      if (options.shouldCancel?.()) {
        journal.state = 'cancelled'
        persistTagWriteJournal(backupRoot, journal)
        return { entries: cloneJournal(journal).entries, cancelled: true }
      }
      const input = inputs[index]
      const entry = journal.entries[index]
      try {
        copyFileSync(input.filePath, entry.backupPath)
      } catch (error) {
        entry.status = 'failed'
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'backedUp'
      persistTagWriteJournal(backupRoot, journal)

      try {
        writeTags(input)
      } catch (error) {
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'written'
      persistTagWriteJournal(backupRoot, journal)
      options.onProgress?.({ current: index + 1, total: inputs.length, filePath: input.filePath })
      await yieldToEventLoop()
    }
    journal.state = 'completed'
    persistTagWriteJournal(backupRoot, journal)
    return { entries: cloneJournal(journal).entries, cancelled: false }
  } catch (error) {
    rollbackJournalEntries(journal, backupRoot)
    journal.state = 'rolledBack'
    persistTagWriteJournal(backupRoot, journal)
    throw new TagWriteBatchError('Tag write batch failed', journal, error)
  }
}

export function readTagWriteJournal(backupRoot: string): TagWriteJournal {
  const loaded = loadJsonFileWithBackup(
    getTagWriteJournalPath(backupRoot),
    TAG_WRITE_JOURNAL_OPTIONS
  )
  if (loaded.status === 'missing') throw new Error('Tag write journal does not exist')
  return cloneJournal(loaded.value)
}

export function getTagWriteJournalRecoveryEntries(backupRoot: string): TagWriteJournalEntry[] {
  const journal = readTagWriteJournal(backupRoot)
  return journal.entries.filter(
    (entry) => entry.status === 'backedUp' || entry.status === 'written'
  )
}

export function restoreTagsFromBackup(filePath: string, backupRoot: string): void {
  const backupPath = tagBackupPath(filePath, backupRoot)
  if (!existsSync(backupPath)) throw new Error('Tag backup does not exist')
  mkdirSync(dirname(filePath), { recursive: true })
  copyFileSync(backupPath, filePath)
}

export function clearTagBackup(filePath: string, backupRoot: string): void {
  rmSync(tagBackupPath(filePath, backupRoot), { force: true })
}

export function readTagsFromFile(
  filePath: string,
  options: TagReadOptions = {}
): LocalLibraryTagSnapshot {
  if (isDsdFilePath(filePath)) return readDsdTags(filePath, options)
  const { File } = loadTaglib()
  let media: Taglib.File | undefined
  try {
    media = createMediaFile(File, filePath)
    return snapshotFromTag(media.tag, options)
  } finally {
    media?.dispose()
  }
}

/** Returns a user-facing reason when taglib cannot safely write the file, otherwise null. */
export function probeTagWrite(filePath: string): string | null {
  try {
    accessSync(filePath, constants.W_OK)
  } catch {
    return '文件不可写：只读、权限不足或文件不存在'
  }
  if (isDsdFilePath(filePath)) return probeDsdTagWrite(filePath)
  const { File } = loadTaglib()
  let media: Taglib.File | undefined
  try {
    media = createMediaFile(File, filePath)
    if (media.isPossiblyCorrupt) {
      const reasons = media.corruptionReasons.filter(Boolean).join('；')
      return reasons
        ? `无法安全写入：文件标签结构异常（${reasons}）`
        : '无法安全写入：文件标签结构异常'
    }
    return null
  } catch (error) {
    return `无法解析文件标签：${errorMessage(error)}`
  } finally {
    media?.dispose()
  }
}

function writeTags(input: TagWriteInput): void {
  if (isDsdFilePath(input.filePath)) {
    writeDsdTags(input)
    return
  }
  const { File } = loadTaglib()
  let media: Taglib.File | undefined
  try {
    media = createMediaFile(File, input.filePath)
    applyTagInput(media.tag, input)
    media.save()
  } finally {
    media?.dispose()
  }
}

function createMediaFile(File: typeof Taglib.File, filePath: string): Taglib.File {
  const mimeType = TAGLIB_MIME_OVERRIDES[extname(filePath).toLowerCase()]
  return mimeType ? File.createFromPath(filePath, mimeType) : File.createFromPath(filePath)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function rollbackJournalEntries(journal: TagWriteJournal, backupRoot: string): void {
  for (const entry of [...journal.entries].reverse()) {
    if (entry.status !== 'backedUp' && entry.status !== 'written') continue
    try {
      restoreTagsFromBackup(entry.filePath, backupRoot)
      entry.status = 'rolledBack'
    } catch (error) {
      entry.status = 'failed'
      entry.error = `Rollback failed: ${errorMessage(error)}`
    }
    persistTagWriteJournal(backupRoot, journal)
  }
}

function persistTagWriteJournal(backupRoot: string, journal: TagWriteJournal): void {
  const journalPath = getTagWriteJournalPath(backupRoot)
  const value = cloneJournal(journal)
  writeJsonFileAtomic(journalPath, JSON.stringify(value), TAG_WRITE_JOURNAL_OPTIONS, value)
}

function isTagWriteJournal(value: unknown): value is TagWriteJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    record.version !== 2 ||
    (record.state !== 'writing' &&
      record.state !== 'completed' &&
      record.state !== 'rolledBack' &&
      record.state !== 'cancelled') ||
    !Array.isArray(record.entries)
  ) {
    return false
  }
  return record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const candidate = entry as Record<string, unknown>
    return (
      typeof candidate.filePath === 'string' &&
      !!candidate.filePath &&
      typeof candidate.backupPath === 'string' &&
      !!candidate.backupPath &&
      (candidate.status === 'pending' ||
        candidate.status === 'backedUp' ||
        candidate.status === 'written' ||
        candidate.status === 'rolledBack' ||
        candidate.status === 'failed') &&
      (candidate.error === undefined || typeof candidate.error === 'string')
    )
  })
}

function cloneJournal(journal: TagWriteJournal): TagWriteJournal {
  return {
    version: 2,
    state: journal.state,
    entries: journal.entries.map((entry) => ({ ...entry }))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
