/**
 * The empty chat: the assistant's animated avatar as the hero, a greeting in
 * the persona's voice and a few things to try.
 */
import type { ReactElement } from 'react';
import type { AvatarState } from '@neo/ui';
import { Badge, Icon, NeoAvatar, useT } from '@neo/ui';
import { useSession } from '../../state/session.js';

export const SUGGESTIONS: { icon: string; key: string }[] = [
  { icon: 'alarm-clock', key: 'chat.suggestion.remind' },
  { icon: 'heart', key: 'chat.suggestion.remember' },
  { icon: 'bar-chart', key: 'chat.suggestion.dashboard' },
  { icon: 'list-checks', key: 'chat.suggestion.tasks' },
];

export function EmptyChat({ avatarState, incognito, onSuggestion }: { avatarState: AvatarState; incognito: boolean; onSuggestion: (text: string) => void }): ReactElement {
  const t = useT();
  const persona = useSession((s) => s.settings?.persona);
  const name = persona?.name ?? 'NEO';
  return (
    <div className="chat-hero">
      <NeoAvatar avatar={persona?.avatar ?? null} size={96} state={avatarState} shape="squircle" title={name} />
      <h2 className="chat-hero__title">{persona?.greeting?.trim() || t('chat.greeting', { name })}</h2>
      <p className="chat-hero__sub">{persona?.tagline?.trim() || t('chat.greeting_sub')}</p>
      {incognito && (
        <Badge tone="neutral" icon="incognito">
          {t('chat.incognito_hint')}
        </Badge>
      )}
      <div className="suggestions" role="list" aria-label={t('chat.suggestions')}>
        {SUGGESTIONS.map((s) => (
          <button key={s.key} type="button" role="listitem" className="suggestion" onClick={() => onSuggestion(t(s.key))}>
            <span className="suggestion__icon">
              <Icon name={s.icon} size={16} />
            </span>
            <span>{t(s.key)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
