import { randomUUID } from 'node:crypto'
import type {
  LocalLibraryTagCancelRequest,
  LocalLibraryTagOperationResult,
  LocalLibraryTagReadRequest,
  LocalLibraryTagReadResult,
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagSnapshot,
  LocalLibraryTagWriteItem,
  LocalLibraryTagWriteProgress,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult
} from '../../shared/localLibraryTags.ts'
import {
  getTagWriteJournalRecoveryEntries,
  probeTagWrite,
  readTagsFromFile,
  restoreTagsFromBackup,
  TagWriteBatchError,
  writeTagsBatchWithRollbackAsync,
  type TagReadOptions,
  type TagWriteBatchOptions,
  type TagWriteBatchOutcome,
  type TagWriteInput,
  type TagWriteJournalEntry
} from './tagWriteService.ts'

const MAX_TAG_MUTATION_ITEMS = 1_000
const MAX_TAG_READ_ITEMS = 500
const MAX_TAG_TEXT_LENGTH = 1_024
const MAX_TAG_LYRICS_LENGTH = 256 * 1_024
const MAX_OPERATION_ID_LENGTH = 128
const MAX_COVER_BYTES = 8 * 1024 * 1024
const MAX_COVER_DIMENSION = 4_096
const MAX_COVER_PIXELS = 16_777_216

export interface TagWriteIpcHandlers {
  write(event: unknown, request: unknown): Promise<LocalLibraryTagWriteResult>
  restore(event: unknown, request: unknown): Promise<LocalLibraryTagRestoreResult>
  read(event: unknown, request: unknown): Promise<LocalLibraryTagReadResult>
  cancel(event: unknown, request: unknown): Promise<boolean>
}

export interface TagWriteIpcDependencies {
  backupRoot: string
  assertTrustedSender(event: unknown): void
  authorizeAudioFile(filePath: string): Promise<string>
  redactError(error: unknown): string
  writeBatchAsync?(
    inputs: readonly TagWriteInput[],
    backupRoot: string,
    options: TagWriteBatchOptions
  ): Promise<TagWriteBatchOutcome>
  restoreFromBackup?(filePath: string, backupRoot: string): void
  readRecoveryEntries?(backupRoot: string): Array<{ filePath: string }>
  probeWritable?(filePath: string): string | null
  readTags?(filePath: string, options: TagReadOptions): LocalLibraryTagSnapshot
  sendProgress?(event: unknown, progress: LocalLibraryTagWriteProgress): void
}

