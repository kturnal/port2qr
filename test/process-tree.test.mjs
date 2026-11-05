import assert from 'node:assert/strict'
import test from 'node:test'
import {parseOrphanedChildren} from '../src/process-tree.mjs'

test('keeps only orphaned children created after the root started', () => {
  const startedAt = 1_800_000_000_000
  const output = [
    `4100 ${startedAt + 250}`,
    `4200 ${startedAt - 500}`,
    `4300 ${startedAt - 60_000}`,
    'garbage',
    '',
    `4400 ${startedAt + 10}\r`,
  ].join('\r\n')

  assert.deepEqual(parseOrphanedChildren(output, startedAt), [4100, 4200, 4400])
  assert.deepEqual(parseOrphanedChildren('', startedAt), [])
})
