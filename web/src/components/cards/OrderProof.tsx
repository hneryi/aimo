import { useEffect, useState } from 'react';
import { getSigningKeys } from '../../api';
import { useApp } from '../../ctx';
import { documentClaims, documentContent, priceDifferences, verifyDocument, type Verification } from '../../signatures';
import type { Order } from '../../types';
import { Fold } from '../ui';

function useDocument(token: string | undefined, expected: Record<string, unknown>): Verification {
  const context = JSON.stringify(expected);
  const [result, setResult] = useState<{ token: string; context: string; value: Verification }>();
  useEffect(() => {
    if (!token) return;
    let active = true;
    const finish = (value: Verification) => { if (active) setResult({ token, context, value }); };
    if (!globalThis.crypto?.subtle) finish({ status: 'unsupported' });
    else void getSigningKeys().then(keys => verifyDocument(token, keys, JSON.parse(context)))
      .then(finish).catch(() => finish({ status: 'unavailable' }));
    return () => { active = false; };
  }, [token, context]);
  // Never show a previous document's green status while the new document is being checked.
  return result && result.token === token && result.context === context ? result.value : { status: 'checking' };
}

function SignedContent({ token }: { token: string }) {
  const { t } = useApp();
  const [copy, setCopy] = useState<'copy' | 'copied' | 'proof.copyFailed'>('copy');
  const content = documentContent(token);
  return <Fold summary={t('proof.content')} className="fold-quiet">
    <button type="button" className="btn btn-ghost btn-small" onClick={() => {
      void navigator.clipboard?.writeText(`${content}\n\n${token}`).then(() => setCopy('copied')).catch(() => setCopy('proof.copyFailed'));
      if (!navigator.clipboard) setCopy('proof.copyFailed');
    }}>{t(copy)}</button>
    <pre className="proof-content">{content}</pre>
    <pre className="proof-content">{token}</pre>
  </Fold>;
}

export function OrderProof({ order }: { order: Order }) {
  const { t, fmt, state } = useApp();
  const q = order.quote;
  const account = state.profile.id;
  const quote = useDocument(q?.signed, {
    type: 'aimo.quote.v1', jti: order.quoteId, account,
    iss: q?.issuer, agent: q?.recipient,
    iat: q ? Math.floor(Date.parse(q.createdAt) / 1000) : undefined,
    exp: q ? Math.floor(Date.parse(q.expiresAt) / 1000) : undefined,
    price_and_availability: q ? { source: 'valio_mock', fetched_at: q.observedAt } : undefined,
  });
  const confirmation = useDocument(order.signedConfirmation, {
    type: 'aimo.order_confirmation.v1', jti: order.id, order_id: order.id, account,
    quote_id: order.quoteId ?? null, confirmation: order.confirmation,
    total_excl_vat: order.totals.net, vat: order.totals.vat, total_incl_vat: order.totals.gross,
    submission: 'local_simulation', simulated: true,
  });
  const quoted = q ? documentClaims(q.signed) : undefined;
  const sent = order.signedConfirmation ? documentClaims(order.signedConfirmation) : undefined;
  const changed = quoted && sent ? priceDifferences(quoted, sent) : [];
  const totalChanged = quoted && sent && (quoted.total_excl_vat !== sent.total_excl_vat || quoted.total_incl_vat !== sent.total_incl_vat);
  const summary = q ? `${t('proof.quote')} ${order.quoteId} · ${t(`proof.${quote.status}`)}` : t('proof.missing');
  return <Fold summary={summary} className="fold-quiet order-proof">
    {q ? <>
      <dl className="proof-facts">
        <div><dt>{t('proof.issuer')}</dt><dd>{q.issuer}</dd></div>
        <div><dt>{t('proof.recipient')}</dt><dd>{q.recipient.name} · {t(`proof.${q.recipient.identity}`)}{q.recipient.identity !== 'kitchen' && q.recipient.id ? ` (${q.recipient.id})` : ''}</dd></div>
        <div><dt>{t('proof.account')}</dt><dd>{state.profiles.find(p => p.id === q.account)?.name ?? q.account}</dd></div>
        <div><dt>{t('proof.observed')}</dt><dd>{fmt.dateTime(q.observedAt)}</dd></div>
        <div><dt>{t('proof.validity')}</dt><dd>{fmt.dateTime(q.createdAt)} → {fmt.dateTime(q.expiresAt)}</dd></div>
      </dl>
      <p>{t('proof.used')}</p>
      <SignedContent token={q.signed} />
    </> : <p>{t('proof.missing')}</p>}
    {order.signedConfirmation ? <>
      <p><strong>{t('proof.confirmation')}</strong> · {t(`proof.${confirmation.status}`)}</p>
      {changed.length || totalChanged ? <div className="callout callout-warn proof-prices">
        <strong>{t('proof.changed')}</strong>
        {quote.status !== 'verified' || confirmation.status !== 'verified' ? <p>{t('proof.unverifiedComparison')}</p> : null}
        <p>{t('proof.prices')}</p>
        <ul className="bullets">
          {changed.map(l => <li key={l.id}>{order.lines.find(x => x.productId === l.id)?.name ?? l.id} · {t('proof.unitPrice')}: {fmt.eur(l.quoted)} → {fmt.eur(l.sent)}</li>)}
          <li>{t('proof.total')}: {fmt.eur(quoted!.total_excl_vat)} → {fmt.eur(sent!.total_excl_vat)}</li>
          <li>{t('gross')}: {fmt.eur(quoted!.total_incl_vat)} → {fmt.eur(sent!.total_incl_vat)}</li>
        </ul>
      </div> : null}
      <SignedContent token={order.signedConfirmation} />
    </> : null}
    <p className="int-note">{t('proof.scope')}</p>
  </Fold>;
}
