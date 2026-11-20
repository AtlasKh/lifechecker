// @ts-nocheck
/**
 * «Мой год» — бэкенд на Supabase Edge Functions (имя функции: lifecal)
 *
 *  POST .../lifecal/bot                 — вебхук Telegram-бота
 *  GET  .../lifecal/api/entries?from&to — дни пользователя (подпись Telegram в X-Telegram-Init-Data)
 *  PUT  .../lifecal/api/entries/:date   — сохранить день
 *  POST .../lifecal/cron                — ежечасный запуск (pg_cron), заголовок X-Cron-Key
 *  GET  .../lifecal/setup?key=SECRET    — один раз: вебхук, команды, кнопка меню
 *
 *  Secrets (Edge Functions → Secrets):
 *    BOT_TOKEN, WEBHOOK_SECRET, WEBAPP_URL, REPORT_HOUR (по умолчанию 20), DAILY_REMINDER ("1"/"0")
 *  SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
 *  ВАЖНО: в настройках функции выключи «Enforce JWT verification».
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const env = (k, d = '') => Deno.env.get(k) ?? d;
const BOT_TOKEN = env('BOT_TOKEN');
const WEBHOOK_SECRET = env('WEBHOOK_SECRET');
const WEBAPP_URL = env('WEBAPP_URL');
const REPORT_HOUR = Number(env('REPORT_HOUR', '20'));
const DAILY_REMINDER = env('DAILY_REMINDER', '1') === '1';
const SUPABASE_URL = env('SUPABASE_URL');
const db = createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

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

/* ---------------- маршрутизация ---------------- */
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/lifecal(?=\/|$)/, '') || '/';
  if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  try {
    if (path === '/bot' && req.method === 'POST') return await handleBot(req);
    if (path.startsWith('/api/')) return cors(await handleApi(req, url, path));
    if (path === '/cron') {
      if (req.headers.get('X-Cron-Key') !== WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      return json(await runSchedule());
    }
    if (path === '/setup') return await setup(url);
    return new Response('Мой год · бэкенд работает ✨', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } catch (e) {
    console.error(e);
    return cors(json({ error: String(e?.message || e) }, 500));
  }
});

/* ---------------- утилиты ---------------- */
const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Telegram-Init-Data,apikey,x-client-info');
  return new Response(res.body, { status: res.status, headers: h });
}
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = (s) => Math.round(s * 100);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

// даты: Date в UTC используем как «локальную» дату пользователя
const keyOf = (d) => d.toISOString().slice(0, 10);
const fromKey = (k) => new Date(k + 'T00:00:00Z');
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const wdIdx = (d) => (d.getUTCDay() + 6) % 7;
const localNow = (tz) => new Date(Date.now() + tz * 60000);
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

/* ---------------- проверка подписи Telegram ---------------- */
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function verifyInitData(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------------- API для мини-приложения ---------------- */
async function handleApi(req, url, path) {
  const initData = req.headers.get('X-Telegram-Init-Data') || '';
  const user = initData && await verifyInitData(initData);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET' && path === '/api/entries') {
    const from = url.searchParams.get('from') || '2000-01-01';
    const to = url.searchParams.get('to') || '2100-01-01';
    const rows = must(await db.from('entries').select('date, answers, score, updated_at')
      .eq('user_id', user.id).gte('date', from).lte('date', to).order('date'));
    return json({ entries: rows.map((r) => ({ ...r, updated_at: Number(r.updated_at) })) });
  }

  const m = path.match(/^\/api\/entries\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'PUT' && m) {
    const date = m[1];
    if (fromKey(date) > addDays(new Date(), 1)) return json({ error: 'future date' }, 400);
    const body = await req.json();
    const answers = {};
    for (const q of QUESTIONS) {
      const v = body?.answers?.[q.id];
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
    must(await db.from('users').upsert({ id: user.id, first_name: user.first_name || '', tz_offset: tz }, { onConflict: 'id' }));
    must(await db.from('entries').upsert({ user_id: user.id, date, answers, score, updated_at: now }, { onConflict: 'user_id,date' }));
    return json({ ok: true, score, updated_at: now });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------------- Telegram ---------------- */
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}
const appButton = (text, quiz = false) => ({
  inline_keyboard: [[{ text, web_app: { url: WEBAPP_URL + (quiz ? '?startapp=quiz' : '') } }]],
});
async function send(chatId, text, markup) {
  const res = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } });
  if (!res.ok && res.error_code === 403) await db.from('users').update({ notify: false }).eq('id', chatId); // бот заблокирован
  return res;
}

