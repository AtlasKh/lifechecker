/**
 * «Мой год» — бэкенд на Cloudflare Workers + D1
 *
 *  POST /bot                  — вебхук Telegram-бота
 *  GET  /api/entries?from&to  — дни пользователя (авторизация через Telegram initData)
 *  PUT  /api/entries/:date    — сохранить день
 *  GET  /setup?key=SECRET     — один раз: подключить вебхук, команды и кнопку меню
 *  cron (каждый час)          — напоминания и отчёты за неделю / месяц / год
 *
 *  Переменные (Settings → Variables):
 *    BOT_TOKEN       (secret)  токен от @BotFather
 *    WEBHOOK_SECRET  (secret)  любая длинная случайная строка
 *    WEBAPP_URL                https://<ник>.github.io/<репо>/
 *    REPORT_HOUR               час отправки по времени пользователя, по умолчанию 20
 *    DAILY_REMINDER            "1" — напоминать, если день не отмечен
 *  Привязка D1: DB
 */

const QUESTIONS = [
  { id: 'food',  emoji: '🍲', short: 'Еда' },
  { id: 'sleep', emoji: '🌙', short: 'Сон' },
  { id: 'sport', emoji: '⚡', short: 'Спорт' },
  { id: 'happy', emoji: '☀️', short: 'Счастье' },
  { id: 'dream', emoji: '🚀', short: 'Мечта' },
];
const ALLOWED = new Set([0, 0.5, 1]);
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_SH = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/bot' && req.method === 'POST') return await handleBot(req, env, ctx);
      if (url.pathname.startsWith('/api/')) return cors(await handleApi(req, env, url));
      if (url.pathname === '/setup') return await setup(env, url);
      return new Response('Мой год · бэкенд работает ✨', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      return cors(json({ error: String(e && e.message || e) }, 500));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
};

/* ---------------- утилиты ---------------- */
const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}
const escHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = s => Math.round(s * 100);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// даты: работаем с Date в UTC как с «локальными» датами пользователя
const keyOf = d => d.toISOString().slice(0, 10);
const fromKey = k => new Date(k + 'T00:00:00Z');
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const wdIdx = d => (d.getUTCDay() + 6) % 7;
const localNow = tz => new Date(Date.now() + tz * 60000);
function rangeOf(kind, ref) {
  const y = ref.getUTCFullYear(), m = ref.getUTCMonth();
  if (kind === 'week') { const s = addDays(ref, -wdIdx(ref)); return [s, addDays(s, 6)]; }
  if (kind === 'month') return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 0))];
  return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))];
}
function prevRef(kind, ref) {
  if (kind === 'week') return addDays(ref, -7);
  if (kind === 'month') return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  return new Date(Date.UTC(ref.getUTCFullYear() - 1, 0, 1));
}

