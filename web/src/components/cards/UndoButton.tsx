import { Undo2 } from 'lucide-react';
import { useApp } from '../../ctx';

/** Takes back the latest plan edit. Shown only while the server has something to undo; the text says what it would revert. */
export function UndoButton() {
  const { t, state, act, busy } = useApp();
  if (!state.undo) return null;
  return (
    <div className="undo-row">
      <button type="button" className="btn btn-soft" disabled={busy} onClick={() => void act({ type: 'undo' }, { inline: true })}>
        <Undo2 size={18} aria-hidden="true" />
        {t('menuEdit.undo')}
      </button>
      <span className="undo-what">{t('menuEdit.undoHint', { what: state.undo.label })}</span>
    </div>
  );
}
