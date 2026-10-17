// Stream overlay (OBS browser source or a second screen): the ranked question board in big type.
// It reads the public room view only, so it polls instead of holding a token.
import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { RoomView } from '../../shared/types.js'
import { LogoMark } from '../components/Logo.js'
import { QuestionCard } from '../components/QuestionCard.js'
import { api } from '../lib/api.js'
import { rankQuestions } from '../lib/cardState.js'
import { applyRoomEvent } from '../lib/events.js'
import { money } from '../lib/format.js'
import { useLiveState } from '../lib/useLiveState.js'
import { paths } from '../lib/url.js'
import { PageError, PageLoading } from './Fallbacks.js'
import '../styles/overlay.css'

const SHOWN = new Set(['open', 'deflected', 'verifying', 'locked', 'review', 'approved'])

export default function OverlayPage() {
  const { room: roomId = '' } = useParams()
  const [params] = useSearchParams()
  const transparent = params.get('bg') === 'transparent'
  const limit = Math.min(12, Math.max(1, Number(params.get('n')) || 5))
  const showQr = params.get('qr') === '1'

  useEffect(() => {
    document.body.classList.toggle('is-transparent', transparent)
    document.title = 'AnswerTab · Overlay'
    return () => document.body.classList.remove('is-transparent')
  }, [transparent])

  const live = useLiveState<RoomView>({ roomId, auth: null, load: () => api.room(roomId), apply: applyRoomEvent, pollMs: 2500 })
  const room = live.data
  if (!room) return live.error ? <PageError title="Overlay unavailable" detail={live.error.message} /> : <PageLoading />

  const ranked = rankQuestions(room.questions)
    .filter((q) => SHOWN.has(q.state))
    .slice(0, limit)
  const fanUrl = `${window.location.host}${paths.fan(room.id)}`

  return (
    <main className={['overlay', transparent ? 'overlay--clear' : ''].filter(Boolean).join(' ')}>
      <header className="overlay__head">
        <LogoMark className="overlay__mark" />
        <div>
          <h1 className="overlay__title">{room.title}</h1>
          <p className="overlay__sub">
            Ask at <strong className="mono">{fanUrl}</strong> · {money(room.prices.questionCents, { compact: true })} to ask, {money(room.prices.metooCents, { compact: true })} to back ·
            charged only if answered
          </p>
        </div>
        {showQr && <img className="overlay__qr" src={api.qrUrl(room.id)} width={120} height={120} alt="QR code for the fan link" />}
      </header>
      {ranked.length === 0 ? (
        <p className="overlay__empty">No questions yet. Scan or open the link to ask.</p>
      ) : (
        <ol className="overlay__list">
          {ranked.map((q, i) => (
            <li key={q.id} style={{ animationDelay: `${i * 40}ms` }}>
              <QuestionCard q={q} large showAsker />
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
