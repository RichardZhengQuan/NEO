/**
 * Opening links from anywhere in the app: `neo://` and `#/` routes navigate
 * in-app, web/mail/tel links go to the platform (system browser on desktop
 * and mobile), pairing links switch servers via the Connect screen.
 */
import { credentialsFromInput } from '../connection.js';
import { getPlatform } from '../platform/index.js';
import { navigate, neoUrlToRoute, parseRoute } from '../router.js';
import { showConnect } from '../state/session.js';
import { setDrawer } from '../state/ui.js';

/** Handle a `neo://pair` link: open the Connect screen prefilled (never switches silently). */
export function openPairLink(url: string): void {
  if (getPlatform().kind === 'electron') return; // the desktop app always uses its embedded server
  const creds = credentialsFromInput({ link: url });
  if (creds) showConnect({ reason: 'manual', serverUrl: creds.serverUrl, token: creds.token });
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
    navigate(parseRoute(trimmed));
    return true;
  }
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) {
    getPlatform().openExternal(trimmed);
    return true;
  }
  return false;
}
