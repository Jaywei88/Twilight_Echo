import assert from 'node:assert/strict'
import test from 'node:test'

import * as metadataProviders from './index.mjs'

const realFetch = globalThis.fetch

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}

async function activateProviders() {
  const providers = new Map()
  await metadataProviders.activate({
    twilight: {
      providers: {
        register: async (provider) => {
          providers.set(provider.id, provider)
        }
      }
    },
    logger: { info: () => undefined, warn: () => undefined }
  })
  return providers
}

function withFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init)
  return () => {
    globalThis.fetch = realFetch
    metadataProviders.deactivate()
  }
}

function qqSong(overrides = {}) {
  return {
    mid: '003nYgF01aN0yF',
    id: 107508849,
    name: '月亮代表我的心',
    singer: [{ name: '邓丽君' }],
    album: { mid: '004f5Qrc3donOX', name: '歌曲精选80首', time_public: '' },
    interval: 215,
    time_public: '1993-01-01',
    index_album: 3,
    index_cd: 0,
    ...overrides
  }
}

test('metadata providers register as hidden multi-source providers', async () => {
  const providers = await activateProviders()
  try {
    assert.deepEqual([...providers.keys()], ['qq', 'kuwo', 'itunes'])
    for (const provider of providers.values()) {
      assert.equal(provider.ui.metadataOnly, true)
      assert.equal(provider.capabilities.includes('search'), true)
    }
    assert.equal(providers.get('qq').capabilities.includes('lyrics'), true)
    assert.equal(providers.get('kuwo').capabilities.includes('lyrics'), true)
    assert.equal(providers.get('itunes').capabilities.includes('lyrics'), false)
  } finally {
    metadataProviders.deactivate()
  }
})

test('QQ search normalizes tags, cover, track number and pagination', async () => {
  let requestedUrl = null
  const dispose = withFetch(async (url, init) => {
    requestedUrl = new URL(url)
    assert.equal(init.headers.Referer, 'https://y.qq.com/')
    return jsonResponse({ data: { song: { totalnum: 42, list: [qqSong()] } } })
  })
  try {
    const providers = await activateProviders()
    const result = await providers.get('qq').searchSongs('月亮代表我的心 邓丽君', 20, 20)
    assert.equal(requestedUrl.hostname, 'c.y.qq.com')
    assert.equal(requestedUrl.searchParams.get('w'), '月亮代表我的心 邓丽君')
    assert.equal(requestedUrl.searchParams.get('n'), '20')
    assert.equal(requestedUrl.searchParams.get('p'), '2')
    assert.equal(result.total, 42)
    assert.deepEqual(result.items[0], {
      id: 'qq:003nYgF01aN0yF',
      title: '月亮代表我的心',
      artist: '邓丽君',
      album: '歌曲精选80首',
      filePath: 'qq:003nYgF01aN0yF',
      fileName: '邓丽君 - 月亮代表我的心',
      duration: 215,
      size: 0,
      cover: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000004f5Qrc3donOX.jpg',
      lyrics: null,
      source: 'qq',
      qqSongMid: '003nYgF01aN0yF',
      qqSongId: 107508849,
      releaseDate: '1993-01-01',
      trackNumber: 3,
      discNumber: 1
    })
  } finally {
    dispose()
  }
})

test('QQ lyrics decode HTML entities and are cached per song', async () => {
  let calls = 0
  const dispose = withFetch(async (url) => {
    calls += 1
    const parsed = new URL(url)
    assert.equal(parsed.pathname, '/lyric/fcgi-bin/fcg_query_lyric_new.fcg')
    assert.equal(parsed.searchParams.get('songmid'), '003nYgF01aN0yF')
    assert.equal(parsed.searchParams.get('nobase64'), '1')
    return jsonResponse({ retcode: 0, lyric: '[00:00.00]A &amp; B&#58; &#x4f60;' })
  })
  try {
    const providers = await activateProviders()
    const track = { id: 'qq:003nYgF01aN0yF', qqSongMid: '003nYgF01aN0yF' }
    const first = await providers.get('qq').getLyrics(track)
    assert.equal(first.lyrics, '[00:00.00]A & B: 你')
    const second = await providers.get('qq').getLyrics(track)
    assert.equal(second.lyrics, first.lyrics)
    assert.equal(calls, 1)
  } finally {
    dispose()
  }
})

