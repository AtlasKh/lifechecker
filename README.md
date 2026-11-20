# ✨ Мой год — календарь жизни

Telegram Mini App: каждый вечер 5 быстрых вопросов → день окрашивается от красного к зелёному → год складывается в картину. Бот присылает итоги недели, месяца и года.

```
lifechecker/
├── docs/index.html                     ← само приложение (GitHub Pages)
└── supabase/
    ├── schema.sql                      ← таблицы базы
    ├── cron.sql                        ← ежечасный запуск отчётов
    └── functions/lifecal/index.ts      ← бэкенд + бот (Edge Function)
```

**Всё бесплатно:** GitHub Pages (приложение) + Supabase (база, сервер, расписание).

---

## Что нужно сделать — 6 шагов

### Шаг 1. Бот
В Telegram: **@BotFather** → `/newbot` → имя и username → сохрани **токен** (`123456:ABC...`).
Никому его не показывай и не клади в GitHub.

### Шаг 2. Приложение на GitHub Pages
1. Залей в репозиторий `lifechecker` папки `docs`, `supabase` и `README.md`
   (на пустой странице репо → **uploading an existing file** → перетащи → **Commit changes**).
2. **Settings → Pages → Deploy from a branch → `main` / `/docs` → Save**.
3. Через 1–2 минуты: **https://atlaskh.github.io/lifechecker/** — открой, проверь.

### Шаг 3. База в Supabase
1. Создай новый проект (**New project**), регион — Frankfurt (ближе всего).
2. Запомни **REF** проекта — это кусок адреса: `supabase.com/dashboard/project/`**`abcdxyz...`**
3. **SQL Editor** → вставь весь `supabase/schema.sql` → **Run**.

### Шаг 4. Сервер (Edge Function)
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Имя функции строго: **`lifecal`**.
3. Удали пример кода, вставь весь `supabase/functions/lifecal/index.ts` → **Deploy**.
4. Открой функцию → **Details / Settings** → **выключи «Enforce JWT verification»** → сохрани.
   ⚠️ Без этого Telegram не сможет достучаться до бота.
5. **Edge Functions → Secrets** → добавь:

   | Имя | Значение |
   |---|---|
   | `BOT_TOKEN` | токен из шага 1 |
   | `WEBHOOK_SECRET` | придумай длинную строку из букв и цифр, например `k8Fq2mZx91LpQw` |
   | `WEBAPP_URL` | `https://atlaskh.github.io/lifechecker/` |
   | `REPORT_HOUR` | `20` — во сколько приходят отчёты (по времени пользователя) |
   | `DAILY_REMINDER` | `1` — вечернее напоминание, если день не отмечен (`0` — без него) |

### Шаг 5. Связать всё
1. **Включить синхронизацию в приложении.** В GitHub открой `docs/index.html` → карандаш (Edit) → найди строку
   `const API_URL = '';` и впиши:
   `const API_URL = 'https://ТВОЙ_REF.supabase.co/functions/v1/lifecal';` → **Commit changes**.
2. **Подключить бота.** Открой в браузере:
   `https://ТВОЙ_REF.supabase.co/functions/v1/lifecal/setup?key=ТВОЙ_WEBHOOK_SECRET`
   Должен прийти текст, где везде `"ok":true`.
3. **Включить отчёты.** Открой `supabase/cron.sql`, замени `ТВОЙ_REF` и `ТВОЙ_WEBHOOK_SECRET` →
   вставь в **SQL Editor** → **Run**.
4. (Опционально) @BotFather → `/newapp` → твой бот → URL `https://atlaskh.github.io/lifechecker/` —
   появится красивая ссылка `t.me/твой_бот/app`.

### Шаг 6. Проверить
Напиши боту `/start` → **«✦ Открыть мой год»** → ответь на 5 вопросов → напиши `/week`.

---

## Если что-то не работает
- **Бот молчит** → открой ссылку `/setup` ещё раз и проверь, что `"ok":true`; проверь, что JWT-проверка выключена; логи — **Edge Functions → lifecal → Logs**.
- **В приложении данные не сохраняются на сервер** → проверь `API_URL` (без `/` в конце). Открывать нужно именно из Telegram — в обычном браузере данные хранятся только локально, это нормально.
- **Не приходят отчёты** → в SQL Editor: `select * from cron.job_run_details order by start_time desc limit 5;`
- **Проект «уснул»** → бесплатный Supabase ставит паузу после недели без активности. Нажми **Restore** в панели — данные на месте.

## Как это работает
- **Опросник:** «Нет / Отчасти / Да» = 0 / 0.5 / 1, можно тапать или свайпать карточку. Оценка дня — среднее, цвет — градиент 🟥 → 🟧 → 🟩.
- **Календарь:** неделя (с точками по вопросам), месяц, год. Тап по дню — детали и редактирование, можно дозаполнить прошлые дни.
- **Статистика:** средний балл, динамика, средние по вопросам, лучший день, лучшая серия.
- **Бот:** итоги недели (вс), месяца (последний день), года (31 дек) + напоминание. Команды: `/today`, `/week`, `/month`, `/year`, `/stop`, `/resume`.
- **Данные:** сначала сохраняются на устройстве, затем на сервер. Сервер проверяет подпись Telegram, таблицы закрыты RLS — чужие данные прочитать или подделать нельзя.

## Как менять
- **Вопросы:** массив `QUESTIONS` в `docs/index.html` **и** в `index.ts` (id должны совпадать), после правки функции — снова Deploy.
- **Цвета:** переменные в `:root` в начале `<style>` и массив `STOPS`.

## Путь к отдельному приложению
Фронтенд — обычная веб-страница; от Telegram зависят только вход и вибрация.
1. **PWA** (manifest + service worker) — установка на телефон с сайта.
2. **Capacitor** — та же страница как iOS/Android-приложение.
3. **Вход вне Telegram** — Supabase Auth (email, Google, Apple) уже есть в твоём проекте; API и база останутся.
