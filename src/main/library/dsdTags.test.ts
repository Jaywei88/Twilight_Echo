import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseFile } from 'music-metadata'
import { emptyTagSnapshot } from './tagFields.ts'
import { probeTagWrite, readTagsFromFile, writeTagsWithBackup } from './tagWriteService.ts'
import type { TagWriteInput } from './tagWriteService.ts'

const DSF_HEADER_SIZE = 28
const DSF_FMT_CHUNK_SIZE = 52
const DSF_DATA_OFFSET = 80

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLxGQAAAABJRU5ErkJggg==',
  'base64'
)

test('writes and patches ID3v2 tags in a DSF file without touching the audio data', async () => {
  const fixture = createFixture()
  const filePath = join(fixture.root, 'song.dsf')
  const audioData = Buffer.alloc(64, 0x69)
  writeFileSync(filePath, createDsfFixture(audioData))
  try {
    assert.deepEqual(readTagsFromFile(filePath), emptyTagSnapshot())
    assert.equal(probeTagWrite(filePath), null)

    const firstInput: TagWriteInput = {
      filePath,
      title: '夜の歌',
      artist: 'テスト歌手',
      album: 'アルバム',
      albumArtist: 'Various Artists',
      track: 3,
      trackCount: 12,
      disc: 1,
      discCount: 2,
      year: 2024,
      genre: 'J-Pop',
      composer: '作曲者A; 作曲者B',
      comment: 'コメント',
      lyrics: '歌詞のテスト',
      coverData: PNG_1X1,
      coverMimeType: 'image/png'
    }
    const result = writeTagsWithBackup(firstInput, fixture.backupRoot)
    assert.equal(result.backupPath, join(fixture.backupRoot, `${Buffer.from(filePath).toString('base64url')}.bak`))
    assert.deepEqual(readFileSync(result.backupPath), createDsfFixture(audioData))

    const snapshot = readTagsFromFile(filePath, { includeCover: true })
    assert.deepEqual(
      { ...snapshot, coverData: undefined },
      {
        ...emptyTagSnapshot(),
        title: '夜の歌',
        artist: 'テスト歌手',
        album: 'アルバム',
        albumArtist: 'Various Artists',
        track: 3,
        trackCount: 12,
        disc: 1,
        discCount: 2,
        year: 2024,
        genre: 'J-Pop',
        composer: '作曲者A; 作曲者B',
        comment: 'コメント',
        lyrics: '歌詞のテスト',
        hasCover: true,
        coverMimeType: 'image/png',
        coverData: undefined
      }
    )
    assert.ok(snapshot.coverData)
    assert.deepEqual(Buffer.from(snapshot.coverData), PNG_1X1)

    const dataEnd = DSF_DATA_OFFSET + 12 + audioData.length
    const written = readFileSync(filePath)
    assert.equal(written.readBigUInt64LE(12), BigInt(written.length))
    assert.equal(written.readBigUInt64LE(20), BigInt(dataEnd))
    assert.equal(dataEnd + id3TagSize(written, dataEnd), written.length)

    const metadata = await parseFile(filePath)
    assert.equal(metadata.common.title, '夜の歌')
    assert.equal(metadata.common.artist, 'テスト歌手')

    writeTagsWithBackup({ filePath, title: '短い', coverData: null }, fixture.backupRoot)
    const patched = readTagsFromFile(filePath)
    assert.equal(patched.title, '短い')
    assert.equal(patched.artist, 'テスト歌手')
    assert.equal(patched.album, 'アルバム')
    assert.equal(patched.lyrics, '歌詞のテスト')
    assert.equal(patched.hasCover, false)
    assert.equal(patched.coverMimeType, null)

    const repatched = readFileSync(filePath)
    assert.equal(repatched.readBigUInt64LE(12), BigInt(repatched.length))
    assert.equal(repatched.readBigUInt64LE(20), BigInt(dataEnd))
    assert.equal(dataEnd + id3TagSize(repatched, dataEnd), repatched.length)
  } finally {
    fixture.dispose()
  }
})

