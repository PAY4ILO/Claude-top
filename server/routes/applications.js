/** Заявки на сервер. Одобрение делает «Пользователя» «Игроком». */
import { tx } from '../db.js';
import { fail } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { LIMITS, clean, validate } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];

export default function register(router, s) {
  const { db, need, views } = s;

  const historyOf = db.prepare('SELECT status, at, by FROM application_history WHERE application_id = ? ORDER BY id');

  function view(a) {
    return {
      id: a.id,
      userId: a.user_id,
      nickname: a.nickname,
      age: a.age,
      license: a.license,
      about: a.about,
      source: a.source,
      contact: a.contact,
      status: a.status,
      comment: a.comment,
      reviewerId: a.reviewer_id,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      history: historyOf.all(a.id).map((h) => ({ status: h.status, at: h.at, by: h.by || undefined })),
      applicant: views.brief(s.getUser(a.user_id)),
      reviewer: views.brief(s.getUser(a.reviewer_id)),
    };
  }
  s.applicationView = view;

  const addHistory = db.prepare('INSERT INTO application_history (application_id, status, at, by) VALUES (?, ?, ?, ?)');

  router.add('GET', '/api/applications/mine', (ctx) => {
    const user = need.user(ctx);
    const a = db.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    return { application: a ? view(a) : null };
  });

  router.add('POST', '/api/applications', (ctx) => {
    const user = need.user(ctx);
    need.rate(ctx, 'apply', 10, 3600_000);
    const d = ctx.body;
    const f = clean(validate.application(d));
    if (Object.keys(f).length) throw fail.validation(f);
    const now = Date.now();
    const id = newId('a');
    tx(db, () => {
      const active = db.prepare("SELECT 1 FROM applications WHERE user_id = ? AND status IN ('pending', 'approved')").get(user.id);
      if (active) throw fail.conflict('У вас уже есть активная заявка.');
      db.prepare('INSERT INTO applications (id, user_id, nickname, age, license, about, source, contact, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        user.id,
        user.nickname,
        Number(d.age),
        d.license,
        str(d.about).trim(),
        d.source,
        str(d.contact).trim(),
        'pending',
        now,
        now
      );
      addHistory.run(id, 'pending', now, null);
    });
    return { application: view(db.prepare('SELECT * FROM applications WHERE id = ?').get(id)) };
  });

  router.add('POST', '/api/applications/:id/withdraw', (ctx) => {
    const user = need.user(ctx);
    const now = Date.now();
    tx(db, () => {
      const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(ctx.params.id);
      if (!a || a.user_id !== user.id) throw fail.notFound('Заявка не найдена.');
      if (a.status !== 'pending') throw fail.conflict('Заявку уже рассмотрели — отозвать нельзя.');
      db.prepare("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now, a.id);
      addHistory.run(a.id, 'withdrawn', now, null);
    });
    return { application: view(db.prepare('SELECT * FROM applications WHERE id = ?').get(ctx.params.id)) };
  });

  router.add('GET', '/api/applications', (ctx) => {
    need.admin(ctx);
    const status = ctx.query.get('status') || 'pending';
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    const counts = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status').all()) counts[r.status] = r.n;
    const where = [];
    const args = [];
    if (status !== 'all' && STATUSES.includes(status)) {
      where.push('status = ?');
      args.push(status);
    }
    if (q) {
      where.push("(lower(nickname) LIKE ? ESCAPE '\\' OR lower(about) LIKE ? ESCAPE '\\')");
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      args.push(like, like);
    }
    const order = status === 'pending' ? 'created_at ASC' : 'updated_at DESC';
    const rows = db.prepare(`SELECT * FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`).all(...args);
    return { items: rows.map(view), counts };
  });

  router.add('GET', '/api/applications/:id', (ctx) => {
    const user = need.user(ctx);
    const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(ctx.params.id);
    if (!a || (user.role !== 'admin' && a.user_id !== user.id)) throw fail.notFound('Заявка не найдена.');
    return { application: view(a) };
  });

  router.add('POST', '/api/applications/:id/review', (ctx) => {
    const admin = need.admin(ctx);
    const status = ctx.body.status;
    const comment = str(ctx.body.comment).trim();
    const f = {};
    if (!['approved', 'rejected'].includes(status)) f.status = 'Выберите решение.';
    if (status === 'rejected' && comment.length < LIMITS.reviewComment.min) f.comment = 'Напишите причину отказа — игрок её увидит.';
    if (comment.length > LIMITS.reviewComment.max) f.comment = `Максимум ${LIMITS.reviewComment.max} символов.`;
    if (Object.keys(f).length) throw fail.validation(f);
    const now = Date.now();
    tx(db, () => {
      const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(ctx.params.id);
      if (!a) throw fail.notFound('Заявка не найдена.');
      if (a.status !== 'pending') throw fail.conflict('Эту заявку уже рассмотрели или отозвали.');
      db.prepare('UPDATE applications SET status = ?, comment = ?, reviewer_id = ?, updated_at = ? WHERE id = ?').run(status, comment, admin.id, now, a.id);
      addHistory.run(a.id, status, now, admin.id);
      // Одобрили — открываем вкладку «Сервер». Админа не понижаем.
      if (status === 'approved') db.prepare("UPDATE users SET role = 'player' WHERE id = ? AND role = 'user'").run(a.user_id);
    });
    return { application: view(db.prepare('SELECT * FROM applications WHERE id = ?').get(ctx.params.id)) };
  });
}
