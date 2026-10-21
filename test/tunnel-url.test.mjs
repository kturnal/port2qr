import assert from 'node:assert/strict'
import test from 'node:test'
import {findQuickTunnelUrl} from '../src/tunnel-url.mjs'

test('extracts a Quick Tunnel URL from cloudflared output', () => {
  const output = 'INF Your quick Tunnel has been created! https://quiet-bird-42.trycloudflare.com'
  assert.equal(findQuickTunnelUrl(output), 'https://quiet-bird-42.trycloudflare.com')
})

test('ignores unrelated and lookalike URLs', () => {
  assert.equal(findQuickTunnelUrl('https://example.com'), null)
  assert.equal(findQuickTunnelUrl('https://trycloudflare.com.evil.example'), null)
})
