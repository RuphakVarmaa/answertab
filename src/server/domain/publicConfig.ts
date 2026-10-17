// GET /api/config: the only configuration the browser sees (the PayPal client id is public).
import type { PublicConfig } from '../../shared/types.js'
import { aiEnabled } from '../ai/index.js'
import { config } from '../config.js'
import { JUDGE_TEST_CARD } from '../paypal/index.js'

export function publicConfig(): PublicConfig {
  const cfg = config()
  return {
    paypalClientId: cfg.paypal.clientId,
    environment: 'sandbox',
    testCard: { ...JUDGE_TEST_CARD },
    aiEnabled: aiEnabled(),
    judgeModeAvailable: !!cfg.judgeCode,
  }
}
