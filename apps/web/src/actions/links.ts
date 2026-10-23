/**
 * Opening links from anywhere in the app: `neo://` and `#/` routes navigate
 * in-app, web/mail/tel links go to the platform (system browser on desktop
 * and mobile), pairing links connect after a successful exchange.
 */
import { buildMessages, createTranslator, resolveLocale } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { STORAGE_KEYS, readString } from '../lib/storage.js';
import { getPlatform } from '../platform/index.js';
import { navigate, neoUrlToRoute, parseRoute } from '../router.js';
import { pushToast } from '../state/notifications.js';
import { useSession } from '../state/session.js';
import { setDrawer } from '../state/ui.js';
import { pairWithLink, pairingOutcomeKey } from './pairing.js';

/** Pair in the background, retaining the current session if it fails. */
export function openPairLink(url: string): void {
  void pairWithLink(url).then((outcome) => {
    const locale = resolveLocale(useSession.getState().settings?.locale ?? readString(STORAGE_KEYS.locale));
    const messages = buildMessages(locale, appDictionaries);
    const t = createTranslator(locale, messages);
    pushToast({ tone: outcome === 'ok' ? 'success' : outcome === 'duplicate' ? 'info' : 'error', title: t(pairingOutcomeKey(outcome)) });
  });
}

/** Returns true when handled (callers then prevent the default navigation). */
export function openLink(url: string): boolean {
  const trimmed = url.trim();
  if (/^neo:\/\//i.test(trimmed)) {
    const route = neoUrlToRoute(trimmed);
    if (!route) return true;
    setDrawer(false);
    if (route.name === 'pair') openPairLink(trimmed);
    else navigate(route);
    return true;
  }
  if (trimmed.startsWith('#/')) {
    setDrawer(false);
    const route = parseRoute(trimmed);
    if (route.name === 'pair') {
      const q = trimmed.indexOf('?');
      const query = q >= 0 ? trimmed.slice(q + 1) : '';
      openPairLink(/^https?:$/.test(window.location.protocol) ? `${window.location.origin}/${trimmed}` : `neo://pair?${query}`);
    } else navigate(route);
    return true;
  }
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) {
    getPlatform().openExternal(trimmed);
    return true;
  }
  return false;
}
