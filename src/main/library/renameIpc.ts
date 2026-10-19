import { rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type {
  LocalLibraryRenameItemResult,
  LocalLibraryRenameRequest,
  LocalLibraryRenameResult,
  LocalLibraryRenameSidecar
} from '../../shared/localLibraryRename.ts'

const MAX_RENAME_ITEMS = 1_000
const MAX_FILE_NAME_LENGTH = 200
const MAX_TARGET_PATH_LENGTH = 259
const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const SIDECAR_SUFFIXES = [
  '.lrc',
  '_trans.lrc',
  '_roma.lrc',
  '.translated.lrc',
  '.word.lrc',
  '.yrc',
  '.ttml'
]

export interface RenameIpcHandlers {
  rename(event: unknown, request: unknown): Promise<LocalLibraryRenameResult>
}

export interface RenameIpcDependencies {
  assertTrustedSender(event: unknown): void
  authorizeAudioFile(filePath: string): Promise<string>
  redactError(error: unknown): string
}

interface PreparedRename {
  index: number
  requestedPath: string
  source: string
  target: string
  moves: Array<{ from: string; to: string; suffix: string }>
}

export function createRenameIpcHandlers(
  dependencies: RenameIpcDependencies
): RenameIpcHandlers {
  let chain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.catch(() => {}).then(operation)
    chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    async rename(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeRenameRequest(rawRequest)
      return await enqueue(async () => {
        const results: Array<LocalLibraryRenameItemResult | undefined> = new Array(
          request.items.length
        )
        const prepared: PreparedRename[] = []
        const claimedTargets = new Map<string, number>()

        for (const [index, item] of request.items.entries()) {
          try {
            const rename = await prepareRename(index, item.filePath, item.fileName, dependencies)
            const claimed = claimedTargets.get(pathKey(rename.target))
            if (claimed !== undefined) {
              results[index] = failed(item.filePath, '目标文件名与其他待重命名歌曲重复', [])
              results[claimed] = failed(
                request.items[claimed].filePath,
                '目标文件名与其他待重命名歌曲重复',
                []
              )
              continue
            }
            claimedTargets.set(pathKey(rename.target), index)
            prepared.push(rename)
          } catch (error) {
            results[index] = failed(item.filePath, dependencies.redactError(error), [])
          }
        }

        for (const item of prepared) {
          if (results[item.index]?.status === 'failed') continue
          results[item.index] = await executeRename(item, dependencies)
        }

        return {
          items: results.map(
            (result, index) =>
              result ?? failed(request.items[index].filePath, '重命名未执行', [])
          )
        }
      })
    }
  }
}

function normalizeRenameRequest(value: unknown): LocalLibraryRenameRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Rename request must be an object')
  }
  const items = (value as Record<string, unknown>).items
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_RENAME_ITEMS) {
    throw new Error(`Rename request must include 1-${MAX_RENAME_ITEMS} items`)
  }
  return {
    items: items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Rename item must be an object')
      }
      const record = item as Record<string, unknown>
      if (typeof record.filePath !== 'string' || !record.filePath || record.filePath.length > 4096) {
        throw new Error('Rename audio file path is invalid')
      }
      if (typeof record.fileName !== 'string') {
        throw new Error('Rename target file name is invalid')
      }
      return { filePath: record.filePath, fileName: record.fileName }
    })
  }
}

async function prepareRename(
  index: number,
  requestedPath: string,
  fileName: string,
  dependencies: RenameIpcDependencies
): Promise<PreparedRename> {
  const source = await dependencies.authorizeAudioFile(requestedPath)
  const oldName = basename(source)
  const oldExtension = extname(oldName)
  const name = normalizeFileName(fileName)
  if (extname(name).toLocaleLowerCase('en-US') !== oldExtension.toLocaleLowerCase('en-US')) {
    throw new Error('重命名不能修改音频扩展名')
  }
  if (name === oldName) {
    return { index, requestedPath, source, target: source, moves: [] }
  }
  const directory = dirname(source)
  const target = join(directory, name)
  if (target.length > MAX_TARGET_PATH_LENGTH) throw new Error('目标路径过长')
  const caseOnly = pathKey(target) === pathKey(source)
  if (!caseOnly && (await pathExists(target))) {
    throw new Error('目标文件已存在')
  }

  const stem = oldName.slice(0, oldName.length - oldExtension.length)
  if (await pathExists(join(directory, `${stem}.cue`))) {
    throw new Error('同名 CUE 表引用了此音频，暂不支持重命名')
  }
  const newStem = name.slice(0, name.length - extname(name).length)
  const moves: PreparedRename['moves'] = []
  for (const suffix of SIDECAR_SUFFIXES) {
    const from = join(directory, `${stem}${suffix}`)
    if (!(await pathExists(from))) continue
    const to = join(directory, `${newStem}${suffix}`)
    if (pathKey(to) !== pathKey(from) && (await pathExists(to))) {
      throw new Error(`同名附属文件已存在：${basename(to)}`)
    }
    moves.push({ from, to, suffix })
  }
  return { index, requestedPath, source, target, moves }
}

async function executeRename(
  item: PreparedRename,
  dependencies: RenameIpcDependencies
): Promise<LocalLibraryRenameItemResult> {
  if (item.source === item.target) {
    return {
      filePath: item.requestedPath,
      newFilePath: item.source,
      status: 'success',
      sidecars: []
    }
  }
  const moves = [{ from: item.source, to: item.target, suffix: '' }, ...item.moves]
  const moved: Array<{ from: string; to: string; suffix: string }> = []
  const sidecars: LocalLibraryRenameSidecar[] = []
  try {
    for (const move of moves) {
      await rename(move.from, move.to)
      moved.push(move)
      if (move.suffix) sidecars.push({ from: move.from, to: move.to, status: 'moved' })
    }
    return {
      filePath: item.requestedPath,
      newFilePath: item.target,
      status: 'success',
      sidecars
    }
  } catch (error) {
    for (const move of moved.reverse()) {
      await rename(move.to, move.from).catch(() => undefined)
    }
    return failed(item.requestedPath, dependencies.redactError(error), [
      ...sidecars.map((sidecar) => ({ ...sidecar, status: 'failed' as const })),
      ...item.moves
        .filter((move) => !moved.some((entry) => entry.from === move.from))
        .map((move) => ({ from: move.from, to: move.to, status: 'failed' as const }))
    ])
  }
}

function normalizeFileName(value: string): string {
  const name = value.trim()
  if (!name || name.length > MAX_FILE_NAME_LENGTH) throw new Error('目标文件名无效')
  if (name === '.' || name === '..') throw new Error('目标文件名无效')
  if (name !== basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error('目标文件名不能包含路径分隔符')
  }
  if (INVALID_FILE_NAME_CHARS.test(name)) throw new Error('目标文件名包含非法字符')
  if (/[. ]$/.test(name)) throw new Error('目标文件名不能以空格或点结尾')
  if (WINDOWS_RESERVED_NAME.test(name)) throw new Error('目标文件名与系统保留名称冲突')
  return name
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw new Error('无法检查目标路径是否可用')
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    error !== undefined &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function pathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function failed(
  filePath: string,
  message: string,
  sidecars: LocalLibraryRenameSidecar[]
): LocalLibraryRenameItemResult {
  return { filePath, status: 'failed', message, sidecars }
}
