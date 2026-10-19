let contextRef = null

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 8_000
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const SEARCH_CACHE_CAPACITY = 240
const LYRICS_CACHE_TTL_MS = 30 * 60_000
const LYRICS_CACHE_CAPACITY = 200
const MAX_SEARCH_RESULTS = 50

const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  Origin: 'https://y.qq.com'
}
// 移动端歌词接口只接受 m.kuwo.cn 的 Referer，桌面端 Referer 会返回 status:301。
const KUWO_HEADERS = {
  Referer: 'https://m.kuwo.cn/'
}
const ITUNES_HEADERS = {
  Accept: 'application/json'
}

const qqSearchLimiter = createLimiter(6)
const kuwoSearchLimiter = createLimiter(6)

// iTunes Search API 按 IP 限流（约 20 次/分钟）。批量匹配时用令牌桶排队，
// 403/429 后整体冷却，避免把配额耗尽变成整轮失败。
const ITUNES_TOKEN_CAPACITY = 5
const ITUNES_TOKEN_REFILL_PER_MS = 1 / 2_500
const ITUNES_RATE_LIMIT_COOLDOWN_MS = 60_000
const ITUNES_RATE_LIMIT_COOLDOWN_MAX_MS = 5 * 60_000

const searchCaches = {
  qq: new Map(),
  kuwo: new Map(),
  itunes: new Map()
}
const lyricsCaches = {
  qq: new Map(),
  kuwo: new Map()
}
// 三个来源同属一个插件，共用同一条 RPC 熔断器；单个来源故障必须就地吞掉
// 并只冷却自己，否则 iTunes 的网络故障会让 QQ/酷我一起被熔断。
const SEARCH_SOURCE_COOLDOWN_MS = { qq: 30_000, kuwo: 30_000, itunes: 60_000 }
const SEARCH_SOURCE_LABELS = { qq: 'QQ 音乐', kuwo: '酷我音乐', itunes: 'iTunes' }
const searchSourceCooldowns = { qq: 0, kuwo: 0, itunes: 0 }
let itunesTokenCount = ITUNES_TOKEN_CAPACITY
let itunesRefillAt = Date.now()
let itunesCooldownMs = 0
let itunesCooldownUntil = 0

const PROVIDERS = [
  {
    id: 'qq',
    name: 'QQ音乐',
    capabilities: ['search', 'lyrics', 'cover'],
    ui: {
      icon: 'pi pi-comments',
      color: '#31c27c',
      description: 'QQ 音乐：标签、封面与歌词回退源',
      authType: 'settings',
      metadataOnly: true
    },
    searchSongs: (keywords, limit, offset, requestContext) =>
      searchWithCache('qq', keywords, limit, offset, requestContext, fetchQqSearch),
    getLyrics: getQqLyrics
  },
  {
    id: 'kuwo',
    name: '酷我音乐',
    capabilities: ['search', 'lyrics', 'cover'],
    ui: {
      icon: 'pi pi-headphones',
      color: '#f7b500',
      description: '酷我音乐：标签与歌词回退源',
      authType: 'settings',
      metadataOnly: true
    },
    searchSongs: (keywords, limit, offset, requestContext) =>
      searchWithCache('kuwo', keywords, limit, offset, requestContext, fetchKuwoSearch),
    getLyrics: getKuwoLyrics
  },
  {
    id: 'itunes',
    name: 'iTunes',
    capabilities: ['search', 'cover'],
    ui: {
      icon: 'pi pi-apple',
      color: '#fa243c',
      description: 'iTunes：元数据与封面最后回退源',
      authType: 'settings',
      metadataOnly: true
    },
    searchSongs: (keywords, limit, offset, requestContext) =>
      searchWithCache('itunes', keywords, limit, offset, requestContext, fetchItunesSearch)
  }
]

export async function activate(context) {
  contextRef = context
  resetState()
  for (const provider of PROVIDERS) {
    await context.twilight.providers.register(provider)
  }
  context.logger?.info?.('Metadata providers registered: QQ Music, Kuwo, iTunes')
}

export function deactivate() {
  contextRef = null
  resetState()
}