test('QQ lyrics failures resolve empty instead of tripping the provider', async () => {
  const dispose = withFetch(async () => jsonResponse('lyric backend down', 502))
  try {
    const providers = await activateProviders()
    assert.deepEqual(await providers.get('qq').getLyrics({ id: 'qq:missing' }), {
      lyrics: null,
      translatedLyrics: null,
      wordLyrics: null
    })
  } finally {
    dispose()
  }
})

test('loose JSON parser accepts single-quoted Kuwo payloads', () => {
  const loose = "{'ARTIST':'A & B','SONGNAME':'It\\'s me','DURATION':'215'}"
  assert.deepEqual(metadataProviders.parseLooseJson(loose), {
    ARTIST: 'A & B',
    SONGNAME: "It's me",
    DURATION: '215'
  })
  assert.deepEqual(metadataProviders.parseLooseJson('MusicJsonCallback({"a":1})'), { a: 1 })
})

test('Kuwo search maps legacy r.s fields and tolerates single quotes', async () => {
  let requestedUrl = null
  const dispose = withFetch(async (url) => {
    requestedUrl = new URL(url)
    return jsonResponse(
      "{'TOTAL':'128','abslist':[{'MUSICRID':'MUSIC_228908','SONGNAME':'晴天','ARTIST':'周杰伦','ALBUM':'叶惠美','DURATION':'269','web_albumpic_short':'120/s4s67/60/298834945.jpg'}]}"
    )
  })
  try {
    const providers = await activateProviders()
    const result = await providers.get('kuwo').searchSongs('晴天 周杰伦', 10, 0)
    assert.equal(requestedUrl.hostname, 'search.kuwo.cn')
    assert.equal(requestedUrl.searchParams.get('all'), '晴天 周杰伦')
    assert.equal(requestedUrl.searchParams.get('rn'), '10')
    assert.equal(result.total, 128)
    assert.deepEqual(result.items[0], {
      id: 'kuwo:228908',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      filePath: 'kuwo:228908',
      fileName: '周杰伦 - 晴天',
      duration: 269,
      size: 0,
      cover: 'https://img1.kuwo.cn/star/albumcover/500/s4s67/60/298834945.jpg',
      lyrics: null,
      source: 'kuwo',
      kuwoMusicId: '228908'
    })
  } finally {
    dispose()
  }
})

test('Kuwo lyrics use the stable openapi endpoint and fall back to the legacy one', async () => {
  let openapiResponse = {
    data: {
      lrclist: [
        { time: '0.0', lineLyric: '晴天 - 周杰伦' },
        { time: '2.25', lineLyric: '词：周杰伦' },
        { time: '4.5', lineLyric: '' }
      ]
    }
  }
  const requestedMusicIds = []
  const requests = []
  const dispose = withFetch(async (url) => {
    const parsed = new URL(url)
    requests.push(`${parsed.hostname}${parsed.pathname}`)
    requestedMusicIds.push(parsed.searchParams.get('musicId'))
    if (parsed.hostname === 'www.kuwo.cn') {
      assert.equal(parsed.pathname, '/openapi/v1/www/lyric/getlyric')
      return jsonResponse(openapiResponse)
    }
    assert.equal(parsed.hostname, 'm.kuwo.cn')
    assert.equal(parsed.pathname, '/newh5/singles/songinfoandlrc')
    assert.ok(parsed.searchParams.get('reqId'))
    return jsonResponse({ data: null, status: 301 })
  })
  try {
    const providers = await activateProviders()
    const lyrics = await providers.get('kuwo').getLyrics({ id: 'kuwo:228908' })
    assert.equal(lyrics.lyrics, '[00:00.00]晴天 - 周杰伦\n[00:02.25]词：周杰伦')
    openapiResponse = { code: 200, data: null }
    const missing = await providers.get('kuwo').getLyrics({ id: 'kuwo:161705' })
    assert.equal(missing.lyrics, null)
    assert.deepEqual(requestedMusicIds, ['228908', '161705', '161705'])
    assert.deepEqual(requests, [
      'www.kuwo.cn/openapi/v1/www/lyric/getlyric',
      'www.kuwo.cn/openapi/v1/www/lyric/getlyric',
      'm.kuwo.cn/newh5/singles/songinfoandlrc'
    ])
  } finally {
    dispose()
  }
})

