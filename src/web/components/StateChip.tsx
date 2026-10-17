import type { ReactNode } from 'react'
import type { Tone } from '../lib/cardState.js'
import { Icon } from './Icon.js'

export function StateChip({ icon, label, tone, large, pop, title }: { icon: string; label: string; tone: Tone; large?: boolean; pop?: boolean; title?: string }) {
  return (
    <span className={['state', large ? 'state--lg' : '', pop ? 'is-pop' : ''].filter(Boolean).join(' ')} data-tone={tone} title={title}>
      <Icon name={icon} />
      <span>{label}</span>
    </span>
  )
}

export function Badge({ icon, children, tone, title, className }: { icon?: string; children: ReactNode; tone?: Tone; title?: string; className?: string }) {
  return (
    <span className={['badge', className].filter(Boolean).join(' ')} data-tone={tone} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  )
}