function resetState() {
  for (const cache of Object.values(searchCaches)) cache.clear()
  for (const cache of Object.values(lyricsCaches)) cache.clear()
  itunesTokenCount = ITUNES_TOKEN_CAPACITY
  itunesRefillAt = Date.now()
  itunesCooldownMs = 0
  itunesCooldownUntil = 0
  for (const source of Object.keys(searchSourceCooldowns)) searchSourceCooldowns[source] = 0
}

function getContext() {
  return contextRef
}

function logWarn(message) {
  try {
    getContext()?.logger?.warn?.(message)
  } catch {
    // Diagnostics must never break a metadata lookup.
  }
}

function createUpstreamError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function abortError(signal) {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('Provider request was cancelled')
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  throw abortError(signal)
}

function waitWithAbort(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function createLimiter(limit) {
  let active = 0
  const waiters = []
  const release = () => {
    const next = waiters.shift()
    if (!next) {
      active = Math.max(0, active - 1)
      return
    }
    next.cleanup()
    next.resolve(release)
  }
  const acquire = (signal) => {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (active < limit) {
      active += 1
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: () => undefined }
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(abortError(signal))
      }
      waiter.cleanup = () => signal?.removeEventListener('abort', onAbort)
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.push(waiter)
    })
  }
  return { acquire }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function normalizeDate(value) {
  const text = cleanString(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!match) return null
  return Number(match[1]) > 0 ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function normalizeUnixDate(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  // QQ 的 pubtime 以北京时间零点为基准，直接按 UTC 会少一天。
  return new Date(seconds * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function clampLimit(value) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return 20
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, number))
}

function normalizeOffset(value) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) && number > 0 ? number : 0
}

function readTimedCache(cache, key, ttlMs) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > ttlMs) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function writeTimedCache(cache, key, value, capacity) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > capacity) {
    cache.delete(cache.keys().next().value)
  }
}

async function searchWithCache(source, keywords, limit, offset, requestContext, fetchResults) {
  const query = cleanString(keywords)
  const normalizedLimit = clampLimit(limit)
  const normalizedOffset = normalizeOffset(offset)
  if (!query) return { items: [], total: 0 }
  const cacheKey = `${query}\u0000${normalizedLimit}\u0000${normalizedOffset}`
  const cached = readTimedCache(searchCaches[source], cacheKey, SEARCH_CACHE_TTL_MS)
  if (cached) return cached
  if (Date.now() < searchSourceCooldowns[source]) return { items: [], total: 0 }
  let value
  try {
    value = await fetchResults(query, normalizedLimit, normalizedOffset, requestContext?.signal)
  } catch (error) {
    if (requestContext?.signal?.aborted) throw error
    noteSearchSourceFailure(source, error)
    return { items: [], total: 0 }
  }
  if (value.items.length > 0) {
    writeTimedCache(searchCaches[source], cacheKey, value, SEARCH_CACHE_CAPACITY)
  }
  return value
}

function noteSearchSourceFailure(source, error) {
  const now = Date.now()
  const cooldownMs = SEARCH_SOURCE_COOLDOWN_MS[source] ?? 30_000
  const wasCoolingDown = now < searchSourceCooldowns[source]
  searchSourceCooldowns[source] = now + cooldownMs
  // iTunes 的 429/403 已由 noteItunesRateLimit 记录过日志，避免重复刷屏。
  if (wasCoolingDown || (source === 'itunes' && error?.code === 'PROVIDER_RATE_LIMITED')) return
  const detail = typeof error?.message === 'string' && error.message ? `：${error.message}` : ''
  logWarn(
    `${SEARCH_SOURCE_LABELS[source] ?? source} 搜索失败，暂停该来源 ${Math.ceil(cooldownMs / 1000)} 秒${detail}`
  )
}

