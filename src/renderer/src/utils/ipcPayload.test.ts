import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reactive, toRaw } from 'vue'
import { toPlainIpcPayload } from './ipcPayload.ts'

/**
 * contextBridge serialises renderer -> preload arguments with structured clone,
 * which rejects Vue reactive proxies ("An object could not be cloned."). The
 * preload's own JSON round-trip cannot save it: the value never arrives.
 */

test('reactive proxies are stripped before the payload crosses IPC', () => {
  const state = reactive({
    audioEqPresets: [
      { id: 'custom-1', name: 'preset', eqBands: [{ frequency: 45, gain: 7.35, q: 0.7 }] }
    ]
  })

  // The trap: reading through a reactive object yields proxies, not plain data.
  const proxied = state.audioEqPresets
  assert.notEqual(toRaw(proxied[0]), proxied[0])

  const payload = toPlainIpcPayload({ audioEqPresets: [...proxied, { id: 'new' }] })

  assert.deepEqual(payload, {
    audioEqPresets: [
      { id: 'custom-1', name: 'preset', eqBands: [{ frequency: 45, gain: 7.35, q: 0.7 }] },
      { id: 'new' }
    ]
  })
  // Nothing in the payload may still point at reactive state.
  assert.notEqual(payload.audioEqPresets[0], proxied[0])
  assert.equal(toRaw(payload.audioEqPresets[0]), payload.audioEqPresets[0])
})

test('nested arrays inside a spread object are copied, not shared', () => {
  const compensation = reactive({
    enabled: true,
    productName: 'DT 770 Pro',
    bands: [{ frequency: 100, gain: 3, q: 1 }]
  })

  // Spreading a reactive object keeps the nested array reactive; that is exactly
  // how disableOpraCompensation produced a non-cloneable payload.
  const naive = { ...compensation, enabled: false }
  const payload = toPlainIpcPayload(naive)

  assert.equal(payload.enabled, false)
  assert.deepEqual(payload.bands, [{ frequency: 100, gain: 3, q: 1 }])
  assert.notEqual(payload.bands, compensation.bands)
})

test('undefined members are dropped instead of failing the clone', () => {
  const payload = toPlainIpcPayload({
    headphoneCompensation: { enabled: false, eqId: undefined, bands: [] }
  })
  assert.deepEqual(payload, { headphoneCompensation: { enabled: false, bands: [] } })
})
