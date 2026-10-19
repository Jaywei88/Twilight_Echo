import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { loadTaglib } from './taglib.ts'

const require = createRequire(import.meta.url)

interface Mpeg4BoxStatic {
  fromFile(header: { dataSize: number }, file: unknown): { boxType: { toString(type: unknown): string } }
}

test('reads an empty MP4 hdlr box without requesting a negative byte count', () => {
  const { ByteVector, Mpeg4BoxHeader, StringType } = loadTaglib()
  const header = Mpeg4BoxHeader.fromType(ByteVector.fromString('hdlr', StringType.Latin1))
  assert.equal(header.dataSize, 0)

  const readSizes: number[] = []
  const file = {
    readBlock(size: number) {
      readSizes.push(size)
      if (size < 0) throw new Error(`negative read: ${size}`)
      return ByteVector.fromSize(size)
    }
  }

  const handlerBox = require('node-taglib-sharp/dist/mpeg4/boxes/isoHandlerBox.js')
    .default as Mpeg4BoxStatic
  const box = handlerBox.fromFile(header, file)
  assert.deepEqual(readSizes, [0])
  assert.equal(box.boxType.toString(StringType.Latin1), 'hdlr')
})
