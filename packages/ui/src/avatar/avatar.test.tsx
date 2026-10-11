import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { I18nProvider } from '../i18n.js';
import {
  AVATAR_CHARACTERS, AVATAR_STATES, DEFAULT_AVATAR,
  isAvatarString, normalizeAvatar, parseAvatar, serializeAvatar,
  type AvatarConfig,
} from './config.js';
import { PORTRAIT_ART } from './art.js';
import { PORTRAITS } from './portraits.data.js';
import { NeoAvatar } from './neo-avatar.js';
import { AvatarPicker } from './avatar-picker.js';
import { useAvatarState, type AvatarActivity } from './use-avatar-state.js';

afterEach(cleanup);

const wrap = (ui: ReactElement, locale = 'en') => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

describe('avatar config', () => {
  it('round-trips through the stored string', () => {
    const cfg: AvatarConfig = { kind: 'cat', bg: '#DCD0F4' };
    const s = serializeAvatar(cfg);
    expect(s.startsWith('neo-avatar:')).toBe(true);
    expect(isAvatarString(s)).toBe(true);
    expect(parseAvatar(s)).toEqual(cfg);
  });

  it('reads strings saved by earlier versions', () => {
    expect(parseAvatar('neo-avatar:{"kind":"girl","color":"#7A8FA6","skin":"#EBC9AE","bg":"#dde4ea"}')).toEqual({ kind: 'girl', bg: '#DDE4EA' });
  });

  it('treats emoji, URLs and null as not-a-config', () => {
    expect(parseAvatar(null)).toBeNull();
    expect(parseAvatar(undefined)).toBeNull();
    expect(parseAvatar('🤖')).toBeNull();
    expect(parseAvatar('https://example.com/a.png')).toBeNull();
  });

  it('fills defaults for broken or partial values', () => {
    expect(parseAvatar('neo-avatar:{not json')).toEqual(DEFAULT_AVATAR);
    expect(parseAvatar('neo-avatar:{"kind":"dragon","bg":"red"}')).toEqual(DEFAULT_AVATAR);
    expect(normalizeAvatar({ kind: 'dog' })).toEqual({ kind: 'dog', bg: DEFAULT_AVATAR.bg });
  });
});

describe('portraits', () => {
  it.each(AVATAR_CHARACTERS)('ships a small WebP portrait for the %s', (kind) => {
    const uri = PORTRAITS[kind];
    expect(uri.startsWith('data:image/webp;base64,')).toBe(true);
    // Every client bundle carries these: keep each under 60 KB.
    expect((uri.length - 'data:image/webp;base64,'.length) * 0.75).toBeLessThan(60 * 1024);
  });
});

