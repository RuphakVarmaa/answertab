// PayPal JS SDK v6 checkout for one AUTHORIZE order: card fields first (judge path), PayPal button second.
// Lazy-loaded: the SDK only downloads when a fan reaches this step.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  INSTANCE_LOADING_STATE,
  PayPalCardCvvField,
  PayPalCardExpiryField,
  PayPalCardFieldsProvider,
  PayPalCardNameField,
  PayPalCardNumberField,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  usePayPal,
  usePayPalCardFields,
  usePayPalCardFieldsOneTimePaymentSession,
  type MerchantStyleObject,
} from '@paypal/react-paypal-js/sdk-v6'
import type { PublicConfig, TabView } from '../../../shared/types.js'
import { toAmount } from '../../../shared/money.js'
import { Icon } from '../../components/Icon.js'
import { Banner, CopyField } from '../../components/ui.js'
import { api, toApiError } from '../../lib/api.js'
import { money } from '../../lib/format.js'
import { friendlyError } from '../../lib/messages.js'

export interface CheckoutProps {
  roomId: string
  fanToken: string
  ceilingCents: number
  config: PublicConfig
  onTab: (tab: TabView) => void
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function useFieldStyle(): MerchantStyleObject {
  return useMemo(() => {
    const ink = cssVar('--c-ink', '#16181d')
    return {
      input: { fontSize: '16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', color: ink, padding: '12px' },
      'input::placeholder': { color: cssVar('--c-faint', '#8b8f99') },
      '.invalid': { color: cssVar('--c-bad', '#ab2318') },
    }
  }, [])
}

function TestCardBox({ card }: { card: PublicConfig['testCard'] }) {
  return (
    <Banner tone="warn" icon="shield" tape>
      <strong>Sandbox only — never a real card.</strong> Use PayPal's published test card:
      <div className="testcard">
        <CopyField value={card.number} label="test card number" display={card.number.replace(/(\d{4})(?=\d)/g, '$1 ')} />
        <span className="testcard__meta mono">
          Expiry {card.expiry} · CVV {card.cvv} · Name {card.name}
        </span>
      </div>
      <span className="xsmall">
        To see a real sandbox decline, type the name <span className="mono">CCREJECT-REFUSED</span>.
      </span>
    </Banner>
  )
}

function CardForm({ roomId, fanToken, ceilingCents, onTab }: Omit<CheckoutProps, 'config'>) {
  const { submit, submitResponse, error } = usePayPalCardFieldsOneTimePaymentSession()
  const { error: initError } = usePayPalCardFields()
  const style = useFieldStyle()
  const pending = useRef<string | null>(null)
  const [busy, setBusy] = useState<'order' | 'card' | 'auth' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // The v6 hook reports submit results through state, so the authorize step runs here.
  useEffect(() => {
    const orderId = pending.current
    if (!orderId) return
    if (submitResponse) {
      pending.current = null
      if (submitResponse.state === 'succeeded') {
        setBusy('auth')
        api
          .tabAuthorize(roomId, fanToken, orderId)
          .then(onTab, (e) => setMsg(friendlyError(toApiError(e))))
          .finally(() => setBusy(null))
      } else {
        setBusy(null)
        setMsg(submitResponse.state === 'canceled' ? 'The card check was cancelled. No hold was placed.' : 'PayPal could not confirm this card. Check the details and try again.')
      }
    } else if (error) {
      pending.current = null
      setBusy(null)
      setMsg('PayPal could not confirm this card. Check the number, expiry and CVV, then try again.')
    }
  }, [submitResponse, error, roomId, fanToken, onTab])

  const place = async () => {
    setMsg(null)
    setBusy('order')
    try {
      const { orderId } = await api.tabOrder(roomId, fanToken, { ceilingCents, funding: 'card' })
      pending.current = orderId
      setBusy('card')
      await submit(orderId)
    } catch (e) {
      pending.current = null
      setBusy(null)
      setMsg(friendlyError(toApiError(e)))
    }
  }

  if (initError)
    return (
      <Banner tone="warn">
        Card fields could not start in this browser ({initError.message}). Use the PayPal button below; it places the same hold.
      </Banner>
    )

  const label = busy === 'order' ? 'Creating order…' : busy === 'card' ? 'Checking card…' : busy === 'auth' ? 'Placing hold…' : `Place ${money(ceilingCents, { compact: true })} hold`
  return (
    <div className="cardform">
      <div className="cardform__grid">
        <div className="cf">
          <span className="cf__label">Name on card</span>
          <PayPalCardNameField containerClassName="cf__box" style={style} placeholder="Judge Test" ariaLabel="Name on card" />
        </div>
        <div className="cf cf--wide">
          <span className="cf__label">Card number</span>
          <PayPalCardNumberField containerClassName="cf__box" style={style} placeholder="4111 1111 1111 1111" ariaLabel="Card number" />
        </div>
        <div className="cf">
          <span className="cf__label">Expiry</span>
          <PayPalCardExpiryField containerClassName="cf__box" style={style} placeholder="MM/YY" ariaLabel="Expiry date" />
        </div>
        <div className="cf">
          <span className="cf__label">CVV</span>
          <PayPalCardCvvField containerClassName="cf__box" style={style} placeholder="123" ariaLabel="Security code" />
        </div>
      </div>
      <button type="button" className="btn btn--primary btn--lg btn--block" onClick={place} disabled={busy !== null}>
        <Icon name={busy ? 'spinner' : 'lock'} />
        {label}
      </button>
      {msg && <Banner tone="bad">{msg}</Banner>}
    </div>
  )
}

function PayPalPath({ roomId, fanToken, ceilingCents, onTab }: Omit<CheckoutProps, 'config'>) {
  const [approved, setApproved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const authorize = async () => {
    if (!approved) return
    setBusy(true)
    setMsg(null)
    try {
      onTab(await api.tabAuthorize(roomId, fanToken, approved))
    } catch (e) {
      setMsg(friendlyError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }
  if (approved)
    return (
      <div className="stack gap-2">
        <p className="small">PayPal approved the hold. Nothing is charged; confirm to place it.</p>
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={authorize} disabled={busy}>
          <Icon name={busy ? 'spinner' : 'lock'} />
          {busy ? 'Placing hold…' : `Place ${money(ceilingCents, { compact: true })} hold`}
        </button>
        {msg && <Banner tone="bad">{msg}</Banner>}
      </div>
    )
  return (
    <div className="stack gap-2">
      <PayPalOneTimePaymentButton
        type="pay"
        createOrder={async () => {
          setMsg(null)
          const { orderId } = await api.tabOrder(roomId, fanToken, { ceilingCents, funding: 'paypal' })
          return { orderId }
        }}
        onApprove={async (data) => setApproved(data.orderId)}
        onCancel={() => setMsg('PayPal window closed. No hold was placed.')}
        onError={(e) => setMsg(e?.message ? `PayPal: ${e.message}` : 'PayPal checkout failed. Try the card option.')}
      />
      <p className="xsmall muted">Log in with a PayPal sandbox buyer account. PayPal's screen says "hold" — you approve, then confirm here.</p>
      {msg && <Banner tone="warn">{msg}</Banner>}
    </div>
  )
}

function SdkGate({ children }: { children: ReactNode }) {
  const { loadingStatus, error } = usePayPal()
  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED || error)
    return <Banner tone="bad">PayPal checkout could not load{error?.message ? `: ${error.message}` : ''}. Check the connection and reload.</Banner>
  if (loadingStatus === INSTANCE_LOADING_STATE.PENDING)
    return (
      <div className="stack gap-2" aria-busy="true" aria-label="Loading PayPal checkout">
        <div className="skeleton" style={{ height: 48 }} />
        <div className="skeleton" style={{ height: 48 }} />
        <div className="skeleton" style={{ height: 52 }} />
      </div>
    )
  return <>{children}</>
}

export default function Checkout(props: CheckoutProps) {
  const { config, ceilingCents } = props
  const amount = useMemo(() => ({ value: toAmount(ceilingCents), currencyCode: 'USD' }), [ceilingCents])
  return (
    <div className="checkout stack gap-4">
      <TestCardBox card={config.testCard} />
      <PayPalProvider clientId={config.paypalClientId} environment="sandbox" components={['card-fields', 'paypal-payments']} pageType="checkout">
        <SdkGate>
          <section aria-label="Pay by card">
            <PayPalCardFieldsProvider amount={amount}>
              <CardForm {...props} />
            </PayPalCardFieldsProvider>
          </section>
          <div className="divider-or">or</div>
          <section aria-label="Pay with PayPal">
            <PayPalPath {...props} />
          </section>
        </SdkGate>
      </PayPalProvider>
    </div>
  )
}