test('iTunes chooses a CJK-friendly storefront and normalizes songs', async () => {
  assert.equal(metadataProviders.selectItunesCountry('晴天 周杰伦'), 'TW')
  assert.equal(metadataProviders.selectItunesCountry('Moon River Audrey'), 'US')
  let requestedUrl = null
  const dispose = withFetch(async (url) => {
    requestedUrl = new URL(url)
    return jsonResponse({
      resultCount: 1,
      results: [
        {
          wrapperType: 'track',
          kind: 'song',
          trackId: 535824738,
          trackName: '晴天',
          artistName: '周杰倫',
          collectionName: '葉惠美',
          trackTimeMillis: 269747,
          releaseDate: '2003-07-31T07:00:00Z',
          primaryGenreName: '華語流行樂',
          trackNumber: 3,
          discNumber: 1,
          artworkUrl100:
            'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/45/8a/e4/cover/100x100bb.jpg'
        }
      ]
    })
  })
  try {
    const providers = await activateProviders()
    const result = await providers.get('itunes').searchSongs('晴天 周杰伦', 10, 0)
    assert.equal(requestedUrl.searchParams.get('country'), 'TW')
    assert.equal(requestedUrl.searchParams.get('media'), 'music')
    assert.equal(requestedUrl.searchParams.get('entity'), 'song')
    assert.deepEqual(result.items[0], {
      id: 'itunes:535824738',
      title: '晴天',
      artist: '周杰倫',
      album: '葉惠美',
      filePath: 'itunes:535824738',
      fileName: '周杰倫 - 晴天',
      duration: 270,
      size: 0,
      cover:
        'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/45/8a/e4/cover/600x600bb.jpg',
      lyrics: null,
      source: 'itunes',
      itunesTrackId: 535824738,
      releaseDate: '2003-07-31',
      genre: '華語流行樂',
      trackNumber: 3,
      discNumber: 1
    })
  } finally {
    dispose()
  }
})

test('iTunes rate limits cool down the source and return empty results', async () => {
  let calls = 0
  const dispose = withFetch(async () => {
    calls += 1
    return jsonResponse({ errorMessage: 'Too many requests' }, 429)
  })
  try {
    const providers = await activateProviders()
    assert.deepEqual(await providers.get('itunes').searchSongs('first query', 5, 0), {
      items: [],
      total: 0
    })
    assert.deepEqual(await providers.get('itunes').searchSongs('second query', 5, 0), {
      items: [],
      total: 0
    })
    assert.equal(calls, 1, 'the cooled-down source is skipped')
  } finally {
    dispose()
  }
})

test('one failing source is isolated and does not block the other providers', async () => {
  const calls = { qq: 0, kuwo: 0 }
  const dispose = withFetch(async (url) => {
    const parsed = new URL(url)
    if (parsed.hostname === 'c.y.qq.com') {
      calls.qq += 1
      return jsonResponse('upstream broke', 500)
    }
    calls.kuwo += 1
    return jsonResponse(
      "{'TOTAL':'1','abslist':[{'MUSICRID':'MUSIC_228908','SONGNAME':'晴天','ARTIST':'周杰伦','ALBUM':'叶惠美','DURATION':'269'}]}"
    )
  })
  try {
    const providers = await activateProviders()
    assert.deepEqual(await providers.get('qq').searchSongs('晴天', 5, 0), {
      items: [],
      total: 0
    })
    assert.deepEqual(await providers.get('qq').searchSongs('晴天 周杰伦', 5, 0), {
      items: [],
      total: 0
    })
    assert.equal(calls.qq, 1, 'the failing source is skipped while cooling down')
    const kuwo = await providers.get('kuwo').searchSongs('晴天', 5, 0)
    assert.equal(kuwo.items.length, 1)
    assert.equal(calls.kuwo, 1)
  } finally {
    dispose()
  }
})

test('metadata searches stop when the caller aborts', async () => {
  const dispose = withFetch(async () => jsonResponse({ data: { song: { list: [] } } }))
  try {
    const providers = await activateProviders()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      providers.get('qq').searchSongs('moon river', 5, 0, { signal: controller.signal }),
      /cancelled|aborted/i
    )
  } finally {
    dispose()
  }
})
