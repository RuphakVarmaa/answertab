import { Link } from 'react-router-dom'

/** The mark: a speech bubble whose answer is checked off. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--c-ink)" />
      <path d="M8.5 9.5h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8.2L11 25v-3.5H8.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" fill="var(--c-bg)" />
      <path d="M11.6 15.6l2.7 2.7 5.6-5.6" fill="none" stroke="var(--c-ok-strong)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Logo({ to = '/', small }: { to?: string; small?: boolean }) {
  return (
    <Link to={to} className="logo" aria-label="AnswerTab home">
      <LogoMark />
      {!small && <span className="logo__word">AnswerTab</span>}
    </Link>
  )
}
