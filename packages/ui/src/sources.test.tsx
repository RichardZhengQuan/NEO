import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '@neo/protocol';
import { I18nProvider } from './i18n.js';
import { LinkProvider } from './links.js';
import { MessageView } from './message.js';

afterEach(cleanup);

const message: Message = {
  id: 'message', episodeId: 'episode', conversationId: 'episode', role: 'assistant', createdAt: 0, status: 'complete',
  parts: [
    { type: 'sources', items: [{ title: 'Example article', url: 'https://example.com/article', snippet: 'Supporting details' }] },
    { type: 'text', text: 'A researched answer.' },
    { type: 'sources', items: [{ title: 'Example article', url: 'https://example.com/article' }, { title: 'More details', url: 'https://example.org/details' }] },
  ],
};

describe('message sources', () => {
  it.each([['en', 'Sources'], ['zh-CN', '来源']])('renders compact, deduplicated links below the answer in %s', (locale, label) => {
    const { container } = render(<I18nProvider locale={locale}><MessageView message={message} /></I18nProvider>);
    const sources = screen.getByRole('group', { name: label });
    expect(sources.querySelectorAll('a')).toHaveLength(2);
    expect(sources.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Example article' }).getAttribute('href')).toBe('https://example.com/article');
    expect(screen.getByRole('link', { name: 'Example article' }).getAttribute('title')).toContain('Supporting details');
    expect(container.querySelector('.neo-msg__body')?.lastElementChild?.previousElementSibling).toBe(sources);
  });

  it('opens a source with the host link handler and prevents browser navigation', () => {
    const openExternal = vi.fn(() => true);
    render(<I18nProvider locale="en"><LinkProvider onLink={openExternal}><MessageView message={message} /></LinkProvider></I18nProvider>);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Example article' }))).toBe(false);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/article');
  });

  it('ignores unsafe source URLs and empty source parts', () => {
    render(<I18nProvider locale="en"><MessageView message={{ ...message, parts: [{ type: 'sources', items: [{ title: 'Unsafe', url: 'javascript:alert(1)' }] }, { type: 'sources', items: [] }] }} /></I18nProvider>);
    expect(screen.queryByRole('group', { name: 'Sources' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
