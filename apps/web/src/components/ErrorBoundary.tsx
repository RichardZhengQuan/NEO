/**
 * Last line of defense: a render error shows a calm recovery screen instead
 * of a blank page. Also hosts `lazyScreen`, which reloads once when a code
 * chunk from an older build is gone (the app was updated while open).
 */
import { Component, lazy, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactElement, type ReactNode } from 'react';
import { Button, Icon, useT } from '@neo/ui';
import { readString, writeString } from '../lib/storage.js';

const RELOAD_KEY = 'neo.chunk-reload';

/** React.lazy that survives deploys: a failed chunk load reloads the page once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy
export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy<T>(() =>
    load().then(
      (mod) => {
        writeString(RELOAD_KEY, null, 'session');
        return mod;
      },
      (err: unknown): Promise<{ default: T }> => {
        if (!readString(RELOAD_KEY, 'session') && typeof window !== 'undefined') {
          writeString(RELOAD_KEY, '1', 'session');
          window.location.reload();
          return new Promise(() => undefined);
        }
        throw err;
      },
    ),
  );
}

function Fallback({ onRetry }: { onRetry: () => void }): ReactElement {
  const t = useT();
  return (
    <div className="center-screen" role="alert">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <span className="neo-empty__icon" style={{ margin: '0 auto' }}>
          <Icon name="alert-triangle" size={22} />
        </span>
        <h1 style={{ margin: '1rem 0 0.375rem', fontSize: '1.25rem', fontWeight: 700 }}>{t('crash.title')}</h1>
        <p className="neo-help" style={{ fontSize: '0.9063rem', margin: '0 0 1.25rem' }}>
          {t('crash.text')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <Button variant="primary" icon="refresh" block onClick={() => window.location.reload()}>
            {t('crash.reload')}
          </Button>
          <Button variant="ghost" block onClick={onRetry}>
            {t('crash.retry')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Visible in the devtools console for bug reports; the UI shows the recovery screen.
    console.error('NEO crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return <Fallback onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
