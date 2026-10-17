// Small building blocks shared by every page.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toApiError } from '../lib/api.js'
import { friendlyError } from '../lib/messages.js'
import { Icon } from './Icon.js'

export function Panel({ title, icon, actions, children, className, bodyClass, id }: { title?: ReactNode; icon?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')} aria-labelledby={id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="panel__head">
          {icon && <Icon name={icon} className="panel__icon" />}
          {typeof title === 'string' ? (
            <h2 className="panel__title" id={id ? `${id}-title` : undefined}>
              {title}
            </h2>
          ) : (
            title
          )}
          <span className="spacer" />
          {actions}
        </header>
      )}
      <div className={bodyClass ?? 'panel__body'}>{children}</div>
    </section>
  )
}

export function Banner({ tone = 'info', icon, children, tape }: { tone?: 'info' | 'ok' | 'warn' | 'bad' | 'neutral'; icon?: string; children: ReactNode; tape?: boolean }) {
  const fallback = { info: 'info', ok: 'checkCircle', warn: 'alert', bad: 'xCircle', neutral: 'info' }[tone]
  return (
    <div className={['banner', tape ? 'banner--tape' : ''].filter(Boolean).join(' ')} data-tone={tone} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon name={icon ?? fallback} />
      <div>{children}</div>
    </div>
  )
}

export function SandboxBanner({ children }: { children?: ReactNode }) {
  return (
    <Banner tone="warn" icon="shield" tape>
      <strong>Sandbox only — never a real card.</strong> {children ?? 'PayPal sandbox test money. Nothing here charges anyone.'}
    </Banner>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row gap-2" role="status">
      <Icon name="spinner" />
      {label && <span className="muted small">{label}</span>}
    </span>
  )
}

export function Empty({ icon = 'info', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  )
}

export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: string; count?: number }[]; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} />}
          {o.label}
          {o.count !== undefined && o.count > 0 && <span className="count num">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function CopyField({ value, label, display }: { value: string; label: string; display?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="copyfield">
      <code title={display ?? value}>{display ?? value}</code>
      <button type="button" className="btn btn--sm btn--ghost" onClick={copy} aria-label={`Copy ${label}`}>
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** A PayPal or ledger ID: monospace, selectable, copy on click. */
export function Id({ value, empty = '—' }: { value: string | null | undefined; empty?: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className="muted">{empty}</span>
  return (
    <button
      type="button"
      className="idchip mono"
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          },
          () => {},
        )
      }}
    >
      {value}
      {copied && <span className="sr-only"> copied</span>}
    </button>
  )
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} style={wide ? { width: 'min(920px, calc(100vw - 32px))' } : undefined} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog__head">
        <h2 className="panel__title" style={{ fontSize: 'var(--fs-md)' }}>
          {title}
        </h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="dialog__body">{open && children}</div>
    </dialog>
  )
}

// ---------- Toasts ----------
interface Toast {
  id: number
  tone: 'ok' | 'bad' | 'info'
  text: string
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++seq.current
    setToasts((t) => [...t.slice(-2), { id, tone, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 4200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone}>
            <Icon name={t.tone === 'bad' ? 'xCircle' : t.tone === 'ok' ? 'checkCircle' : 'info'} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/** Re-render every `ms` (clocks, "3 min ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Run an async action with a busy flag; errors go to the toast. */
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, onError?: (e: unknown) => boolean | void): Promise<T | undefined> => {
      setBusy(key)
      try {
        return await fn()
      } catch (e) {
        if (!onError?.(e)) toast(friendlyError(toApiError(e)), 'bad')
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )
  return { busy, run }
}