test('writes an ID3 chunk at the end of a DFF file and preserves fields absent from the patch', async () => {
  const fixture = createFixture()
  const filePath = join(fixture.root, 'song.dff')
  const audioData = Buffer.alloc(64, 0x5a)
  writeFileSync(filePath, createDffFixture(audioData))
  try {
    assert.deepEqual(readTagsFromFile(filePath), emptyTagSnapshot())
    assert.equal(probeTagWrite(filePath), null)

    writeTagsWithBackup(
      {
        filePath,
        title: '鳥の詩',
        artist: 'Lia',
        album: 'AIR',
        track: 1,
        year: 2000,
        coverData: PNG_1X1,
        coverMimeType: 'image/png'
      },
      fixture.backupRoot
    )
    const written = readFileSync(filePath)
    const id3 = findDffChunk(written, 'ID3 ')
    assert.ok(id3)
    assert.equal(id3.offset + id3.totalSize, written.length)
    assert.equal(written.readBigUInt64BE(4), BigInt(written.length - 12))

    const snapshot = readTagsFromFile(filePath, { includeCover: true })
    assert.equal(snapshot.title, '鳥の詩')
    assert.equal(snapshot.artist, 'Lia')
    assert.equal(snapshot.album, 'AIR')
    assert.equal(snapshot.track, 1)
    assert.equal(snapshot.year, 2000)
    assert.equal(snapshot.hasCover, true)
    assert.ok(snapshot.coverData)
    assert.deepEqual(Buffer.from(snapshot.coverData), PNG_1X1)

    const metadata = await parseFile(filePath)
    assert.equal(metadata.common.title, '鳥の詩')
    assert.equal(metadata.common.artist, 'Lia')

    writeTagsWithBackup({ filePath, title: 'REFRAIN' }, fixture.backupRoot)
    const repatched = readFileSync(filePath)
    const repatchedId3 = findDffChunk(repatched, 'ID3 ')
    assert.ok(repatchedId3)
    assert.equal(repatchedId3.offset + repatchedId3.totalSize, repatched.length)
    assert.equal(repatched.readBigUInt64BE(4), BigInt(repatched.length - 12))
    const patched = readTagsFromFile(filePath)
    assert.equal(patched.title, 'REFRAIN')
    assert.equal(patched.artist, 'Lia')
    assert.equal(patched.album, 'AIR')
    assert.equal(patched.hasCover, true)
  } finally {
    fixture.dispose()
  }
})

test('refuses to modify a DFF file whose ID3 chunk is not the last chunk', () => {
  const fixture = createFixture()
  const filePath = join(fixture.root, 'non-terminal-id3.dff')
  try {
    writeFileSync(filePath, createDffFixture(Buffer.alloc(10, 0x33)))
    writeTagsWithBackup({ filePath, title: 'Before' }, fixture.backupRoot)

    const withTrailingChunk = Buffer.concat([
      readFileSync(filePath),
      dffChunk('TEST', Buffer.from([1, 2, 3, 4]))
    ])
    withTrailingChunk.writeBigUInt64BE(BigInt(withTrailingChunk.length - 12), 4)
    writeFileSync(filePath, withTrailingChunk)

    assert.match(probeTagWrite(filePath) ?? '', /ID3 标签块不在文件末尾/)
    assert.throws(
      () => writeTagsWithBackup({ filePath, title: 'After' }, fixture.backupRoot),
      /非末尾位置/
    )
    assert.equal(readTagsFromFile(filePath).title, 'Before')
  } finally {
    fixture.dispose()
  }
})

test('refuses to append an ID3 chunk after an odd-length final DFF chunk', () => {
  const fixture = createFixture()
  const filePath = join(fixture.root, 'odd-final-chunk.dff')
  try {
    writeFileSync(filePath, createDffFixture(Buffer.alloc(65, 0x44)))
    assert.match(probeTagWrite(filePath) ?? '', /奇数长度/)
    assert.throws(
      () => writeTagsWithBackup({ filePath, title: 'After' }, fixture.backupRoot),
      /奇数长度/
    )
  } finally {
    fixture.dispose()
  }
})

