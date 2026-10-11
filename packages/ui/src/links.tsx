/**
 * Link handling for Markdown and generative-UI links.
 *
 * Apps decide what a link does: in-app navigation for `neo://` routes, the
 * desktop shell's `openExternal` for web links, etc. Without a provider, web
 * links open in a new tab and `neo://` links do nothing.
 */
import { createContext, useContext, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { isSafeLinkUrl } from '@neo/protocol';

/** Return true when the app handled the link (the default navigation is then prevented). */
export type LinkHandler = (url: string) => boolean | void;

const LinkContext = createContext<LinkHandler | null>(null);

export function LinkProvider({ onLink, children }: { onLink: LinkHandler; children: ReactNode }): ReactElement {
  return <LinkContext.Provider value={onLink}>{children}</LinkContext.Provider>;
}

/** Click handler for an anchor pointing at `url`. Unsafe URLs are always blocked. */
export function useLinkClick(url: string): (event: MouseEvent<HTMLElement>) => void {
  const handler = useContext(LinkContext);
  return (event) => {
    if (!isSafeLinkUrl(url)) {
      event.preventDefault();
      return;
    }
    // Let the browser handle modified clicks (new tab/window) for web links.
    if (/^https?:/i.test(url) && (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1)) return;
    if (handler) {
      const handled = handler(url);
      if (handled !== false) event.preventDefault();
      return;
    }
    if (url.toLowerCase().startsWith('neo://')) event.preventDefault();
  };
}

/** Imperative variant for buttons that open a link. */
export function useOpenLink(): (url: string) => void {
  const handler = useContext(LinkContext);
  return (url) => {
    if (!isSafeLinkUrl(url)) return;
    if (handler && handler(url) !== false) return;
    if (/^(https?:|mailto:|tel:)/i.test(url) && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  };
}
