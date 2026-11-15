import { Check, Store } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../../ctx';
import { DISH_NAME_MAX, filterRecipes, pickerEnter, recipeOptions, tidyDishName } from '../../recipeOptions';
import { dayDomId } from '../../stream';

/**
 * Choose the dish of one menu entry: a search field over the approved recipes of the entry's role, every option a
 * button (`confirm_recipe`). When no approved recipe of the role has the typed name, one button searches the wholesaler
 * for it: the name becomes the kitchen's own dish (`set_custom_dish`, no recipe and no quantities) and the dish's card
 * shows the matching products. Enter does the same only when no recipe matches at all; an exact name or the only match
 * picks that recipe, and several matches do nothing. The same picker serves every state of an entry. `onClose` (Escape,
 * or after a choice) belongs to a picker the user opened; `autoFocus` puts the cursor in the search field when it opens;
 * `reveal` brings the dish's card into view afterwards (the picker sits on another card).
 */
export function RecipePicker({ date, autoFocus, onClose, reveal }: { date: string; autoFocus?: boolean; onClose?: () => void; reveal?: boolean }) {
  const { t, state, act, busy, searchDish } = useApp();
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const day = state.menu?.days.find((d) => (d.id ?? d.date) === date);
  if (!day) return null;
  const options = recipeOptions(state, date);
  const matches = filterRecipes(options, query);
  const { items, exact } = matches;
  const typed = tidyDishName(query).slice(0, DISH_NAME_MAX);
  const current = day.match === 'confirmed' ? day.recipeId : undefined;
  const done = (ok: boolean) => {
    if (ok) onClose?.();
  };
  const choose = (recipeId: string) => void act({ type: 'confirm_recipe', date, recipeId }, { inline: true }).then(done);
  const wholesale = (name: string) =>
    void act({ type: 'set_custom_dish', date, name }, { inline: true }).then((ok) => {
      if (!ok) return;
      searchDish(date, name);
      onClose?.();
      if (!reveal) return;
      window.setTimeout(() => {
        const card = document.getElementById(dayDomId(date));
        // the menu card is not in the view: bring it back, the search shows there
        if (card) card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        else void act({ type: 'show_menu' }, { inline: true });
      }, 60);
    });

  return (
    <div
      className="dish-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="dish-picker-label" htmlFor={id}>
        {t('picker.label')}
      </label>
      <input
        id={id}
        ref={field}
        className="input"
        type="search"
        value={query}
        maxLength={DISH_NAME_MAX}
        placeholder={t('picker.placeholder')}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (busy) return;
          const next = pickerEnter(matches, query);
          if (next.kind === 'recipe') {
            if (next.id === current) onClose?.();
            else choose(next.id);
          } else if (next.kind === 'wholesale') wholesale(next.name);
        }}
        autoComplete="off"
        enterKeyHint="search"
      />
      {!day.role ? (
        <p className="muted">{t('picker.noRole')}</p>
      ) : options.length === 0 ? (
        <p className="muted">{t('picker.noRecipes')}</p>
      ) : (
        <ul className="dish-options" aria-label={t('picker.recipes')}>
          {items.map((r) => {
            const mark =
              day.importRecipe?.recipeId === r.id
                ? t(day.importRecipe.exact ? 'picker.imported' : 'picker.closest', { name: day.dishName })
                : '';
            return (
              <li key={r.id}>
                {r.id === current ? (
                  <span className="dish-option is-current">
                    <span className="dish-option-name">{r.name}</span>
                    <span className="dish-option-tag">
                      <Check size={14} strokeWidth={3} aria-hidden="true" />
                      {t('picker.current')}
                    </span>
                    {mark ? <span className="dish-option-tag">{mark}</span> : null}
                  </span>
                ) : (
                  <button type="button" className="dish-option" disabled={busy} onClick={() => choose(r.id)}>
                    <span className="dish-option-name">{r.name}</span>
                    {mark ? <span className="dish-option-tag">{mark}</span> : null}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {day.role && options.length > 0 && items.length === 0 ? <p className="muted">{t('picker.noMatch')}</p> : null}
      {typed && !exact ? (
        <>
          <button type="button" className="btn btn-soft dish-custom" disabled={busy} onClick={() => wholesale(typed)}>
            <Store size={18} aria-hidden="true" />
            <span>{t('picker.wholesale', { name: typed })}</span>
          </button>
          <p className="hint">{t('picker.wholesaleHint')}</p>
        </>
      ) : null}
      {onClose ? (
        <button type="button" className="text-btn dish-picker-close" onClick={onClose}>
          {t('close')}
        </button>
      ) : null}
    </div>
  );
}
