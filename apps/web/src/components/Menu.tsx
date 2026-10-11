/**
 * A small accessible dropdown menu: an icon button that opens a list of
 * actions. Arrow keys move, Enter activates, Escape / outside click close.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { Icon, IconButton } from '@neo/ui';

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onSelect: () => void;
  /** Separator before this item. */
  separated?: boolean;
  hidden?: boolean;
}

export function Menu(props: { label: string; items: MenuItem[]; icon?: string; align?: 'left' | 'right'; className?: string; size?: 'sm' | 'md' }): ReactElement {
  const { label, items, icon = 'more-horizontal', align = 'right', className, size = 'sm' } = props;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={wrap} className={className} style={{ position: 'relative' }} data-open={open || undefined}>
      <IconButton icon={icon} label={label} size={size} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} />
      {open && (
        <div ref={list} id={id} role="menu" aria-label={label} className="menu" style={{ top: '100%', marginTop: 4, [align === 'right' ? 'right' : 'left']: 0 }} onKeyDown={onListKey}>
          {visible.map((item, i) => (
            <div key={i}>
              {item.separated && i > 0 && <div className="menu__sep" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                data-danger={item.danger || undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} size={15} />}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
