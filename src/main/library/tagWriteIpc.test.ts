import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { File } from 'node-taglib-sharp'
import { createTagWriteIpcHandlers } from './tagWriteIpc.ts'
import { readTagWriteJournal, writeTagsBatchWithRollback } from './tagWriteService.ts'

test('trusted and authorized tag IPC writes a real WAV with a PNG cover and restores it from its journal', async () => {
  const fixture = createFixture()
  try {
    writeTags(fixture.audioFile, 'Before', 'Original Artist')
    let trustedCalls = 0
    const event = { sender: 'trusted-renderer' }
    const handlers = createTagWriteIpcHandlers({
      backupRoot: fixture.backupRoot,
      assertTrustedSender: (actualEvent) => {
        trustedCalls++
        assert.equal(actualEvent, event)
      },
      authorizeAudioFile: async (filePath) => {
        assert.equal(filePath, fixture.audioFile)
        return fixture.audioFile
      },
      redactError: errorMessage
    })

    const writeResult = await handlers.write(event, {
      items: [
        {
          filePath: fixture.audioFile,
          title: 'After',
          artist: 'Updated Artist',
          track: 2,
          coverData: PNG_1X1
        }
      ]
    })
    assert.deepEqual(writeResult, { items: [{ filePath: fixture.audioFile, status: 'success' }] })
    assert.deepEqual(structuredClone(writeResult), writeResult)
    assert.deepEqual(readTags(fixture.audioFile), {
      title: 'After',
      artist: 'Updated Artist',
      track: 2,
      coverMime: 'image/png'
    })
    assert.deepEqual(readTagWriteJournal(fixture.backupRoot), {
      version: 2,
      state: 'completed',
      entries: [
        {
          filePath: fixture.audioFile,
          backupPath: backupPath(fixture.audioFile, fixture.backupRoot),
          status: 'written'
        }
      ]
    })

    const restoreResult = await handlers.restore(event, { fromJournal: true })
    assert.deepEqual(restoreResult, { items: [{ filePath: fixture.audioFile, status: 'success' }] })
    assert.deepEqual(structuredClone(restoreResult), restoreResult)
    assert.deepEqual(readTags(fixture.audioFile), {
      title: 'Before',
      artist: 'Original Artist',
      track: 0,
      coverMime: null
    })
    assert.equal(trustedCalls, 2)
  } finally {
    fixture.dispose()
  }
})

test('tag IPC writes, reads, and clears extended tags with cover progress', async () => {
  const fixture = createFixture()
  try {
    const event = { sender: 'trusted-renderer' }
    const progress: Array<{ operationId: string; current: number; total: number }> = []
    const handlers = createTagWriteIpcHandlers({
      backupRoot: fixture.backupRoot,
      assertTrustedSender: () => {},
      authorizeAudioFile: async (filePath) => filePath,
      redactError: errorMessage,
      sendProgress: (_event, value) => progress.push(value)
    })

    const writeResult = await handlers.write(event, {
      operationId: 'workshop_write_1',
      items: [
        {
          filePath: fixture.audioFile,
          title: 'Extended',
          artist: 'Artist',
          album: 'Album',
          albumArtist: 'Album Artist',
          track: 3,
          trackCount: 12,
          disc: 1,
          discCount: 2,
          year: 2024,
          genre: 'Pop',
          composer: 'Composer A; Composer B',
          comment: 'Workshop note',
          lyrics: 'First line\nSecond line',
          coverData: PNG_1X1
        }
      ]
    })
    assert.deepEqual(writeResult, {
      operationId: 'workshop_write_1',
      items: [{ filePath: fixture.audioFile, status: 'success' }]
    })
    assert.deepEqual(progress, [
      { operationId: 'workshop_write_1', current: 1, total: 1, filePath: fixture.audioFile }
    ])

    const readResult = await handlers.read(event, {
      filePaths: [fixture.audioFile],
      includeCover: true
    })
    const snapshot = readResult.items[0].tags
    assert.ok(snapshot)
    assert.deepEqual(
      {
        ...snapshot,
        coverData: snapshot.coverData ? snapshot.coverData.byteLength : 0
      },
      {
        title: 'Extended',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Album Artist',
        track: 3,
        trackCount: 12,
        disc: 1,
        discCount: 2,
        year: 2024,
        genre: 'Pop',
        composer: 'Composer A; Composer B',
        comment: 'Workshop note',
        lyrics: 'First line\nSecond line',
        hasCover: true,
        coverMimeType: 'image/png',
        coverData: PNG_1X1.byteLength
      }
    )

    const clearResult = await handlers.write(event, {
      operationId: 'workshop_clear_1',
      items: [
        {
          filePath: fixture.audioFile,
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
          coverData: null
        }
      ]
    })
    assert.deepEqual(clearResult.items, [{ filePath: fixture.audioFile, status: 'success' }])
    const cleared = await handlers.read(event, { filePaths: [fixture.audioFile] })
    assert.deepEqual(cleared.items[0].tags, {
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
    })
  } finally {
    fixture.dispose()
  }
})

