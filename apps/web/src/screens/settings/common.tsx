import type { ReactElement, ReactNode } from 'react';

/** A settings section: heading, short explanation, content. */
export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }): ReactElement {
  return (
    <section className="settings-group" aria-label={title} style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="h-section">{title}</h2>
          {description && <p className="h-sub">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Label + help on the left, control on the right (stacks on phones). */
export function SettingRow({ label, help, children, stack }: { label: ReactNode; help?: ReactNode; children: ReactNode; stack?: boolean }): ReactElement {
  return (
    <div className={`setting-row${stack ? ' setting-row--stack' : ''}`}>
      <div className="setting-row__text">
        <div className="setting-row__label">{label}</div>
        {help && <div className="setting-row__help">{help}</div>}
      </div>
      <div style={{ flexShrink: 0, minWidth: 0 }}>{children}</div>
    </div>
  );
}
