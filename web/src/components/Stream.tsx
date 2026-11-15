import { Paperclip, X } from 'lucide-react';
import { useApp } from '../ctx';
import { cardDomId, isClosable, isFoldable, type StreamCard, type Turn } from '../stream';
import { CardView } from './cards/CardView';
import { IngredientList } from './cards/IngredientList';
import { TurnFold } from './TurnFold';

export interface Pending {
  status: string;
  user?: string;
  inline: boolean;
}

function Welcome() {
  const { t, state, sendChat, pickFile, busy } = useApp();
  // the server's suggestions fit the active account (school week, event, restaurant)
  const examples = state.suggestions.slice(0, 3);
  // a café orders what it needs today: no menu to attach, so the welcome goes straight to ordering
  const small = state.kitchen.kind === 'cafe';
  return (
    <section className="welcome">
      <img className="welcome-mascot" src="/mascot.png" alt="" width={176} height={176} />
      <h1 className="welcome-title">{t('welcome.title')}</h1>
      <p className="welcome-text">{t(small ? 'welcome.textSmall' : 'welcome.text')}</p>
      {small ? null : (
        <div className="welcome-upload">
          <button type="button" className="btn btn-primary btn-lg" onClick={pickFile} disabled={busy}>
            <Paperclip size={19} aria-hidden="true" />
            {t('welcome.upload')}
          </button>
          <p className="hint hint-center">{t('welcome.uploadHint')}</p>
        </div>
      )}
      {examples.length > 0 ? <p className="welcome-try">{t('welcome.try')}</p> : null}
      <ul className="welcome-examples">
        {examples.map((ex, i) => (
          <li key={i}>
            <button type="button" className="prompt-chip prompt-chip-lg" onClick={() => sendChat(ex)} disabled={busy}>
              {ex}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Avatar({ thinking }: { thinking?: boolean }) {
  return (
    <img
      className={`avatar ${thinking ? 'is-thinking' : ''}`}
      src="/mascot-192.png"
      alt="Aimo"
      width={36}
      height={36}
    />
  );
}

/** Cards in display order. Consecutive ingredient groups (two or more) become one compact ingredient list. */
function blocks(cards: StreamCard[]): { key: string; card?: StreamCard; groups?: StreamCard[] }[] {
  const out: { key: string; card?: StreamCard; groups?: StreamCard[] }[] = [];
  let run: StreamCard[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ key: run[0].key, groups: run });
    else for (const card of run) out.push({ key: card.key, card });
    run = [];
  };
  for (const sc of cards) {
    if (sc.card.type === 'products' && sc.card.ingredient) run.push(sc);
    else {
      flush();
      out.push({ key: sc.key, card: sc });
    }
  }
  flush();
  return out;
}

function TurnView({ turn, onToggle, onClose }: { turn: Turn; onToggle: (id: number) => void; onClose: (id: number) => void }) {
  const { t } = useApp();
  // a search turn that a newer request folded keeps a one-line header; it toggles the rest of the turn
  const foldable = turn.folded !== undefined && isFoldable(turn);
  const bodyId = `turn-body-${turn.id}`;
  // results, notes, comparisons, the portions form, order receipts and plain replies can be closed: only the view
  // changes, an order stays an order (side panel)
  const first = turn.cards[0]?.card;
  const what = (
    turn.user ??
    (first?.type === 'products' || first?.type === 'comparison' ? first.title
      : first?.type === 'note' ? (first.title ?? first.text)
        : first?.type === 'order' ? first.order.id
          : first?.type === 'portions' ? t('portions')
            : (turn.reply ?? turn.error ?? ''))
  ).slice(0, 80);
  const close = isClosable(turn) ? (
    <button
      type="button"
      className="icon-btn turn-close"
      onClick={() => onClose(turn.id)}
      aria-label={what ? t('turn.closeWhat', { what }) : t('close')}
      title={t('turn.close.hint')}
    >
      <X size={18} aria-hidden="true" />
    </button>
  ) : null;
  // a folded search turn has its X on the fold row; elsewhere it sits on Aimo's reply
  const own = foldable ? null : close;
  const body = (
    <>
      {turn.user && !foldable ? (
        <div className="user-row">
          <p className="user-pill">
            <span className="sr-only">{t('you')}: </span>
            {turn.user}
          </p>
        </div>
      ) : null}
      {turn.reply || turn.resumed ? (
        <div className="aimo-row">
          <Avatar />
          <p className="aimo-text">{turn.reply ?? t('resumed')}</p>
          {own}
        </div>
      ) : null}
      {turn.error ? (
        <div className="aimo-row">
          <Avatar />
          <p className="aimo-text aimo-error" role="alert">
            {turn.error}
          </p>
          {turn.reply || turn.resumed ? null : own}
        </div>
      ) : null}
      {/* a turn without Aimo's words (the portions form opened from the side panel) gets its X on a row of its own */}
      {own && !turn.reply && !turn.resumed && !turn.error ? <div className="turn-tools">{own}</div> : null}
      {blocks(turn.cards).map((b) =>
        b.groups ? (
          <div className="card-slot" key={b.key}>
            <IngredientList groups={b.groups} />
          </div>
        ) : b.card ? (
          <div className="card-slot" key={b.key} id={cardDomId(b.key)}>
            <CardView card={b.card.card} />
          </div>
        ) : null,
      )}
    </>
  );
  return (
    <section
      className={`turn ${turn.quiet ? 'turn-quiet' : ''} ${foldable && turn.folded ? 'is-folded' : ''}`}
      id={`turn-${turn.id}`}
    >
      {foldable ? (
        <>
          <div className="turn-fold-row">
            <TurnFold turn={turn} bodyId={bodyId} onToggle={() => onToggle(turn.id)} />
            {close}
          </div>
          <div className="turn-body" id={bodyId} hidden={turn.folded}>
            {turn.folded ? null : body}
          </div>
        </>
      ) : (
        body
      )}
    </section>
  );
}

/** The workspace: each turn is the user's short message, Aimo's one-line reply, then result cards. Earlier search
 *  turns fold to one line when a new request starts. */
export function Stream({
  turns,
  pending,
  onToggle,
  onClose,
}: {
  turns: Turn[];
  pending: Pending | null;
  onToggle: (id: number) => void;
  /** hide a closable turn from the view */
  onClose: (id: number) => void;
}) {
  const { t } = useApp();
  const showPending = pending && !pending.inline;
  if (turns.length === 0 && !showPending) return <Welcome />;
  return (
    <div className="stream">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} onToggle={onToggle} onClose={onClose} />
      ))}
      {showPending ? (
        <section className="turn turn-pending" id="turn-pending">
          {pending.user ? (
            <div className="user-row">
              <p className="user-pill">
                <span className="sr-only">{t('you')}: </span>
                {pending.user}
              </p>
            </div>
          ) : null}
          <div className="aimo-row">
            <Avatar thinking />
            <p className="aimo-text aimo-pending">
              {pending.status}
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