async function handleBot(req) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const upd = await req.json();
  const msg = upd.message;
  if (!msg?.text || msg.chat.type !== 'private') return new Response('ok');
  const chatId = msg.chat.id;
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  try {
    if (cmd === '/start' || cmd === '/resume') {
      must(await db.from('users').upsert({ id: chatId, first_name: msg.from.first_name || '', notify: true }, { onConflict: 'id' }));
      const name = escHtml(msg.from.first_name || 'друг');
      await send(chatId,
        cmd === '/start'
          ? `✨ <b>Привет, ${name}!</b>\n\nЭто <b>«Мой ${new Date().getUTCFullYear()}»</b> — календарь твоей жизни.\n\nКаждый вечер — 5 коротких вопросов, 10 секунд. Каждый день окрашивается от 🟥 к 🟩, и год складывается в живую картину.\n\nРаз в неделю, месяц и год я пришлю тебе итоги.`
          : '🔔 Отчёты снова включены.',
        appButton('✦ Открыть мой год'));
    } else if (cmd === '/stop') {
      await db.from('users').update({ notify: false }).eq('id', chatId);
      await send(chatId, '🔕 Отчёты и напоминания выключены. Включить снова — /resume');
    } else if (cmd === '/today') {
      await send(chatId, '🌙 Как прошёл день?', appButton('✦ Отметить день', true));
    } else if (cmd === '/week' || cmd === '/month' || cmd === '/year') {
      const u = must(await db.from('users').select('tz_offset').eq('id', chatId).maybeSingle());
      const ref = fromKey(keyOf(localNow(u ? u.tz_offset : 120)));
      await send(chatId, await buildReport(chatId, cmd.slice(1), ref, true), appButton('📊 Подробнее в приложении'));
    } else {
      await send(chatId, 'Открой приложение кнопкой ниже 👇\n\n/today — отметить день\n/week /month /year — итоги\n/stop — выключить уведомления', appButton('✦ Мой год'));
    }
  } catch (e) {
    console.error('bot', e);
  }
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
const bar = (v) => { const n = Math.round(v * 10); return '▰'.repeat(n) + '▱'.repeat(10 - n); };

async function loadRange(userId, start, end) {
  const rows = must(await db.from('entries').select('date, answers, score')
    .eq('user_id', userId).gte('date', keyOf(start)).lte('date', keyOf(end)));
  const map = {};
  for (const r of rows) map[r.date] = { a: r.answers, s: r.score };
  return map;
}

