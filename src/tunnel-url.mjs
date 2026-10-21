export const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i

export function findQuickTunnelUrl(output) {
  return output.match(QUICK_TUNNEL_URL)?.[0] ?? null
}
