import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { QuestionView } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Dialog, Panel, Seg } from '../../components/ui.js'
import { friendlyError } from '../../lib/messages.js'
import { takeCreatorToken } from '../../lib/session.js'
import { paths } from '../../lib/url.js'
import { PageError, PageLoading } from '../Fallbacks.js'
import '../../styles/console.css'
import { ConsoleHeader } from './ConsoleParts.js'
import { Checklist, PricesPanel, SharePanel } from './Extras.js'
import { InputBar } from './InputBar.js'
import { ContestsPanel, DisputesPanel, LedgerPanel, PayoutPanel, TabsPanel } from './MoneyPanels.js'
import { disputeIsOpen } from '../../lib/disputes.js'
import { QuestionsPanel } from './QuestionsPanel.js'
import { ResultsPanel, ReviewPanel } from './SettlePanels.js'
import { Transcript } from './Transcript.js'
import { useConsole, type ConsoleModel } from './useConsole.js'

export type StageTab = 'questions' | 'review' | 'results'
export type MoneyTab = 'tabs' | 'ledger' | 'contests' | 'payout' | 'disputes'

/** Follows the room through its lifecycle: questions while live, review after End, results once settled. */
export function useStage(model: ConsoleModel): [StageTab, (t: StageTab) => void] {
  const status = model.view?.room.status
  const [stage, setStage] = useState<StageTab>('questions')
  useEffect(() => {
    if (status === 'ended' || status === 'settling') setStage('review')
    else if (status === 'settled' || status === 'voided') setStage('results')
    else if (status) setStage('questions')
  }, [status])
  return [stage, setStage]
}

export function stageOptions(model: ConsoleModel) {
  const view = model.view!
  const status = view.room.status
  const open = view.room.questions.filter((q) => q.state !== 'hidden').length
  const opts: { value: StageTab; label: string; icon: string; count?: number }[] = [{ value: 'questions', label: 'Questions', icon: 'users', count: open }]
  if (status === 'ended' || status === 'settling') opts.push({ value: 'review', label: 'Review & settle', icon: 'flag' })
  if (status === 'settled' || status === 'voided') opts.push({ value: 'results', label: 'Results', icon: 'receipt' })
  return opts
}

export function StageBody({ model, stage, onPoint, large, onShare }: { model: ConsoleModel; stage: StageTab; onPoint: (q: QuestionView) => void; large?: boolean; onShare?: () => void }) {
  if (stage === 'review') return <ReviewPanel model={model} />
  if (stage === 'results') return <ResultsPanel model={model} />
  return <QuestionsPanel model={model} onPoint={onPoint} large={large} onShare={onShare} />
}

export function usePointing(model: ConsoleModel) {
  const [pointingId, setPointingId] = useState<string | null>(null)
  const pointing = useMemo(() => model.view?.room.questions.find((q) => q.id === pointingId) ?? null, [model.view, pointingId])
  return { pointing, start: (q: QuestionView) => setPointingId(q.id), done: () => setPointingId(null) }
}

function MoneyPanel({ model }: { model: ConsoleModel }) {
  const view = model.view!
  const [tab, setTab] = useState<MoneyTab>('ledger')
  const pendingContests = view.contests.filter((c) => c.state === 'pending_creator' || c.state === 'failed').length
  const disputes = view.disputes ?? []
  const openDisputes = disputes.filter(disputeIsOpen).length
  return (
    <Panel
      title={
        <Seg
          label="Money"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'ledger', label: 'PayPal ledger', icon: 'bank', count: view.ledger.length },
            { value: 'tabs', label: 'Tabs', icon: 'card', count: view.tabs.length },
            { value: 'contests', label: 'Contests', icon: 'receipt', count: pendingContests || view.contests.length },
            { value: 'payout', label: 'Payout', icon: 'webhook' },
            { value: 'disputes', label: 'Disputes', icon: 'shield', count: openDisputes || disputes.length },
          ]}
        />
      }
    >
      {tab === 'tabs' && <TabsPanel model={model} />}
      {tab === 'ledger' && <LedgerPanel model={model} />}
      {tab === 'contests' && <ContestsPanel model={model} />}
      {tab === 'payout' && <PayoutPanel model={model} />}
      {tab === 'disputes' && <DisputesPanel model={model} />}
    </Panel>
  )
}

function ConsoleScreen({ roomId, token }: { roomId: string; token: string }) {
  const model = useConsole(roomId, token)
  const [localInterim, setLocalInterim] = useState<string | null>(null)
  const [micLive, setMicLive] = useState(false)
  const [dialog, setDialog] = useState<'share' | 'prices' | null>(null)
  const point = usePointing(model)
  const [stage, setStage] = useStage(model)

  useEffect(() => {
    document.title = 'AnswerTab · Console'
  }, [])

  const { view, live } = model
  if (!view) {
    if (live.error) {
      const e = live.error
      const title = e.status === 401 || e.status === 403 ? 'That console key does not match this room' : e.status === 404 ? 'Room not found' : 'Could not load the console'
      return (
        <PageError
          title={title}
          detail={friendlyError(e)}
          action={
            <button type="button" className="btn btn--primary" onClick={() => void live.reload()}>
              <Icon name="refresh" /> Try again
            </button>
          }
        />
      )
    }
    return <PageLoading />
  }

  return (
    <div className="console">
      <a className="skip-link" href="#console-main">
        Skip to console
      </a>
      <ConsoleHeader
        model={model}
        micLive={micLive}
        onShare={() => setDialog('share')}
        onPrices={() => setDialog('prices')}
        extra={
          view.room.kind === 'demo' ? (
            <Link className="btn btn--ghost btn--sm" to={paths.demo(roomId)}>
              <Icon name="external" />
              Presentation
            </Link>
          ) : null
        }
      />
      <main id="console-main" className="console__grid">
        <div className="console__left">
          <Panel title="Transcript" icon="mic" className="console__transcript" bodyClass="panel__body panel__body--flush">
            <Transcript model={model} localInterim={localInterim} pointing={point.pointing} onPointDone={point.done} footer={<InputBar model={model} onInterim={setLocalInterim} onLive={setMicLive} />} />
          </Panel>
          {view.room.kind === 'demo' && <Checklist view={view} />}
        </div>
        <div className="console__right">
          <Panel title={<Seg label="Stage" value={stage} onChange={setStage} options={stageOptions(model)} />}>
            <StageBody model={model} stage={stage} onPoint={point.start} onShare={() => setDialog('share')} />
          </Panel>
          <MoneyPanel model={model} />
        </div>
      </main>
      <Dialog open={dialog === 'share'} onClose={() => setDialog(null)} title="Share this room">
        <SharePanel roomId={roomId} token={token} />
      </Dialog>
      <Dialog open={dialog === 'prices'} onClose={() => setDialog(null)} title="Prices and PayPal fees" wide>
        <PricesPanel prices={view.room.prices} />
      </Dialog>
    </div>
  )
}

export default function ConsolePage() {
  const { room = '' } = useParams()
  const [token] = useState(() => takeCreatorToken(room))
  if (!token)
    return (
      <PageError
        title="This console link is missing its key"
        detail="Open the console from the link you got when the room was created; it ends in #k=… The key stays in this browser tab and is never put in the address a server sees."
      />
    )
  return <ConsoleScreen roomId={room} token={token} />
}
