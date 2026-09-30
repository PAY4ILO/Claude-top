/**
 * Права админов. «Создатель» — владелец из LWL_ADMINS: может всё, его нельзя понизить или удалить,
 * и только он раздаёт права остальным админам (кабинет → «Люди» → админ → «Права»).
 * Список и подписи отдаются в браузер с сервера (permissionCatalog) — дублировать в api.js не нужно.
 */
export const PERMISSIONS = [
  { key: 'applications', title: 'Заявки', text: 'Читать анкеты, одобрять и отклонять' },
  { key: 'tickets', title: 'Обращения', text: 'Читать обращения и отвечать игрокам' },
  { key: 'users', title: 'Люди', text: 'Роли «Пользователь» и «Игрок», ссылки для сброса пароля' },
  { key: 'server', title: 'Сервер', text: 'Адрес, подсказки, ссылки и сборки' },
  { key: 'delete', title: 'Удаление', text: 'Удалять заявки, обращения и аккаунты' },
  { key: 'admins', title: 'Админы', text: 'Назначать и снимать других админов' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** Права нового админа (и тех, кому их ещё не настраивали). */
export const DEFAULT_ADMIN_PERMISSIONS = ['applications', 'tickets', 'users', 'server'];

/** Из колонки users.admin_perms (JSON-список; NULL — права по умолчанию). */
export function parsePermissions(json) {
  if (json === null || json === undefined) return DEFAULT_ADMIN_PERMISSIONS.slice();
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? PERMISSION_KEYS.filter((k) => list.includes(k)) : DEFAULT_ADMIN_PERMISSIONS.slice();
  } catch {
    return DEFAULT_ADMIN_PERMISSIONS.slice();
  }
}
