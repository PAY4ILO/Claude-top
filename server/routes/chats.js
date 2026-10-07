/**
 * Поддержка: у каждого пользователя одно обращение (переписка с администрацией).
 * Непрочитанное считается для каждого читателя отдельно (conversation_reads); оттуда же «прочитано» (две галочки):
 * сообщения игрока прочитаны, когда их открыл кто-то из админов, сообщения админов — когда их открыл игрок.
 * Отвечать в обращениях могут админы с правом «Обращения».
 * Новые сообщения клиент забирает опросом раз в несколько секунд (Api.chats.subscribe).
 * Фото и файлы — тоже сообщения (с вложением): загрузка и скачивание — routes/attachments.js.
 */
import { tx } from '../db.js';
import { fail } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { validate } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const SYSTEM_GREETING = 'Спасибо за обращение! Администратор ответит здесь, как только освободится. Уведомлений на почту нет — загляните позже.';

export default function register(router, s) {
  const { db, need, views, config } = s;

  const convById = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const readAt = db.prepare('SELECT read_at FROM conversation_reads WHERE conversation_id = ? AND user_id = ?');
  const supportReadAt = db.prepare('SELECT MAX(read_at) AS t FROM conversation_reads WHERE conversation_id = ? AND user_id != ?');
  const setRead = db.prepare('INSERT INTO conversation_reads (conversation_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)');

  function unreadFor(user, c) {
    const since = (readAt.get(c.id, user.id) || {}).read_at || 0;
    // Приветствие-автоответ админам как «непрочитанное» не показываем.
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at > ? AND (author_id IS NULL OR author_id != ?) ${user.id !== c.player_id ? 'AND system = 0' : ''}`)
      .get(c.id, since, user.id);
    return row.n;
  }

  function canAccess(user, c) {
    return !!c && (c.player_id === user.id || s.can(user, 'tickets'));
  }

  /** До какого момента собеседник прочитал переписку: для игрока — любой из админов, для админа — игрок. */
  function peerReadAt(user, c) {
    if (user.id === c.player_id) return supportReadAt.get(c.id, c.player_id).t || 0;
    return (readAt.get(c.id, c.player_id) || {}).read_at || 0;
  }

  function partnerFor(user, c) {
    if (c.player_id !== user.id) return views.brief(s.getUser(c.player_id));
    // Для игрока собеседник — последний ответивший администратор.
    const last = db.prepare('SELECT author_id FROM messages WHERE conversation_id = ? AND system = 0 AND author_id IS NOT NULL AND author_id != ? ORDER BY created_at DESC LIMIT 1').get(c.id, user.id);
    return last ? views.brief(s.getUser(last.author_id)) : null;
  }

  const lastMessage = db.prepare(
    `SELECT m.text, m.author_id, m.system, m.created_at, a.kind, a.name FROM messages m LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 1`
  );

  function view(user, c) {
    const last = lastMessage.get(c.id);
    return {
      id: c.id,
      status: c.status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      player: views.brief(s.getUser(c.player_id)),
      partner: partnerFor(user, c),
      // attachment — чтобы в списке обращений показать «Фото» или имя файла, если текста нет
      lastMessage: last && { text: last.text, authorId: last.system ? 'system' : last.author_id, createdAt: last.created_at, attachment: last.kind ? { kind: last.kind, name: last.name } : null },
      messageCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(c.id).n,
      unread: unreadFor(user, c),
      peerReadAt: peerReadAt(user, c),
    };
  }

  const attachmentsOf = db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at');
  const attachmentView = (a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    kind: a.kind,
    mime: a.mime,
    width: a.width,
    height: a.height,
    url: `/api/attachments/${encodeURIComponent(a.id)}`,
  });

  function messageView(m) {
    const author = m.system ? null : s.getUser(m.author_id);
    return {
      id: m.id,
      clientId: m.client_id,
      text: m.text,
      createdAt: m.created_at,
      authorId: m.system ? 'system' : m.author_id,
      system: !!m.system,
      author: views.brief(author),
      attachments: attachmentsOf.all(m.id).map(attachmentView),
    };
  }

  /** Повтор отправки (плохой интернет) с тем же clientId — то же сообщение, без дубля. */
  const findDuplicate = (conversationId, userId, clientId) =>
    clientId ? db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND author_id = ? AND client_id = ?').get(conversationId, userId, clientId) : null;

  /**
   * Новое сообщение (текст и/или вложение) — вызывать внутри tx(). Сообщение игрока открывает закрытое обращение,
   * первое — добавляет автоответ. attachment: { id, name, size, kind, mime, width, height } — файл уже лежит на диске.
   */
  function addMessage(user, c, { text, clientId, attachment }) {
    const now = Date.now();
    const isPlayer = user.id === c.player_id;
    const id = newId('m');
    db.prepare('INSERT INTO messages (id, conversation_id, author_id, system, client_id, text, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, c.id, user.id, clientId, text, now);
    if (attachment) {
      const a = attachment;
      db.prepare('INSERT INTO attachments (id, message_id, name, size, kind, mime, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(a.id, id, a.name, a.size, a.kind, a.mime, a.width, a.height, now);
    }
    if (isPlayer && c.player_messages === 0) {
      db.prepare('INSERT INTO messages (id, conversation_id, author_id, system, text, created_at) VALUES (?, ?, NULL, 1, ?, ?)').run(newId('m'), c.id, SYSTEM_GREETING, now + 1);
    }
    db.prepare(`UPDATE conversations SET updated_at = ?, player_messages = player_messages + ? ${isPlayer ? ", status = 'open'" : ''} WHERE id = ?`).run(now, isPlayer ? 1 : 0, c.id);
    setRead.run(c.id, user.id, now + 1);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  s.chat = {
    byId: (id) => convById.get(id),
    canAccess,
    findDuplicate,
    addMessage,
    messageView,
    unreadMessagesFor(user) {
      const c = db.prepare('SELECT * FROM conversations WHERE player_id = ?').get(user.id);
      return c ? unreadFor(user, c) : 0;
    },
    unreadConversationsFor(admin) {
      return db
        .prepare('SELECT * FROM conversations WHERE player_messages > 0')
        .all()
        .filter((c) => unreadFor(admin, c) > 0).length;
    },
  };

  router.add('POST', '/api/support/conversation', (ctx) => {
    const user = need.user(ctx);
    let c = db.prepare('SELECT * FROM conversations WHERE player_id = ?').get(user.id);
    if (!c) {
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO conversations (id, player_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(newId('c'), user.id, 'open', now, now);
      c = db.prepare('SELECT * FROM conversations WHERE player_id = ?').get(user.id);
    }
    return { conversation: view(user, c) };
  });

  router.add('GET', '/api/conversations', (ctx) => {
    const admin = need.perm(ctx, 'tickets');
    const status = ctx.query.get('status') || 'open';
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c JOIN users u ON u.id = c.player_id
         WHERE c.player_messages > 0 ${status === 'open' || status === 'closed' ? 'AND c.status = ?' : ''} ${q ? "AND lower(u.nickname) LIKE ? ESCAPE '\\'" : ''}
         ORDER BY c.updated_at DESC LIMIT 500`
      )
      .all(...[status === 'open' || status === 'closed' ? status : null, q ? '%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%' : null].filter((x) => x !== null));
    const items = rows.map((c) => view(admin, c)).sort((a, b) => b.unread - a.unread || b.updatedAt - a.updatedAt);
    return { items };
  });

  router.add('GET', '/api/conversations/:id', (ctx) => {
    const user = need.user(ctx);
    const c = convById.get(ctx.params.id);
    if (!canAccess(user, c)) throw fail.notFound('Обращение не найдено.');
    // maxFileBytes — чтобы кабинет сразу отказал в слишком большом файле, а не грузил его зря
    return { conversation: Object.assign(view(user, c), { maxFileBytes: config.chatMaxFileBytes }) };
  });

  router.add('GET', '/api/conversations/:id/messages', (ctx) => {
    const user = need.user(ctx);
    const c = convById.get(ctx.params.id);
    if (!canAccess(user, c)) throw fail.notFound('Обращение не найдено.');
    const before = Number(ctx.query.get('before')) || 0;
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 50, 1), 200);
    const rows = db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ${before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...(before ? [c.id, before, limit + 1] : [c.id, limit + 1]));
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse().map(messageView), hasMore };
  });

  router.add('POST', '/api/conversations/:id/messages', (ctx) => {
    const user = need.user(ctx);
    need.rate(ctx, 'message', 30, 60_000, 'Слишком много сообщений подряд. Подождите минуту.');
    const text = str(ctx.body.text).trim();
    const err = validate.message(text);
    if (err) throw fail.validation({ text: err }, err);
    const clientId = str(ctx.body.clientId).slice(0, 64) || null;
    const result = tx(db, () => {
      const c = convById.get(ctx.params.id);
      if (!canAccess(user, c)) throw fail.notFound('Обращение не найдено.');
      return findDuplicate(c.id, user.id, clientId) || addMessage(user, c, { text, clientId });
    });
    return { message: messageView(result) };
  });

  router.add('POST', '/api/conversations/:id/read', (ctx) => {
    const user = need.user(ctx);
    const c = convById.get(ctx.params.id);
    if (canAccess(user, c)) setRead.run(c.id, user.id, Date.now());
    return null;
  });

  for (const [action, status] of [
    ['close', 'closed'],
    ['reopen', 'open'],
  ]) {
    router.add('POST', `/api/conversations/:id/${action}`, (ctx) => {
      need.perm(ctx, 'tickets');
      const c = convById.get(ctx.params.id);
      if (!c) throw fail.notFound('Обращение не найдено.');
      db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), c.id);
      return null;
    });
  }

  // Удалить обращение вместе с перепиской и файлами. Игрок сможет написать снова — начнётся новое.
  router.add('DELETE', '/api/conversations/:id', (ctx) => {
    need.perm(ctx, 'tickets', 'delete');
    const c = convById.get(ctx.params.id);
    if (!c) throw fail.notFound('Обращение не найдено.');
    const files = s.attachments.idsOfConversation(c.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    s.attachments.removeFiles(files);
    return null;
  });
}
