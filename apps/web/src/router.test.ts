import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { neoUrlToRoute, parseRoute, routeToHash, useRoute, type Route } from './router.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/');
});

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', { name: 'timeline' }],
    ['#/', { name: 'timeline' }],
    ['#/timeline', { name: 'timeline' }],
    ['#/timeline/msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['#/timeline?messageId=msg_2', { name: 'timeline', messageId: 'msg_2' }],
    ['#/chat', { name: 'timeline' }],
    ['#/chat/conv_abc123', { name: 'timeline' }],
    ['#/chat/conv_1?messageId=msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['#/chat/conv_1/msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['#/chat/conv_1/messages/msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['#/memory', { name: 'memory', tab: 'net' }],
    ['#/memory/journal', { name: 'memory', tab: 'journal' }],
    ['#/memory/mem_1', { name: 'memory', tab: 'net', nodeId: 'mem_1' }],
    ['#/memory/list?node=mem_2', { name: 'memory', tab: 'list', nodeId: 'mem_2' }],
    ['#/reminders', { name: 'reminders' }],
    ['#/reminders/rem_9', { name: 'reminders', reminderId: 'rem_9' }],
    ['#/tasks', { name: 'tasks' }],
    ['#/tasks/list_inbox', { name: 'tasks', listId: 'list_inbox' }],
    ['#/tasks/task_7', { name: 'tasks', taskId: 'task_7' }],
    ['#/notes/note_3', { name: 'notes', noteId: 'note_3' }],
    ['#/settings', { name: 'settings' }],
    ['#/settings/avatar', { name: 'settings', section: 'avatar' }],
    ['#/settings/persona', { name: 'settings', section: 'avatar' }],
    ['#/settings/devices', { name: 'settings', section: 'devices' }],
    ['#/settings/nope', { name: 'settings' }],
    ['#/connect', { name: 'connect' }],
    ['#/onboarding', { name: 'onboarding' }],
    ['#/pair?token=abc&server=https%3A%2F%2Fneo.example.com', { name: 'pair', token: 'abc', serverUrl: 'https://neo.example.com' }],
    ['#/pair?token=abc', { name: 'pair', token: 'abc' }],
    ['#/pair?v=2&code=abc_123&server=https%3A%2F%2Fneo.example.com', { name: 'pair', version: '2', code: 'abc_123', serverUrl: 'https://neo.example.com' }],
    ['#/unknown/thing', { name: 'timeline' }],
  ])('%s', (hash, expected) => {
    const route = parseRoute(hash);
    expect(route).toMatchObject(expected);
    for (const [k, v] of Object.entries(route)) if (!(k in expected)) expect(v).toBeUndefined();
  });

  it('ignores ids with unsafe characters', () => {
    expect(parseRoute('#/timeline/<script>')).toEqual({ name: 'timeline' });
    expect(parseRoute('#/chat/conv_1?messageId=%3Cscript%3E')).toEqual({ name: 'timeline' });
  });
});

describe('routeToHash', () => {
  it.each<Route>([
    { name: 'timeline' },
    { name: 'timeline', messageId: 'msg_1' },
    { name: 'memory', tab: 'net' },
    { name: 'memory', tab: 'stats' },
    { name: 'memory', tab: 'net', nodeId: 'mem_1' },
    { name: 'memory', tab: 'list', nodeId: 'mem_1' },
    { name: 'reminders', reminderId: 'rem_1' },
    { name: 'tasks', listId: 'list_x' },
    { name: 'tasks', taskId: 'task_x' },
    { name: 'notes', noteId: 'note_1' },
    { name: 'settings', section: 'ai' },
    { name: 'settings', section: 'avatar' },
    { name: 'pair', token: 't', serverUrl: 'https://a.b' },
    { name: 'pair', version: '2', code: 'pairing_code', serverUrl: 'https://a.b' },
  ])('round-trips %j', (route) => {
    expect(parseRoute(routeToHash(route))).toMatchObject(route);
  });
});

describe('neoUrlToRoute', () => {
  it.each<[string, Route | null]>([
    ['neo://chat/conv_1', { name: 'timeline' }],
    ['neo://chat/conv_1?messageId=msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['neo://timeline/msg_1', { name: 'timeline', messageId: 'msg_1' }],
    ['neo://reminders/rem_abc', { name: 'reminders', reminderId: 'rem_abc' }],
    ['neo://reminders', { name: 'reminders' }],
    ['neo://memory/mem_5', { name: 'memory', tab: 'net', nodeId: 'mem_5' }],
    ['neo://tasks/task_1', { name: 'tasks', taskId: 'task_1' }],
    ['neo://notes/note_1', { name: 'notes', noteId: 'note_1' }],
    ['neo://settings/persona', { name: 'settings', section: 'avatar' }],
    ['neo://settings/notifications', { name: 'settings', section: 'notifications' }],
    ['NEO://Chat', { name: 'timeline' }],
    ['neo://pair?server=https%3A%2F%2Fhome.example&token=tok', { name: 'pair', token: 'tok', serverUrl: 'https://home.example' }],
    ['neo://pair?v=2&code=pairing_code&server=https%3A%2F%2Fhome.example', { name: 'pair', version: '2', code: 'pairing_code', serverUrl: 'https://home.example' }],
    ['neo://elsewhere/x', null],
    ['https://example.com', null],
  ])('%s', (url, expected) => {
    const route = neoUrlToRoute(url);
    if (expected === null) expect(route).toBeNull();
    else expect(route).toMatchObject(expected);
  });
});

it('opens timeline message sources and notification targets', () => {
  expect(neoUrlToRoute('neo://timeline?messageId=msg_1')).toEqual({ name: 'timeline', messageId: 'msg_1' });
  expect(routeToHash({ name: 'timeline', messageId: 'msg_1' })).toBe('#/timeline?messageId=msg_1');
});

it.each([
  ['#/chat/conv_1', '#/', { name: 'timeline' }],
  ['#/chat/conv_1?messageId=msg_1', '#/timeline?messageId=msg_1', { name: 'timeline', messageId: 'msg_1' }],
])('redirects the old route %s without a new history entry', (oldHash, expectedHash, expectedRoute) => {
  window.history.replaceState(null, '', oldHash);
  const historyLength = window.history.length;
  const { result } = renderHook(useRoute);
  expect(result.current).toEqual(expectedRoute);
  expect(window.location.hash).toBe(expectedHash);
  expect(window.history.length).toBe(historyLength);
});
