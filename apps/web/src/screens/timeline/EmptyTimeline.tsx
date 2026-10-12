/**
 * The empty timeline: the assistant's animated avatar as the hero, a greeting
 * and a few things to try.
 */
import type { ReactElement } from 'react';
import type { AvatarState } from '@neo/ui';
import { Button, Icon, NeoAvatar, useT } from '@neo/ui';
import { useSession } from '../../state/session.js';

export const SUGGESTIONS: { icon: string; key: string }[] = [
  { icon: 'alarm-clock', key: 'chat.suggestion.remind' },
  { icon: 'heart', key: 'chat.suggestion.remember' },
  { icon: 'bar-chart', key: 'chat.suggestion.dashboard' },
  { icon: 'list-checks', key: 'chat.suggestion.tasks' },
];

export function EmptyTimeline({ avatarState, noProvider, onSuggestion, onConnect }: { avatarState: AvatarState; noProvider: boolean; onSuggestion: (text: string) => void; onConnect: () => void }): ReactElement {
  const t = useT();
  const persona = useSession((s) => s.settings?.persona);
  return (
    <div className="chat-hero">
      <NeoAvatar avatar={persona?.avatar ?? null} size={96} state={avatarState} shape="squircle" title="NEO" />
      <h2 className="chat-hero__title">{noProvider ? t('chat.connect_ai') : t('chat.greeting')}</h2>
      <p className="chat-hero__sub">{noProvider ? t('chat.connect_ai_hint') : t('chat.greeting_sub')}</p>
      {noProvider ? (
        <Button variant="primary" icon="settings" onClick={onConnect}>{t('chat.open_ai_settings')}</Button>
      ) : (
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
      )}
    </div>
  );
}
