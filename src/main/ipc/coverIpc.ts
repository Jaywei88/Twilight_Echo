import { nativeImage, type IpcMain } from 'electron'
import {
  cacheCoverFromBuffer,
  isCoverCacheFileName,
  readCoverCacheFileBytes
} from '../library/coverCache'
import {
  createRemoteMediaRequestHandler,
  grantRemoteImageUrl
} from '../security/remoteMediaGrants.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const MAX_DATA_URL_BYTES = 8 * 1024 * 1024
const MAX_COVER_INPUT_BYTES = 16 * 1024 * 1024
const MAX_TAG_COVER_BYTES = 8 * 1024 * 1024

export interface CoverBytesResult {
  data: Uint8Array
  mimeType: 'image/jpeg' | 'image/png'
}

export type CoverIpcResult = Uint8Array | string | null

export function registerCoverIpc(ipcMain: IpcMain): void {
  ipcMain.handle('cover:get', async (event, handle: string): Promise<CoverIpcResult> => {
    assertTrustedIpcSender(event, 'cover IPC')
    if (!handle || typeof handle !== 'string') return null
    // Pass through existing data: URLs (e.g. from plugins)
    if (handle.startsWith('data:')) return normalizeCoverDataUrl(handle)
    if (!handle.startsWith('cover://')) return null
    const fileName = handle.slice('cover://'.length).split(/[?#]/, 1)[0]
    if (!fileName || fileName.includes('/') || !isCoverCacheFileName(fileName)) return null
    return await readCoverCacheFileBytes(fileName)
  })

  ipcMain.handle('cover:cache', async (event, input: unknown): Promise<string | null> => {
    assertTrustedIpcSender(event, 'cover IPC')
    const data = normalizeCoverBuffer(input)
    if (!data || data.byteLength === 0 || data.byteLength > MAX_COVER_INPUT_BYTES) return null
    return cacheCoverFromBuffer(data)
  })

  // Re-issue an image grant for a durable http(s) cover origin (session restore /
  // listening-stats rows whose previous twilight-media token has expired).
  ipcMain.handle('cover:grantRemote', async (event, source: string): Promise<string> => {
    assertTrustedIpcSender(event, 'cover IPC')
    const raw = typeof source === 'string' ? source.trim() : ''
    if (!raw || raw.length > 4096) throw new Error('Remote cover source is invalid')
    return grantRemoteImageUrl(raw)
  })

  // Materialize a cover handle (remote grant, local cache, or data URL) into
  // PNG/JPEG bytes so the tag workshop can embed matched artwork.
  ipcMain.handle('cover:readBytes', async (event, input: unknown): Promise<CoverBytesResult | null> => {
    assertTrustedIpcSender(event, 'cover IPC')
    const request = normalizeCoverReadInput(input)
    if (!request) return null
    const bytes = await readCoverBytes(request.handle, request.source)
    return bytes ? normalizeTagCoverBytes(bytes) : null
  })
}

function normalizeCoverReadInput(
  value: unknown
): { handle: string; source: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const handle = typeof record.handle === 'string' ? record.handle.trim() : ''
  const source = typeof record.source === 'string' ? record.source.trim() : ''
  if (!handle || handle.length > 8_192) return null
  if (source.length > 8_192) return null
  return { handle, source: /^https?:\/\//i.test(source) ? source : null }
}

async function readCoverBytes(handle: string, source: string | null): Promise<Uint8Array | null> {
  if (handle.startsWith('data:')) return decodeCoverDataUrl(handle)
  const remoteSource =
    /^twilight-media:\/\/image\//i.test(handle) || /^https?:\/\//i.test(handle) ? source : null
  if (remoteSource) {
    try {
      return await fetchRemoteCoverBytes(remoteSource)
    } catch {
      // The durable origin can be stale; fall back to the live grant below.
    }
  }
  if (/^https?:\/\//i.test(handle)) {
    try {
      return await fetchRemoteCoverBytes(handle)
    } catch {
      return null
    }
  }
  if (!handle.startsWith('twilight-media://image/')) return readLocalCoverBytes(handle)
  try {
    return await fetchRemoteCoverBytes(handle)
  } catch {
    return source ? fetchRemoteCoverBytes(source).catch(() => null) : null
  }
}

async function readLocalCoverBytes(handle: string): Promise<Uint8Array | null> {
  if (!handle.startsWith('cover://')) return null
  const fileName = handle.slice('cover://'.length).split(/[?#]/, 1)[0]
  if (!fileName || fileName.includes('/') || !isCoverCacheFileName(fileName)) return null
  const bytes = await readCoverCacheFileBytes(fileName)
  return bytes ? new Uint8Array(bytes) : null
}

function decodeCoverDataUrl(handle: string): Uint8Array | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(handle)
  if (!match || match[1].length * 0.75 > MAX_COVER_INPUT_BYTES) return null
  return new Uint8Array(Buffer.from(match[1], 'base64'))
}

async function fetchRemoteCoverBytes(source: string): Promise<Uint8Array | null> {
  const grantUrl = /^twilight-media:\/\/image\//i.test(source)
    ? source
    : grantRemoteImageUrl(source)
  const response = await createRemoteMediaRequestHandler({ fetch: globalThis.fetch })(
    new Request(grantUrl)
  )
  if (!response.ok) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > 0 ? bytes : null
}

function normalizeTagCoverBytes(input: Uint8Array): CoverBytesResult | null {
  const mimeType = coverMagicMimeType(input)
  if (mimeType) {
    return input.byteLength <= MAX_TAG_COVER_BYTES ? { data: input, mimeType } : null
  }
  const image = nativeImage.createFromBuffer(Buffer.from(input))
  if (image.isEmpty()) return null
  const jpeg = image.toJPEG(90)
  if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_TAG_COVER_BYTES) return null
  return { data: new Uint8Array(jpeg), mimeType: 'image/jpeg' }
}

function coverMagicMimeType(data: Uint8Array): CoverBytesResult['mimeType'] | null {
  if (
    data.byteLength >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png'
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}

function normalizeCoverDataUrl(handle: string): string | null {
  if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(handle)) return null
  if (Buffer.byteLength(handle, 'utf-8') > MAX_DATA_URL_BYTES) return null
  return handle
}

function normalizeCoverBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
