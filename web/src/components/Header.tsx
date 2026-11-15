import { ChevronDown, House, Menu } from 'lucide-react';
import { LANGS, LANG_NAMES, type TFn } from '../i18n';
import type { Lang } from '../types';

export function Header({
  kitchenName,
  lang,
  t,
  onLang,
  onMenu,
  onProfile,
  onStartOver,
  busy,
}: {
  kitchenName?: string;
  lang: Lang;
  t: TFn;
  onLang: (lang: Lang) => void;
  onMenu?: () => void;
  /** opens the account picker; absent when there is nothing to switch to */
  onProfile?: () => void;
  /** "Start over": back to the welcome view; absent when already there without a menu */
  onStartOver?: () => void;
  busy?: boolean;
}) {
  return (
    <header className="header">
      <div className="shell header-inner">
        {onProfile && kitchenName ? (
          <button
            type="button"
            className="brand brand-btn"
            onClick={onProfile}
            aria-haspopup="dialog"
            aria-label={`Aimo – ${kitchenName}. ${t('profile.switch')}`}
          >
            <span className="wordmark">Aimo</span>
            <span className="brand-kitchen">
              <span className="brand-name">{kitchenName}</span>
              <ChevronDown size={15} strokeWidth={2.6} aria-hidden="true" />
            </span>
          </button>
        ) : (
          <div className="brand">
            <span className="wordmark">Aimo</span>
            {kitchenName ? (
              <span className="brand-kitchen">
                <span className="brand-name">{kitchenName}</span>
              </span>
            ) : null}
          </div>
        )}
        {onStartOver ? (
          // icon and text on wide screens; on a phone the icon alone, its name stays for screen readers and as a tooltip
          <button type="button" className="start-over" onClick={onStartOver} disabled={busy} title={t('startOver.hint')}>
            <House size={20} aria-hidden="true" />
            <span className="start-over-text">{t('startOver')}</span>
          </button>
        ) : null}
        <div className="lang" role="group" aria-label={t('lang.label')}>
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              className={`lang-btn ${l === lang ? 'is-active' : ''}`}
              onClick={() => onLang(l)}
              aria-pressed={l === lang}
              lang={l}
              title={LANG_NAMES[l]}
              aria-label={LANG_NAMES[l]}
            >
              <span>{l.toUpperCase()}</span>
            </button>
          ))}
        </div>
        {onMenu ? (
          <button type="button" className="icon-btn" onClick={onMenu} aria-label={t('menu.open')} aria-haspopup="dialog">
            <Menu size={22} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
