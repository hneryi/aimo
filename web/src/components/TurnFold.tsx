import { ChevronRight } from 'lucide-react';
import { useApp } from '../ctx';
import type { Turn } from '../stream';

/** The one-line form of an earlier search turn: the request, how many product groups it showed and how many of those
 *  products are on an order card. One press opens the turn again; the same row folds it back. */
export function TurnFold({ turn, bodyId, onToggle }: { turn: Turn; bodyId: string; onToggle: () => void }) {
  const { t, state } = useApp();
  const groups = turn.cards.flatMap((c) => (c.card.type === 'products' ? [c.card] : []));
  const shown = new Set(groups.flatMap((g) => g.items.map((a) => a.product.id)));
  const onCards = new Set((state.drafts ?? []).flatMap((d) => d.lines.map((l) => l.product.id)).filter((id) => shown.has(id))).size;
  const first = turn.cards[0]?.card;
  const title =
    turn.user ?? (first?.type === 'products' ? first.title : first?.type === 'note' ? (first.title ?? first.text) : '');
  const meta = groups.length
    ? [
        groups.length === 1 ? t('fold.groups.one') : t('fold.groups', { n: groups.length }),
        onCards === 0 ? t('fold.onCards.none') : onCards === 1 ? t('fold.onCards.one') : t('fold.onCards', { n: onCards }),
      ].join(' · ')
    : '';
  return (
    <button type="button" className="turn-fold" aria-expanded={!turn.folded} aria-controls={bodyId} onClick={onToggle}>
      <ChevronRight size={18} className="turn-fold-chevron" aria-hidden="true" />
      <span className="turn-fold-main">
        <span className="turn-fold-text">
          <span className="sr-only">{t('fold.earlier')}: </span>
          {title}
        </span>
        {meta ? <span className="turn-fold-meta">{meta}</span> : null}
      </span>
    </button>
  );
}
