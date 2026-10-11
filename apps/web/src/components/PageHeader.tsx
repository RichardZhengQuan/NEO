import type { ReactElement, ReactNode } from 'react';
import { IconButton, useT } from '@neo/ui';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { setDrawer } from '../state/ui.js';

/** Screen header: on phones it carries the menu button that opens the drawer. */
export function PageHeader(props: { title?: ReactNode; children?: ReactNode; actions?: ReactNode; back?: () => void }): ReactElement {
  const t = useT();
  const desktop = useIsDesktop();
  return (
    <header className="page-header">
      {props.back ? (
        <IconButton icon="arrow-left" label={t('common.back')} onClick={props.back} />
      ) : (
        !desktop && <IconButton icon="menu" label={t('nav.open_menu')} onClick={() => setDrawer(true)} />
      )}
      {props.title !== undefined && <h1 className="page-header__title">{props.title}</h1>}
      {props.children}
      {props.actions && <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>{props.actions}</div>}
    </header>
  );
}
