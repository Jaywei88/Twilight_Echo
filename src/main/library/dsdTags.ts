import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync
} from 'node:fs'
import { extname } from 'node:path'
import type { Id3v2Tag as Id3v2TagLike, Tag } from 'node-taglib-sharp'
import type { LocalLibraryTagSnapshot } from '../../shared/localLibraryTags.ts'
import type { TagReadOptions, TagWriteInput } from './tagWriteService.ts'
import { applyTagInput, emptyTagSnapshot, snapshotFromTag } from './tagFields.ts'
import { loadTaglib } from './taglib.ts'

const DSD_EXTENSIONS = new Set(['.dsf', '.dff'])

const DSF_SIGNATURE = 'DSD '
const DSF_HEADER_SIZE = 28
const DSF_FMT_OFFSET = 28
const DSF_FMT_CHUNK_SIZE = 52
const DSF_DATA_OFFSET = 80
const DFF_SIGNATURE = 'FRM8'
const DFF_FORM_TYPE = 'DSD '
const DFF_HEADER_SIZE = 16
const ID3_HEADER_SIZE = 10
const ID3_FOOTER_SIZE = 10
const ID3_FOOTER_FLAG = 0x10
const MAX_ID3_TAG_BYTES = 64 * 1024 * 1024

interface DsfLayout {
  header: Buffer
  fileSize: number
  metadataOffset: number
}

interface DffLayout {
  fileSize: number
  id3Offset: number | null
  id3PayloadOffset: number | null
  id3PayloadSize: number | null
  id3ChunkSize: number | null
  lastChunkPayloadSize: number | null
}

