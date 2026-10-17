// Demo rooms (judge mode): a live room with three strip bots plus one bot whose card the sandbox processor
// declines. Bot holds open in parallel and stream in over SSE as PayPal answers. The replay director
// (director.ts, timeline in script.ts) is registered by default and plays the scripted autoplay; tests and
// tools can swap it with setDemoDirector(), or pass one per room to startDemoRoom().
import { botCard, declineCard, type TestCard } from '../paypal/index.js'
import { DomainError, createRoom, joinRoom, judgeCodeMatches, openBotTab, startRoom } from '../domain/index.js'
import { replayDirector } from './director.js'

export interface DemoFan {
  fanId: string
  fanToken: string
  displayName: string
}

export interface DemoContext {
  roomId: string
  creatorToken: string
  pool: 'judge' | 'public'
  /** The three bots shown as phones in the presentation layout. */
  stripFans: DemoFan[]
  /** The extra bot whose sandbox card is declined by the processor. */
  declinedFan: DemoFan
  /** Settles once every bot hold has an answer from PayPal (held or declined). Never rejects. */
  tabsReady: Promise<void>
}

/** Its resolved value is kept for demoDirectorDone() (the replay director returns a DirectorReport). */
export type DemoDirector = (ctx: DemoContext) => unknown

/**
 * On by default. DEMO_AUTOPLAY=0 turns the autoplay off (rooms still get their bots); under Vitest no director
 * runs unless a test installs one, so API tests of POST /api/demo see only the bots.
 */
function defaultDirector(): DemoDirector | null {
  const v = (process.env.DEMO_AUTOPLAY ?? '').toLowerCase()
  if (v === '0' || v === 'false' || v === 'off') return null
  if (v === '1' || v === 'true' || v === 'on') return replayDirector
  return process.env.VITEST === 'true' ? null : replayDirector
}

let director: DemoDirector | null = defaultDirector()
const ready = new Map<string, Promise<void>>()
const runs = new Map<string, Promise<unknown>>()

/** Replace the director for rooms started from now on (null: bots only, no autoplay). */
export function setDemoDirector(fn: DemoDirector | null): void {
  director = fn
}

export const DEMO_TITLE = 'Office hours: structuring an API project'
export const DEMO_TAB_CENTS = 1000
export const STRIP_NAMES = ['Asha', 'Ben', 'Chen'] as const
export const DECLINED_NAME = 'Dev'
/** How long finished director runs stay readable through demoDirectorDone(). */
const RUN_TTL_MS = 10 * 60_000

function log(msg: string): void {
  if (process.env.VITEST !== 'true') console.warn(`[demo] ${msg}`)
}

export async function startDemoRoom(p: {
  judgeCode?: string | undefined
  ip: string
  /** This room only: a different director (the synthetic run passes the replay director explicitly). */
  director?: DemoDirector | null
}): Promise<{ roomId: string; creatorToken: string; pool: 'judge' | 'public'; stripFans: DemoFan[] }> {
  // A code that was typed but is wrong is an error, not a silent drop into the public pool. No code: public pool.
  const code = typeof p.judgeCode === 'string' ? p.judgeCode.trim() : ''
  if (code !== '' && !judgeCodeMatches(code)) {
    throw new DomainError(403, 'bad_judge_code', 'That judge code is not recognized. Check it, or leave it empty to use the public demo pool.')
  }
  const { roomId, creatorToken, pool } = await createRoom({ kind: 'demo', title: DEMO_TITLE, judgeCode: code || undefined, ip: p.ip })
  await startRoom(roomId)
  const stripFans: DemoFan[] = []
  for (const name of STRIP_NAMES) stripFans.push(await joinRoom(roomId, name, { isBot: true }))
  const declinedFan = await joinRoom(roomId, DECLINED_NAME, { isBot: true })

  const cards: [DemoFan, TestCard][] = [
    ...stripFans.map((f, i): [DemoFan, TestCard] => [f, botCard(i, `${f.displayName} Test`)]),
    [declinedFan, declineCard(botCard(3))],
  ]
  // Not awaited: the holds appear on the console as PayPal answers, in parallel (the PayPal limiter caps in-flight calls).
  const tabsReady = Promise.allSettled(
    cards.map(([f, card]) =>
      openBotTab(roomId, f.fanId, { ceilingCents: DEMO_TAB_CENTS, card }).catch((e) => log(`bot tab for ${f.displayName} failed: ${e instanceof Error ? e.message : String(e)}`)),
    ),
  ).then(() => undefined)
  ready.set(roomId, tabsReady)
  tabsReady.finally(() => setTimeout(() => ready.delete(roomId), 60_000).unref()).catch(() => {})

  const fn = p.director !== undefined ? p.director : director
  if (fn) {
    const ctx: DemoContext = { roomId, creatorToken, pool, stripFans, declinedFan, tabsReady }
    // Started now, so demoDirectorDone() sees the run as soon as this returns; it runs after the response is sent.
    const run = Promise.resolve()
      .then(() => fn(ctx))
      .catch((e: unknown) => {
        log(`director failed for ${roomId}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      })
    runs.set(roomId, run)
    run.finally(() => setTimeout(() => runs.delete(roomId), RUN_TTL_MS).unref()).catch(() => {})
  }
  return { roomId, creatorToken, pool, stripFans }
}

/** Tests and the synthetic run: wait for the bot holds of a demo room started in this process. */
export function demoTabsReady(roomId: string): Promise<void> {
  return ready.get(roomId) ?? Promise.resolve()
}

/** Resolves with the director's result once its autoplay is over (null when no director ran here, or it failed). */
export function demoDirectorDone(roomId: string): Promise<unknown> {
  return runs.get(roomId) ?? Promise.resolve(null)
}
