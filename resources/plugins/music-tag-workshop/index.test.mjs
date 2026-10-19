import test from 'node:test'
import assert from 'node:assert/strict'
import { activate, deactivate } from './index.mjs'

test('tag workshop registers a command-backed library sidebar entry', async () => {
  let page
  let command
  let handler
  await activate({
    twilight: {
      ui: {
        onCommand: (id, callback) => {
          command = id
          handler = callback
        },
        register: async (entry) => {
          page = entry
        }
      }
    }
  })
  assert.equal(page.id, 'tag-workshop')
  assert.equal(page.kind, 'sidebarPage')
  assert.equal(page.command, command)
  assert.deepEqual(handler(), { page: 'tag-workshop' })
  assert.equal(deactivate(), undefined)
})
