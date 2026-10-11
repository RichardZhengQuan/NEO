/**
 * Theme context: applies `dark` class + `data-theme` attribute on
 * `document.documentElement`, tracks the resolved (OS) theme.
 */
import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';

export type ThemeSetting = 'system' | 'light' | 'dark';

interface ThemeCtx {
  setting: ThemeSetting;
  resolved: 'light' | 'dark';
}

const Ctx = createContext<ThemeCtx>({ setting: 'system', resolved: 'light' });

function resolveTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  // system: check media query (falls back to 'light' in jsdom / SSR)
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function ThemeProvider(props: { theme: ThemeSetting; children: ReactNode }): ReactElement {
  const { theme, children } = props;
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(theme));

  useEffect(() => {
    if (theme !== 'system') {
      setResolved(theme);
      return;
    }
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const update = () => setResolved(mq?.matches ? 'dark' : 'light');
    update();
    mq?.addEventListener('change', update);
    return () => mq?.removeEventListener('change', update);
  }, [theme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.setAttribute('data-theme', theme);
    if (resolved === 'dark') {
      el.classList.add('dark');
    } else {
      el.classList.remove('dark');
    }
  }, [theme, resolved]);

  return <Ctx.Provider value={{ setting: theme, resolved }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}
