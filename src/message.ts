/**
 * The message codec: one JSON file per message, written atomically into the
 * target's inbox, parsed back on delivery. Also owns the model-facing
 * framing — every injected cross-session turn is clearly labeled
 * `[message from session <name> (<cwd>)]` and carries a `crosstalk` source so
 * the append-only log records provenance by construction and the UI renders
 * it as a labeled relay card, never as user text.
 *
 * @module @dsh-crosstalk/bundle/message
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ensureDir, readJsonFile, unlinkQuiet, writeJsonAtomic } from './atomic.ts'
import type { MessageFile, MessageSender } from './types.ts'

/** The exact framing prefix injected ahead of every cross-session message. */
export function frameLabel(from: MessageSender): string {
  return `[message from session ${from.name} (${from.cwd})]`
}

/**
 * Compose the model-facing text of an injected message: the label line, an
 * optional summary line, a blank line, then the body.
 */
export function frameText(from: MessageSender, text: string, summary?: string): string {
  const parts = [frameLabel(from)]
  if (summary !== undefined && summary.trim() !== '') parts.push(`Summary: ${summary.trim()}`)
  parts.push('', text)
  return parts.join('\n')
}

/** One-line account used for the `notice` presentation when notifyUser is off. */
export function noticeSummary(from: MessageSender): string {
  return `Message from session ${from.name}`
}

/** Mint a stable message id (also used as the inbox file basename). */
export function mintMessageId(now: () => number): string {
  return `msg-${now()}-${randomBytes(4).toString('hex')}`
}

/** Build the durable source carried on the injected UserMessage. */
export function crosstalkSource(from: MessageSender, notifyUser: boolean): {
  kind: 'crosstalk'
  form: 'relay' | 'notice'
  senderSessionId?: SessionId
  summary?: string
} {
  const base = { kind: 'crosstalk' as const }
  if (notifyUser) {
    return {
      ...base,
      form: 'relay' as const,
      ...(from.sessionId === undefined ? {} : { senderSessionId: from.sessionId as SessionId }),
    }
  }
  return {
    ...base,
    form: 'notice' as const,
    ...(from.sessionId === undefined ? {} : { senderSessionId: from.sessionId as SessionId }),
    summary: noticeSummary(from),
  }
}

/** Build the injected model-facing turn for one parsed message file. */
export function toUserMessage(file: MessageFile, notifyUser: boolean): UserMessage {
  const content: ContentBlock[] = [{ type: 'text', text: frameText(file.from, file.text, file.summary) }]
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: crosstalkSource(file.from, notifyUser),
  } as UserMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Validate one parsed message file, or undefined when corrupt. */
export function parseMessageFile(value: unknown): MessageFile | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const sentAt = asNumber(value.sentAt)
  const from = value.from
  const text = asString(value.text)
  if (id === undefined || sentAt === undefined || text === undefined || !isRecord(from)) return undefined
  const senderName = asString(from.name)
  const senderRef = asString(from.ref)
  const senderCwd = asString(from.cwd)
  if (senderName === undefined || senderRef === undefined || senderCwd === undefined) return undefined
  const sender: MessageSender = {
    name: senderName,
    ref: senderRef,
    cwd: senderCwd,
    ...(asString(from.sessionId) === undefined ? {} : { sessionId: asString(from.sessionId) as string }),
    ...(asNumber(from.uid) === undefined ? {} : { uid: asNumber(from.uid) as number }),
  }
  const summary = asString(value.summary)
  return { id, sentAt, from: sender, text, ...(summary === undefined ? {} : { summary }) }
}

/**
 * Serialize one message file. The file never contains the sender's OS uid
 * path-derived secrets beyond what the heartbeat already publishes.
 */
export function serializeMessageFile(file: MessageFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * Atomically write one message into the target's inbox. The temp file
 * (`<id>.tmp.json`) is never read by the watcher, so a crash mid-write
 * leaves nothing deliverable.
 * @returns the absolute path of the delivered file.
 */
export function writeMessageFile(inboxDir: string, file: MessageFile): string {
  const path = join(inboxDir, `${file.id}.json`)
  ensureDir(inboxDir)
  writeJsonAtomic(path, file)
  return path
}

/** Remove a consumed message file (absence is fine). */
export function consumeMessageFile(path: string): void {
  unlinkQuiet(path)
}

/** Read a message file back for tests/diagnostics. */
export function readMessageFile(path: string): MessageFile | undefined {
  return parseMessageFile(readJsonFile(path))
}