describe('NeoAvatar', () => {
  it.each(AVATAR_CHARACTERS)('draws the %s in every state', (kind) => {
    for (const state of AVATAR_STATES) {
      const { container, unmount } = render(<NeoAvatar avatar={{ kind, bg: '#EEE2DF' }} state={state} />);
      const root = container.querySelector('.neo-av')!;
      expect(root.getAttribute('data-kind')).toBe(kind);
      expect(root.getAttribute('data-state')).toBe(state);
      expect(root.querySelector('image')!.getAttribute('href')).toBe(PORTRAITS[kind]);
      expect(root.querySelector('rect')!.getAttribute('fill')).toBe('#EEE2DF');
      expect(root.querySelectorAll('.neo-av-lid')).toHaveLength(2);
      expect(root.querySelectorAll('.neo-av-mouth-open')).toHaveLength(PORTRAIT_ART[kind].mouth ? 1 : 0);
      expect(root.querySelector('.neo-av-thought')).not.toBeNull();
      expect(root.querySelector('.neo-av-alert')).not.toBeNull();
      unmount();
    }
  });

  it('gives the robot glowing eyes instead of a mouth', () => {
    const { container } = render(<NeoAvatar avatar={{ kind: 'robot', bg: '#CDE9FD' }} />);
    expect(container.querySelectorAll('.neo-av-halo')).toHaveLength(2);
  });

  it('reads a stored string and defaults to the robot', () => {
    const { container, rerender } = render(<NeoAvatar avatar={serializeAvatar({ kind: 'girl', bg: '#DCD0F4' })} />);
    expect(container.querySelector('.neo-av')!.getAttribute('data-kind')).toBe('girl');
    rerender(<NeoAvatar avatar={null} />);
    expect(container.querySelector('.neo-av')!.getAttribute('data-kind')).toBe('robot');
  });

  it('shows legacy emoji and image avatars', () => {
    const { container, rerender } = render(<NeoAvatar avatar="🦊" />);
    expect(container.textContent).toContain('🦊');
    rerender(<NeoAvatar avatar="https://example.com/a.png" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('is labelled when titled and hidden otherwise', () => {
    const { container } = render(<><NeoAvatar title="NEO" /><NeoAvatar /></>);
    expect(screen.getByRole('img', { name: 'NEO' })).toBeTruthy();
    expect(container.querySelectorAll('.neo-av')[1]!.getAttribute('aria-hidden')).toBe('true');
  });

  it('can render a still frame', () => {
    const { container } = render(<NeoAvatar animated={false} size={28} />);
    const root = container.querySelector('.neo-av') as HTMLElement;
    expect(root.classList.contains('neo-av--still')).toBe(true);
    expect(root.style.width).toBe('28px');
  });

  it('injects its stylesheet once', () => {
    render(<><NeoAvatar /><NeoAvatar /><NeoAvatar /></>);
    expect(document.querySelectorAll('style[data-href="neo-avatar"], style[href="neo-avatar"]').length).toBe(1);
  });
});

describe('AvatarPicker', () => {
  function Harness({ onChange }: { onChange: (s: string, c: AvatarConfig) => void }): ReactElement {
    const [value, setValue] = useState<string | null>(null);
    return <AvatarPicker value={value} onChange={(s, c) => { setValue(s); onChange(s, c); }} />;
  }

  it('changes character and background and emits the stored string', () => {
    const onChange = vi.fn();
    wrap(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: /Cat/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^neo-avatar:/), { kind: 'cat', bg: DEFAULT_AVATAR.bg });

    fireEvent.click(screen.getByRole('radio', { name: '#DCD0F4' }));
    expect(onChange.mock.lastCall![1]).toEqual({ kind: 'cat', bg: '#DCD0F4' });

    fireEvent.change(screen.getByLabelText('Custom color'), { target: { value: '#123456' } });
    expect(onChange.mock.lastCall![1]).toEqual({ kind: 'cat', bg: '#123456' });
    expect(parseAvatar(onChange.mock.lastCall![0])).toEqual(onChange.mock.lastCall![1]);
  });

  it('previews each state', () => {
    const { container } = wrap(<AvatarPicker value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(container.querySelector('.neo-avp-stage .neo-av')!.getAttribute('data-state')).toBe('thinking');
  });

  it('cycles the preview by itself when compact', () => {
    vi.useFakeTimers();
    try {
      const { container } = wrap(<AvatarPicker compact value={null} onChange={() => {}} />);
      const stage = () => container.querySelector('.neo-avp-stage .neo-av')!.getAttribute('data-state');
      expect(stage()).toBe('idle');
      act(() => { vi.advanceTimersByTime(2600); });
      expect(stage()).toBe('listening');
    } finally {
      vi.useRealTimers();
    }
  });

  it('speaks Chinese', () => {
    wrap(<AvatarPicker value={null} onChange={() => {}} />, 'zh-CN');
    expect(screen.getByText('角色')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /机器人/ })).toBeTruthy();
  });
});

describe('useAvatarState', () => {
  it('follows the turn: thinking, speaking while text streams, back to idle', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook((a: AvatarActivity) => useAvatarState(a), { initialProps: {} });
      expect(result.current).toBe('idle');

      rerender({ typing: true });
      expect(result.current).toBe('listening');

      rerender({ busy: true, text: '' });
      expect(result.current).toBe('thinking');

      rerender({ busy: true, text: 'Hel' });
      expect(result.current).toBe('speaking');
      rerender({ busy: true, text: 'Hello' });
      act(() => { vi.advanceTimersByTime(500); });
      expect(result.current).toBe('speaking');
      act(() => { vi.advanceTimersByTime(300); });
      expect(result.current).toBe('thinking');

      rerender({ busy: true, text: 'Hello there' });
      expect(result.current).toBe('speaking');
      rerender({ busy: false, text: 'Hello there' });
      expect(result.current).toBe('idle');

      // A new turn starts thinking, not still speaking from the last one.
      rerender({ busy: true, text: '' });
      expect(result.current).toBe('thinking');
    } finally {
      vi.useRealTimers();
    }
  });
});
