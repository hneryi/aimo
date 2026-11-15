import { isIngredientRequest } from '../../shared/ingredientIntent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ACCEPTED_EXT,
  ApiError,
  errorText,
  getState,
  loadProfile,
  postAction,
  postChat,
  postImport,
  saveProfile,
  searchProducts,
  signOut as endSession,
  type ProfileId,
} from './api';
import { LoginDialog, TokenDialog } from './components/AccessDialogs';
import { Dock, type Bubble, type Notice } from './components/Dock';
import { Header } from './components/Header';
import { MenuSheet } from './components/MenuSheet';
import { ProfileSheet } from './components/ProfileSheet';
import { DraftSheet } from './components/DraftSheet';
import { Stream, type Pending } from './components/Stream';
import { Today } from './components/Today';
import { MENU_EDITS, PLAN_EDITS, undoRecorded } from './changes';
import { Ctx, type ActOpts, type AppCtx, type DishSearch } from './ctx';
import { makeFmt } from './format';
import { loadLang, makeT, saveLang, type Key } from './i18n';
import {
  applyResponse,
  cardDomId,
  closeTurn,
  foldEarlier,
  isQuiet,
  keyCards,
  nextId,
  panelDraft,
  resyncTurns,
  seedTurns,
  withLocalCard,
  type Turn,
} from './stream';
import type { DashboardState, Lang, Requirement, TurnResponse, UiAction } from './types';

function statusFor(action: UiAction): Key {
  switch (action.type) {
    case 'load_demo_menu':
      return 'status.reading';
    case 'build_plan':
    case 'show_plan':
      return 'status.building';
    case 'resolve_issue':
    case 'swap_line':
    case 'find_cheaper':
      return 'status.checking';
    case 'create_order':
    case 'draft_order':
      return 'status.ordering';
    case 'approve_order':
      return 'status.sending';
    default:
      return 'status.updating';
  }
}

