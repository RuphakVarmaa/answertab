// README and Devpost images from a running build. Drives one demo room in headless Chrome (puppeteer-core and the
// installed Chrome, nothing downloaded) through the autoplay, End, settle, a receipt, a contest and the payout,
// and saves PNGs plus the three-phone GIF to docs/img/. Re-runnable against any build that serves the app:
//   BASE_URL=http://localhost:8799 npx tsx scripts/capture.ts
// Env: BASE_URL (default http://localhost:8799), CHROME_PATH (default the macOS Chrome app), JUDGE_CODE (optional:
// the room uses the judge pool when it matches the server's), OUT_DIR (default docs/img). Needs ffmpeg on PATH.
// Costs one demo room: real sandbox calls (bot holds, captures, a refund, a payout) and Claude calls (detector,
// Opus verifier, one Opus contest desk run). The script prints the room's Claude spend at the end.
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { ConsoleView, QuestionState } from '../src/shared/types.js'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8799').replace(/\/+$/, '')
const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const JUDGE_CODE = process.env.JUDGE_CODE?.trim() || ''
const OUT_DIR = resolve(process.env.OUT_DIR ?? 'docs/img')

const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 }
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const PNG_MAX_BYTES = 500 * 1024
const GIF_MAX_BYTES = 3 * 1024 * 1024
/** The GIF keeps this much before the moment all three phones show a lock, and this much after. */
const GIF_BEFORE_MS = 3_300
const GIF_AFTER_MS = 1_700
/** The still of the lock is the recorded frame this long after the flip (before the partial answer's interim text). */
const STILL_AFTER_MS = 900

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string) => console.log(`[capture] ${msg}`)

