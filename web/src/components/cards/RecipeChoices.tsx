import { Check } from 'lucide-react';
import { useApp } from '../../ctx';
import type { RecipeChoice } from '../../types';

/** Approved recipes offered for one menu day (a recommendation, or the closest match to a requested dish). The button links the recipe to the day.
 *  "Chosen" is read from the live menu (the day's entry id, else its date): undo, a skip or a choice made elsewhere update it. */
export function RecipeChoices({ date, options }: { date: string; options: RecipeChoice[] }) {
  const { t, act, busy, state } = useApp();
  const day = state.menu?.days.find((d) => d.id === date) ?? state.menu?.days.find((d) => d.date === date);
  return (
    <ul className="choices">
      {options.map((o) => (
        <li key={o.recipeId} className="choice">
          <span className="choice-name">{o.recipeName}</span>
          <span className="choice-why">{o.why}</span>
          {o.facts?.length ? (
            <ul className="choice-facts">
              {o.facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          {day?.match === 'confirmed' && day.recipeId === o.recipeId ? (
            <span className="choice-done">
              <Check size={16} strokeWidth={3} aria-hidden="true" />
              {t('menuEdit.chosen')}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void act({ type: 'confirm_recipe', date, recipeId: o.recipeId }, { inline: true })}
            >
              {t('menuEdit.chooseForDay')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