test('tag IPC cancels a queued write before it starts', async () => {
  const fixture = createFixture()
  try {
    const event = { sender: 'trusted-renderer' }
    const handlers = createTagWriteIpcHandlers({
      backupRoot: fixture.backupRoot,
      assertTrustedSender: () => {},
      authorizeAudioFile: async (filePath) => filePath,
      redactError: errorMessage
    })

    const pending = handlers.write(event, {
      operationId: 'cancel_before_start',
      items: [{ filePath: fixture.audioFile, title: 'Never Written' }]
    })
    assert.equal(await handlers.cancel(event, { operationId: 'cancel_before_start' }), true)
    assert.deepEqual(await pending, {
      operationId: 'cancel_before_start',
      cancelled: true,
      items: [{ filePath: fixture.audioFile, status: 'notAttempted', message: '写入已取消' }]
    })
    assert.equal(await handlers.cancel(event, { operationId: 'missing_operation' }), false)
    assert.throws(() => readTagWriteJournal(fixture.backupRoot), /does not exist/)
    assert.deepEqual(readTags(fixture.audioFile), {
      title: '',
      artist: '',
      track: 0,
      coverMime: null
    })
  } finally {
    fixture.dispose()
  }
})

test('tag IPC rejects an over-limit PNG, skips an unparseable file, and rejects unauthorized paths', async () => {
  const fixture = createFixture()
  try {
    writeTags(fixture.audioFile, 'Before', 'Original Artist')
    writeFileSync(fixture.invalidAudioFile, 'not a WAV file')
    const event = { sender: 'trusted-renderer' }
    const handlers = createTagWriteIpcHandlers({
      backupRoot: fixture.backupRoot,
      assertTrustedSender: (actualEvent) => assert.equal(actualEvent, event),
      authorizeAudioFile: async (filePath) => {
        if (filePath === fixture.audioFile || filePath === fixture.invalidAudioFile) return filePath
        throw new Error('audio file is outside the authorized library')
      },
      redactError: errorMessage
    })

    await assert.rejects(
      () =>
        handlers.write(event, {
          items: [
            {
              filePath: fixture.audioFile,
              title: 'Oversized PNG',
              coverData: createPngHeader(4_097, 1)
            }
          ]
        }),
      /dimensions exceed/
    )

    const preflightResult = await handlers.write(event, {
      items: [
        { filePath: fixture.audioFile, title: 'Written After Preflight' },
        { filePath: fixture.invalidAudioFile, title: 'Invalid Fixture' }
      ]
    })
    assert.deepEqual(
      preflightResult.items.map((item) => item.status),
      ['success', 'failed']
    )
    assert.match(preflightResult.items[1].message ?? '', /无法解析文件标签/)
    assert.deepEqual(structuredClone(preflightResult), preflightResult)
    assert.deepEqual(readTags(fixture.audioFile), {
      title: 'Written After Preflight',
      artist: 'Original Artist',
      track: 0,
      coverMime: null
    })
    const completedJournal = readTagWriteJournal(fixture.backupRoot)
    assert.equal(completedJournal.state, 'completed')
    assert.deepEqual(
      completedJournal.entries.map((entry) => entry.status),
      ['written']
    )

    const deniedPath = join(fixture.directory, 'outside.wav')
    const deniedResult = await handlers.write(event, {
      items: [
        { filePath: fixture.audioFile, title: 'Not Attempted' },
        { filePath: deniedPath, title: 'Denied' }
      ]
    })
    assert.deepEqual(deniedResult.items, [
      {
        filePath: fixture.audioFile,
        status: 'notAttempted',
        message: 'Batch not started because another path was unauthorized'
      },
      {
        filePath: deniedPath,
        status: 'failed',
        message: 'audio file is outside the authorized library'
      }
    ])
    assert.deepEqual(structuredClone(deniedResult), deniedResult)
  } finally {
    fixture.dispose()
  }
})