async function fetchText(
  url,
  { headers = {}, signal, timeoutMs = REQUEST_TIMEOUT_MS, label = '上游请求', onRateLimited } = {}
) {
  throwIfAborted(signal)
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`${label} 请求超时`))
  }, timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: controller.signal
    })
    if (response.status === 403 || response.status === 429) {
      onRateLimited?.()
      throw createUpstreamError(`${label} 触发限流（HTTP ${response.status}）`, 'PROVIDER_RATE_LIMITED')
    }
    if (!response.ok) {
      throw createUpstreamError(`${label} HTTP ${response.status}`, 'PROVIDER_HTTP_ERROR')
    }
    return await response.text()
  } catch (error) {
    throwIfAborted(signal)
    if (timedOut) throw createUpstreamError(`${label} 请求超时`, 'PROVIDER_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options)
  if (!text.trim()) throw new Error(`${options.label ?? '上游'}返回空响应`)
  return parseLooseJson(text, options.label)
}

export function parseLooseJson(text, label = '上游响应') {
  const trimmed = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
  if (!trimmed) throw new Error(`${label}返回空响应`)
  const payloads = [trimmed]
  const open = trimmed.indexOf('(')
  const close = trimmed.lastIndexOf(')')
  if (open > 0 && close > open) {
    payloads.push(trimmed.slice(open + 1, close).trim())
  }
  for (const payload of payloads) {
    const direct = tryJsonParse(payload)
    if (direct !== undefined) return direct
    const normalized = normalizeLooseJson(payload)
    const parsed = tryJsonParse(normalized)
    if (parsed !== undefined) return parsed
  }
  throw new Error(`${label}返回了无法解析的数据`)
}

function tryJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// 酷我旧版 r.s 接口在部分环境下返回单引号 JSON；逐字符转换，避免粗暴
// replace 把歌词或歌名里的撇号误当成字符串边界。
export function normalizeLooseJson(input) {
  let output = ''
  let quote = ''
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (!quote) {
      if (char === "'" || char === '"') {
        quote = char
        output += '"'
      } else {
        output += char
      }
      continue
    }
    if (char === '\\') {
      const next = input[index + 1]
      if (next === undefined) {
        output += '\\\\'
        continue
      }
      if (next === quote) {
        output += quote === "'" ? "'" : '\\"'
      } else if (next === '"') {
        output += '\\"'
      } else {
        output += `\\${next}`
      }
      index += 1
      continue
    }
    if (char === quote) {
      quote = ''
      output += '"'
      continue
    }
    if (char === '"') {
      output += '\\"'
      continue
    }
    if (char === '\n') {
      output += '\\n'
      continue
    }
    if (char === '\r') {
      output += '\\r'
      continue
    }
    if (char === '\t') {
      output += '\\t'
      continue
    }
    output += char
  }
  return output
}

async function fetchQqSearch(keywords, limit, offset, signal) {
  const release = await qqSearchLimiter.acquire(signal)
  try {
    const page = Math.floor(offset / limit) + 1
    // client_search_cp 已返回空响应 500，musicu.fcg 匿名访问返回 code 2001；
    // search_for_qq_cp 是目前仍允许匿名调用的网页搜索入口。
    const url = new URL('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp')
    url.search = new URLSearchParams({
      format: 'json',
      w: keywords,
      n: String(limit),
      p: String(page),
      new_json: '1',
      cr: '1',
      aggr: '1',
      lossless: '1',
      g_tk: '5381'
    }).toString()
    const data = await fetchJson(url, {
      headers: QQ_HEADERS,
      signal,
      label: 'QQ 音乐搜索'
    })
    const songs = Array.isArray(data?.data?.song?.list) ? data.data.song.list : []
    const declaredTotal = Number(data?.data?.song?.totalnum)
    const items = songs.slice(0, limit).map(normalizeQqSong).filter(Boolean)
    return {
      items,
      total: Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : items.length
    }
  } finally {
    release()
  }
}