export function createTagWriteIpcHandlers(
  dependencies: TagWriteIpcDependencies
): TagWriteIpcHandlers {
  const writeBatchAsync = dependencies.writeBatchAsync ?? writeTagsBatchWithRollbackAsync
  const restoreFromBackup = dependencies.restoreFromBackup ?? restoreTagsFromBackup
  const readRecoveryEntries = dependencies.readRecoveryEntries ?? getTagWriteJournalRecoveryEntries
  const probeWritable = dependencies.probeWritable ?? probeTagWrite
  const readTags = dependencies.readTags ?? readTagsFromFile
  const activeOperations = new Map<string, { cancelled: boolean }>()
  let writeChain: Promise<unknown> = Promise.resolve()

  function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeChain.catch(() => {}).then(operation)
    writeChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function withOperationId(
    request: LocalLibraryTagWriteRequest,
    operationId: string,
    result: LocalLibraryTagWriteResult
  ): LocalLibraryTagWriteResult {
    return request.operationId === undefined ? result : { operationId, ...result }
  }

  return {
    async write(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeWriteRequest(rawRequest)
      const operationId = request.operationId ?? randomUUID()
      const operation = { cancelled: false }
      activeOperations.set(operationId, operation)

      try {
        return await enqueueWrite(async () => {
          if (operation.cancelled) {
            return withOperationId(request, operationId, {
              items: request.items.map((item) => notAttempted(item.filePath, '写入已取消')),
              cancelled: true
            })
          }

          const authorization = await authorizeItems(request.items, dependencies)
          if (authorization.failures.size > 0) {
            return withOperationId(request, operationId, {
              items: request.items.map((item, index) =>
                authorization.failures.has(index)
                  ? failed(item.filePath, authorization.failures.get(index)!)
                  : notAttempted(
                      item.filePath,
                      'Batch not started because another path was unauthorized'
                    )
              )
            })
          }

          const preflightFailures = new Map<number, string>()
          const writableIndexes: number[] = []
          for (const [index, item] of authorization.items.entries()) {
            if (operation.cancelled) break
            let failure: string | null
            try {
              failure = probeWritable(item.filePath)
            } catch (error) {
              failure = `无法检查文件是否可写：${dependencies.redactError(error)}`
            }
            if (failure) preflightFailures.set(index, dependencies.redactError(failure))
            else writableIndexes.push(index)
            await yieldToEventLoop()
          }

          if (operation.cancelled) {
            return withOperationId(request, operationId, {
              items: request.items.map((item) => notAttempted(item.filePath, '写入已取消')),
              cancelled: true
            })
          }
          if (writableIndexes.length === 0) {
            return withOperationId(request, operationId, {
              items: request.items.map((item, index) =>
                failed(item.filePath, preflightFailures.get(index) ?? '文件不可写')
              )
            })
          }

          const writableItems = writableIndexes.map((index) => authorization.items[index])
          const mergeResults = (
            results: Map<number, LocalLibraryTagOperationResult>
          ): LocalLibraryTagOperationResult[] =>
            request.items.map(
              (item, index) =>
                results.get(index) ??
                failed(item.filePath, preflightFailures.get(index) ?? '文件未写入')
            )
          try {
            const outcome = await writeBatchAsync(writableItems, dependencies.backupRoot, {
              shouldCancel: () => operation.cancelled,
              onProgress: (progress) => {
                dependencies.sendProgress?.(event, {
                  operationId,
                  current: progress.current + preflightFailures.size,
                  total: request.items.length,
                  filePath: progress.filePath
                })
              }
            })
            const results = new Map<number, LocalLibraryTagOperationResult>()
            outcome.entries.forEach((entry, entryIndex) => {
              results.set(writableIndexes[entryIndex], toWriteOperationResult(entry, dependencies))
            })
            return withOperationId(request, operationId, {
              items: mergeResults(results),
              ...(outcome.cancelled ? { cancelled: true } : {})
            })
          } catch (error) {
            if (error instanceof TagWriteBatchError) {
              const results = new Map<number, LocalLibraryTagOperationResult>()
              error.journal.entries.forEach((entry, entryIndex) => {
                results.set(writableIndexes[entryIndex], toWriteOperationResult(entry, dependencies))
              })
              return withOperationId(request, operationId, {
                items: mergeResults(results)
              })
            }
            return withOperationId(request, operationId, {
              items: request.items.map((item, index) =>
                preflightFailures.has(index)
                  ? failed(item.filePath, preflightFailures.get(index) ?? '文件不可写')
                  : notAttempted(
                      item.filePath,
                      `Batch journal could not be initialized: ${dependencies.redactError(error)}`
                    )
              )
            })
          }
        })
      } finally {
        activeOperations.delete(operationId)
      }
    },

    async restore(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeRestoreRequest(rawRequest)
      let filePaths: string[]
      try {
        filePaths = request.fromJournal
          ? readRecoveryEntries(dependencies.backupRoot).map((entry) => entry.filePath)
          : (request.filePaths ?? [])
      } catch (error) {
        return {
          items: [
            failed('', `Could not read tag recovery journal: ${dependencies.redactError(error)}`)
          ]
        }
      }
      const authorization = await authorizeFilePaths(filePaths, dependencies)
      if (authorization.failures.size > 0) {
        return {
          items: filePaths.map((filePath, index) =>
            authorization.failures.has(index)
              ? failed(filePath, authorization.failures.get(index)!)
              : notAttempted(filePath, 'Restore not started because another path was unauthorized')
          )
        }
      }

      return {
        items: authorization.filePaths.map((filePath) => {
          try {
            restoreFromBackup(filePath, dependencies.backupRoot)
            return success(filePath)
          } catch (error) {
            return failed(filePath, dependencies.redactError(error))
          }
        })
      }
    },

    async read(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeReadRequest(rawRequest)
      const authorization = await authorizeFilePaths(request.filePaths, dependencies)
      const items: LocalLibraryTagReadResult['items'] = []
      for (let index = 0; index < request.filePaths.length; index++) {
        const requestedPath = request.filePaths[index]
        const failure = authorization.failures.get(index)
        if (failure !== undefined) {
          items.push({ filePath: requestedPath, message: failure })
          continue
        }
        try {
          items.push({
            filePath: requestedPath,
            tags: readTags(authorization.filePaths[index], { includeCover: request.includeCover })
          })
        } catch (error) {
          items.push({ filePath: requestedPath, message: dependencies.redactError(error) })
        }
        await yieldToEventLoop()
      }
      return { items }
    },

    async cancel(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeCancelRequest(rawRequest)
      const operation = activeOperations.get(request.operationId)
      if (!operation) return false
      operation.cancelled = true
      return true
    }
  }
}