export function isDsdFilePath(filePath: string): boolean {
  return DSD_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function readDsdTags(
  filePath: string,
  options: TagReadOptions = {}
): LocalLibraryTagSnapshot {
  const extension = requireDsdExtension(filePath)
  const fd = openSync(filePath, 'r')
  try {
    const tag = extension === '.dsf' ? readDsfId3Tag(fd) : readDffId3Tag(fd)
    return tag ? snapshotFromTag(tag, options) : emptyTagSnapshot()
  } finally {
    closeSync(fd)
  }
}

/** Returns a user-facing reason when the DSD file cannot be safely written, otherwise null. */
export function probeDsdTagWrite(filePath: string): string | null {
  try {
    accessSync(filePath, constants.W_OK)
  } catch {
    return '文件不可写：只读、权限不足或文件不存在'
  }

  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const extension = requireDsdExtension(filePath)
    if (extension === '.dsf') {
      const layout = inspectDsf(fd)
      if (layout.metadataOffset !== 0) {
        readId3TagAt(fd, layout.metadataOffset, layout.fileSize)
      }
    } else {
      const layout = inspectDff(fd)
      if (layout.id3Offset !== null) {
        if (
          layout.id3PayloadOffset === null ||
          layout.id3PayloadSize === null ||
          layout.id3ChunkSize === null
        ) {
          throw new Error('DFF 的 ID3 标签块不完整')
        }
        if (layout.id3Offset + layout.id3ChunkSize !== layout.fileSize) {
          return '无法安全写入：DFF 的 ID3 标签块不在文件末尾'
        }
        if (layout.id3PayloadSize > 0) {
          readId3TagAt(
            fd,
            layout.id3PayloadOffset,
            layout.id3PayloadOffset + layout.id3PayloadSize
          )
        }
      } else if (
        layout.lastChunkPayloadSize !== null &&
        (layout.lastChunkPayloadSize & 1) === 1
      ) {
        return '无法安全写入：DFF 最后一个数据块为奇数长度，追加 ID3 标签会影响部分读取器'
      }
    }
    return null
  } catch (error) {
    return `无法解析文件标签：${errorMessage(error)}`
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function writeDsdTags(input: TagWriteInput): void {
  const extension = requireDsdExtension(input.filePath)
  const fd = openSync(input.filePath, 'r+')
  try {
    if (extension === '.dsf') writeDsfTag(fd, input)
    else writeDffTag(fd, input)
  } finally {
    closeSync(fd)
  }
}

function requireDsdExtension(filePath: string): '.dsf' | '.dff' {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.dsf' || extension === '.dff') return extension
  throw new Error('不支持的 DSD 文件类型')
}

function readDsfId3Tag(fd: number): Tag | null {
  const layout = inspectDsf(fd)
  if (layout.metadataOffset === 0) return null
  return readId3TagAt(fd, layout.metadataOffset, layout.fileSize)
}

function inspectDsf(fd: number): DsfLayout {
  const fileSize = fstatSync(fd).size
  if (fileSize < DSF_HEADER_SIZE) throw new Error('DSF 文件头不完整')
  const header = readBytes(fd, 0, DSF_HEADER_SIZE)
  if (header.toString('latin1', 0, 4) !== DSF_SIGNATURE) {
    throw new Error('不是有效的 DSF 文件')
  }
  if (readUint64Le(header, 4) !== DSF_HEADER_SIZE) {
    throw new Error('DSF 文件头版本不受支持')
  }
  if (fileSize < DSF_DATA_OFFSET) throw new Error('DSF 音频数据块不完整')

  const fmtHeader = readBytes(fd, DSF_FMT_OFFSET, 12)
  if (
    fmtHeader.toString('latin1', 0, 4) !== 'fmt ' ||
    readUint64Le(fmtHeader, 4) !== DSF_FMT_CHUNK_SIZE
  ) {
    throw new Error('DSF 缺少有效的 fmt 数据块')
  }
  const dataHeader = readBytes(fd, DSF_DATA_OFFSET, 12)
  if (dataHeader.toString('latin1', 0, 4) !== 'data') {
    throw new Error('DSF 缺少 data 数据块')
  }

  const metadataOffset = readUint64Le(header, 20)
  if (
    metadataOffset !== 0 &&
    (metadataOffset < DSF_DATA_OFFSET || metadataOffset > fileSize)
  ) {
    throw new Error('DSF 元数据指针无效')
  }
  return { header, fileSize, metadataOffset }
}

function writeDsfTag(fd: number, input: TagWriteInput): void {
  const layout = inspectDsf(fd)
  const metadataOffset = layout.metadataOffset === 0 ? layout.fileSize : layout.metadataOffset
  const rendered = renderDsdTag(
    fd,
    layout.metadataOffset === 0 ? null : metadataOffset,
    layout.fileSize,
    input
  )
  writeExact(fd, rendered, metadataOffset)
  ftruncateSync(fd, metadataOffset + rendered.length)

  const header = Buffer.from(layout.header)
  header.writeBigUInt64LE(BigInt(metadataOffset + rendered.length), 12)
  header.writeBigUInt64LE(BigInt(metadataOffset), 20)
  writeExact(fd, header, 0)
}

function readDffId3Tag(fd: number): Tag | null {
  const layout = inspectDff(fd)
  if (
    layout.id3PayloadOffset === null ||
    layout.id3PayloadSize === null ||
    layout.id3PayloadSize === 0
  ) {
    return null
  }
  return readId3TagAt(
    fd,
    layout.id3PayloadOffset,
    layout.id3PayloadOffset + layout.id3PayloadSize
  )
}

function inspectDff(fd: number): DffLayout {
  const fileSize = fstatSync(fd).size
  if (fileSize < DFF_HEADER_SIZE) throw new Error('DFF 文件头不完整')
  const header = readBytes(fd, 0, DFF_HEADER_SIZE)
  if (header.toString('latin1', 0, 4) !== DFF_SIGNATURE) {
    throw new Error('不是有效的 DFF 文件')
  }
  if (header.toString('latin1', 12, 16) !== DFF_FORM_TYPE) {
    throw new Error('不支持的 DFF 表单类型')
  }
  const declaredSize = readUint64Be(header, 4)
  if (declaredSize < 4 || declaredSize > fileSize - 12) {
    throw new Error('DFF 文件长度与文件头不一致')
  }

  const contentEnd = 12 + declaredSize
  let offset = DFF_HEADER_SIZE
  let lastChunkPayloadSize: number | null = null
  while (offset + 12 <= contentEnd) {
    const chunkHeader = readBytes(fd, offset, 12)
    const chunkSize = readUint64Be(chunkHeader, 4)
    const payloadOffset = offset + 12
    if (chunkSize > contentEnd - payloadOffset) {
      throw new Error('DFF 数据块长度无效')
    }
    const chunkSizeWithHeader = 12 + chunkSize + (chunkSize & 1)
    if (chunkHeader.toString('latin1', 0, 4) === 'ID3 ') {
      return {
        fileSize,
        id3Offset: offset,
        id3PayloadOffset: payloadOffset,
        id3PayloadSize: chunkSize,
        id3ChunkSize: chunkSizeWithHeader,
        lastChunkPayloadSize
      }
    }
    lastChunkPayloadSize = chunkSize
    offset += chunkSizeWithHeader
  }
  // A handful of bytes that cannot hold a chunk header are treated as padding.
  return {
    fileSize,
    id3Offset: null,
    id3PayloadOffset: null,
    id3PayloadSize: null,
    id3ChunkSize: null,
    lastChunkPayloadSize
  }
}

function writeDffTag(fd: number, input: TagWriteInput): void {
  const layout = inspectDff(fd)
  let rendered: Buffer
  let newFileSize: number
  if (layout.id3Offset !== null) {
    if (
      layout.id3PayloadOffset === null ||
      layout.id3PayloadSize === null ||
      layout.id3ChunkSize === null ||
      layout.id3Offset + layout.id3ChunkSize !== layout.fileSize
    ) {
      throw new Error('暂不支持写入非末尾位置的 DFF ID3 标签块')
    }
    const payloadOffset = layout.id3PayloadOffset
    rendered =
      layout.id3PayloadSize === 0
        ? renderDsdTag(fd, null, 0, input)
        : renderDsdTag(fd, payloadOffset, payloadOffset + layout.id3PayloadSize, input)
    writeExact(fd, rendered, payloadOffset)
    newFileSize = payloadOffset + rendered.length
    if (rendered.length & 1) {
      writeExact(fd, Buffer.from([0]), newFileSize)
      newFileSize += 1
    }
    ftruncateSync(fd, newFileSize)
  } else {
    // The library scanner's DSDIFF parser does not skip the required pad byte
    // after an odd-sized chunk, which would make the appended ID3 unreadable.
    if (
      layout.lastChunkPayloadSize !== null &&
      (layout.lastChunkPayloadSize & 1) === 1
    ) {
      throw new Error(
        '无法安全写入：DFF 最后一个数据块为奇数长度，追加 ID3 标签会影响部分读取器'
      )
    }
    rendered = renderDsdTag(fd, null, 0, input)
    let offset = layout.fileSize
    if (offset & 1) {
      writeExact(fd, Buffer.from([0]), offset)
      offset += 1
    }
    const chunkHeader = Buffer.alloc(12)
    chunkHeader.write('ID3 ', 0, 'latin1')
    chunkHeader.writeBigUInt64BE(BigInt(rendered.length), 4)
    writeExact(fd, chunkHeader, offset)
    writeExact(fd, rendered, offset + 12)
    newFileSize = offset + 12 + rendered.length
    if (rendered.length & 1) {
      writeExact(fd, Buffer.from([0]), newFileSize)
      newFileSize += 1
    }
  }

  const sizeField = Buffer.alloc(8)
  sizeField.writeBigUInt64BE(BigInt(newFileSize - 12), 0)
  writeExact(fd, sizeField, 4)
}

function readId3TagAt(fd: number, offset: number, limit: number): Id3v2TagLike | null {
  if (limit - offset < ID3_HEADER_SIZE) throw new Error('ID3v2 标签头不完整')
  const header = readBytes(fd, offset, ID3_HEADER_SIZE)
  if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) {
    throw new Error('元数据不是 ID3v2 标签')
  }
  if (header[3] < 2 || header[3] > 4) throw new Error('不支持的 ID3v2 版本')
  const tagSize = readSyncSafeUint32(header, 6)
  if (tagSize === 0) return null
  if (tagSize > MAX_ID3_TAG_BYTES) throw new Error('ID3v2 标签过大')
  const hasFooter = header[3] === 4 && (header[5] & ID3_FOOTER_FLAG) !== 0
  const totalSize = ID3_HEADER_SIZE + tagSize + (hasFooter ? ID3_FOOTER_SIZE : 0)
  if (limit - offset < totalSize) throw new Error('ID3v2 标签长度无效')

  const data = readBytes(fd, offset, totalSize)
  const { ByteVector, Id3v2Tag } = loadTaglib()
  return Id3v2Tag.fromData(ByteVector.fromByteArray(data))
}

function renderDsdTag(
  fd: number,
  tagOffset: number | null,
  limit: number,
  input: TagWriteInput
): Buffer {
  const { Id3v2Tag } = loadTaglib()
  const existing = tagOffset === null ? null : readId3TagAt(fd, tagOffset, limit)
  const tag = existing ?? Id3v2Tag.fromEmpty()
  applyTagInput(tag, input)
  return Buffer.from(tag.render().toByteArray())
}

function readUint64Le(buffer: Buffer, offset: number): number {
  return toSafeOffset(buffer.readBigUInt64LE(offset))
}

function readUint64Be(buffer: Buffer, offset: number): number {
  return toSafeOffset(buffer.readBigUInt64BE(offset))
}

function toSafeOffset(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件偏移超出支持范围')
  return Number(value)
}

function readSyncSafeUint32(buffer: Buffer, offset: number): number {
  for (let index = 0; index < 4; index++) {
    if (buffer[offset + index] & 0x80) throw new Error('ID3v2 标签长度无效')
  }
  return (
    (buffer[offset] << 21) |
    (buffer[offset + 1] << 14) |
    (buffer[offset + 2] << 7) |
    buffer[offset + 3]
  )
}

function readBytes(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  readExact(fd, buffer, position)
  return buffer
}

function readExact(fd: number, target: Buffer, position: number): void {
  let read = 0
  while (read < target.length) {
    const bytesRead = readSync(fd, target, read, target.length - read, position + read)
    if (bytesRead === 0) throw new Error('文件内容不完整')
    read += bytesRead
  }
}

function writeExact(fd: number, data: Buffer, position: number): void {
  let written = 0
  while (written < data.length) {
    const bytesWritten = writeSync(fd, data, written, data.length - written, position + written)
    if (bytesWritten === 0) throw new Error('写入文件失败')
    written += bytesWritten
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
