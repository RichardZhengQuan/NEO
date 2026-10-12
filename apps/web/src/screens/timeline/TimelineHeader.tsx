import type { ReactElement } from 'react';
import { IconButton, NeoAvatar, useT, type AvatarState } from '@neo/ui';
import { Menu } from '../../components/Menu.js';
import { PageHeader } from '../../components/PageHeader.js';
import { StatusDot } from '../../components/StatusDot.js';
import { useIsDesktop } from '../../hooks/useMediaQuery.js';
import { useSession } from '../../state/session.js';

export function TimelineHeader({ avatarState, onSearch, onDate }: { avatarState: AvatarState; onSearch: () => void; onDate: () => void }): ReactElement {
  const t = useT();
  const desktop = useIsDesktop();
  const avatar = useSession((s) => s.settings?.persona.avatar);
  return (
    <PageHeader actions={desktop ? (
      <>
        <IconButton icon="search" label={t('timeline.search')} onClick={onSearch} />
        <IconButton icon="calendar" label={t('timeline.jump_date')} onClick={onDate} />
      </>
    ) : (
      <Menu label={t('timeline.options')} items={[
        { label: t('timeline.search'), icon: 'search', onSelect: onSearch },
        { label: t('timeline.jump_date'), icon: 'calendar', onSelect: onDate },
      ]} />
    )}>
      <span className="page-header__avatar">
        <NeoAvatar avatar={avatar ?? null} size={28} state={avatarState} animated={avatarState !== 'idle'} title="NEO" />
        <StatusDot />
      </span>
      <h1 className="page-header__title">NEO</h1>
    </PageHeader>
  );
}
