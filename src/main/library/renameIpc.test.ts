import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRenameIpcHandlers, type RenameIpcHandlers } from './renameIpc.ts'

test('renames an audio file and moves its lyric sidecars together', async () => {
  const fixture = createFixture()
  try {
    const handlers = fixture.handlers()
    const target = join(fixture.directory, 'Artist - Renamed.wav')
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: 'Artist - Renamed.wav' }]
    })

    assert.deepEqual(result.items, [
      {
        filePath: fixture.audioFile,
        newFilePath: target,
        status: 'success',
        sidecars: [
          {
            from: join(fixture.directory, 'song.lrc'),
            to: join(fixture.directory, 'Artist - Renamed.lrc'),
            status: 'moved'
          },
          {
            from: join(fixture.directory, 'song_trans.lrc'),
            to: join(fixture.directory, 'Artist - Renamed_trans.lrc'),
            status: 'moved'
          },
          {
            from: join(fixture.directory, 'song.yrc'),
            to: join(fixture.directory, 'Artist - Renamed.yrc'),
            status: 'moved'
          }
        ]
      }
    ])
    assert.equal(existsSync(fixture.audioFile), false)
    assert.equal(existsSync(target), true)
    assert.equal(existsSync(join(fixture.directory, 'Artist - Renamed.lrc')), true)
    assert.equal(existsSync(join(fixture.directory, 'Artist - Renamed_trans.lrc')), true)
    assert.equal(existsSync(join(fixture.directory, 'Artist - Renamed.yrc')), true)
    assert.equal(existsSync(join(fixture.directory, 'song.lrc')), false)
  } finally {
    fixture.dispose()
  }
})

test('keeps the extension and rejects an extension change', async () => {
  const fixture = createFixture()
  try {
    const handlers = fixture.handlers()
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: 'Renamed.mp3' }]
    })
    assert.equal(result.items[0].status, 'failed')
    assert.match(result.items[0].message ?? '', /扩展名/)
    assert.equal(existsSync(fixture.audioFile), true)
  } finally {
    fixture.dispose()
  }
})

test('rejects a target that already exists without moving anything', async () => {
  const fixture = createFixture()
  try {
    writeFileSync(join(fixture.directory, 'Existing.wav'), 'existing')
    const handlers = fixture.handlers()
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: 'Existing.wav' }]
    })
    assert.equal(result.items[0].status, 'failed')
    assert.match(result.items[0].message ?? '', /已存在/)
    assert.equal(existsSync(fixture.audioFile), true)
    assert.equal(existsSync(join(fixture.directory, 'song.lrc')), true)
  } finally {
    fixture.dispose()
  }
})

test('rejects renaming an audio file referenced by a CUE sheet', async () => {
  const fixture = createFixture()
  try {
    writeFileSync(join(fixture.directory, 'song.cue'), 'FILE "song.wav" WAVE')
    const handlers = fixture.handlers()
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: 'Renamed.wav' }]
    })
    assert.equal(result.items[0].status, 'failed')
    assert.match(result.items[0].message ?? '', /CUE/)
    assert.equal(existsSync(fixture.audioFile), true)
  } finally {
    fixture.dispose()
  }
})

test('rejects an existing sidecar destination before the audio file moves', async () => {
  const fixture = createFixture()
  try {
    writeFileSync(join(fixture.directory, 'Renamed.lrc'), 'occupied')
    const handlers = fixture.handlers()
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: 'Renamed.wav' }]
    })
    assert.equal(result.items[0].status, 'failed')
    assert.match(result.items[0].message ?? '', /附属文件/)
    assert.equal(existsSync(fixture.audioFile), true)
    assert.equal(existsSync(join(fixture.directory, 'song.lrc')), true)
  } finally {
    fixture.dispose()
  }
})

test('rejects invalid target names and marks every duplicate target as failed', async () => {
  const fixture = createFixture()
  try {
    writeFileSync(join(fixture.directory, 'second.wav'), 'second')
    const handlers = fixture.handlers()
    const invalid = await handlers.rename(fixture.event, {
      items: [{ filePath: fixture.audioFile, fileName: '..\\escape.wav' }]
    })
    assert.equal(invalid.items[0].status, 'failed')
    assert.match(invalid.items[0].message ?? '', /路径分隔符/)

    const duplicate = await handlers.rename(fixture.event, {
      items: [
        { filePath: fixture.audioFile, fileName: 'Same.wav' },
        { filePath: join(fixture.directory, 'second.wav'), fileName: 'same.wav' }
      ]
    })
    assert.deepEqual(
      duplicate.items.map((item) => item.status),
      ['failed', 'failed']
    )
    for (const item of duplicate.items) {
      assert.match(item.message ?? '', /重复/)
    }
    assert.equal(existsSync(fixture.audioFile), true)
    assert.equal(existsSync(join(fixture.directory, 'second.wav')), true)
    assert.equal(existsSync(join(fixture.directory, 'Same.wav')), false)
  } finally {
    fixture.dispose()
  }
})

test('rejects unauthorized paths per item', async () => {
  const fixture = createFixture()
  try {
    const handlers = fixture.handlers()
    const result = await handlers.rename(fixture.event, {
      items: [{ filePath: join(tmpdir(), 'outside.wav'), fileName: 'Other.wav' }]
    })
    assert.equal(result.items[0].status, 'failed')
    assert.match(result.items[0].message ?? '', /授权/)
  } finally {
    fixture.dispose()
  }
})

function createFixture(): {
  directory: string
  audioFile: string
  event: unknown
  handlers(): RenameIpcHandlers
  dispose(): void
} {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-rename-'))
  const audioFile = join(directory, 'song.wav')
  writeFileSync(audioFile, 'audio')
  writeFileSync(join(directory, 'song.lrc'), 'lyrics')
  writeFileSync(join(directory, 'song_trans.lrc'), 'translated')
  writeFileSync(join(directory, 'song.yrc'), 'word lyrics')
  const event = { sender: 'trusted-renderer' }
  return {
    directory,
    audioFile,
    event,
    handlers: () => {
      const authorizedRoot = directory
      return createRenameIpcHandlers({
        assertTrustedSender: (actualEvent) => assert.equal(actualEvent, event),
        authorizeAudioFile: async (filePath) => {
          if (!filePath.startsWith(authorizedRoot)) throw new Error('文件未获得授权')
          return filePath
        },
        redactError: (error) => (error instanceof Error ? error.message : String(error))
      })
    },
    dispose: () => rmSync(directory, { recursive: true, force: true })
  }
}
