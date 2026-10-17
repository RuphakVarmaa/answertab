// AI-layer logging. Info lines carry metadata only (purpose, model, tokens, cost, latency, outcome),
// never prompts, transcripts, question text or credentials. Debug output needs AI_DEBUG=1.

export interface AiLogger {
  info(fields: Record<string, unknown>, msg: string): void
  warn(fields: Record<string, unknown>, msg: string): void
  debug(fields: Record<string, unknown>, msg: string): void
}

const quiet = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

const consoleLogger: AiLogger = {
  info(fields, msg) {
    if (!quiet) console.info(`[ai] ${msg}`, JSON.stringify(fields))
  },
  warn(fields, msg) {
    if (!quiet) console.warn(`[ai] ${msg}`, JSON.stringify(fields))
  },
  debug(fields, msg) {
    if (process.env.AI_DEBUG === '1') console.debug(`[ai:debug] ${msg}`, JSON.stringify(fields))
  },
}

let current: AiLogger = consoleLogger

/** The server can pass its Fastify/pino logger (same `(obj, msg)` signature). */
export function setAiLogger(logger: AiLogger): void {
  current = logger
}

export const aiLog: AiLogger = {
  info: (f, m) => current.info(f, m),
  warn: (f, m) => current.warn(f, m),
  debug: (f, m) => current.debug(f, m),
}