export function normalizeQqSong(song) {
  const mid = cleanString(song?.mid) || cleanString(song?.songmid)
  const songId = positiveInteger(song?.id) ?? positiveInteger(song?.songid)
  const idPart = mid || (songId ? String(songId) : '')
  if (!idPart) return null
  const title =
    cleanString(song?.name) || cleanString(song?.title) || cleanString(song?.songname)
  if (!title) return null
  const singerNames = (Array.isArray(song?.singer) ? song.singer : [])
    .map((singer) => cleanString(singer?.name))
    .filter(Boolean)
  const artist = singerNames.join(' / ') || cleanString(song?.artist) || '未知艺术家'
  const albumMid = cleanString(song?.album?.mid) || cleanString(song?.albummid)
  const album = cleanString(song?.album?.name) || cleanString(song?.albumname) || '未知专辑'
  const albumCover = albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
    : null
  const duration = positiveInteger(song?.interval) ?? 0
  const releaseDate =
    normalizeDate(song?.time_public) ??
    normalizeDate(song?.album?.time_public) ??
    normalizeUnixDate(song?.pubtime) ??
    undefined
  const trackNumber = positiveInteger(song?.index_album)
  const discIndex = Number(song?.index_cd)
  const discNumber =
    Number.isInteger(discIndex) && discIndex >= 0 ? discIndex + 1 : undefined
  const track = {
    id: `qq:${idPart}`,
    title,
    artist,
    album,
    filePath: `qq:${idPart}`,
    fileName: `${artist} - ${title}`,
    duration,
    size: 0,
    cover: albumCover,
    lyrics: null,
    source: 'qq',
    qqSongMid: mid || undefined,
    qqSongId: songId
  }
  if (releaseDate) track.releaseDate = releaseDate
  if (trackNumber !== undefined) track.trackNumber = trackNumber
  if (discNumber !== undefined) track.discNumber = discNumber
  return track
}

export function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    })
    .replace(/&#(\d+);/g, (match, decimal) => {
      const code = Number.parseInt(decimal, 10)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
      const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
      return entities[String(name).toLowerCase()] ?? match
    })
}

function safeFromCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

async function getQqLyrics(track, requestContext) {
  const mid = cleanString(track?.qqSongMid) || providerTrackId(track, 'qq')
  if (!mid) return emptyLyrics()
  const cached = readTimedCache(lyricsCaches.qq, mid, LYRICS_CACHE_TTL_MS)
  if (cached) return cached
  const url = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg')
  url.search = new URLSearchParams({
    songmid: mid,
    format: 'json',
    nobase64: '1'
  }).toString()
  let data
  try {
    data = await fetchJson(url, {
      headers: QQ_HEADERS,
      signal: requestContext?.signal,
      label: 'QQ 音乐歌词'
    })
  } catch (error) {
    if (requestContext?.signal?.aborted) throw error
    // 歌词只是附加信息：单曲失败返回空，避免把整条多源插件熔断。
    return emptyLyrics()
  }
  const lyrics = decodeHtmlEntities(cleanString(data?.lyric))
  if (!lyrics) return emptyLyrics()
  const value = { lyrics, translatedLyrics: null, wordLyrics: null }
  writeTimedCache(lyricsCaches.qq, mid, value, LYRICS_CACHE_CAPACITY)
  return value
}

async function fetchKuwoSearch(keywords, limit, offset, signal) {
  const release = await kuwoSearchLimiter.acquire(signal)
  try {
    const page = Math.floor(offset / limit)
    const url = new URL('https://search.kuwo.cn/r.s')
    url.search = new URLSearchParams({
      client: 'kt',
      all: keywords,
      pn: String(page),
      rn: String(limit),
      uid: '0',
      ver: 'kwplayer_ar_9.2.2.1',
      vipver: '1',
      show_copyright_off: '1',
      newver: '1',
      ft: 'music',
      cluster: '0',
      strategy: '2012',
      encoding: 'utf8',
      rformat: 'json',
      vermerge: '1',
      mobi: '1'
    }).toString()
    const data = await fetchJson(url, {
      headers: KUWO_HEADERS,
      signal,
      label: '酷我音乐搜索'
    })
    const songs = Array.isArray(data?.abslist)
      ? data.abslist
      : Array.isArray(data?.data?.abslist)
        ? data.data.abslist
        : []
    const declaredTotal = Number(data?.TOTAL ?? data?.total)
    const items = songs.map(normalizeKuwoSong).filter(Boolean)
    return {
      items,
      total: Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : items.length
    }
  } finally {
    release()
  }
}

export function normalizeKuwoSong(song) {
  const rawId =
    cleanString(song?.MUSICRID) ||
    String(song?.DC_TARGETID ?? song?.MUSICID ?? '').trim()
  const idPart = rawId.replace(/^MUSIC_/i, '')
  if (!idPart) return null
  const title =
    cleanString(song?.SONGNAME) || cleanString(song?.NAME) || cleanString(song?.FSONGNAME)
  if (!title) return null
  const artist =
    (cleanString(song?.ARTIST) || cleanString(song?.FARTIST) || '未知艺术家').replace(
      /\s*&\s*/g,
      ' / '
    ) || '未知艺术家'
  const album = cleanString(song?.ALBUM) || '未知专辑'
  const duration = positiveInteger(song?.DURATION) ?? 0
  return {
    id: `kuwo:${idPart}`,
    title,
    artist,
    album,
    filePath: `kuwo:${idPart}`,
    fileName: `${artist} - ${title}`,
    duration,
    size: 0,
    cover: kuwoCoverUrl(song),
    lyrics: null,
    source: 'kuwo',
    kuwoMusicId: idPart
  }
}