async function api<T>(path: string, token?: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { 'x-creator-token': token } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>, everyMs = 300): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await probe().catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${label}`)
    await sleep(everyMs)
  }
}

/** Re-encodes a PNG to 256 colours (ffmpeg) when it is over the size limit; fails if it still is. */
async function fitPng(file: string): Promise<number> {
  let size = (await stat(file)).size
  if (size > PNG_MAX_BYTES) {
    const tmp = `${file}.8bit.png`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none', tmp])
    execFileSync('mv', [tmp, file])
    size = (await stat(file)).size
  }
  if (size > PNG_MAX_BYTES) throw new Error(`${file} is ${Math.round(size / 1024)} KB, over the 500 KB limit`)
  return size
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  const file = join(OUT_DIR, name)
  await page.screenshot({ path: file as `${string}.png`, fullPage: opts.fullPage ?? false })
  const size = await fitPng(file)
  log(`${name}: ${Math.round(size / 1024)} KB`)
}

/** Clicks the first element matching a puppeteer selector (CSS, ::-p-text or ::-p-aria). */
async function click(page: Page, selector: string, timeoutMs = 10_000) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: timeoutMs })
  if (!el) throw new Error(`no element for ${selector}`)
  await el.click()
}

/** Text of every fan-phone iframe in the presentation layout. */
async function phoneTexts(page: Page): Promise<string[]> {
  const frames = page.frames().filter((f) => f.url().includes('/f/'))
  return Promise.all(frames.map((f) => f.evaluate('document.body ? document.body.innerText : ""') as Promise<string>))
}

function q(view: ConsoleView, n: number) {
  return view.room.questions.find((x) => x.number === n)
}
const isIn = (state: QuestionState | undefined, states: QuestionState[]) => !!state && states.includes(state)

type Frame = { file: string; t: number }

/** Screenshots the viewport as fast as Chrome allows until stop() is called. */
function startRecorder(page: Page, dir: string) {
  const frames: Frame[] = []
  let stopped = false
  const done = (async () => {
    while (!stopped) {
      const file = join(dir, `f${String(frames.length).padStart(4, '0')}.png`)
      const t = Date.now()
      await page.screenshot({ path: file as `${string}.png` })
      frames.push({ file, t })
    }
  })()
  return {
    frames,
    stop: async () => {
      stopped = true
      await done
    },
  }
}

/** ffconcat with each frame's real duration, then palettegen/paletteuse; shrinks the width until it fits 3 MB. */
async function buildGif(frames: Frame[], dir: string, out: string) {
  const list = join(dir, 'frames.ffconcat')
  const lines = ['ffconcat version 1.0']
  frames.forEach((f, i) => {
    const next = frames[i + 1]
    lines.push(`file '${f.file}'`, `duration ${((next ? next.t - f.t : 100) / 1000).toFixed(3)}`)
  })
  // The concat demuxer needs the last file repeated for its duration to count.
  lines.push(`file '${frames[frames.length - 1]!.file}'`)
  await writeFile(list, lines.join('\n') + '\n')
  for (const width of [1280, 1000, 880, 760]) {
    const vf = `fps=10,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-loop', '0', out])
    const size = (await stat(out)).size
    log(`three-phone-lock.gif at ${width} px: ${Math.round(size / 1024)} KB, ${((frames[frames.length - 1]!.t - frames[0]!.t) / 1000).toFixed(1)} s`)
    if (size <= GIF_MAX_BYTES) return
  }
  throw new Error('three-phone-lock.gif is over 3 MB even at 760 px')
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const health = await fetch(`${BASE_URL}/healthz`).catch(() => null)
  if (!health?.ok) throw new Error(`${BASE_URL}/healthz does not answer; start the built app first (see the header of this file)`)
  let roomSpend: (() => Promise<string>) | null = null
  const scratch = await mkdtemp(join(tmpdir(), 'answertab-capture-'))
  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: DESKTOP,
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'],
  })
  try {
    const page = await browser.newPage()
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ])

    // 1. Landing -> Start a demo room. A judge link (?code=) prefills the field; the page drops it from the URL.
    await page.goto(`${BASE_URL}/${JUDGE_CODE ? `?code=${encodeURIComponent(JUDGE_CODE)}` : ''}`, { waitUntil: 'networkidle0' })
    await click(page, 'form.hero__cta button[type=submit]')
    await page.waitForFunction('location.pathname.startsWith("/demo/")', { timeout: 30_000 })
    const roomId = new URL(page.url()).pathname.split('/')[2]!
    const token = (await page.evaluate(`sessionStorage.getItem('answertab:creator:${roomId}')`)) as string | null
    if (!token) throw new Error('the landing page did not hand over a creator token')
    const view = () => api<ConsoleView>(`/api/rooms/${roomId}/console`, token)
    roomSpend = async () => `room ${roomId}: Claude spend ${((await view()).llmSpentMicros / 1e6).toFixed(4)} USD`
    log(`room ${roomId} started`)

    // 2. Autoplay: record frames from the deflection on, until the three phones have shown the lock for a moment.
    await waitFor('the deflection on Q1', 40_000, async () => isIn(q(await view(), 1)?.state, ['deflected', 'verifying', 'locked', 'review']))
    const v1 = await view()
    if (v1.room.aiMode !== 'ai') throw new Error('the room is in manual-confirm mode (no Claude key or budget); nothing would lock')
    const rec = startRecorder(page, scratch)
    let lockedAt = 0
    try {
      await waitFor('Q1 to lock', 30_000, async () => {
        const s = q(await view(), 1)?.state
        if (s === 'review') throw new Error('Q1 went to review instead of locking; start a fresh room')
        return s === 'locked'
      })
      await waitFor('all three phones to show the lock', 10_000, async () => {
        const texts = await phoneTexts(page)
        return texts.length === 3 && texts.every((t) => /locked/i.test(t))
      }, 150)
      lockedAt = Date.now()
      await sleep(GIF_AFTER_MS + 200)
    } finally {
      await rec.stop()
    }
    const window = rec.frames.filter((f) => f.t >= lockedAt - GIF_BEFORE_MS && f.t <= lockedAt + GIF_AFTER_MS)
    if (window.length < 10) throw new Error(`only ${window.length} frames in the GIF window`)
    await buildGif(window, scratch, join(OUT_DIR, 'three-phone-lock.gif'))
    const still = window.reduce((best, f) => (Math.abs(f.t - lockedAt - STILL_AFTER_MS) < Math.abs(best.t - lockedAt - STILL_AFTER_MS) ? f : best))
    await copyFile(still.file, join(OUT_DIR, 'presentation-lock.png'))
    log(`presentation-lock.png: ${Math.round((await fitPng(join(OUT_DIR, 'presentation-lock.png'))) / 1024)} KB`)

    // 3. Replay done (Q2 partial) -> the fan page at phone width, then close the "Try it yourself" drawer.
    await waitFor('Q2 to reach review', 40_000, async () => isIn(q(await view(), 2)?.state, ['review', 'locked']))
    const asha = v1.tabs.find((t) => t.displayName === 'Asha')
    const fans = JSON.parse(((await page.evaluate(`sessionStorage.getItem('answertab:demo:${roomId}')`)) as string | null) ?? '[]') as { fanToken: string; displayName: string }[]
    const ashaFan = fans.find((f) => f.displayName === (asha?.displayName ?? 'Asha')) ?? fans[0]
    if (!ashaFan) throw new Error('no strip fans in sessionStorage')
    const phone = await browser.newPage()
    await phone.setViewport(PHONE)
    await phone.goto(`${BASE_URL}/f/${roomId}?t=${encodeURIComponent(ashaFan.fanToken)}`, { waitUntil: 'networkidle2' })
    await phone.waitForFunction('document.body.innerText.includes("locked")', { timeout: 15_000 })
    await sleep(800)
    await shot(phone, 'fan-phone.png')
    await phone.close()
    await sleep(1_500)
    const closeDrawer = await page.$('::-p-aria(Close the checklist)')
    if (closeDrawer && (await closeDrawer.isVisible())) await closeDrawer.click()

    // 4. End stream -> review screen. A taller viewport fits both review cards above the sticky settle bar.
    await page.setViewport({ ...DESKTOP, height: 1000 })
    await click(page, '::-p-text(End stream)')
    await click(page, '::-p-text(End and review)')
    await waitFor('the room to end', 20_000, async () => (await view()).room.status === 'ended')
    await page.waitForSelector('.review__item', { visible: true, timeout: 15_000 })
    // Rate Q2 Half (the demo choice); Q1's lock defaults to Full. Scroll first: the sticky settle bar can cover it.
    const q2Rating = '[role=radiogroup][aria-label="Rating for question 2"]'
    await page.waitForSelector(q2Rating, { visible: true, timeout: 15_000 })
    await page.evaluate(`document.querySelector('${q2Rating}').closest('.review__item').scrollIntoView({ block: 'center' })`)
    await sleep(300)
    const half = await waitFor('the Half option', 5_000, async () => {
      for (const b of await page.$$(`${q2Rating} [role=radio]`)) if ((await b.evaluate((el) => el.textContent ?? '')).trim() === 'Half') return b
      return null
    })
    await half.click()
    await page.waitForSelector(`${q2Rating} [role=radio][aria-checked=true]`, { timeout: 5_000 })
    if ((await page.$eval(`${q2Rating} [role=radio][aria-checked=true]`, (el) => el.textContent ?? '')).trim() !== 'Half') throw new Error('Q2 is not rated Half')
    await page.evaluate(`document.querySelector('.demo__stagebody')?.scrollTo(0, 0)`)
    await sleep(600)
    await shot(page, 'review.png')

    // 5. Settle -> results with the ledger and a Replay to PayPal result (full console).
    await click(page, '::-p-text(Approve all and settle)')
    await waitFor('settlement', 180_000, async () => ['settled', 'voided'].includes((await view()).room.status), 1_000)
    const settled = await view()
    const con = await browser.newPage()
    await con.setViewport({ ...DESKTOP, height: 1400 })
    await con.goto(`${BASE_URL}/c/${roomId}#k=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
    await con.waitForSelector('::-p-text(Replay to PayPal)', { visible: true, timeout: 20_000 })
    await click(con, '::-p-text(Replay to PayPal)')
    await con.waitForSelector('::-p-text(Same capture ID)', { visible: true, timeout: 30_000 })
    await sleep(800)
    await shot(con, 'results-ledger.png')
    await con.close()

    // 6. Chen's receipt (Q1 me-too, Q2 asked and rated Half): Verify with PayPal.
    const chen = settled.tabs.find((t) => t.displayName === 'Chen' && t.receiptToken)
    if (!chen?.receiptToken) throw new Error("no receipt token for Chen's tab")
    const rc = await browser.newPage()
    await rc.goto(`${BASE_URL}/r/${chen.receiptToken}`, { waitUntil: 'networkidle2' })
    await click(rc, '::-p-text(Verify with PayPal)')
    await rc.waitForSelector('.verify__out', { visible: true, timeout: 30_000 })
    await sleep(500)
    await shot(rc, 'receipt-verify.png', { fullPage: true })

    // 7. Contest the Q2 line ("deferred to next week") and wait for the desk.
    const q2Line = await waitFor('the Q2 receipt line', 10_000, async () => {
      for (const li of await rc.$$('li.rline')) {
        if ((await li.evaluate((el) => (el as { innerText?: string }).innerText ?? '')).includes('#2')) return li
      }
      return null
    })
    let flag = null
    for (const b of await q2Line.$$('button')) if ((await b.evaluate((el) => el.textContent ?? '')).includes('answered')) flag = b
    if (!flag) throw new Error('no contest button on the Q2 line (is it charged?)')
    await flag.click()
    await rc.type('form.contestform textarea', "They said they'd do testing properly next week, so this wasn't answered.")
    await click(rc, '::-p-text(Send contest)')
    const contest = await waitFor('the contest desk', 150_000, async () => {
      const c = (await view()).contests[0]
      return c && ['refunded', 'pending_creator', 'upheld', 'failed'].includes(c.state) ? c : null
    }, 1_500)
    log(`contest ${contest.state}${contest.finding ? ` (${contest.finding})` : ''}`)
    if (contest.state !== 'refunded') throw new Error(`the contest ended ${contest.state}, not refunded; the image would not match the README`)
    await rc.reload({ waitUntil: 'networkidle2' })
    await rc.waitForSelector('::-p-text(Refunded)', { visible: true, timeout: 20_000 })
    await sleep(500)
    const line2 = await waitFor('the refunded Q2 line', 10_000, async () => {
      for (const li of await rc.$$('li.rline')) {
        if ((await li.evaluate((el) => (el as { innerText?: string }).innerText ?? '')).includes('#2')) return li
      }
      return null
    })
    await line2.evaluate((el) => (el as { scrollIntoView: (o: object) => void }).scrollIntoView({ block: 'center' }))
    await sleep(300)
    await shot(rc, 'contest-refunded.png')
    await rc.close()

    // 8. Payout: Contests & payout pane -> Close contest window (demo) -> the batch status PayPal returned.
    await click(page, '::-p-text(Contests & payout)')
    await click(page, '::-p-text(Close contest window (demo))')
    await waitFor('the payout batch', 120_000, async () => {
      const p = (await view()).payout
      return p && p.batchStatus && !['PENDING', 'PROCESSING', 'CREATING'].includes(p.batchStatus) ? p : null
    }, 2_000).catch(async (e: unknown) => {
      log(`payout not terminal yet (${e instanceof Error ? e.message : String(e)}); capturing the current status`)
    })
    await sleep(2_500)
    await page.evaluate(`document.querySelector('.demo__stagebody')?.scrollTo(0, document.querySelector('.demo__stagebody').scrollHeight)`)
    // A fan page inside a phone frame can scroll the frame's clipping box from inside (scrollIntoView on a
    // contest update); put every phone back so the bezel shows.
    const shifted = (await page.evaluate(
      `[...document.querySelectorAll('.strip, .phone, .phone__screen')].filter((el) => el.scrollTop || el.scrollLeft).map((el) => { const r = el.className + ' ' + el.scrollLeft + ',' + el.scrollTop; el.scrollTop = 0; el.scrollLeft = 0; return r })`,
    )) as string[]
    if (shifted.length) log(`reset scrolled phone frames: ${shifted.join('; ')}`)
    await sleep(300)
    await shot(page, 'payout.png')

    log(`payout batch status: ${(await view()).payout?.batchStatus ?? 'none'}`)
  } finally {
    if (roomSpend) log(await roomSpend().catch(() => 'room spend unavailable'))
    await browser.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(`[capture] failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