test('tag IPC still rolls back the batch when a write fails after preflight', async () => {
  const fixture = createFixture()
  try {
    writeTags(fixture.audioFile, 'Before', 'Original Artist')
    writeFileSync(fixture.invalidAudioFile, 'not a WAV file')
    const event = { sender: 'trusted-renderer' }
    const handlers = createTagWriteIpcHandlers({
      backupRoot: fixture.backupRoot,
      assertTrustedSender: () => {},
      authorizeAudioFile: async (filePath) => filePath,
      redactError: errorMessage,
      probeWritable: () => null
    })

    const result = await handlers.write(event, {
      items: [
        { filePath: fixture.audioFile, title: 'Must Roll Back' },
        { filePath: fixture.invalidAudioFile, title: 'Invalid Fixture' }
      ]
    })
    assert.deepEqual(
      result.items.map((item) => item.status),
      ['rolledBack', 'rolledBack']
    )
    assert.deepEqual(readTags(fixture.audioFile), {
      title: 'Before',
      artist: 'Original Artist',
      track: 0,
      coverMime: null
    })
    const journal = readTagWriteJournal(fixture.backupRoot)
    assert.equal(journal.state, 'rolledBack')
    assert.deepEqual(
      journal.entries.map((entry) => entry.status),
      ['rolledBack', 'rolledBack']
    )
  } finally {
    fixture.dispose()
  }
})

test('persists the pending journal intent before a first backup copy can fail', () => {
  const fixture = createFixture()
  try {
    const missingFile = join(fixture.directory, 'missing.wav')
    assert.throws(
      () =>
        writeTagsBatchWithRollback(
          [{ filePath: missingFile, title: 'Never Written' }],
          fixture.backupRoot
        ),
      /Tag write batch failed/
    )
    const journal = readTagWriteJournal(fixture.backupRoot)
    assert.equal(journal.state, 'rolledBack')
    assert.deepEqual(
      journal.entries.map((entry) => entry.status),
      ['failed']
    )
    assert.equal(journal.entries[0].filePath, missingFile)
    assert.equal(journal.entries[0].backupPath, backupPath(missingFile, fixture.backupRoot))
    assert.match(journal.entries[0].error ?? '', /ENOENT/)
  } finally {
    fixture.dispose()
  }
})

function createFixture(): {
  directory: string
  audioFile: string
  invalidAudioFile: string
  backupRoot: string
  dispose(): void
} {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-tag-write-'))
  const audioFile = join(directory, 'fixture.wav')
  const invalidAudioFile = join(directory, 'invalid.wav')
  const backupRoot = join(directory, 'tag-backups')
  writeFileSync(audioFile, createWavFixture())
  return {
    directory,
    audioFile,
    invalidAudioFile,
    backupRoot,
    dispose: () => rmSync(directory, { recursive: true, force: true })
  }
}

function createWavFixture(): Buffer {
  const dataLength = 2
  const wav = Buffer.alloc(44 + dataLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataLength, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(44_100, 24)
  wav.writeUInt32LE(88_200, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataLength, 40)
  return wav
}

function writeTags(filePath: string, title: string, artist: string): void {
  const media = File.createFromPath(filePath)
  try {
    media.tag.title = title
    media.tag.performers = [artist]
    media.save()
  } finally {
    media.dispose()
  }
}

function readTags(filePath: string): {
  title: string
  artist: string
  track: number
  coverMime: string | null
} {
  const media = File.createFromPath(filePath)
  try {
    return {
      title: media.tag.title ?? '',
      artist: media.tag.performers[0] ?? '',
      track: media.tag.track,
      coverMime: media.tag.pictures[0]?.mimeType ?? null
    }
  } finally {
    media.dispose()
  }
}

function createPngHeader(width: number, height: number): Uint8Array {
  const png = Buffer.alloc(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

function backupPath(filePath: string, backupRoot: string): string {
  return join(backupRoot, `${Buffer.from(filePath).toString('base64url')}.bak`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLxGQAAAABJRU5ErkJggg==',
  'base64'
)
