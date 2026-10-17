// Tiny concurrency limiter: at most `max` PayPal HTTP calls in flight, the rest wait in FIFO order.
// Apply it only around single HTTP requests, never around functions that make further limited calls
// (a holder waiting on a nested slot could deadlock the pool).

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>
  inFlight(): number
  queued(): number
}

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error(`limiter max must be a positive integer, got ${max}`)
  let active = 0
  const waiting: (() => void)[] = []

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    // The releasing caller hands its slot straight to us, so `active` is not incremented again.
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  return Object.assign(run, { inFlight: () => active, queued: () => waiting.length })
}

export const PAYPAL_MAX_IN_FLIGHT = 4

/** Shared limiter for every PayPal call this process makes. */
export const paypalLimit = createLimiter(PAYPAL_MAX_IN_FLIGHT)
