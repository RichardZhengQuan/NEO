import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { I18nProvider } from '../i18n.js';
import {
  AVATAR_BACKGROUNDS, AVATAR_CHARACTERS, AVATAR_STATES, DEFAULT_AVATAR,
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
  function Harness({ onChange, hero = false, orbit = false }: { onChange: (s: string, c: AvatarConfig) => void; hero?: boolean; orbit?: boolean }): ReactElement {
    const [value, setValue] = useState<string | null>(null);
    return <AvatarPicker size={hero ? 'hero' : 'default'} layout={orbit ? 'orbit' : 'default'} value={value} onChange={(s, c) => { setValue(s); onChange(s, c); }} />;
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

  it.each(['default', 'compact', 'hero'] as const)('retains preset and custom backgrounds in the %s picker', (layout) => {
    wrap(<AvatarPicker value={null} onChange={() => {}} compact={layout === 'compact'} size={layout === 'hero' ? 'hero' : 'default'} />);
    const group = screen.getByRole('radiogroup', { name: 'Background' });
    expect(within(group).getAllByRole('radio')).toHaveLength(AVATAR_BACKGROUNDS.length + 1);
    AVATAR_BACKGROUNDS.forEach((bg) => expect(within(group).getByRole('radio', { name: bg })).toBeTruthy());
    expect(within(group).getByRole('radio', { name: 'Custom color' }).getAttribute('type')).toBe('color');
  });

  it('uses the default background when a fresh orbit picker changes character', () => {
    const onChange = vi.fn();
    wrap(<Harness orbit onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    expect(onChange).toHaveBeenLastCalledWith(serializeAvatar({ kind: 'dog', bg: DEFAULT_AVATAR.bg }), { kind: 'dog', bg: DEFAULT_AVATAR.bg });
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

  it('shows a large hero preview, five character tiles and backgrounds without state controls', () => {
    wrap(<AvatarPicker size="hero" value={null} onChange={() => {}} />);
    const preview = screen.getByRole('img', { name: 'Preview' });
    expect(parseInt(preview.style.width)).toBeGreaterThanOrEqual(160);
    expect(within(screen.getByRole('radiogroup', { name: 'Character' })).getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radiogroup', { name: 'Background' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Speaking' })).toBeNull();
  });

  it('briefly speaks after a different hero character is picked, resetting for rapid changes', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = wrap(<Harness hero onChange={() => {}} />);
      const preview = screen.getByRole('img', { name: 'Preview' });
      fireEvent.click(screen.getByRole('radio', { name: 'Robot' }));
      expect(preview.getAttribute('data-state')).toBe('idle');
      fireEvent.click(screen.getByRole('radio', { name: '#DCD0F4' }));
      expect(preview.getAttribute('data-state')).toBe('idle');

      fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
      expect(preview.getAttribute('data-state')).toBe('speaking');
      act(() => { vi.advanceTimersByTime(800); });
      fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
      act(() => { vi.advanceTimersByTime(800); });
      expect(preview.getAttribute('data-kind')).toBe('dog');
      expect(preview.getAttribute('data-state')).toBe('speaking');
      fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
      act(() => { vi.advanceTimersByTime(400); });
      expect(preview.getAttribute('data-state')).toBe('idle');
      act(() => { vi.advanceTimersByTime(2600); });
      expect(preview.getAttribute('data-state')).toBe('idle');
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the hero speaking timer when unmounted', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = wrap(<Harness hero onChange={() => {}} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['hero', 'orbit'])('selects and focuses %s characters with arrows, Home and End', (layout) => {
    const onChange = vi.fn();
    wrap(<Harness hero={layout === 'hero'} orbit={layout === 'orbit'} onChange={onChange} />);
    const robot = screen.getByRole('radio', { name: 'Robot' });
    const cat = screen.getByRole('radio', { name: 'Cat' });
    const girl = screen.getByRole('radio', { name: 'Girl' });
    robot.focus();
    fireEvent.keyDown(robot, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cat);
    expect(cat.getAttribute('aria-checked')).toBe('true');
    expect(cat.tabIndex).toBe(0);
    expect(robot.tabIndex).toBe(-1);
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^neo-avatar:/), { kind: 'cat', bg: DEFAULT_AVATAR.bg });

    fireEvent.keyDown(cat, { key: 'End' });
    expect(document.activeElement).toBe(girl);
    expect(girl.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(girl, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(robot);
    fireEvent.keyDown(robot, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(girl);
    fireEvent.keyDown(girl, { key: 'Home' });
    expect(document.activeElement).toBe(robot);
    expect(robot.getAttribute('aria-checked')).toBe('true');
  });

  it('exposes only the character orbit slot without a preview or state controls', () => {
    const { container } = wrap(
      <AvatarPicker layout="orbit" size="hero" value={null} onChange={() => {}}>
        {({ characters }) => <section data-testid="characters">{characters}</section>}
      </AvatarPicker>,
    );
    const characters = within(screen.getByTestId('characters')).getByRole('radiogroup', { name: 'Character' });
    expect(within(characters).getAllByRole('radio')).toHaveLength(5);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Background' })).toBeNull();
    expect(container.querySelector('.neo-avp-swatch, input[type="color"], [data-orbit="color"]')).toBeNull();
    expect(container.querySelector('.neo-avp--orbit')).not.toBeNull();
    expect(container.querySelector('.neo-avp-stage')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();
    expect(container.querySelector('.neo-avp-orbit-trace')).toBeNull();
    expect(container.querySelectorAll('.neo-avp-kind .neo-av--circle')).toHaveLength(5);
  });

  it.each(['#DCD0F4', '#123456'])('selects an orbit portrait while preserving its previous background %s', (bg) => {
    const onChange = vi.fn();
    const { container } = wrap(<AvatarPicker layout="orbit" value={serializeAvatar({ kind: 'robot', bg })} onChange={onChange} />);
    const robot = screen.getByRole('radio', { name: 'Robot' });
    const cat = screen.getByRole('radio', { name: 'Cat' });
    fireEvent.click(cat);
    expect(cat.getAttribute('data-orbit')).toBe('portrait');
    expect(cat.textContent).toBe('');
    expect(cat.getAttribute('title')).toBe('Cat');
    expect(onChange).toHaveBeenLastCalledWith(serializeAvatar({ kind: 'cat', bg }), { kind: 'cat', bg });
    expect(Array.from(container.querySelectorAll('.neo-avp-kind .neo-av')).map((portrait) => portrait.querySelector('rect')!.getAttribute('fill'))).toEqual(Array(5).fill(bg));
    expect(robot.getAttribute('aria-checked')).toBe('true');
  });

  it('selects and focuses hero colors with arrows, Home and End, including custom', () => {
    const onChange = vi.fn();
    wrap(<Harness hero onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Background' });
    const radios = within(group).getAllByRole('radio');
    const first = radios[0]!;
    const second = radios[1]!;
    const custom = screen.getByRole('radio', { name: 'Custom color' });
    expect(radios).toHaveLength(AVATAR_BACKGROUNDS.length + 1);
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([first]);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(onChange.mock.lastCall![1].bg).toBe(AVATAR_BACKGROUNDS[1]);
    fireEvent.keyDown(second, { key: 'End' });
    expect(document.activeElement).toBe(custom);
    expect(custom.getAttribute('aria-checked')).toBe('true');
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([custom]);
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toEqual([custom]);
    fireEvent.change(custom, { target: { value: '#123456' } });
    expect(onChange.mock.lastCall![1].bg).toBe('#123456');
    fireEvent.keyDown(custom, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-checked')).toBe('true');
    expect(custom.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(custom);
    fireEvent.keyDown(custom, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([first]);
  });

  it('submits its containing form with Enter from each orbit character', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    wrap(<form onSubmit={onSubmit}><Harness orbit onChange={() => {}} /><button type="submit">Continue</button></form>);
    for (const name of ['Robot', 'Cat', 'Dog', 'Boy', 'Girl']) {
      fireEvent.keyDown(screen.getByRole('radio', { name }), { key: 'Enter' });
    }
    expect(onSubmit).toHaveBeenCalledTimes(AVATAR_CHARACTERS.length);
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
