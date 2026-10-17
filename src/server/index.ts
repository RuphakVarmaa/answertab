// Server entry: config (refuses non-sandbox), DB, the Fastify app with the built web app, the job sweeper, the
// status checker and the synthetic-run schedule (off unless SYNTHETIC_EVERY_MIN is set). Graceful shutdown on
// SIGINT/SIGTERM.
import path from 'node:path'
import { buildApp, redactUrl } from './app.js'
import { loadConfig } from './config.js'
import { openDb, setDb } from './db/db.js'
import { recoverStaleContests, resumeLiveRooms, resumeSettlingRooms, stopAllDetectors } from './domain/index.js'
import { startSyntheticScheduler } from './demo/synthetic.js'
import { recoverStaleJobs, startSweeper } from './jobs/index.js'
import { stopSseHub } from './sse.js'
import { startStatusChecker } from './status.js'

async function main(): Promise<void> {
  const cfg = loadConfig() // throws unless PAYPAL_ENVIRONMENT=sandbox
  const db = await openDb({ databaseUrl: cfg.databaseUrl, pgliteDir: process.env.PGLITE_DIR || undefined })
  setDb(db)
  const app = buildApp({
    db,
    webDir: path.resolve(process.cwd(), 'dist/web'),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers["x-creator-token"]', 'req.headers["x-fan-token"]', 'req.headers.authorization'],
      serializers: {
        req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url) }),
      },
    },
  })
  await recoverStaleJobs()
  const live = await resumeLiveRooms()
  // A restart loses in-flight work: settles resume through a job, and contest desks go to the creator.
  const settling = await resumeSettlingRooms()
  const contests = await recoverStaleContests()
  const sweeper = startSweeper({ intervalMs: 5_000 })
  const stopStatus = startStatusChecker()
  const stopSynthetic = startSyntheticScheduler()
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  app.log.info(
    `AnswerTab on :${cfg.port} (${db.kind}, sandbox, ${cfg.anthropicApiKey ? 'AI on' : 'manual-confirm mode'}, ${live} live rooms resumed, ` +
      `${settling} settling rooms resumed, ${contests} interrupted contests sent to the creator)`,
  )

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info(`${signal}: shutting down`)
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    stopStatus()
    stopSynthetic()
    stopAllDetectors()
    stopSseHub()
    await sweeper.stop().catch(() => {})
    await app.close().catch(() => {})
    await db.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error(`AnswerTab failed to start: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
