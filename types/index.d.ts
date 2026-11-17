declare module 'claude-code' {
  interface PluginState {
    'cache': {
      record: Shaped<{
        messageId: string | null
        anchorAt: number | null
        ttl: '5m' | '1h' | null
        recacheTokens: number | null
        compactedAt: number | null
      } | null>
    }
  }
}
