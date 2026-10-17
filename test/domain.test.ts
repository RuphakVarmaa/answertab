// Pure pieces of the domain and server layers: transcript stamping, note_to_payer, SSE audiences, log redaction.
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { clampLag, noteToPayer, stampSegment } from '../src/server/domain/index.js'
import { wordsOf } from '../src/server/domain/segments.js'
import { scrub } from '../src/server/domain/webhooks.js'
import { allowed } from '../src/server/sse.js'
import { redactUrl } from '../src/server/app.js'
import { findSpan, classify } from '../src/server/domain/testkit.js'

describe('segment stamping on the room clock', () => {
  it('ends at arrival minus the recognition lag, clamped to 0-3000 ms', () => {
    expect(clampLag(-50)).toBe(0)
    expect(clampLag(1200.4)).toBe(1200)
    expect(clampLag(9000)).toBe(3000)
    expect(clampLag('x')).toBe(0)
    expect(stampSegment({ clockMs: 60_000, lagMs: 9000, words: 4, prevEndMs: null }).tEndMs).toBe(57_000)
    expect(stampSegment({ clockMs: 1000, lagMs: 3000, words: 4, prevEndMs: null })).toEqual({ tStartMs: 0, tEndMs: 0 })
  })

  it('starts by spoken length, never before the previous segment ended, never after its own end', () => {
    expect(stampSegment({ clockMs: 60_000, lagMs: 0, words: 10, prevEndMs: 0 })).toEqual({ tStartMs: 56_500, tEndMs: 60_000 })
    expect(stampSegment({ clockMs: 60_000, lagMs: 0, words: 10, prevEndMs: 58_000 })).toEqual({ tStartMs: 58_000, tEndMs: 60_000 })
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.integer({ min: -5000, max: 10_000 }), fc.nat(500), fc.option(fc.nat(10_000_000)), (clockMs, lagMs, words, prev) => {
        const t = stampSegment({ clockMs, lagMs, words, prevEndMs: prev })
        return t.tStartMs <= t.tEndMs && t.tEndMs >= clockMs - 3000 && t.tEndMs <= clockMs && t.tStartMs >= 0
      }),
    )
  })

  it('splits words like ARCHITECTURE.md says', () => {
    expect(wordsOf('  Okay,  folders:\none router ')).toEqual(['Okay,', 'folders:', 'one', 'router'])
    expect(wordsOf('   ')).toEqual([])
  })
})

describe('note_to_payer', () => {
  const url = 'https://answertab.example/r/AbCdEfGhJkLmNpQrStUvWxYz12345678'
  it('names the first question, how many more, and the receipt link', () => {
    expect(noteToPayer(['How should I split a big API project into folders?', 'Should tests live next to the code?'], url)).toBe(
      `AnswerTab: "How should I split a big API project into folders?" and 1 more. Receipt: ${url}`,
    )
    expect(noteToPayer(['One question'], url)).toBe(`AnswerTab: "One question". Receipt: ${url}`)
  })
  it('never exceeds 255 characters and always keeps the receipt link', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 600 }), { minLength: 1, maxLength: 30 }), (qs) => {
        const n = noteToPayer(qs, url)
        return n.length <= 255 && n.endsWith(url)
      }),
    )
  })
})

describe('SSE audiences', () => {
  const creator = { role: 'creator' as const, fanId: null }
  const fanA = { role: 'fan' as const, fanId: 'fan_a' }
  const viewer = { role: 'public' as const, fanId: null }
  it('routes creator-only, own-fan-only, and non-creator events', () => {
    expect([creator, fanA, viewer].map((c) => allowed(c, { to: 'all' }))).toEqual([true, true, true])
    expect([creator, fanA, viewer].map((c) => allowed(c, { to: 'creator' }))).toEqual([true, false, false])
    expect([creator, fanA, viewer].map((c) => allowed(c, { to: 'fan', fanId: 'fan_a' }))).toEqual([false, true, false])
    expect(allowed({ role: 'fan', fanId: 'fan_b' }, { to: 'fan', fanId: 'fan_a' })).toBe(false)
    expect([creator, fanA, viewer].map((c) => allowed(c, { to: 'others' }))).toEqual([false, true, true])
  })
})

describe('redaction', () => {
  it('keeps tokens out of logged URLs', () => {
    expect(redactUrl('/api/rooms/abc/events?token=SECRET&x=1')).toBe('/api/rooms/abc/events?token=REDACTED&x=1')
    expect(redactUrl('/api/receipts/SECRET/verify')).toBe('/api/receipts/REDACTED/verify')
    expect(redactUrl('/?ref=x&code=SECRET')).toBe('/?ref=x&code=REDACTED')
    expect(redactUrl('/r/SECRET')).toBe('/r/REDACTED')
  })
  it('drops payer details from stored webhook payloads', () => {
    expect(scrub({ id: 'E1', resource: { id: 'C1', payer: { email_address: 'a@b.c' }, amount: { value: '1.00' }, items: [{ name: 'x', id: 1 }] } })).toEqual({
      id: 'E1',
      resource: { id: 'C1', amount: { value: '1.00' }, items: [{ id: 1 }] },
    })
  })
})

describe('test kit', () => {
  it('finds a phrase as a word span in the rendered transcript', () => {
    const t = '<transcript>\n[seg 3 | 00:10-00:14] [0]Okay, [1]folders: [2]one [3]router [4]file\n</transcript>'
    expect(findSpan(t, 'one router file')).toEqual({ startSeg: 3, startWord: 2, endSeg: 3, endWord: 4 })
    expect(findSpan(t, 'two routers')).toBeNull()
  })
  it('classifies Claude calls by shape', () => {
    expect(classify({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } as never)).toBe('verify')
    expect(classify({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: '<question>\nq\n</question>' }] } as never)).toBe('intake')
  })
})
