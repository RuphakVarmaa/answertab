import { useState } from 'react'
import type { QuestionView } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { QuestionCard } from '../../components/QuestionCard.js'
import { Banner, Empty } from '../../components/ui.js'
import { rankQuestions } from '../../lib/cardState.js'
import type { ConsoleModel } from './useConsole.js'

function CardActions({ q, model, onPoint }: { q: QuestionView; model: ConsoleModel; onPoint: (q: QuestionView) => void }) {
  const [confirmHide, setConfirmHide] = useState(false)
  const status = model.view!.room.status
  const live = status === 'live'
  const canUndo = live && (q.state === 'locked' || q.state === 'verifying' || q.state === 'review')
  const canPoint = (live || status === 'ended') && (q.state === 'open' || q.state === 'deflected' || q.state === 'review')
  const canHide = live && (q.state === 'open' || q.state === 'deflected' || q.state === 'review')
  const busy = model.busy
  if (!canUndo && !canPoint && !canHide) return null
  if (confirmHide)
    return (
      <>
        <span className="small">Hide #{q.number}? Its reservations are released.</span>
        <button type="button" className="btn btn--sm btn--danger" onClick={() => model.actions.hide(q.id).then(() => setConfirmHide(false))} disabled={busy === `hide:${q.id}`}>
          <Icon name={busy === `hide:${q.id}` ? 'spinner' : 'eyeOff'} />
          Hide
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmHide(false)}>
          Keep
        </button>
      </>
    )
  return (
    <>
      {canUndo && (
        <button type="button" className="btn btn--sm" onClick={() => model.actions.undo(q.id)} disabled={busy === `undo:${q.id}`} title="Undo is free: nothing has been charged yet">
          <Icon name={busy === `undo:${q.id}` ? 'spinner' : 'undo'} />
          Undo
        </button>
      )}
      {canPoint && (
        <button type="button" className="btn btn--sm" onClick={() => onPoint(q)} title="Select the words in the transcript that answer this">
          <Icon name="highlight" />
          Point at answer
        </button>
      )}
      {canHide && (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmHide(true)}>
          <Icon name="eyeOff" />
          Hide
        </button>
      )}
    </>
  )
}

export function QuestionsPanel({ model, onPoint, large, onShare }: { model: ConsoleModel; onPoint: (q: QuestionView) => void; large?: boolean; onShare?: () => void }) {
  const room = model.view!.room
  const [showHidden, setShowHidden] = useState(false)
  const ranked = rankQuestions(room.questions, { includeHidden: showHidden })
  const hidden = room.questions.filter((q) => q.state === 'hidden').length
  return (
    <div className="stack gap-3">
      {room.aiMode === 'manual' && (
        <Banner tone="warn" icon="hand">
          <strong>Manual confirm.</strong> Claude is off for this room. Use Point at answer on a card; the same span guard checks your selection before
          anything locks.
        </Banner>
      )}
      {ranked.length === 0 ? (
        <Empty icon="users">
          No questions yet.
          {onShare && (
            <>
              {' '}
              <button type="button" className="linklike" onClick={onShare}>
                Share the fan link
              </button>
            </>
          )}
        </Empty>
      ) : (
        <ol className="qlist" aria-label="Questions ranked by backing">
          {ranked.map((q) => (
            <li key={q.id}>
              <QuestionCard q={q} large={large} actions={<CardActions q={q} model={model} onPoint={onPoint} />} />
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 && (
        <button type="button" className="linklike small" onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? 'Hide hidden cards' : `Show ${hidden} hidden`}
        </button>
      )}
    </div>
  )
}