/* ---------------- проверка Telegram initData ---------------- */
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
async function verifyInitData(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), token);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const authDate = Number(p.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 7 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------------- API для мини-приложения ---------------- */
async function handleApi(req, env, url) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('tma ')) return json({ error: 'unauthorized' }, 401);
  const user = await verifyInitData(auth.slice(4), env.BOT_TOKEN);
  if (!user) return json({ error: 'bad initData' }, 401);

  if (req.method === 'GET' && url.pathname === '/api/entries') {
    const from = url.searchParams.get('from') || '2000-01-01';
    const to = url.searchParams.get('to') || '2100-01-01';
    const { results } = await env.DB.prepare(
      'SELECT date, answers, score, updated_at FROM entries WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date'
    ).bind(user.id, from, to).all();
    return json({ entries: results.map(r => ({ ...r, answers: JSON.parse(r.answers) })) });
  }

  const m = url.pathname.match(/^\/api\/entries\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'PUT' && m) {
    const date = m[1];
    if (fromKey(date) > addDays(new Date(), 1)) return json({ error: 'future date' }, 400);
    const body = await req.json();
    const answers = {};
    for (const q of QUESTIONS) {
      const v = body.answers && body.answers[q.id];
      if (v !== undefined && v !== null) {
        if (!ALLOWED.has(v)) return json({ error: 'bad answer ' + q.id }, 400);
        answers[q.id] = v;
      }
    }
    const vals = Object.values(answers);
    if (!vals.length) return json({ error: 'empty' }, 400);
    const score = mean(vals);
    const tz = Number.isFinite(body.tz) ? Math.max(-720, Math.min(840, Math.round(body.tz))) : 120;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, first_name, tz_offset, notify, created_at) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, tz_offset=excluded.tz_offset`)
        .bind(user.id, user.first_name || '', tz, now),
      env.DB.prepare(`INSERT INTO entries (user_id, date, answers, score, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET answers=excluded.answers, score=excluded.score, updated_at=excluded.updated_at`)
        .bind(user.id, date, JSON.stringify(answers), score, now),
    ]);
    return json({ ok: true, score, updated_at: now });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------------- Telegram ---------------- */
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}
const appButton = (env, text, quiz) => ({
  inline_keyboard: [[{ text, web_app: { url: env.WEBAPP_URL + (quiz ? '?startapp=quiz' : '') } }]],
});
async function send(env, chatId, text, markup) {
  const res = await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } });
  if (!res.ok && res.error_code === 403) {
    await env.DB.prepare('UPDATE users SET notify=0 WHERE id=?').bind(chatId).run(); // пользователь заблокировал бота
  }
  return res;
}

async function handleBot(req, env, ctx) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const upd = await req.json();
  const msg = upd.message;
  if (!msg || !msg.text || msg.chat.type !== 'private') return new Response('ok');
  const chatId = msg.chat.id;
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const now = Date.now();

  const work = (async () => {
    if (cmd === '/start' || cmd === '/resume') {
      await env.DB.prepare(`INSERT INTO users (id, first_name, tz_offset, notify, created_at) VALUES (?, ?, 120, 1, ?)
        ON CONFLICT(id) DO UPDATE SET notify=1, first_name=excluded.first_name`).bind(chatId, msg.from.first_name || '', now).run();
      const name = escHtml(msg.from.first_name || 'друг');
      await send(env, chatId,
        cmd === '/start'
          ? `✨ <b>Привет, ${name}!</b>\n\nЭто <b>«Мой ${new Date().getUTCFullYear()}»</b> — календарь твоей жизни.\n\nКаждый вечер — 5 коротких вопросов, 10 секунд. Каждый день окрашивается от 🟥 к 🟩, и год складывается в живую картину.\n\nРаз в неделю, месяц и год я пришлю тебе итоги.`
          : '🔔 Отчёты снова включены.',
        appButton(env, '✦ Открыть мой год'));
    } else if (cmd === '/stop') {
      await env.DB.prepare('UPDATE users SET notify=0 WHERE id=?').bind(chatId).run();
      await send(env, chatId, '🔕 Отчёты и напоминания выключены. Включить снова — /resume');
    } else if (cmd === '/today') {
      await send(env, chatId, '🌙 Как прошёл день?', appButton(env, '✦ Отметить день', true));
    } else if (cmd === '/week' || cmd === '/month' || cmd === '/year') {
      const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(chatId).first();
      const tz = user ? user.tz_offset : 120;
      const ln = localNow(tz);
      const ref = fromKey(keyOf(ln));
      const text = await buildReport(env, chatId, cmd.slice(1), ref, true);
      await send(env, chatId, text, appButton(env, '📊 Подробнее в приложении'));
    } else {
      await send(env, chatId, 'Открой приложение кнопкой ниже 👇\n\n/today — отметить день\n/week /month /year — итоги\n/stop — выключить уведомления', appButton(env, '✦ Мой год'));
    }
  })();
  ctx.waitUntil(work);
  return new Response('ok');
}

/* ---------------- отчёты ---------------- */
function square(s) {
  if (s == null) return '⬛';
  if (s < 0.3) return '🟥';
  if (s < 0.5) return '🟧';
  if (s < 0.75) return '🟨';
  return '🟩';
}
const bar = v => { const n = Math.round(v * 10); return '▰'.repeat(n) + '▱'.repeat(10 - n); };

async function loadRange(env, userId, start, end) {
  const { results } = await env.DB.prepare('SELECT date, answers, score FROM entries WHERE user_id=? AND date BETWEEN ? AND ?')
    .bind(userId, keyOf(start), keyOf(end)).all();
  const map = {};
  for (const r of results) map[r.date] = { a: JSON.parse(r.answers), s: r.score };
  return map;
}

async function buildReport(env, userId, kind, ref, partial = false) {
  const [start, end] = rangeOf(kind, ref);
  const map = await loadRange(env, userId, start, end);
  const lastDay = partial && ref < end ? ref : end;
  const days = [];
  for (let d = start; d <= lastDay; d = addDays(d, 1)) days.push(d);
  const ents = days.map(d => map[keyOf(d)]).filter(Boolean);
  const avg = ents.length ? mean(ents.map(e => e.s)) : null;

  // прошлый период для сравнения
  const [ps, pe] = rangeOf(kind, prevRef(kind, ref));
  const pmap = await loadRange(env, userId, ps, pe);
  const pvals = Object.values(pmap).map(e => e.s);
  const pavg = pvals.length ? mean(pvals) : null;

  const title = kind === 'week'
    ? `🗓 <b>Итоги недели</b> · ${start.getUTCDate()} ${MONTHS_GEN[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS_GEN[end.getUTCMonth()]}`
    : kind === 'month' ? `🌕 <b>Итоги месяца</b> · ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`
    : `🏆 <b>Итоги года</b> · ${start.getUTCFullYear()}`;

  const lines = [title, ''];

  if (kind === 'week') {
    lines.push(days.map(d => square(map[keyOf(d)] ? map[keyOf(d)].s : null)).join(''));
    lines.push('<i>пн → вс</i>', '');
  } else if (kind === 'month') {
    let row = '▫️'.repeat(wdIdx(start));
    for (const d of days) {
      row += square(map[keyOf(d)] ? map[keyOf(d)].s : null);
      if (wdIdx(d) === 6) { lines.push(row); row = ''; }
    }
    if (row) lines.push(row);
    lines.push('');
  } else {
    for (let m = 0; m < 12; m++) {
      const mv = Object.entries(map).filter(([k]) => Number(k.slice(5, 7)) === m + 1).map(([, e]) => e.s);
      if (!mv.length) continue;
      const a = mean(mv);
      lines.push(`<code>${MONTHS_SH[m]}</code> ${square(a)} ${bar(a)} ${pct(a)}%`);
    }
    lines.push('');
  }

  if (avg == null) {
    lines.push('Ни одного отмеченного дня за этот период.', 'Начни сегодня — это 10 секунд ✨');
    return lines.join('\n');
  }

  let cmp = '';
  if (pavg != null) {
    const diff = pct(avg) - pct(pavg);
    cmp = diff > 0 ? ` · ↗️ +${diff}%` : diff < 0 ? ` · ↘️ ${diff}%` : ' · без изменений';
  }
  lines.push(`${square(avg)} Средний день: <b>${pct(avg)}%</b>${cmp}`);
  lines.push(`📌 Отмечено: <b>${ents.length}</b> из ${days.length} дней`, '');

  for (const q of QUESTIONS) {
    const v = ents.map(e => e.a[q.id]).filter(x => typeof x === 'number');
    if (!v.length) continue;
    const a = mean(v);
    lines.push(`${q.emoji} ${q.short}  ${bar(a)} ${pct(a)}%`);
  }

  const bestQ = QUESTIONS.map(q => {
    const v = ents.map(e => e.a[q.id]).filter(x => typeof x === 'number');
    return { q, a: v.length ? mean(v) : null };
  }).filter(x => x.a != null).sort((x, y) => x.a - y.a);
  if (bestQ.length > 1) {
    lines.push('', `💪 Сильная сторона: <b>${bestQ[bestQ.length - 1].q.short}</b>`, `🎯 Точка роста: <b>${bestQ[0].q.short}</b>`);
  }
  return lines.join('\n');
}

/* ---------------- расписание ---------------- */
async function once(env, userId, kind, period) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent (user_id, kind, period) VALUES (?, ?, ?)').bind(userId, kind, period).run();
  return r.meta.changes === 1;
}

async function runSchedule(env) {
  const hour = Number(env.REPORT_HOUR || 20);
  const { results: users } = await env.DB.prepare('SELECT * FROM users WHERE notify=1').all();
  for (const u of users) {
    try {
      const ln = localNow(u.tz_offset);
      if (ln.getUTCHours() !== hour) continue;
      const todayKey = keyOf(ln);
      const ref = fromKey(todayKey);
      const tomorrow = addDays(ref, 1);

      if (env.DAILY_REMINDER === '1') {
        const has = await env.DB.prepare('SELECT 1 FROM entries WHERE user_id=? AND date=?').bind(u.id, todayKey).first();
        if (!has && await once(env, u.id, 'remind', todayKey)) {
          await send(env, u.id, '🌙 <b>Как прошёл день?</b>\nОтметь его — 5 вопросов, 10 секунд.', appButton(env, '✦ Отметить день', true));
        }
      }
      if (wdIdx(ref) === 6 && await once(env, u.id, 'week', todayKey)) {
        await send(env, u.id, await buildReport(env, u.id, 'week', ref), appButton(env, '📊 Открыть статистику'));
      }
      if (tomorrow.getUTCDate() === 1 && await once(env, u.id, 'month', todayKey.slice(0, 7))) {
        await send(env, u.id, await buildReport(env, u.id, 'month', ref), appButton(env, '📊 Открыть статистику'));
      }
      if (ref.getUTCMonth() === 11 && ref.getUTCDate() === 31 && await once(env, u.id, 'year', todayKey.slice(0, 4))) {
        await send(env, u.id, await buildReport(env, u.id, 'year', ref), appButton(env, '🏆 Мой год целиком'));
      }
    } catch (e) {
      console.log('user', u.id, e);
    }
  }
}

/* ---------------- разовая настройка бота ---------------- */
async function setup(env, url) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const out = {};
  out.webhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/bot`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true,
  });
  out.commands = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'today', description: 'Отметить сегодняшний день' },
      { command: 'week', description: 'Итоги недели' },
      { command: 'month', description: 'Итоги месяца' },
      { command: 'year', description: 'Итоги года' },
      { command: 'stop', description: 'Выключить уведомления' },
      { command: 'resume', description: 'Включить уведомления' },
    ],
  });
  out.menu = await tg(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Мой год', web_app: { url: env.WEBAPP_URL } },
  });
  return json(out);
}
