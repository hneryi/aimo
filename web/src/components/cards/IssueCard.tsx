import { Check, OctagonAlert, RotateCcw, Search, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { errorText, searchProducts } from '../../api';
import { canReopen } from '../../changes';
import { useApp } from '../../ctx';
import type { Alternative, Issue, IssueKind, Requirement, WeekMenu } from '../../types';
import { CheckBlock, Chip, Fold, ProductFacts, ProductMeta, ProductRow } from '../ui';
import { PortionsEditor } from './PortionsEditor';
import { RecipePicker } from './RecipePicker';

/** Verified alternatives + free product search; the chosen product resolves the issue. */
function ProductResolve({ issue }: { issue: Issue }) {
  const { t, lang, profile, act, busy, scrollToCard } = useApp();
  const alts = useMemo(() => issue.alternatives ?? [], [issue.alternatives]);
  const [picked, setPicked] = useState(() => alts.find((a) => a.suitable)?.product.id ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Alternative[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // the requirements a replacement has to meet: from the failed check and the checks on the suggestions
  const reqs = useMemo(() => {
    const map = new Map<Requirement, string>();
    if (issue.check) map.set(issue.check.requirement, issue.check.requirementLabel);
    for (const a of alts) for (const c of a.checks) map.set(c.requirement, c.requirementLabel);
    return map;
  }, [issue.check, alts]);

  const found = (results ?? []).filter((r) => !alts.some((a) => a.product.id === r.product.id));
  const canUse = [...alts, ...found].some((a) => a.suitable && a.product.id === picked);
  const group = `pick-${issue.id}`;

  const search = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError('');
    try {
      setResults(await searchProducts(q, [...reqs.keys()], lang, profile));
    } catch (err) {
      setResults(null);
      setSearchError(errorText(err, t));
    } finally {
      setSearching(false);
    }
  };

  const row = (a: Alternative, tag?: string) => (
    <ProductRow
      key={a.product.id}
      alt={a}
      tag={tag}
      select={{ name: group, checked: picked === a.product.id, onSelect: () => setPicked(a.product.id) }}
    />
  );

  return (
    <section className="resolve">
      <h4 className="section-title">{t('verifiedAlternatives')}</h4>
      {alts.length === 0 ? <p className="muted">{t('noAlternatives')}</p> : null}
      <div className="prod-list">{alts.map((a, i) => row(a, i === 0 && a.suitable ? t('recommended') : undefined))}</div>

      <Fold
        className="fold-search"
        summary={
          <>
            <Search size={16} aria-hidden="true" /> {t('searchAnother')}
          </>
        }
      >
        <form className="search-form" onSubmit={search}>
          <input
            className="input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t('search.placeholder')}
            aria-label={t('searchAnother')}
            enterKeyHint="search"
          />
          <button type="submit" className="btn btn-soft" disabled={!query.trim() || searching}>
            {searching ? t('searching') : t('search')}
          </button>
        </form>
        {reqs.size > 0 ? (
          <p className="hint">{t('searchChecked', { reqs: [...reqs.values()].join(', ') })}</p>
        ) : null}
        {searchError ? (
          <p className="inline-warn" role="alert">
            {searchError}
          </p>
        ) : null}
        {results && found.length === 0 && !searchError ? <p className="muted">{t('noResults')}</p> : null}
        {found.length > 0 ? <div className="prod-list">{found.map((a) => row(a))}</div> : null}
      </Fold>

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!canUse || busy}
        onClick={() =>
          void act({ type: 'resolve_issue', issueId: issue.id, productId: picked }, { inline: true }).then((ok) => {
            // the card collapses to one line: keep that confirmation in view instead of whatever slid up
            if (ok) window.setTimeout(() => scrollToCard(`issue:${issue.id}`), 60);
          })
        }
      >
        {t('useProduct')}
      </button>

      <div className="skip-issue">
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={busy}
          onClick={() =>
            void act({ type: 'skip_issue', issueId: issue.id }, { inline: true }).then((ok) => {
              if (ok) window.setTimeout(() => scrollToCard(`issue:${issue.id}`), 60);
            })
          }
        >
          {t('skipIssue')}
        </button>
        <p className="hint hint-center">{t('skipIssue.hint')}</p>
      </div>
    </section>
  );
}

function RecipeResolve({ issue }: { issue: Issue }) {
  const { t, state, act, busy, scrollToCard } = useApp();
  const date = menuEntryId(issue, state.menu);
  const settle = (ok: boolean) => {
    if (ok) window.setTimeout(() => scrollToCard(`issue:${issue.id}`), 60);
  };
  const options = issue.recipeOptions ?? [];
  return (
    <section className="resolve">
      {options.length > 0 ? <h4 className="section-title">{t('recipeOptions')}</h4> : null}
      <ul className="recipe-opts">
        {options.map((o) => (
          <li key={o.recipeId} className="recipe-opt">
            <span className="recipe-opt-text">
              <strong>{o.recipeName}</strong>
              {o.why ? <span className="recipe-opt-why">{o.why}</span> : null}
            </span>
            {date ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void act({ type: 'confirm_recipe', date, recipeId: o.recipeId }, { inline: true }).then(settle)}
              >
                {t('useRecipe')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {date ? (
        <>
          {/* the wholesaler search of an own dish shows in the dish's card: this question is answered then */}
          <RecipePicker date={date} reveal />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void act({ type: 'skip_day', date }, { inline: true }).then(settle)}
            >
              <Trash2 size={17} aria-hidden="true" />
              {t('skipDay')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Issue kinds that are solved by choosing another product (or leaving the product out). */
const PRODUCT_KINDS: ReadonlySet<IssueKind> = new Set(['allergen_fail', 'allergen_unknown', 'unavailable', 'no_price']);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The menu entry a recipe issue is about, as the id that confirm_recipe / skip_day expect. For weekly menus
 * that is the date itself; for event menus `issue.date` is expected to carry the entry id.
 */
function menuEntryId(issue: Issue, menu: WeekMenu | undefined): string | undefined {
  const ref = issue.date;
  if (!ref || !menu) return ref;
  if (menu.days.some((d) => d.id === ref)) return ref;
  const sameDate = menu.days.filter((d) => d.date === ref);
  return sameDate.length === 1 ? (sameDate[0].id ?? ref) : ref;
}

/** A resolved item in one line. An accepted alternative or a left-out line can be changed again: the item then opens
 *  with the same checked options and blocks the order until it is decided again. */
export function ResolvedIssue({ issue, compact }: { issue: Issue; compact?: boolean }) {
  const { t, act, busy, scrollToCard } = useApp();
  return (
    <div className={compact ? 'issue-done issue-done-compact' : 'card issue-done'}>
      <span className="done-icon" aria-hidden="true">
        <Check size={16} strokeWidth={3} />
      </span>
      <div className="done-body">
        <p>
          <span className="done-tag">{t('resolved')}: </span>
          <span className="done-title">{issue.title}</span>
          {issue.resolution ? <span className="done-text">{issue.resolution}</span> : null}
        </p>
        {canReopen(issue) ? (
          <button
            type="button"
            className="btn btn-ghost btn-small done-change"
            disabled={busy}
            title={t('changeChoice.hint')}
            onClick={() =>
              void act({ type: 'reopen_issue', issueId: issue.id }, { inline: true }).then((ok) => {
                // the choice opens again as its own card: bring it into view, wherever it was reopened from
                if (ok) window.setTimeout(() => scrollToCard(`issue:${issue.id}`), 60);
              })
            }
          >
            <RotateCcw size={16} aria-hidden="true" />
            {t('changeChoice')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function IssueCard({ issue }: { issue: Issue }) {
  const { t, fmt, state } = useApp();

  if (issue.resolved) return <ResolvedIssue issue={issue} />;

  const SevIcon = issue.severity === 'block' ? OctagonAlert : TriangleAlert;
  const isRecipe = issue.kind === 'missing_recipe' || issue.kind === 'suggested_recipe';
  // `date` may be a menu entry id on event menus: show the course label then, and never a raw id
  const entry = issue.date ? state.menu?.days.find((d) => d.id === issue.date) : undefined;
  const when =
    state.menu?.kind === 'event' && entry?.label
      ? entry.label
      : issue.date && ISO_DAY.test(issue.date)
        ? fmt.day(issue.date)
        : entry
          ? fmt.day(entry.date)
          : '';
  const context = [...new Set([when, issue.recipeName, issue.ingredient].filter(Boolean))];

  return (
    <article className={`card issue issue-${issue.severity}`}>
      <header className="issue-head">
        <span className={`sev sev-${issue.severity}`}>
          <SevIcon size={15} strokeWidth={2.6} aria-hidden="true" />
          {t(`sev.${issue.severity}`)}
        </span>
        <h3 className="card-title">{issue.title}</h3>
        {issue.detail ? <p className="issue-detail">{issue.detail}</p> : null}
        {issue.groupLabel || context.length > 0 ? (
          <div className="badges">
            {issue.groupLabel ? <Chip tone="leaf">{issue.groupLabel}</Chip> : null}
            {context.map((c) => (
              <Chip key={c}>{c}</Chip>
            ))}
          </div>
        ) : null}
      </header>

      {issue.product ? (
        <div className="issue-product">
          <span className="prod-name">{issue.product.name}</span>
          <ProductMeta product={issue.product} />
        </div>
      ) : null}

      {issue.check ? <CheckBlock check={issue.check} /> : null}

      {issue.product ? (
        <Fold summary={t('ingredients')} className="fold-quiet">
          <ProductFacts product={issue.product} />
        </Fold>
      ) : null}

      {isRecipe ? (
        <RecipeResolve issue={issue} />
      ) : issue.kind === 'portions' ? (
        <PortionsEditor kitchen={state.kitchen} />
      ) : PRODUCT_KINDS.has(issue.kind) ? (
        <ProductResolve issue={issue} />
      ) : null}
    </article>
  );
}
