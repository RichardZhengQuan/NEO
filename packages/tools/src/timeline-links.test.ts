import { describe, expect, it } from 'vitest';
import { createConversationStore, migrate, openNeoDatabase } from '@neo/storage';
import { createProductivityStores, toolsMigrations } from './index.js';

it('migrates legacy reminder and notification conversation links to timeline messages', () => {
  const db = openNeoDatabase(':memory:');
  try {
    migrate(db, 'tools', toolsMigrations.filter(migration => migration.version < 6));
    const conversations = createConversationStore(db, { clock: () => 100 });
    const episode = conversations.create();
    conversations.appendMessage({ id: 'source', conversationId: episode.id, role: 'assistant', createdAt: 100, parts: [{ type: 'text', text: 'Set a reminder.' }], status: 'complete' });
    conversations.appendMessage({ id: 'later', conversationId: episode.id, role: 'assistant', createdAt: 200, parts: [{ type: 'text', text: 'Later reply.' }], status: 'complete' });
    db.prepare(`INSERT INTO reminders (id,title,due_at,anchor_at,timezone,conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run('legacy-reminder', 'Legacy', 1000, 1000, 'UTC', episode.id, 100, 100);
    const notification = db.prepare(`INSERT INTO notifications (id,kind,title,body,created_at,data) VALUES (?,?,?,?,?,?)`);
    notification.run('legacy-notification', 'reminder', 'Legacy', 'Details', 100, JSON.stringify({ conversationId: episode.id, reminderId: 'legacy-reminder', url: `neo://chat/${episode.id}` }));
    notification.run('missing-source', 'reminder', 'Missing', 'Details', 100, JSON.stringify({ conversationId: 'missing', reminderId: 'missing-reminder', url: 'neo://chat/missing' }));
    migrate(db, 'tools', toolsMigrations);
    const stores = createProductivityStores(db);
    expect(stores.reminders.get('legacy-reminder')).toMatchObject({ messageId: 'source' });
    expect(stores.reminders.get('legacy-reminder')).not.toHaveProperty('conversationId');
    const notifications = stores.notifications.list();
    expect(notifications.find(item => item.id === 'legacy-notification')?.data).toEqual({ messageId: 'later', reminderId: 'legacy-reminder', url: 'neo://timeline/later' });
    expect(notifications.find(item => item.id === 'missing-source')?.data).toEqual({ messageId: null, reminderId: 'missing-reminder' });
    expect(db.prepare('SELECT conversation_id FROM reminders').get()).toEqual(expect.objectContaining({ conversation_id: episode.id }));
    expect(conversations.messages(episode.id)).toHaveLength(2);
  } finally { db.close(); }
});

describe('timeline reminder storage', () => {
  it('round-trips a message source through reminder updates, snooze and firing', () => {
    const db = openNeoDatabase(':memory:');
    try {
      migrate(db, 'tools', toolsMigrations);
      const { reminders } = createProductivityStores(db, { clock: () => 100 });
      const reminder = reminders.create({ title: 'Source', dueAt: 200, messageId: 'msg-source' });
      expect(reminders.update(reminder.id, { notes: 'Details' }).messageId).toBe('msg-source');
      expect(reminders.snooze(reminder.id, 1).messageId).toBe('msg-source');
      expect(reminders.markFired(reminder.id, 60_100).reminder.messageId).toBe('msg-source');
    } finally { db.close(); }
  });
});