async function buildReport(userId, kind, ref, partial = false) {
  const [start, end] = rangeOf(kind, ref);
  const map = await loadRange(userId, start, end);
  const lastDay = partial && ref < end ? ref : end;
  const days = [];
  for (let d = start; d <= lastDay; d = addDays(d, 1)) days.push(d);
  const ents = days.map((d) => map[keyOf(d)]).filter(Boolean);
  const avg = ents.length ? mean(ents.map((e) => e.s)) : null;

  const [ps, pe] = rangeOf(kind, prevRef(kind, ref));
  const pvals = Object.values(await loadRange(userId, ps, pe)).map((e) => e.s);
  const pavg = pvals.length ? mean(pvals) : null;

  const title = kind === 'week'
    ? `🗓 <b>Итоги недели</b> · ${start.getUTCDate()} ${MONTHS_GEN[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS_GEN[end.getUTCMonth()]}`
    : kind === 'month' ? `🌕 <b>Итоги месяца</b> · ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`
    : `🏆 <b>Итоги года</b> · ${start.getUTCFullYear()}`;
  const lines = [title, ''];

  if (kind === 'week') {
    lines.push(days.map((d) => square(map[keyOf(d)]?.s ?? null)).join(''), '<i>пн → вс</i>', '');
  } else if (kind === 'month') {
    let row = '▫️'.repeat(wdIdx(start));
    for (const d of days) {
      row += square(map[keyOf(d)]?.s ?? null);
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

  const perQ = QUESTIONS.map((q) => {
    const v = ents.map((e) => e.a[q.id]).filter((x) => typeof x === 'number');
    return { q, a: v.length ? mean(v) : null };
  }).filter((x) => x.a != null);
  for (const { q, a } of perQ) lines.push(`${q.emoji} ${q.short}  ${bar(a)} ${pct(a)}%`);
  if (perQ.length > 1) {
    const sorted = [...perQ].sort((x, y) => x.a - y.a);
    lines.push('', `💪 Сильная сторона: <b>${sorted[sorted.length - 1].q.short}</b>`, `🎯 Точка роста: <b>${sorted[0].q.short}</b>`);
  }
  return lines.join('\n');
}

/* ---------------- расписание (вызывается pg_cron раз в час) ---------------- */
async function once(userId, kind, period) {
  const rows = must(await db.from('sent')
    .upsert({ user_id: userId, kind, period }, { onConflict: 'user_id,kind,period', ignoreDuplicates: true })
    .select());
  return rows.length > 0;
}

async function runSchedule() {
  const users = must(await db.from('users').select('id, tz_offset').eq('notify', true));
  let sentCount = 0;
  for (const u of users) {
    try {
      const ln = localNow(u.tz_offset);
      if (ln.getUTCHours() !== REPORT_HOUR) continue;
      const todayKey = keyOf(ln);
      const ref = fromKey(todayKey);
      const tomorrow = addDays(ref, 1);

      if (DAILY_REMINDER) {
        const has = must(await db.from('entries').select('date').eq('user_id', u.id).eq('date', todayKey).maybeSingle());
        if (!has && await once(u.id, 'remind', todayKey)) {
          await send(u.id, '🌙 <b>Как прошёл день?</b>\nОтметь его — 5 вопросов, 10 секунд.', appButton('✦ Отметить день', true)); sentCount++;
        }
      }
      if (wdIdx(ref) === 6 && await once(u.id, 'week', todayKey)) {
        await send(u.id, await buildReport(u.id, 'week', ref), appButton('📊 Открыть статистику')); sentCount++;
      }
      if (tomorrow.getUTCDate() === 1 && await once(u.id, 'month', todayKey.slice(0, 7))) {
        await send(u.id, await buildReport(u.id, 'month', ref), appButton('📊 Открыть статистику')); sentCount++;
      }
      if (ref.getUTCMonth() === 11 && ref.getUTCDate() === 31 && await once(u.id, 'year', todayKey.slice(0, 4))) {
        await send(u.id, await buildReport(u.id, 'year', ref), appButton('🏆 Мой год целиком')); sentCount++;
      }
    } catch (e) {
      console.error('user', u.id, e);
    }
  }
  return { ok: true, users: users.length, sent: sentCount };
}

/* ---------------- разовая настройка бота ---------------- */
async function setup(url) {
  if (url.searchParams.get('key') !== WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const out = {};
  out.webhook = await tg('setWebhook', {
    url: `${SUPABASE_URL}/functions/v1/lifecal/bot`,
    secret_token: WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true,
  });
  out.commands = await tg('setMyCommands', {
    commands: [
      { command: 'today', description: 'Отметить сегодняшний день' },
      { command: 'week', description: 'Итоги недели' },
      { command: 'month', description: 'Итоги месяца' },
      { command: 'year', description: 'Итоги года' },
      { command: 'stop', description: 'Выключить уведомления' },
      { command: 'resume', description: 'Включить уведомления' },
    ],
  });
  out.menu = await tg('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Мой год', web_app: { url: WEBAPP_URL } },
  });
  return json(out);
}