function kuwoCoverUrl(song) {
  const rawPath = cleanString(song?.web_albumpic_short)
  if (!rawPath) return null
  const path = rawPath.replace(/^\/+/, '').replace(/^\d+\//, '')
  if (!/^[\w./-]+$/.test(path)) return null
  return `https://img1.kuwo.cn/star/albumcover/500/${path}`
}

async function getKuwoLyrics(track, requestContext) {
  const musicId = cleanString(track?.kuwoMusicId) || providerTrackId(track, 'kuwo')
  if (!musicId) return emptyLyrics()
  const cached = readTimedCache(lyricsCaches.kuwo, musicId, LYRICS_CACHE_TTL_MS)
  if (cached) return cached
  const lrcList = await fetchKuwoLyricList(musicId, requestContext)
  if (!Array.isArray(lrcList)) return emptyLyrics()
  const lyrics = kuwoLrcFromList(lrcList)
  if (!lyrics) return emptyLyrics()
  const value = { lyrics, translatedLyrics: null, wordLyrics: null }
  writeTimedCache(lyricsCaches.kuwo, musicId, value, LYRICS_CACHE_CAPACITY)
  return value
}

async function fetchKuwoLyricList(musicId, requestContext) {
  const signal = requestContext?.signal
  // 移动端 songinfoandlrc 会随机返回 status:301「音乐查询失败」；开放式
  // lyric/getlyric 接口稳定得多，保留旧接口仅作兜底。
  try {
    const url = new URL('https://www.kuwo.cn/openapi/v1/www/lyric/getlyric')
    url.search = new URLSearchParams({ musicId, httpsStatus: '1' }).toString()
    const data = await fetchJson(url, {
      headers: KUWO_HEADERS,
      signal,
      label: '酷我音乐歌词'
    })
    const list = data?.data?.lrclist
    if (Array.isArray(list)) return list
  } catch (error) {
    if (signal?.aborted) throw error
  }
  try {
    const url = new URL('https://m.kuwo.cn/newh5/singles/songinfoandlrc')
    url.search = new URLSearchParams({
      musicId,
      reqId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      httpsStatus: '1'
    }).toString()
    const data = await fetchJson(url, {
      headers: KUWO_HEADERS,
      signal,
      label: '酷我音乐歌词'
    })
    const list = data?.data?.lrclist
    return Array.isArray(list) ? list : null
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

export function kuwoLrcFromList(lrcList) {
  const lines = []
  for (const item of Array.isArray(lrcList) ? lrcList : []) {
    const text = cleanString(item?.lineLyric)
    if (!text) continue
    const timestamp = lrcTimestamp(item?.time)
    if (!timestamp) continue
    lines.push(`${timestamp}${text}`)
  }
  return lines.join('\n')
}

function lrcTimestamp(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const centiseconds = Math.round(seconds * 100)
  const minutes = Math.floor(centiseconds / 6_000)
  const remainder = centiseconds % 6_000
  const wholeSeconds = Math.floor(remainder / 100)
  const fraction = remainder % 100
  const pad = (number) => String(number).padStart(2, '0')
  return `[${pad(minutes)}:${pad(wholeSeconds)}.${pad(fraction)}]`
}

function emptyLyrics() {
  return { lyrics: null, translatedLyrics: null, wordLyrics: null }
}

function providerTrackId(track, providerId) {
  const id = typeof track?.id === 'string' ? track.id : ''
  const prefix = `${providerId}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : ''
}

export function selectItunesCountry(keywords) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(keywords)
    ? 'TW'
    : 'US'
}

function noteItunesRateLimit() {
  const now = Date.now()
  if (now < itunesCooldownUntil) return
  itunesCooldownMs = itunesCooldownMs
    ? Math.min(ITUNES_RATE_LIMIT_COOLDOWN_MAX_MS, itunesCooldownMs * 2)
    : ITUNES_RATE_LIMIT_COOLDOWN_MS
  itunesCooldownUntil = now + itunesCooldownMs
  itunesTokenCount = 0
  logWarn(`iTunes 搜索触发限流，暂停 ${Math.ceil(itunesCooldownMs / 1000)} 秒`)
}

function throwIfItunesCoolingDown() {
  const now = Date.now()
  if (now >= itunesCooldownUntil) return
  throw createUpstreamError(
    `iTunes 搜索冷却中（${Math.ceil((itunesCooldownUntil - now) / 1000)} 秒后重试）`,
    'PROVIDER_RATE_LIMITED'
  )
}

async function acquireItunesToken(signal) {
  while (true) {
    throwIfAborted(signal)
    throwIfItunesCoolingDown()
    const now = Date.now()
    if (now < itunesRefillAt) {
      itunesRefillAt = now
    } else {
      itunesTokenCount = Math.min(
        ITUNES_TOKEN_CAPACITY,
        itunesTokenCount + (now - itunesRefillAt) * ITUNES_TOKEN_REFILL_PER_MS
      )
      itunesRefillAt = now
    }
    if (itunesTokenCount >= 1) {
      itunesTokenCount -= 1
      return
    }
    await waitWithAbort(
      Math.max(50, Math.ceil((1 - itunesTokenCount) / ITUNES_TOKEN_REFILL_PER_MS)),
      signal
    )
  }
}

async function fetchItunesSearch(keywords, limit, offset, signal) {
  const country = selectItunesCountry(keywords)
  const requestedLimit = Math.min(200, limit + offset)
  await acquireItunesToken(signal)
  const url = new URL('https://itunes.apple.com/search')
  url.search = new URLSearchParams({
    term: keywords,
    country,
    media: 'music',
    entity: 'song',
    limit: String(requestedLimit)
  }).toString()
  const data = await fetchJson(url, {
    headers: ITUNES_HEADERS,
    signal,
    label: 'iTunes 搜索',
    onRateLimited: noteItunesRateLimit
  })
  if (data?.errorMessage) throw new Error(`iTunes 搜索失败：${cleanString(data.errorMessage)}`)
  const results = Array.isArray(data?.results) ? data.results : []
  const declaredTotal = Number(data?.resultCount)
  return {
    items: results
      .slice(offset, offset + limit)
      .map(normalizeItunesSong)
      .filter(Boolean),
    total:
      Number.isFinite(declaredTotal) && declaredTotal >= 0 ? declaredTotal : results.length
  }
}

export function normalizeItunesSong(song) {
  const trackId = positiveInteger(song?.trackId)
  if (!trackId) return null
  if (song?.wrapperType && song.wrapperType !== 'track') return null
  if (song?.kind && song.kind !== 'song') return null
  const title = cleanString(song?.trackName)
  if (!title) return null
  const artist = cleanString(song?.artistName) || '未知艺术家'
  const album = cleanString(song?.collectionName) || '未知专辑'
  const durationMs = Number(song?.trackTimeMillis)
  const duration =
    Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0
  const releaseDate = normalizeDate(song?.releaseDate) ?? undefined
  const genre = cleanString(song?.primaryGenreName)
  const trackNumber = positiveInteger(song?.trackNumber)
  const discNumber = positiveInteger(song?.discNumber)
  const track = {
    id: `itunes:${trackId}`,
    title,
    artist,
    album,
    filePath: `itunes:${trackId}`,
    fileName: `${artist} - ${title}`,
    duration,
    size: 0,
    cover: itunesCoverUrl(song?.artworkUrl100),
    lyrics: null,
    source: 'itunes',
    itunesTrackId: trackId
  }
  if (releaseDate) track.releaseDate = releaseDate
  if (genre) track.genre = genre
  if (trackNumber !== undefined) track.trackNumber = trackNumber
  if (discNumber !== undefined) track.discNumber = discNumber
  return track
}

function itunesCoverUrl(value) {
  const url = cleanString(value)
  if (!url) return null
  return url.replace(/\/\d+x\d+(bb)?\.(jpg|jpeg|png)$/i, '/600x600bb.$2')
}
