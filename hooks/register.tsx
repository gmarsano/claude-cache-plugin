import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Shows how long the prompt cache stays warm, by the same rules as the Claude
// Code VS Code extension's prompt cache indicator:
// the window starts when the request that wrote or read the cache was sent
// (the last main-thread user or tool-result message before the response),
// lasts the tier the response wrote (5m or 1h), and a compaction makes it cold
// until the next response.

type Ttl = '5m' | '1h'
type CacheRecord = {
  messageId: string | null
  anchorAt: number | null
  ttl: Ttl | null
  recacheTokens: number | null
  compactedAt: number | null
}
type Usage = {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
}
type Entry = {
  type?: string
  subtype?: string
  timestamp?: string
  isSidechain?: boolean
  isCompactSummary?: boolean
  message?: { id?: string; model?: string; usage?: Usage }
}
type CacheWindow =
  | { kind: 'unknown' }
  | { kind: 'warm'; ttl: Ttl; msLeft: number; minutesLeft: number }
  | { kind: 'cold'; reason: 'compacted' | 'expired'; idleMs: number; recacheTokens: number | null }

const PANE = 'cache-warm'
const TTL_MS: Record<Ttl, number> = { '5m': 300000, '1h': 3600000 }

const record = atom({ plugin: 'cache', key: 'record' } as const, null, {
  shape: 'record-1',
})

const parseTime = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null
  }
  const at = Date.parse(value)

  return Number.isNaN(at) ? null : at
}

const tierOf = (usage: Usage): Ttl | null => {
  const wrote = usage.cache_creation
  if (wrote === undefined) {
    return null
  }
  if ((wrote.ephemeral_1h_input_tokens ?? 0) > 0) {
    return '1h'
  }
  if ((wrote.ephemeral_5m_input_tokens ?? 0) > 0) {
    return '5m'
  }

  return null
}

const compacted = (state: CacheRecord | null, at: number): CacheRecord => ({
  messageId: state?.messageId ?? null,
  anchorAt: state?.anchorAt ?? null,
  ttl: state?.ttl ?? null,
  recacheTokens: state?.recacheTokens ?? null,
  compactedAt: at,
})

const replay = (text: string): CacheRecord | null => {
  let current: CacheRecord | null = null
  let requestAt: number | null = null

  for (const line of text.split('\n')) {
    const relevant =
      line.includes('"type":"user"') ||
      line.includes('"type":"assistant"') ||
      line.includes('"compact_boundary"')
    if (!relevant || line.includes('"isSidechain":true')) {
      continue
    }
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    const at = parseTime(entry.timestamp)

    if (entry.type === 'user') {
      if (at !== null) {
        requestAt = Math.max(requestAt ?? at, at)
      }
      if (entry.isCompactSummary === true && at !== null) {
        current = compacted(current, at)
      }
      continue
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && at !== null) {
      current = compacted(current, at)
      continue
    }

    const usage = entry.message?.usage
    if (entry.type !== 'assistant' || usage === undefined || entry.message?.model === '<synthetic>') {
      continue
    }
    const messageId = entry.message?.id ?? null
    const sameMessage = current !== null && messageId !== null && current.messageId === messageId
    const sentAt = requestAt !== null && (at === null || requestAt <= at) ? requestAt : at
    const anchorAt = sameMessage && current?.anchorAt != null ? current.anchorAt : sentAt
    const touched = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) > 0
    const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    if (total <= 0) {
      continue
    }
    const compactedAt = current?.compactedAt ?? null
    const staysCompacted = compactedAt !== null && (sameMessage || !(at !== null && at > compactedAt))
    if (messageId !== current?.messageId) {
      requestAt = null
    }
    current = {
      messageId,
      anchorAt,
      ttl: touched ? (tierOf(usage) ?? current?.ttl ?? null) : null,
      recacheTokens: total,
      compactedAt: staysCompacted ? compactedAt : null,
    }
  }

  return current
}

const windowOf = (state: CacheRecord | null, at: number): CacheWindow => {
  if (state?.compactedAt != null) {
    return { kind: 'cold', reason: 'compacted', idleMs: Math.max(0, at - state.compactedAt), recacheTokens: null }
  }
  if (state === null || state.anchorAt === null || state.ttl === null) {
    return { kind: 'unknown' }
  }
  const ttl = TTL_MS[state.ttl]
  const msLeft = Math.min(ttl, state.anchorAt + ttl - at)
  if (msLeft > 0) {
    return { kind: 'warm', ttl: state.ttl, msLeft, minutesLeft: Math.ceil(msLeft / 60000) }
  }

  return { kind: 'cold', reason: 'expired', idleMs: at - state.anchorAt, recacheTokens: state.recacheTokens }
}

const label = (state: CacheWindow): string | undefined =>
  state.kind === 'warm' ? `${state.minutesLeft}m` : undefined

// $.fs.read refuses files over 4 MiB, and long sessions pass that: then only
// the transcript's last part is read, which holds the latest response, with
// the system's own tool (PowerShell on Windows, tail elsewhere). A line cut at
// the start fails to parse and is skipped.
const TAIL_BYTES = 3000000
const TAIL_LINES = 2000

const isWindows = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('OS')) === 'Windows_NT'

async function readTail($: EngineInterface, path: string, windows: boolean): Promise<string> {
  const info = await $.fs.stat(path)
  if (info.size < TAIL_BYTES) {
    return $.fs.read(path)
  }
  const quoted = path.replace(/'/g, "''")
  const argv = windows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Content -Encoding UTF8 -Tail ${TAIL_LINES} -LiteralPath '${quoted}'`]
    : ['tail', '-c', String(TAIL_BYTES), path]
  const { exitCode, stdout } = await $.process.run(argv)
  if (exitCode !== 0) {
    throw new Error('reading the transcript tail failed')
  }

  return stdout
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const windows = await isWindows($)
    const home = windows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
    const cwd = await $.session.cwd()
    const id = await $.session.id()
    const folder = cwd.replace(/[^A-Za-z0-9]/g, '-')
    const text = await readTail($, `${home}/.claude/projects/${folder}/${id}.jsonl`, windows)
    const next = replay(text)
    await update($, record, () => next)
  } catch {
    // No transcript yet: the indicator stays hidden.
  }
}

// The status line, drawn above the prompt with the plugin's name before it.
async function showStatus($: EngineInterface): Promise<void> {
  const state = windowOf(await read($, record), await $.clock.now())
  if (state.kind === 'unknown') {
    $.ui.status(undefined)

    return
  }
  $.ui.status(`◷ ${label(state) ?? 'cold'}`)
}

// Off until session.start confirms this is not the VS Code extension, which
// draws its own indicator: there the mod never sets the status line.
let isActive = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isActive = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-vscode'
    if (!isActive) {
      $.ui.status(undefined)

      return next(e)
    }
    await refresh($)
    await showStatus($)
    let ticks = 0
    $.clock.every(15000, async () => {
      ticks += 1
      if (ticks % 2 === 0) {
        await refresh($)
      }
      await showStatus($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isActive && e.agentId === undefined) {
      await refresh($)
      await showStatus($)
    }

    return done
  })
}
