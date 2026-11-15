import type { DashboardState, MenuDay, RecipeSummary } from './types';

/** Only the server's role metadata decides what belongs in a menu entry's picker. */
export function recipeOptions(state: DashboardState, date: string, exclude?: string) {
  const day = state.menu?.days.find(d => (d.id ?? d.date) === date);
  return day?.role ? state.recipes.filter(r => r.role === day.role && r.id !== exclude) : [];
}

/** The dish an entry shows: the linked recipe, the kitchen's own dish, the removed dish, or the imported name. */
export const shownDish = (day: MenuDay): string =>
  day.match === 'confirmed' ? day.recipeName ?? day.dishName
    : day.match === 'custom' ? day.customName ?? day.dishName
      : day.match === 'skipped' ? day.removedDish ?? day.dishName
        : day.dishName;

/** The menu card's entries in menu order: the dishes shown as cards, and the removed ones for the short list at the
 *  card's end. The order never changes, so a restored dish is back in its own place. */
export const menuCardDays = (days: MenuDay[]): { shown: MenuDay[]; removed: MenuDay[] } => ({
  shown: days.filter((d) => d.match !== 'skipped'),
  removed: days.filter((d) => d.match === 'skipped'),
});

/** The server's `norm` (catalog.ts): lower case, accents removed, anything else than letters and digits as one space. */
export const normText = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A typed dish name as the server stores it (set_custom_dish): control characters and repeated spaces removed. */
export const tidyDishName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export const DISH_NAME_MAX = 60;

export interface RecipeMatches {
  /** the options to show, in their original order */
  items: RecipeSummary[];
  /** the option whose name (any language) or alias is exactly what was typed: choosing it is the same as typing it */
  exact?: RecipeSummary;
}

/**
 * The picker's list for what the user typed. Empty input shows every option. Otherwise every typed word must occur in
 * the recipe's name, one of its names in another language, an alias or a hint word; a hint word inside the typed text
 * also counts ("kalakeitto" finds the salmon soup by its hint "kala"). Only `options` are ever returned, so the role
 * rule of `recipeOptions` is kept.
 */
export function filterRecipes(options: RecipeSummary[], typed: string): RecipeMatches {
  const q = normText(typed);
  if (!q) return { items: options };
  const words = q.split(' ');
  const namesOf = (r: RecipeSummary) => [normText(r.name), ...(r.names ?? [])];
  const items = options.filter((r) => {
    const hay = [...namesOf(r), ...(r.hints ?? [])];
    return words.every((w) => hay.some((h) => h.includes(w))) || (r.hints ?? []).some((h) => h.length >= 3 && q.includes(h));
  });
  return { items, exact: options.find((r) => namesOf(r).includes(q)) };
}

/** What Enter in the picker's search field does: an exact name or the only matching recipe picks that recipe; no
 *  matching recipe at all searches the wholesaler for the typed name as the kitchen's own dish (the same as the
 *  "Find from the wholesaler" button); several matches, or nothing typed, do nothing. */
export type PickerEnter = { kind: 'recipe'; id: string } | { kind: 'wholesale'; name: string } | { kind: 'none' };

export function pickerEnter(matches: RecipeMatches, typed: string): PickerEnter {
  const name = tidyDishName(typed).slice(0, DISH_NAME_MAX);
  if (!name) return { kind: 'none' };
  const pick = matches.exact ?? (matches.items.length === 1 ? matches.items[0] : undefined);
  if (pick) return { kind: 'recipe', id: pick.id };
  return matches.items.length === 0 ? { kind: 'wholesale', name } : { kind: 'none' };
}
