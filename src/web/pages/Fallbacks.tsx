import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon.js'
import { Logo } from '../components/Logo.js'

export function PageLoading() {
  return (
    <div className="center" style={{ minHeight: '60dvh' }} role="status" aria-label="Loading">
      <Icon name="spinner" className="loading-mark" />
    </div>
  )
}

export function PageError({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <main className="page-error">
      <Logo />
      <h1 className="display" style={{ fontSize: 'var(--fs-3xl)' }}>
        {title}
      </h1>
      {detail && <p className="muted">{detail}</p>}
      <div className="row">
        {action}
        <Link className="btn" to="/">
          Back to AnswerTab
        </Link>
      </div>
    </main>
  )
}

export function NotFound() {
  return <PageError title="Nothing here" detail="This link may have expired. Rooms and transcripts are deleted after 7 days." />
}
