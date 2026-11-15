import { CalendarDays, Check, CircleHelp, FileSpreadsheet, FileText, Minus, PenLine, RotateCcw, Search, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../../ctx';
import type { Fmt } from '../../format';
import { menuCardDays, shownDish } from '../../recipeOptions';
import { dayDomId } from '../../stream';
import type { MenuDay, Requirement, WeekMenu } from '../../types';
import { Chip, ProductRow } from '../ui';
import { AddToDraft } from './DraftCard';
import { DraftTarget } from './DraftTools';
import { RecipePicker } from './RecipePicker';
import { UndoButton } from './UndoButton';

const MATCH_ICON = { confirmed: Check, suggested: CircleHelp, missing: TriangleAlert, skipped: Minus, custom: PenLine } as const;
const SOURCE_ICON = { xlsx: FileSpreadsheet, pdf: FileText, demo: Sparkles, manual: FileText } as const;

/** What a menu entry is called: the course label of an event menu, otherwise the weekday and date. */
const entryTitle = (day: MenuDay, event: boolean, fmt: Fmt) =>
  event && day.label ? day.label : `${day.weekdayLabel} ${fmt.dayMonth(day.date)}`;

/**
 * The kitchen's own dish has no recipe, so Aimo calculates nothing for it: the buyer picks the products from the
 * wholesaler's assortment. The search runs only on the button or Enter (the supplier API has a rate limit), and every
 * product goes to the order draft by the buyer's own press. With diet groups, one requirement can be checked: a product
 * not verified for it cannot be added with that requirement.
 */
function DishSearch({ entry, name }: { entry: string; name: string }) {
  const { t, state, dishSearch, searchDish } = useApp();
  const found = dishSearch[entry];
  const [q, setQ] = useState(found?.q ?? name);
  const groups = state.kitchen.groups.filter((g) => g.count > 0 && g.requirements.length === 1);
  const [req, setReq] = useState<Requirement | ''>(found?.req[0] ?? '');
  const id = useId();
  const searching = found?.status === 'searching';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim() || searching) return;
    searchDish(entry, q, req ? [req] : []);
  };
  const checked = found?.req[0] ? (groups.find((g) => g.requirements[0] === found.req[0])?.label ?? found.req[0]) : '';

  return (
    <section className="dish-search" aria-labelledby={`${id}-title`}>
      <h4 className="dish-search-title" id={`${id}-title`}>
        {t('dishSearch.title')}
      </h4>
      <form className="search-form" role="search" onSubmit={submit}>
        <input
          className="input"
          type="search"
          value={q}
          maxLength={100}
          aria-label={t('dishSearch.label')}
          onChange={(e) => setQ(e.currentTarget.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-soft" disabled={!q.trim() || searching}>
          <Search size={17} aria-hidden="true" />
          {searching ? t('searching') : t('dishSearch.go')}
        </button>
      </form>
      {groups.length > 0 ? (
        <label className="draft-field">
          <span>{t('dishSearch.diet')}</span>
          <select className="select" value={req} onChange={(e) => setReq(e.currentTarget.value as Requirement | '')}>
            <option value="">{t('dishSearch.dietNone')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.requirements[0]}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="hint">{t(groups.length > 0 ? 'dishSearch.dietHint' : 'dishSearch.noDietCheck')}</p>

      <div aria-live="polite">
        {found?.status === 'searching' ? <p className="muted">{t('dishSearch.searching', { q: found.q })}</p> : null}
        {found?.status === 'done' && found.items.length === 0 ? <p className="muted">{t('dishSearch.none', { q: found.q })}</p> : null}
        {found?.status === 'done' && found.items.length > 0 ? (
          <p className="hint">
            {checked ? t('dishSearch.resultsChecked', { q: found.q, req: checked }) : t('dishSearch.results', { q: found.q })}
          </p>
        ) : null}
      </div>
      {found?.status === 'error' ? (
        <p className="inline-warn" role="alert">
          {found.error}
        </p>
      ) : null}
      {found?.status === 'done' && found.items.length > 0 ? (
        <>
          <DraftTarget />
          <div className="prod-list">
            {found.items.map((a) => (
              <ProductRow key={a.product.id} alt={a} footer={<AddToDraft alt={a} />} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** One menu entry as a card: a weekday of a weekly menu, or one course of an event menu. Its X removes the dish (the
 *  card goes to the "removed dishes" list, from where it comes back to its own place); every state can change the dish. */
function Day({ day, event }: { day: MenuDay; event: boolean }) {
  const { t, fmt, act, busy, sendChat } = useApp();
  const [picking, setPicking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const Icon = MATCH_ICON[day.match] ?? CircleHelp;
  // the entry's own id addresses it in actions (for weekly menus it equals the date)
  const entry = day.id ?? day.date;
  const dish = shownDish(day);
  const title = entryTitle(day, event, fmt);
  const close = () => {
    setPicking(false);
    window.requestAnimationFrame(() => opener.current?.focus());
  };
  const change = (label: string) => (
    <button
      type="button"
      ref={opener}
      className="btn btn-soft"
      disabled={busy}
      aria-expanded={picking}
      onClick={() => setPicking((v) => !v)}
    >
      <Search size={17} aria-hidden="true" />
      {label}
    </button>
  );
  const picker = picking ? <RecipePicker date={entry} autoFocus onClose={close} /> : null;

  return (
    <li className={`day day-${day.match}`} id={dayDomId(entry)}>
      <div className="day-head">
        <span className="day-when">
          {event && day.label ? (
            <span className="day-wd">{day.label}</span>
          ) : (
            <>
              <span className="day-wd">{day.weekdayLabel}</span> {fmt.dayMonth(day.date)}
            </>
          )}
        </span>
        <span className={`match match-${day.match}`}>
          <Icon size={14} strokeWidth={2.8} aria-hidden="true" />
          {t(day.roleProblem ? 'role.check' : `m.${day.match}`)}
        </span>
      </div>
      <button
        type="button"
        className="icon-btn card-x day-x"
        disabled={busy}
        aria-label={t('day.removeAria', { name: title })}
        title={t('day.removeAria', { name: title })}
        onClick={(e) => {
          // the card leaves the grid and the next one takes its place: focus goes to that card's X, so the dishes can be
          // closed one after another, and the view never jumps (the way back is the list of removed dishes and Undo)
          const li = e.currentTarget.closest('li');
          const neighbour = (li?.nextElementSibling ?? li?.previousElementSibling)?.id;
          void act({ type: 'skip_day', date: entry }, { inline: true }).then((ok) => {
            if (!ok) return;
            window.setTimeout(() => {
              const next = neighbour ? document.getElementById(neighbour)?.querySelector<HTMLElement>('.day-x') : null;
              (next ?? document.getElementById(dayDomId(entry, 'restore')))?.focus({ preventScroll: true });
            }, 60);
          });
        }}
      >
        <X size={20} aria-hidden="true" />
      </button>
      <p className="day-dish">{dish}</p>
      {day.match === 'custom' ? <Chip>{t('custom.tag')}</Chip> : null}
      {(day.match === 'confirmed' || day.match === 'custom') && dish.toLowerCase() !== day.dishName.toLowerCase() ? (
        <p className="day-recipe">{t('menuEdit.originalDish', { name: day.dishName })}</p>
      ) : null}
      {day.roleProblem ? <p className="inline-warn">{day.roleProblem}</p> : null}
      {event && !day.role ? (
        <label className="draft-field">
          <span>{t('role.label')}</span>
          <select
            className="select"
            value=""
            disabled={busy}
            onChange={(e) => {
              const role = e.currentTarget.value as 'main' | 'drink' | 'dessert';
              if (role) void act({ type: 'set_course', date: entry, role }, { inline: true });
            }}
          >
            <option value="">{t('role.chooseFirst')}</option>
            <option value="main">{t('role.main')}</option>
            <option value="drink">{t('role.drink')}</option>
            <option value="dessert">{t('role.dessert')}</option>
          </select>
        </label>
      ) : null}
      {day.match !== 'custom' ? (
        <p className="day-portions">
          {t('portionsCount', { n: fmt.num(day.portions, 0) })}
          {typeof day.importedPortions === 'number' && day.importedPortions !== day.portions
            ? ` (${t('inFile', { n: fmt.num(day.importedPortions, 0) })})`
            : ''}
        </p>
      ) : null}
      {day.dietNotes?.length ? (
        <div className="badges">
          {day.dietNotes.map((n, i) => (
            <Chip key={i}>{n}</Chip>
          ))}
        </div>
      ) : null}

      {day.match === 'suggested' && day.suggestion ? (
        <div className="day-action">
          <p className="day-suggest">
            {t('suggests')} <strong>{day.suggestion.recipeName}</strong>
            {day.suggestion.why ? <> — {day.suggestion.why}</> : null}
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(
                  { type: 'confirm_recipe', date: entry, recipeId: day.suggestion!.recipeId },
                  { inline: true },
                )
              }
            >
              {t('useRecipe')}
            </button>
            {change(t('day.change'))}
          </div>
          {picker}
        </div>
      ) : null}

      {day.match === 'missing' || (day.match === 'suggested' && !day.suggestion) ? (
        <div className="day-action">
          <RecipePicker date={entry} />
        </div>
      ) : null}

      {day.match === 'confirmed' ? (
        <div className="day-action">
          <div className="btn-row">{change(t('day.change'))}</div>
          {picker}
        </div>
      ) : null}

      {day.match === 'custom' ? (
        <div className="day-action">
          <p className="day-note">{t('custom.note')}</p>
          <DishSearch key={day.customName ?? day.dishName} entry={entry} name={day.customName ?? day.dishName} />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => sendChat(t('custom.findMessage', { name: day.customName ?? day.dishName }))}
            >
              {t('custom.find')}
            </button>
            {change(t('day.change'))}
          </div>
          {picker}
        </div>
      ) : null}
    </li>
  );
}

/** Removed dishes, in a short list at the end of the menu card: one press puts a dish back on its own place. */
function RemovedDishes({ days, event }: { days: MenuDay[]; event: boolean }) {
  const { t, fmt, act, busy } = useApp();
  const id = useId();
  if (days.length === 0) return null;
  return (
    <section className="menu-removed" aria-labelledby={id}>
      <h4 className="plan-group-head" id={id}>
        <span className="group-title">
          <Trash2 size={15} strokeWidth={2.4} aria-hidden="true" />
          {t('menu.removed', { n: days.length })}
        </span>
      </h4>
      <ul className="removed-lines">
        {days.map((d) => {
          const entry = d.id ?? d.date;
          const dish = shownDish(d);
          const title = entryTitle(d, event, fmt);
          return (
            <li key={entry}>
              <span className="removed-name">
                <span className="prod-name">{dish}</span>
                <span className="prod-meta">{title}</span>
              </span>
              <button
                type="button"
                id={dayDomId(entry, 'restore')}
                className="btn btn-soft btn-small"
                disabled={busy}
                aria-label={t('menu.restoreAria', { name: dish, when: title })}
                onClick={() => void act({ type: 'restore_day', date: entry }, { inline: true })}
              >
                <RotateCcw size={16} aria-hidden="true" />
                {t('restore')}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MenuCard({ menu }: { menu: WeekMenu }) {
  const { t, fmt, state, act, busy } = useApp();
  const SourceIcon = SOURCE_ICON[menu.source.kind] ?? FileText;
  const sourceName = menu.source.filename || (menu.source.kind === 'demo' ? t('menu.demo') : '');
  const event = menu.kind === 'event';
  const first = event ? menu.days[0]?.date : undefined;
  // the event date is shown once: skip our own line when the server's label already names it
  const eventDate = first && !menu.weekLabel.includes(fmt.dayMonth(first)) ? first : undefined;
  // a removed dish is not a card any more: it waits in the list below, in its own place in the menu's order
  const { shown, removed } = menuCardDays(menu.days);
  return (
    <article className="card menu-card">
      <header className="card-head card-head-x">
        <p className="card-kicker">{t(event ? 'eventMenu' : 'weekMenu')}</p>
        <h3 className="card-title">{menu.weekLabel}</h3>
        {eventDate ? (
          <p className="card-sub card-sub-date">
            <CalendarDays size={15} aria-hidden="true" />
            {fmt.longDay(eventDate)}
          </p>
        ) : null}
        {sourceName ? (
          <p className="card-sub">
            <SourceIcon size={15} aria-hidden="true" />
            {t('menu.source', { name: sourceName })}
          </p>
        ) : null}
        <button
          type="button"
          className="icon-btn card-x"
          disabled={busy}
          aria-label={t('menu.removeAria')}
          title={t('menu.removeHint')}
          onClick={() => void act({ type: 'clear_menu' }, { inline: true })}
        >
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      {menu.warnings.map((w, i) => (
        <p className="callout callout-warn" key={i}>
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{w}</span>
        </p>
      ))}
      <ul className="days">
        {shown.map((d) => (
          <Day key={d.id ?? d.date} day={d} event={event} />
        ))}
      </ul>
      <RemovedDishes days={removed} event={event} />
      <footer className="card-foot">
        <UndoButton />
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy}
          onClick={() => void act({ type: 'build_plan' }, { label: t(state.plan ? 'updatePlan' : 'buildPlan') })}
        >
          {t(state.plan ? 'updatePlan' : 'buildPlan')}
        </button>
      </footer>
    </article>
  );
}
