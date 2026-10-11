import { describe, expect, it } from 'vitest';
import { neoUrlToRoute, parseRoute, routeToHash, type Route } from './router.js';

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', { name: 'chat' }],
    ['#/', { name: 'chat' }],
    ['#/chat', { name: 'chat' }],
    ['#/chat/conv_abc123', { name: 'chat', conversationId: 'conv_abc123' }],
    ['#/memory', { name: 'memory', tab: 'net' }],
    ['#/memory/pending', { name: 'memory', tab: 'pending' }],
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
    ['#/settings/devices', { name: 'settings', section: 'devices' }],
    ['#/settings/nope', { name: 'settings' }],
    ['#/connect', { name: 'connect' }],
    ['#/onboarding', { name: 'onboarding' }],
    ['#/pair?token=abc&server=https%3A%2F%2Fneo.example.com', { name: 'pair', token: 'abc', serverUrl: 'https://neo.example.com' }],
    ['#/pair?token=abc', { name: 'pair', token: 'abc' }],
    ['#/pair?v=2&code=abc_123&server=https%3A%2F%2Fneo.example.com', { name: 'pair', version: '2', code: 'abc_123', serverUrl: 'https://neo.example.com' }],
    ['#/unknown/thing', { name: 'chat' }],
  ])('%s', (hash, expected) => {
    const route = parseRoute(hash);
    expect(route).toMatchObject(expected);
    for (const [k, v] of Object.entries(route)) if (!(k in expected)) expect(v).toBeUndefined();
  });

  it('ignores ids with unsafe characters', () => {
    expect(parseRoute('#/chat/<script>')).toEqual({ name: 'chat', conversationId: undefined });
  });
});

describe('routeToHash', () => {
  it.each<Route>([
    { name: 'chat' },
    { name: 'chat', conversationId: 'conv_1' },
    { name: 'memory', tab: 'net' },
    { name: 'memory', tab: 'stats' },
    { name: 'memory', tab: 'net', nodeId: 'mem_1' },
    { name: 'memory', tab: 'list', nodeId: 'mem_1' },
    { name: 'reminders', reminderId: 'rem_1' },
    { name: 'tasks', listId: 'list_x' },
    { name: 'tasks', taskId: 'task_x' },
    { name: 'notes', noteId: 'note_1' },
    { name: 'settings', section: 'ai' },
    { name: 'pair', token: 't', serverUrl: 'https://a.b' },
    { name: 'pair', version: '2', code: 'pairing_code', serverUrl: 'https://a.b' },
  ])('round-trips %j', (route) => {
    expect(parseRoute(routeToHash(route))).toMatchObject(route);
  });
});

describe('neoUrlToRoute', () => {
  it.each<[string, Route | null]>([
    ['neo://chat/conv_1', { name: 'chat', conversationId: 'conv_1' }],
    ['neo://reminders/rem_abc', { name: 'reminders', reminderId: 'rem_abc' }],
    ['neo://reminders', { name: 'reminders' }],
    ['neo://memory/mem_5', { name: 'memory', tab: 'net', nodeId: 'mem_5' }],
    ['neo://memory/pending', { name: 'memory', tab: 'pending' }],
    ['neo://tasks/task_1', { name: 'tasks', taskId: 'task_1' }],
    ['neo://notes/note_1', { name: 'notes', noteId: 'note_1' }],
    ['neo://settings/notifications', { name: 'settings', section: 'notifications' }],
    ['NEO://Chat', { name: 'chat' }],
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