interface RunOpts {
  status: Key;
  inline?: boolean;
  /** a plan edit: its confirmation may offer Undo when the server recorded a step for it */
  planEdit?: boolean;
  /** an edit of a menu entry: confirmed in place, the view does not move to cards the answer adds */
  stay?: boolean;
  user?: string;
  /** the server state was wiped: start the stream over */
  reset?: boolean;
  /** "Start over": the conversation view is emptied once the request went through; the bubble says what was done */
  startOver?: boolean;
  openDraft?: boolean;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function App() {
  const [lang, setLangState] = useState<Lang>(loadLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const fmt = useMemo(() => makeFmt(lang), [lang]);

  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [draftPanel, setDraftPanel] = useState<{ id: string; profile: string } | null>(null);
  const draftOpener = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  /** the signed-in approver's name (only used when the server has approvers configured) */
  const [approver, setApprover] = useState<string | null>(null);
  /** an action that was refused because it needs an approver: repeated once someone has signed in */
  const [login, setLogin] = useState<{ retry: () => void } | null>(null);
  const [issued, setIssued] = useState<TurnResponse['issuedToken'] | null>(null);
  const [dishSearch, setDishSearch] = useState<Record<string, DishSearch>>({});
  const dishSeq = useRef(0);

  // latest values for callbacks that outlive a render
  const langRef = useRef(lang);
  langRef.current = lang;
  const tRef = useRef(t);
  tRef.current = t;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** the customer account every request is made for; undefined until the server has told us its default */
  const profileRef = useRef<ProfileId>(loadProfile());
  const busyRef = useRef(false);
  /** bumped by every request, so a background poll that raced with one is thrown away */
  const epoch = useRef(0);
  /** attention ids of orders waiting for approval that the user has already been shown */
  const knownOrders = useRef<Set<string> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const seeded = useRef(false);
  const lastScrolled = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- state: load once, refetch when the language changes ----
  useEffect(() => {
    let cancelled = false;
    document.documentElement.lang = lang;
    const asked = profileRef.current;
    getState(lang, asked)
      .then((s) => {
        if (cancelled || profileRef.current !== asked) return;
        profileRef.current = asked ?? s.profile?.id;
        setState(s);
        setLoadError('');
        if (!seeded.current) {
          seeded.current = true;
          const seed = seedTurns(s);
          lastScrolled.current = seed.length ? seed[seed.length - 1].id : 0; // don't jump on page load
          setTurns(seed);
        } else {
          setTurns((prev) => resyncTurns(prev, s));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (asked && !seeded.current) {
          // a remembered account the server no longer knows: fall back to its default
          profileRef.current = undefined;
          saveProfile(undefined);
          setReload((n) => n + 1);
          return;
        }
        setLoadError(errorText(e, makeT(lang)) || makeT(lang)('err.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [lang, reload]);

  const setLang = useCallback((next: Lang) => {
    saveLang(next);
    setLangState(next);
  }, []);

  // ---- one request at a time; every response replaces state and folds its cards into the stream ----
  const run = useCallback(
    (job: (lang: Lang, profile: ProfileId) => Promise<TurnResponse>, o: RunOpts): Promise<boolean> => {
    const exec = async (): Promise<boolean> => {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      busyRef.current = true;
      epoch.current += 1;
      setPending({ status: tRef.current(o.status), user: o.user, inline: !!o.inline });
      const undoBefore = stateRef.current?.undo;
      try {
        const res = await job(langRef.current, profileRef.current);
        setState(res.state);
        const shown = res.cards.find((c) => c.type === 'draft');
        const opensDraft = (o.openDraft || o.user) && shown?.type === 'draft' && res.state.activeDraft === shown.draft.id;
        if (opensDraft && shown?.type === 'draft') {
          // The request disables the opener before showModal(), so remember it before awaiting.
          draftOpener.current = opener;
          setDraftPanel({ id: shown.draft.id, profile: res.state.profile.id });
          setBubble(null);
        }
        if (o.reset) setDraftPanel(null);
        if (res.issuedToken) setIssued(res.issuedToken);
        if (o.reset || o.startOver) {
          setTurns([]);
          setDishSearch({});
          lastScrolled.current = 0;
          const text = o.startOver ? `${tRef.current('startOver.done')} ${res.reply}` : res.reply;
          if (text) setBubble({ id: nextId(), text, tone: 'info', undo: !!o.planEdit && undoRecorded(undoBefore, res.state.undo) });
          window.scrollTo({ top: 0 });
          return true;
        }
        const incoming = keyCards(res.cards);
        const inline = !!o.inline;
        const stay = inline && !!o.stay;
        if (!opensDraft && inline && res.reply && (stay || o.status === 'status.ordering' || isQuiet(turnsRef.current, incoming))) {
          setBubble({ id: nextId(), text: res.reply, tone: 'info', undo: !!o.planEdit && undoRecorded(undoBefore, res.state.undo) });
        }
        const turnId = nextId();
        // the first menu edit adds the shopping list below: it must not pull the user away from the menu
        if (stay) lastScrolled.current = Math.max(lastScrolled.current, turnId);
        setTurns((prev) => applyResponse(prev, res, incoming, { turnId, inline, user: o.user }));
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'approver_required') {
          // nobody is signed in (or the session ran out): ask for name and PIN, then do the same thing again
          endSession();
          setApprover(null);
          setLogin({ retry: () => void run(job, o) });
          return false;
        }
        const text = errorText(e, tRef.current);
        if (o.inline) setBubble({ id: nextId(), text, tone: 'warn' });
        // a failed new request still starts a new turn: earlier search results fold as after any request
        else setTurns((prev) => [...(o.user ? foldEarlier(prev) : prev), { id: nextId(), user: o.user, error: text, cards: [] }]);
        return false;
      } finally {
        busyRef.current = false;
        epoch.current += 1;
        setPending(null);
      }
    };
    const p = queue.current.then(exec);
    queue.current = p;
    return p;
    },
    [],
  );

  // ---- switching the customer account: everything on screen belongs to the old one, so start over ----
  const switchProfile = useCallback((id: string) => {
    if (busyRef.current || id === profileRef.current) return;
    const exec = async () => {
      busyRef.current = true;
      epoch.current += 1;
      setPending({ status: tRef.current('status.switching'), inline: true });
      try {
        const s = await getState(langRef.current, id);
        profileRef.current = id;
        saveProfile(id);
        knownOrders.current = null;
        setNotice(null);
        setBubble(null);
        setDraftPanel(null);
        setDishSearch({});
        setState(s);
        const seed = seedTurns(s);
        lastScrolled.current = seed.length ? seed[seed.length - 1].id : 0;
        setTurns(seed);
        window.scrollTo({ top: 0 });
      } catch (e) {
        setBubble({ id: nextId(), text: errorText(e, tRef.current), tone: 'warn' });
      } finally {
        busyRef.current = false;
        epoch.current += 1;
        setPending(null);
      }
    };
    queue.current = queue.current.then(exec);
  }, []);

  const act = useCallback(
    (action: UiAction, opts?: ActOpts) =>
      run((l, p) => postAction(action, l, p), {
        status: statusFor(action),
        inline: action.type === 'show_draft' || opts?.inline,
        user: opts?.label,
        reset: action.type === 'reset_demo',
        openDraft: action.type === 'show_draft',
        planEdit: PLAN_EDITS.has(action.type),
        stay: MENU_EDITS.has(action.type),
      }),
    [run],
  );

  /** "Start over": empty the conversation view and remove the menu (clear_menu, undoable). Orders and order drafts stay
   *  and remain in the side panel and the draft bar. No confirmation: the bubble says what was done and offers Undo. */
  const startOver = useCallback(() => {
    if (busyRef.current) return;
    if (stateRef.current?.menu) {
      void run((l, p) => postAction({ type: 'clear_menu' }, l, p), { status: 'status.updating', inline: true, planEdit: true, stay: true, startOver: true });
      return;
    }
    setTurns([]);
    setDishSearch({});
    lastScrolled.current = 0;
    setBubble({ id: nextId(), text: tRef.current('startOver.cleared'), tone: 'info' });
    window.scrollTo({ top: 0 });
  }, [run]);

  const closeTurnView = useCallback((id: number) => {
    setTurns((prev) => closeTurn(prev, id));
  }, []);

  const searchDish = useCallback((entry: string, q: string, req: Requirement[] = []) => {
    const query = q.trim();
    if (!query) return;
    const seq = ++dishSeq.current;
    const profile = profileRef.current;
    const settle = (next: Omit<DishSearch, 'seq' | 'q' | 'req'>) =>
      setDishSearch((prev) => (prev[entry]?.seq === seq && profileRef.current === profile ? { ...prev, [entry]: { ...next, q: query, req, seq } } : prev));
    setDishSearch((prev) => ({ ...prev, [entry]: { q: query, req, status: 'searching', items: [], seq } }));
    searchProducts(query, req, langRef.current, profile).then(
      (items) => settle({ status: 'done', items }),
      (e) => settle({ status: 'error', items: [], error: errorText(e, tRef.current) }),
    );
  }, []);

  const openDraft = useCallback((id: string) => {
    void act({ type: 'show_draft', draftId: id }, { inline: true });
  }, [act]);

  useEffect(() => {
    if (draftPanel && state && !panelDraft(state, draftPanel)) setDraftPanel(null);
  }, [state, draftPanel]);

  const sendChat = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || busyRef.current) return;
      void run((l, p) => postChat(message, l, p), { status: isIngredientRequest(message) ? 'status.ingredients' : 'status.thinking', user: message });
    },
    [run],
  );

  const upload = useCallback(
    (file: File) => {
      if (busyRef.current) return;
      const user = tRef.current('sentFile', { name: file.name });
      const name = file.name.toLowerCase();
      if (!ACCEPTED_EXT.some((ext) => name.endsWith(ext))) {
        setTurns((prev) => [...foldEarlier(prev), { id: nextId(), user, error: tRef.current('err.fileType'), cards: [] }]);
        return;
      }
      void run((l, p) => postImport(file, l, p), { status: 'status.reading', user });
    },
    [run],
  );

  const pickFile = useCallback(() => fileInput.current?.click(), []);

  const signIn = useCallback(() => setLogin({ retry: () => undefined }), []);
  const signOut = useCallback(() => {
    endSession();
    setApprover(null);
  }, []);

  const toggleTurn = useCallback((id: number) => {
    setTurns((prev) => prev.map((turn) => (turn.id === id ? { ...turn, folded: !turn.folded } : turn)));
  }, []);

  const scrollToCard = useCallback((key: string) => {
    // a card inside a folded turn: open the turn first, so the card is on the page to scroll to
    const folded = turnsRef.current.find((turn) => turn.folded && turn.cards.some((c) => c.key === key));
    if (folded) flushSync(() => setTurns((prev) => prev.map((turn) => (turn.id === folded.id ? { ...turn, folded: false } : turn))));
    const el = document.getElementById(cardDomId(key));
    if (!el) return false;
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    return true;
  }, []);

  const showPortions = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const turnId = nextId();
    setTurns((prev) => withLocalCard(prev, { type: 'portions', kitchen: s.kitchen }, turnId));
  }, []);

  // ---- background refresh: orders from an external agent (MCP) arrive without any UI action ----
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded) return;
    const poll = async () => {
      if (document.visibilityState !== 'visible' || busyRef.current) return;
      const started = epoch.current;
      const l = langRef.current;
      const p = profileRef.current;
      try {
        const s = await getState(l, p);
        if (busyRef.current || epoch.current !== started || langRef.current !== l || profileRef.current !== p) return;
        const known = knownOrders.current;
        const fresh = known
          ? s.attention.find((a) => a.action?.type === 'show_order' && !known.has(a.id))
          : undefined;
        if (fresh?.action?.type === 'show_order') {
          const orderId = fresh.action.orderId;
          setNotice({
            id: fresh.id,
            action: fresh.action,
            orderId,
            agent: s.orders.find((o) => o.id === orderId)?.source === 'mcp',
          });
        }
        // only state and the cards already on screen are refreshed; polling never adds turns
        setState(s);
        setTurns((prev) => resyncTurns(prev, s));
      } catch {
        /* stay quiet: the next poll or the next action will surface a real problem */
      }
    };
    const timer = window.setInterval(() => void poll(), 12000);
    const wake = () => void poll();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [loaded]);

  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.attention.filter((a) => a.action?.type === 'show_order').map((a) => a.id));
    knownOrders.current = ids;
    setNotice((n) => (n && !ids.has(n.id) ? null : n)); // decided elsewhere in the meantime
  }, [state]);

  // ---- keep the newest turn in view ----
  useEffect(() => {
    const last = [...turns].reverse().find((turn) => !turn.quiet);
    if (!last || last.id <= lastScrolled.current) return;
    lastScrolled.current = last.id;
    document
      .getElementById(`turn-${last.id}`)
      ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }, [turns]);

  useEffect(() => {
    if (pending && !pending.inline) {
      document
        .getElementById('turn-pending')
        ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }
  }, [pending]);

  // ---- transient speech bubble for in-place edits ----
  useEffect(() => {
    if (!bubble) return;
    const id = window.setTimeout(() => setBubble(null), bubble.tone === 'warn' || bubble.undo ? 9000 : 6000);
    return () => window.clearTimeout(id);
  }, [bubble]);

  // ---- the whole page is a drop target for a menu file ----
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) uploadRef.current(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const busy = pending !== null;
  const ctx = useMemo<AppCtx | null>(
    () =>
      state
        ? {
            lang,
            t,
            fmt,
            state,
            profile: state.profile?.id ?? profileRef.current,
            busy,
            act,
            showPortions,
            scrollToCard,
            openDraft,
            pickFile,
            sendChat,
            dishSearch,
            searchDish,
            approver,
            signIn,
            signOut,
          }
        : null,
    [lang, t, fmt, state, busy, act, showPortions, scrollToCard, openDraft, pickFile, sendChat, dishSearch, searchDish, approver, signIn, signOut],
  );

  if (!ctx || !state) {
    return (
      <div className="app">
        <Header lang={lang} t={t} onLang={setLang} />
        <div className="boot" role="status">
          <img
            className={`boot-mascot ${loadError ? '' : 'is-thinking'}`}
            src="/mascot.png"
            alt=""
            width={140}
            height={140}
          />
          {loadError ? (
            <>
              <p>{loadError}</p>
              <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>
                {t('retry')}
              </button>
            </>
          ) : (
            <p>{t('loading')}</p>
          )}
        </div>
      </div>
    );
  }

  const empty = turns.length === 0 && !(pending && !pending.inline);
  // already at the start with no menu: there is nothing to start over from
  const canStartOver = turns.length > 0 || !!state.menu;

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app ${empty ? 'is-first-run' : ''}`} aria-busy={busy}>
        <Header
          kitchenName={state.kitchen.name}
          lang={lang}
          t={t}
          onLang={setLang}
          onMenu={() => setSheetOpen(true)}
          onProfile={(state.profiles?.length ?? 0) > 1 ? () => setProfilesOpen(true) : undefined}
          onStartOver={canStartOver ? startOver : undefined}
          busy={busy}
        />
        <div className="shell layout">
          <Today />
          <main className="workspace">
            <Stream turns={turns} pending={pending} onToggle={toggleTurn} onClose={closeTurnView} />
          </main>
        </div>

        <Dock
          status={pending ? pending.status : null}
          bubble={bubble}
          onDismissBubble={() => setBubble(null)}
          notice={notice}
          onOpenNotice={() => {
            if (!notice || busy) return;
            setNotice(null);
            void act(notice.action);
          }}
          onDismissNotice={() => setNotice(null)}
          showChips={!empty}
        />
        <DraftSheet draft={panelDraft(state, draftPanel)} message={bubble?.text} tone={bubble?.tone} returnFocus={draftOpener.current} onClose={() => setDraftPanel(null)} />
        <MenuSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
        <ProfileSheet open={profilesOpen} onClose={() => setProfilesOpen(false)} onPick={switchProfile} />
        <LoginDialog
          open={login !== null}
          onClose={() => setLogin(null)}
          onDone={(name) => {
            const next = login;
            setLogin(null);
            setApprover(name);
            next?.retry();
          }}
        />
        <TokenDialog issued={issued} onClose={() => setIssued(null)} />

        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_EXT.join(',')}
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) upload(file);
          }}
        />

        {dragging ? (
          <div className="drop" aria-hidden="true">
            <div className="drop-inner">
              <img src="/mascot.png" alt="" width={150} height={150} />
              <p className="drop-title">{t('drop.title')}</p>
              <p>{t('drop.text')}</p>
            </div>
          </div>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite">
          {pending ? pending.status : (bubble?.text ?? [...turns].reverse().find((x) => x.reply)?.reply ?? '')}
        </p>
      </div>
    </Ctx.Provider>
  );
}
