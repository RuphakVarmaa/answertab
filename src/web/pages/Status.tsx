import { useCallback, useEffect, useState } from 'react'
import type { PublicConfig, StatusCheck } from '../../shared/types.js'
import { Icon } from '../components/Icon.js'
import { Logo } from '../components/Logo.js'
import { Badge } from '../components/StateChip.js'
import { Banner, Empty, useNow } from '../components/ui.js'
import { api, toApiError } from '../lib/api.js'
import { timeAgo } from '../lib/format.js'
import { friendlyError } from '../lib/messages.js'
import '../styles/status.css'

export default function StatusPage() {
  const [checks, setChecks] = useState<StatusCheck[] | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow(15_000)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [c, cfg] = await Promise.all([api.status(), api.config().catch(() => null)])
      setChecks(c)
      setConfig(cfg)
      setError(null)
    } catch (e) {
      setError(friendlyError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    document.title = 'AnswerTab · Status'
    void load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const bad = checks?.filter((c) => !c.ok).length ?? 0
  return (
    <div className="statuspage">
      <header className="statuspage__bar">
        <Logo />
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={busy}>
          <Icon name={busy ? 'spinner' : 'refresh'} />
          Refresh
        </button>
      </header>
      <main className="statuspage__main">
        <h1 className="display statuspage__title">Service status</h1>
        <p className="muted">The server runs real checks every 5 minutes: PayPal OAuth, webhook registration, merchant balance, Anthropic, the LLM budget and the last synthetic run.</p>
        {checks && (
          <Banner tone={bad ? 'warn' : 'ok'}>
            <strong>{bad ? `${bad} of ${checks.length} checks failing.` : `All ${checks.length} checks passing.`}</strong>
            {bad ? ' PayPal calls stay real; when Claude is unavailable rooms switch to manual confirm.' : ''}
          </Banner>
        )}
        {error && <Banner tone="bad">{error}</Banner>}
        {config && (
          <div className="row gap-2">
            <Badge icon="shield" className="badge--sandbox">
              PayPal {config.environment}
            </Badge>
            <Badge icon={config.aiEnabled ? 'spark' : 'hand'} tone={config.aiEnabled ? 'ok' : 'warn'}>
              {config.aiEnabled ? 'Claude checks enabled' : 'Manual confirm (no AI key)'}
            </Badge>
            {config.judgeModeAvailable && <Badge icon="users">Judge pool available</Badge>}
          </div>
        )}
        {!checks && !error ? (
          <div className="stack gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 64 }} />
            ))}
          </div>
        ) : checks && checks.length === 0 ? (
          <Empty>No checks have run yet.</Empty>
        ) : (
          <ul className="checks">
            {checks?.map((c) => (
              <li key={c.name} className="check" data-tone={c.ok ? 'ok' : 'bad'}>
                <Icon name={c.ok ? 'checkCircle' : 'xCircle'} />
                <div className="check__body">
                  <div className="row">
                    <strong>{c.name}</strong>
                    <span className="check__state">{c.ok ? 'OK' : 'Failing'}</span>
                    <span className="spacer" />
                    <span className="xsmall muted">{timeAgo(c.checkedAt, now)}</span>
                  </div>
                  <p className="small muted">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