async function authorizeItems(
  items: readonly LocalLibraryTagWriteItem[],
  dependencies: TagWriteIpcDependencies
): Promise<{ items: TagWriteInput[]; failures: Map<number, string> }> {
  const authorization = await authorizeFilePaths(
    items.map((item) => item.filePath),
    dependencies
  )
  return {
    items: items.map((item, index) => ({ ...item, filePath: authorization.filePaths[index] })),
    failures: authorization.failures
  }
}

async function authorizeFilePaths(
  filePaths: readonly string[],
  dependencies: TagWriteIpcDependencies
): Promise<{ filePaths: string[]; failures: Map<number, string> }> {
  const authorized: string[] = []
  const failures = new Map<number, string>()
  for (const [index, filePath] of filePaths.entries()) {
    try {
      authorized[index] = await dependencies.authorizeAudioFile(filePath)
    } catch (error) {
      failures.set(index, dependencies.redactError(error))
      authorized[index] = filePath
    }
  }
  return { filePaths: authorized, failures }
}

function normalizeWriteRequest(value: unknown): LocalLibraryTagWriteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag write request must be an object')
  }
  const record = value as Record<string, unknown>
  const items = record.items
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TAG_MUTATION_ITEMS) {
    throw new Error(`Tag write request must include 1-${MAX_TAG_MUTATION_ITEMS} items`)
  }
  const operationId = optionalOperationId(record.operationId)
  return {
    items: items.map(normalizeWriteItem),
    ...(operationId !== undefined ? { operationId } : {})
  }
}

function normalizeWriteItem(value: unknown): LocalLibraryTagWriteItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag write item must be an object')
  }
  const record = value as Record<string, unknown>
  const patch = normalizeTagPatch(record)
  if (Object.keys(patch).length === 0) {
    throw new Error('Tag write item must include at least one tag field')
  }
  return { filePath: normalizeFilePath(record.filePath), ...patch }
}

function normalizeRestoreRequest(value: unknown): LocalLibraryTagRestoreRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag restore request must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.fromJournal === true) {
    if (record.filePaths !== undefined) {
      throw new Error('Journal restore must not include file paths')
    }
    return { fromJournal: true }
  }
  if (
    !Array.isArray(record.filePaths) ||
    record.filePaths.length === 0 ||
    record.filePaths.length > MAX_TAG_MUTATION_ITEMS
  ) {
    throw new Error(`Tag restore request must include 1-${MAX_TAG_MUTATION_ITEMS} file paths`)
  }
  return { filePaths: record.filePaths.map(normalizeFilePath) }
}

function normalizeReadRequest(value: unknown): Required<LocalLibraryTagReadRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag read request must be an object')
  }
  const record = value as Record<string, unknown>
  if (
    !Array.isArray(record.filePaths) ||
    record.filePaths.length === 0 ||
    record.filePaths.length > MAX_TAG_READ_ITEMS
  ) {
    throw new Error(`Tag read request must include 1-${MAX_TAG_READ_ITEMS} file paths`)
  }
  if (record.includeCover !== undefined && typeof record.includeCover !== 'boolean') {
    throw new Error('Tag read includeCover must be a boolean')
  }
  return {
    filePaths: record.filePaths.map(normalizeFilePath),
    includeCover: record.includeCover === true
  }
}

function normalizeCancelRequest(value: unknown): LocalLibraryTagCancelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag cancel request must be an object')
  }
  const operationId = optionalOperationId((value as Record<string, unknown>).operationId)
  if (operationId === undefined) throw new Error('Tag cancel operation id is invalid')
  return { operationId }
}

function optionalOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OPERATION_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('Tag operation id is invalid')
  }
  return value
}

