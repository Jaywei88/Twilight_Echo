import { createRequire } from 'module'
import type * as Taglib from 'node-taglib-sharp'

export type { Taglib }

const require = createRequire(import.meta.url)
let taglib: typeof Taglib | null = null

/** node-taglib-sharp costs ~100 ms to load; only tag writes and downloads need it. */
export function loadTaglib(): typeof Taglib {
  if (!taglib) {
    taglib = require('node-taglib-sharp') as typeof Taglib
    installEmptyMpeg4HandlerBoxCompat()
  }
  return taglib
}

interface Mpeg4BoxHeaderLike {
  dataSize: number
}

interface Mpeg4BoxStatic {
  fromFile(header: Mpeg4BoxHeaderLike, file: unknown, handlerType?: unknown): unknown
}

interface Mpeg4BoxModule {
  default: Mpeg4BoxStatic
}

/**
 * Some M4A files embed an empty 8-byte `hdlr` box inside `ilst`. TagLib# then
 * reads `dataSize - 4` bytes, which is a negative length, and marks the whole
 * file corrupt and unwritable. An empty handler box has no payload, so decode
 * it as an unknown box and leave the rest of the MP4 reader untouched.
 */
function installEmptyMpeg4HandlerBoxCompat(): void {
  const handlerBox =
    (require('node-taglib-sharp/dist/mpeg4/boxes/isoHandlerBox.js') as Mpeg4BoxModule).default
  const unknownBox =
    (require('node-taglib-sharp/dist/mpeg4/boxes/unknownBox.js') as Mpeg4BoxModule).default
  const patched = handlerBox.fromFile as Mpeg4BoxStatic['fromFile'] & {
    __emptyHandlerBoxCompat?: true
  }
  if (patched.__emptyHandlerBoxCompat) return
  const originalFromFile = handlerBox.fromFile
  const compat: typeof patched = function (header, file, handlerType) {
    if (header.dataSize === 0) return unknownBox.fromFile(header, file, handlerType)
    return originalFromFile.call(handlerBox, header, file, handlerType)
  }
  compat.__emptyHandlerBoxCompat = true
  handlerBox.fromFile = compat
}