test('reports invalid DSF headers instead of writing', () => {
  const fixture = createFixture()
  const filePath = join(fixture.root, 'broken.dsf')
  try {
    const broken = createDsfFixture(Buffer.alloc(16))
    broken.write('XXXX', 0, 'latin1')
    writeFileSync(filePath, broken)
    assert.match(probeTagWrite(filePath) ?? '', /不是有效的 DSF 文件/)
    assert.throws(
      () => writeTagsWithBackup({ filePath, title: 'After' }, fixture.backupRoot),
      /不是有效的 DSF 文件/
    )
  } finally {
    fixture.dispose()
  }
})

function createFixture(): { root: string; backupRoot: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'twilight-dsd-tags-'))
  return {
    root,
    backupRoot: join(root, 'tag-backups'),
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}

function createDsfFixture(audioData: Buffer): Buffer {
  const format = Buffer.alloc(DSF_FMT_CHUNK_SIZE)
  format.write('fmt ', 0, 'latin1')
  format.writeBigUInt64LE(BigInt(DSF_FMT_CHUNK_SIZE), 4)
  format.writeUInt32LE(1, 12)
  format.writeUInt32LE(2, 16)
  format.writeUInt32LE(2, 20)
  format.writeUInt32LE(1, 24)
  format.writeUInt32LE(2_822_400, 28)
  format.writeUInt32LE(1, 32)
  format.writeBigUInt64LE(2_822_400n, 36)
  format.writeUInt32LE(4096, 44)

  const dataHeader = Buffer.alloc(12)
  dataHeader.write('data', 0, 'latin1')
  dataHeader.writeBigUInt64LE(BigInt(audioData.length), 4)

  const header = Buffer.alloc(DSF_HEADER_SIZE)
  header.write('DSD ', 0, 'latin1')
  header.writeBigUInt64LE(BigInt(DSF_HEADER_SIZE), 4)
  header.writeBigUInt64LE(BigInt(DSF_DATA_OFFSET + dataHeader.length + audioData.length), 12)
  header.writeBigUInt64LE(0n, 20)
  return Buffer.concat([header, format, dataHeader, audioData])
}

function createDffFixture(audioData: Buffer): Buffer {
  return createDffContainer([
    dffChunk('FVER', Buffer.from([1, 5, 0, 0])),
    dffChunk('DSD ', audioData)
  ])
}

function createDffContainer(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('DSD ', 'latin1'), ...chunks])
  const header = Buffer.alloc(12)
  header.write('FRM8', 0, 'latin1')
  header.writeBigUInt64BE(BigInt(body.length), 4)
  return Buffer.concat([header, body])
}

function dffChunk(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header.write(id, 0, 'latin1')
  header.writeBigUInt64BE(BigInt(payload.length), 4)
  return payload.length & 1
    ? Buffer.concat([header, payload, Buffer.from([0])])
    : Buffer.concat([header, payload])
}

function findDffChunk(
  buffer: Buffer,
  targetId: string
): { offset: number; size: number; totalSize: number } | null {
  const contentEnd = 12 + Number(buffer.readBigUInt64BE(4))
  let offset = 16
  while (offset + 12 <= contentEnd) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = Number(buffer.readBigUInt64BE(offset + 4))
    const totalSize = 12 + size + (size & 1)
    if (id === targetId) return { offset, size, totalSize }
    offset += totalSize
  }
  return null
}

function id3TagSize(buffer: Buffer, offset: number): number {
  const size =
    (buffer[offset + 6] << 21) |
    (buffer[offset + 7] << 14) |
    (buffer[offset + 8] << 7) |
    buffer[offset + 9]
  const hasFooter = buffer[offset + 3] === 4 && (buffer[offset + 5] & 0x10) !== 0
  return 10 + size + (hasFooter ? 10 : 0)
}
