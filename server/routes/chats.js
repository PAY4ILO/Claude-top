/**
 * Поддержка: у каждого пользователя одно обращение (переписка с администрацией).
 * Непрочитанное считается для каждого читателя отдельно (conversation_reads).
 * Новые сообщения клиент забирает опросом раз в несколько секунд (Api.chats.subscribe).
 */
import { tx } from '../db.js';
import { fail } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { validate } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const SYSTEM_GREETING = 'Спасибо за обращение! Администратор ответит здесь, как только освободится. Уведомлений на почту нет — загляните позже.';

export default function register(router, s) {
  const { db, need, views } = s;

  const convById = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const readAt = db.prepare('SELECT read_at FROM conversation_reads WHERE conversation_id = ? AND user_id = ?');
  const setRead = db.prepare('INSERT INTO conversation_reads (conversation_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)');

  function unreadFor(user, c) {
    const since = (readAt.get(c.id, user.id) || {}).read_at || 0;
    // Приветствие-автоответ админам как «непрочитанное» не показываем.
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at > ? AND (author_id IS NULL OR author_id != ?) ${user.role === 'admin' ? 'AND system = 0' : ''}`)
      .get(c.id, since, user.id);
    return row.n;
  }

  function canAccess(user, c) {
    return !!c && (user.role === 'admin' || c.player_id === user.id);
  }

  function partnerFor(user, c) {
    if (user.role === 'admin' && c.player_id !== user.id) return views.brief(s.getUser(c.player_id));
    // Для игрока собеседник — последний ответивший администратор.
    const last = db.prepare('SELECT author_id FROM messages WHERE conversation_id = ? AND system = 0 AND author_id IS NOT NULL AND author_id != ? ORDER BY created_at DESC LIMIT 1').get(c.id, user.id);
    return last ? views.brief(s.getUser(last.author_id)) : null;
  }

  function view(user, c) {
    const last = db.prepare('SELECT text, author_id, system, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id);
    return {
      id: c.id,
      status: c.status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      player: views.brief(s.getUser(c.player_id)),
      partner: partnerFor(user, c),
      lastMessage: last && { text: last.text, authorId: last.system ? 'system' : last.author_id, createdAt: last.created_at },
      messageCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(c.id).n,
      unread: unreadFor(user, c),
    };
  }

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
    };
  }

  s.chat = {
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
    const admin = need.admin(ctx);
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
    return { conversation: view(user, c) };
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
      if (clientId) {
        // Повтор отправки (плохой интернет) не создаёт дубль.
        const dup = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND author_id = ? AND client_id = ?').get(c.id, user.id, clientId);
        if (dup) return dup;
      }
      const now = Date.now();
      const isPlayer = user.id === c.player_id;
      const id = newId('m');
      db.prepare('INSERT INTO messages (id, conversation_id, author_id, system, client_id, text, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, c.id, user.id, clientId, text, now);
      if (isPlayer && c.player_messages === 0) {
        db.prepare('INSERT INTO messages (id, conversation_id, author_id, system, text, created_at) VALUES (?, ?, NULL, 1, ?, ?)').run(newId('m'), c.id, SYSTEM_GREETING, now + 1);
      }
      db.prepare(`UPDATE conversations SET updated_at = ?, player_messages = player_messages + ? ${isPlayer ? ", status = 'open'" : ''} WHERE id = ?`).run(now, isPlayer ? 1 : 0, c.id);
      setRead.run(c.id, user.id, now + 1);
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
      return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
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
      need.admin(ctx);
      const c = convById.get(ctx.params.id);
      if (!c) throw fail.notFound('Обращение не найдено.');
      db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), c.id);
      return null;
    });
  }
}