function normalizeTagPatch(record: Record<string, unknown>): Omit<TagWriteInput, 'filePath'> {
  const title = optionalNullableText(record.title, 'title')
  const artist = optionalNullableText(record.artist, 'artist')
  const album = optionalNullableText(record.album, 'album')
  const albumArtist = optionalNullableText(record.albumArtist, 'album artist')
  const track = optionalNullablePositiveInteger(record.track, 'track')
  const trackCount = optionalNullablePositiveInteger(record.trackCount, 'track count')
  const disc = optionalNullablePositiveInteger(record.disc, 'disc')
  const discCount = optionalNullablePositiveInteger(record.discCount, 'disc count')
  const year = optionalNullablePositiveInteger(record.year, 'year')
  const genre = optionalNullableText(record.genre, 'genre')
  const composer = optionalNullableText(record.composer, 'composer')
  const comment = optionalNullableText(record.comment, 'comment')
  const lyrics = optionalNullableText(record.lyrics, 'lyrics', MAX_TAG_LYRICS_LENGTH)
  const cover = record.coverData === undefined ? undefined : normalizeCoverOrNull(record.coverData)
  return {
    ...(title !== undefined ? { title } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(albumArtist !== undefined ? { albumArtist } : {}),
    ...(track !== undefined ? { track } : {}),
    ...(trackCount !== undefined ? { trackCount } : {}),
    ...(disc !== undefined ? { disc } : {}),
    ...(discCount !== undefined ? { discCount } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(genre !== undefined ? { genre } : {}),
    ...(composer !== undefined ? { composer } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(lyrics !== undefined ? { lyrics } : {}),
    ...(cover === null
      ? { coverData: null }
      : cover
        ? { coverData: cover.data, coverMimeType: cover.mimeType }
        : {})
  }
}

function normalizeFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error('Tag audio file path is invalid')
  }
  return value
}

function optionalNullableText(
  value: unknown,
  field: string,
  maxLength = MAX_TAG_TEXT_LENGTH
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`Tag ${field} is invalid`)
  }
  return value
}

function optionalNullablePositiveInteger(
  value: unknown,
  field: string
): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 9_999) {
    throw new Error(`Tag ${field} is invalid`)
  }
  return value as number
}

function normalizeCoverOrNull(
  value: unknown
): { data: Uint8Array; mimeType: 'image/jpeg' | 'image/png' } | null {
  if (value === null) return null
  return normalizeCoverData(value)
}

function normalizeCoverData(value: unknown): {
  data: Uint8Array
  mimeType: 'image/jpeg' | 'image/png'
} {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_COVER_BYTES
  ) {
    throw new Error('Tag cover data is invalid')
  }
  const dimensions = parsePngDimensions(value) ?? parseJpegDimensions(value)
  if (!dimensions) throw new Error('Only PNG and JPEG tag covers are supported')
  if (
    dimensions.width > MAX_COVER_DIMENSION ||
    dimensions.height > MAX_COVER_DIMENSION ||
    dimensions.width * dimensions.height > MAX_COVER_PIXELS
  ) {
    throw new Error('Tag cover dimensions exceed the allowed limit')
  }
  return { data: value, mimeType: dimensions.mimeType }
}

function parsePngDimensions(
  data: Uint8Array
): { width: number; height: number; mimeType: 'image/png' } | null {
  if (
    data.byteLength < 24 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47 ||
    data[4] !== 0x0d ||
    data[5] !== 0x0a ||
    data[6] !== 0x1a ||
    data[7] !== 0x0a ||
    data[12] !== 0x49 ||
    data[13] !== 0x48 ||
    data[14] !== 0x44 ||
    data[15] !== 0x52
  ) {
    return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height, mimeType: 'image/png' } : null
}

function parseJpegDimensions(
  data: Uint8Array
): { width: number; height: number; mimeType: 'image/jpeg' } | null {
  if (data.byteLength < 11 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let offset = 2
  while (offset < data.byteLength) {
    while (offset < data.byteLength && data[offset] === 0xff) offset++
    if (offset >= data.byteLength) return null
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.byteLength) return null
    const length = (data[offset] << 8) | data[offset + 1]
    if (length < 7 || offset + length > data.byteLength) return null
    if (isJpegStartOfFrame(marker)) {
      const height = (data[offset + 3] << 8) | data[offset + 4]
      const width = (data[offset + 5] << 8) | data[offset + 6]
      return width > 0 && height > 0 ? { width, height, mimeType: 'image/jpeg' } : null
    }
    offset += length
  }
  return null
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

function toWriteOperationResult(
  entry: TagWriteJournalEntry,
  dependencies: TagWriteIpcDependencies
): LocalLibraryTagOperationResult {
  switch (entry.status) {
    case 'written':
      return success(entry.filePath)
    case 'rolledBack':
      return {
        filePath: entry.filePath,
        status: 'rolledBack',
        ...(entry.error ? { message: dependencies.redactError(entry.error) } : {})
      }
    case 'pending':
      return notAttempted(entry.filePath, 'Write was not attempted')
    case 'backedUp':
      return failed(entry.filePath, 'Backup exists and requires journal recovery')
    case 'failed':
      return failed(entry.filePath, dependencies.redactError(entry.error ?? 'Tag write failed'))
  }
}

function success(filePath: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'success' }
}

function failed(filePath: string, message: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'failed', message }
}

function notAttempted(filePath: string, message: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'notAttempted', message }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
