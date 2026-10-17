// Pieces shared by the full console and the presentation layout.
import { useState, type ReactNode } from 'react'
import type { RoomStatus } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Logo } from '../../components/Logo.js'
import { Badge, StateChip } from '../../components/StateChip.js'
import { Dialog, useNow } from '../../components/ui.js'
import type { Tone } from '../../lib/cardState.js'
import { formatClock } from '../../lib/format.js'
import type { SseStatus } from '../../lib/useRoomEvents.js'
import type { ConsoleModel } from './useConsole.js'

export const ROOM_STATUS: Record<RoomStatus, { label: string; icon: string; tone: Tone }> = {
  draft: { label: 'Not started', icon: 'circle', tone: 'neutral' },
  live: { label: 'Streaming', icon: 'play', tone: 'info' },
  ended: { label: 'Ended — review', icon: 'flag', tone: 'warn' },
  settling: { label: 'Settling', icon: 'spinner', tone: 'warn' },
  settled: { label: 'Settled', icon: 'checkCircle', tone: 'ok' },
  voided: { label: 'Voided — all released', icon: 'slash', tone: 'muted' },
}

export function RoomClock({ startedAt, endedAt }: { startedAt: string | null; endedAt: string | null }) {
  const now = useNow(1000)
  if (!startedAt) return null
  const end = endedAt ? Date.parse(endedAt) : now
  return (
    <span className="clock num" title="Room clock: answers are timestamped on it">
      <Icon name="clock" />
      {formatClock(end - Date.parse(startedAt))}
    </span>
  )
}

export function StreamBadge({ status }: { status: SseStatus }) {
  if (status === 'open' || status === 'idle') return null
  return (
    <Badge icon="refresh" tone="warn" title="Live updates paused; the page reloads full state when they resume">
      {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </Badge>
  )
}

export function ModeBadge({ mode }: { mode: 'ai' | 'manual' }) {
  return mode === 'ai' ? (
    <Badge icon="spark" tone="ok" title="Claude Haiku matches answers; Opus re-checks big locks">
      AI checks on
    </Badge>
  ) : (
    <Badge icon="hand" tone="warn" title="Claude is off for this room (no key, budget cap or API trouble). Point at answers yourself.">
      Manual confirm
    </Badge>
  )
}

export function ConsoleHeader({
  model,
  micLive,
  onShare,
  onPrices,
  extra,
}: {
  model: ConsoleModel
  micLive: boolean
  onShare?: () => void
  onPrices?: () => void
  extra?: ReactNode
}) {
  const room = model.view!.room
  const st = ROOM_STATUS[room.status]
  const [confirmEnd, setConfirmEnd] = useState(false)
  return (
    <header className="appbar console__bar">
      <Logo small />
      <div className="console__title">
        <h1>{room.title}</h1>
        <span className="xsmall muted">
          {room.kind === 'demo' ? 'Demo room' : 'Room'} <span className="mono">{room.id}</span>
        </span>
      </div>
      <StateChip icon={st.icon} label={st.label} tone={st.tone} />
      <ModeBadge mode={room.aiMode} />
      {micLive && <span className="badge badge--live">LIVE</span>}
      <StreamBadge status={model.live.stream} />
      <RoomClock startedAt={room.clockStartedAt} endedAt={room.endedAt} />
      <span className="spacer" />
      {extra}
      {onPrices && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onPrices}>
          <Icon name="scale" />
          Prices
        </button>
      )}
      {onShare && (
        <button type="button" className="btn btn--sm" onClick={onShare}>
          <Icon name="qr" />
          Share
        </button>
      )}
      {room.status === 'draft' && (
        <button type="button" className="btn btn--primary btn--sm" onClick={() => model.actions.start()} disabled={model.busy === 'start'}>
          <Icon name={model.busy === 'start' ? 'spinner' : 'play'} />
          Start room
        </button>
      )}
      {room.status === 'live' && (
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setConfirmEnd(true)} disabled={model.busy === 'end'}>
          <Icon name={model.busy === 'end' ? 'spinner' : 'stop'} />
          End stream
        </button>
      )}
      <Dialog open={confirmEnd} onClose={() => setConfirmEnd(false)} title="End the stream?">
        <div className="stack gap-4">
          <p>Fans can no longer ask or back questions. Nothing is charged yet: you review every lock and approve before PayPal captures anything.</p>
          <div className="row gap-2">
            <button
              type="button"
              className="btn btn--primary"
              onClick={async () => {
                setConfirmEnd(false)
                await model.actions.end()
              }}
            >
              End and review
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmEnd(false)}>
              Keep streaming
            </button>
          </div>
        </div>
      </Dialog>
    </header>
  )
}
