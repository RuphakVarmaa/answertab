// Share links + QR, the price screen (published-rate fee estimates), and the judge checklist.
import { useState } from 'react'
import type { ConsoleView, PricesView } from '../../../shared/types.js'
import { PUBLISHED_RATES } from '../../../shared/money.js'
import { Icon } from '../../components/Icon.js'
import { CopyField } from '../../components/ui.js'
import { api } from '../../lib/api.js'
import { judgeChecklist } from '../../lib/checklist.js'
import { feeRows, rateLabel } from '../../lib/fees.js'
import { money, percent } from '../../lib/format.js'
import { absolute, paths } from '../../lib/url.js'

export function SharePanel({ roomId, token }: { roomId: string; token: string }) {
  const origin = window.location.origin
  const fan = absolute(paths.fan(roomId), origin)
  const overlay = absolute(paths.overlay(roomId), origin)
  const consoleLink = absolute(paths.console(roomId, token), origin)
  return (
    <div className="share">
      <div className="share__qr">
        <img src={api.qrUrl(roomId)} width={176} height={176} alt="QR code that opens the fan link" />
        <span className="xsmall muted">Fans scan to join</span>
      </div>
      <div className="stack gap-4" style={{ minWidth: 0, flex: 1 }}>
        <div className="field">
          <span className="field__label">Fan link</span>
          <CopyField value={fan} label="fan link" />
        </div>
        <div className="field">
          <span className="field__label">Overlay for OBS or a second screen</span>
          <CopyField value={overlay} label="overlay link" />
          <span className="field__hint">
            Add <span className="mono">?bg=transparent</span> for a browser source. <a href={paths.overlay(roomId)} target="_blank" rel="noopener">Open overlay</a>
          </span>
        </div>
        <div className="field">
          <span className="field__label">Console link (secret)</span>
          <CopyField value={consoleLink} label="console link" display={`${absolute(paths.console(roomId), origin)}#k=••••••••`} />
          <span className="field__hint">Anyone with this link can run your room. The key stays in the # part, which browsers never send to servers.</span>
        </div>
      </div>
    </div>
  )
}

export function PricesPanel({ prices }: { prices: PricesView }) {
  const rows = feeRows(prices)
  return (
    <div className="stack gap-4">
      <dl className="dl prices__set">
        <dt>Question</dt>
        <dd>{money(prices.questionCents)}</dd>
        <dt>Me too</dt>
        <dd>{money(prices.metooCents)}</dd>
        <dt>Hold sizes</dt>
        <dd>{prices.ceilingsCents.map((c) => money(c, { compact: true })).join(' / ')}</dd>
        <dt>Platform fee</dt>
        <dd>{percent(prices.platformFeeBps, 10_000, prices.platformFeeBps % 100 ? 1 : 0)}</dd>
      </dl>
      <div className="banner" data-tone="warn">
        <Icon name="info" />
        <div>
          <strong>Estimate.</strong> PayPal's published US rates (page updated 2026-10-01): Checkout {rateLabel(PUBLISHED_RATES.checkout)}, advanced cards{' '}
          {rateLabel(PUBLISHED_RATES.advancedCards)}. Real fees come from PayPal's response on each capture and appear in the ledger.
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>One fan pays</th>
              <th className="r">PayPal fee (est.)</th>
              <th className="r">Platform</th>
              <th className="r">Creator keeps (est.)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.amountCents}>
                <td>
                  <strong className="num">{money(r.amountCents)}</strong> <span className="muted small">{r.label}</span>
                </td>
                <td className="r num">
                  {money(r.cardsFeeCents)}–{money(r.checkoutFeeCents)}
                </td>
                <td className="r num">{money(r.platformFeeCents)}</td>
                <td className="r num">
                  {percent(r.keepLowCents, r.amountCents)}–{percent(r.keepHighCents, r.amountCents)}
                  <div className="xsmall muted">
                    {money(r.keepLowCents)}–{money(r.keepHighCents)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="xsmall muted">
        Why one capture per fan: every capture pays the fixed part of PayPal's fee, so AnswerTab charges each fan once at the end and releases the rest.
        Prices are fixed for this room.
      </p>
    </div>
  )
}

/** `embedded`: just the list (always open), for a container that has its own heading, like the presentation drawer. */
/** Pass `ticked`/`setTicked` to share manual ticks with a counter outside the list (the presentation header). */
export function Checklist({
  view,
  embedded,
  ticked: tickedProp,
  setTicked: setTickedProp,
}: {
  view: ConsoleView
  embedded?: boolean
  ticked?: Set<string>
  setTicked?: (fn: (s: Set<string>) => Set<string>) => void
}) {
  const [ownTicked, setOwnTicked] = useState<Set<string>>(() => new Set())
  const ticked = tickedProp ?? ownTicked
  const setTicked = setTickedProp ?? setOwnTicked
  const [open, setOpen] = useState(true)
  const items = judgeChecklist(view, ticked)
  const done = items.filter((i) => i.done).length
  if (embedded) return <ChecklistList items={items} setTicked={setTicked} />
  return (
    <section className="checklist panel" aria-labelledby="try-title">
      <button type="button" className="checklist__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="checkCircle" />
        <span id="try-title" className="panel__title">
          Try it yourself
        </span>
        <span className="small muted num">
          {done} of {items.length}
        </span>
        <span className="spacer" />
        <Icon name={open ? 'chevronDown' : 'chevronRight'} />
      </button>
      {open && <ChecklistList items={items} setTicked={setTicked} />}
    </section>
  )
}

function ChecklistList({ items, setTicked }: { items: ReturnType<typeof judgeChecklist>; setTicked: (fn: (s: Set<string>) => Set<string>) => void }) {
  return (
    <ol className="checklist__list">
      {items.map((it) => (
        <li key={it.id} className={it.done ? 'is-done' : ''}>
          <label>
            <input
              type="checkbox"
              checked={it.done}
              disabled={!it.manual && it.done}
              onChange={() =>
                setTicked((s) => {
                  const n = new Set(s)
                  if (n.has(it.id)) n.delete(it.id)
                  else n.add(it.id)
                  return n
                })
              }
            />
            <span>
              <span className="checklist__label">{it.label}</span>
              <span className="xsmall muted">{it.hint}</span>
            </span>
          </label>
        </li>
      ))}
    </ol>
  )
}
