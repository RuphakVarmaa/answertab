// Env parsing. Imported once at boot; everything else reads `config`.

function str(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var ${name}`)
  }
  return v
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got ${v}`)
  return n
}

export interface Config {
  port: number
  publicBaseUrl: string
  paypal: {
    clientId: string
    clientSecret: string
    environment: 'sandbox'
    apiBase: string
    webhookId: string | null
    creatorPayeeEmail: string | null
  }
  anthropicApiKey: string | null
  databaseUrl: string | null
  judgeCode: string | null
  detectTau: number
  budgets: { judgeDailyMicros: number; publicDailyMicros: number; roomCapMicros: number }
  isTest: boolean
}

export function loadConfig(): Config {
  const environment = str('PAYPAL_ENVIRONMENT', 'sandbox').toLowerCase()
  if (environment !== 'sandbox') {
    throw new Error('AnswerTab is a sandbox-only build. Set PAYPAL_ENVIRONMENT=sandbox.')
  }
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
  return {
    port: int('PORT', 8790),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8790').replace(/\/$/, ''),
    paypal: {
      clientId: str('PAYPAL_CLIENT_ID', isTest ? 'test-client-id' : undefined),
      clientSecret: str('PAYPAL_CLIENT_SECRET', isTest ? 'test-client-secret' : undefined),
      environment: 'sandbox',
      apiBase: 'https://api-m.sandbox.paypal.com',
      webhookId: process.env.PAYPAL_WEBHOOK_ID || null,
      creatorPayeeEmail: process.env.PAYPAL_CREATOR_PAYEE_EMAIL || null,
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    databaseUrl: process.env.DATABASE_URL || null,
    judgeCode: process.env.JUDGE_CODE || null,
    detectTau: int('DETECT_TAU', 0.8),
    budgets: {
      judgeDailyMicros: int('JUDGE_DAILY_MICROS', 5_000_000),
      publicDailyMicros: int('PUBLIC_DAILY_MICROS', 2_000_000),
      roomCapMicros: int('ROOM_CAP_MICROS', 750_000),
    },
    isTest,
  }
}

let cached: Config | null = null
export function config(): Config {
  if (!cached) cached = loadConfig()
  return cached
}

/** Tests only: reset after changing process.env. */
export function resetConfigForTests(): void {
  cached = null
}
