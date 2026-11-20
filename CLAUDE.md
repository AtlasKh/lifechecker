# Мой год (lifechecker) — заметки для Claude

Telegram Mini App «календарь жизни»: ежедневный опросник из 5 вопросов, день окрашивается от красного к зелёному, статистика за неделю/месяц/год, бот присылает итоги. Владелец пишет по-русски, отвечай по-русски.

## Устройство
- `docs/index.html` — всё приложение в одном файле (HTML+CSS+JS, без сборки). Хостинг: GitHub Pages (main, /docs) → https://atlaskh.github.io/lifechecker/
- `supabase/functions/lifecal/index.ts` — бэкенд и бот (Supabase Edge Function `lifecal`, Deno). При push в main автоматически деплоится workflow `.github/workflows/deploy-function.yml` (нужен секрет репозитория `SUPABASE_ACCESS_TOKEN`).
- `supabase/schema.sql` — таблицы `users`, `entries`, `sent` (RLS включён без политик; доступ только через service role в функции). Изменения схемы применять вручную через SQL Editor — давать владельцу готовый SQL.
- `supabase/cron.sql` — pg_cron раз в час дёргает `/lifecal/cron` (заголовок X-Cron-Key = WEBHOOK_SECRET).
- Supabase project ref: `wkjszhpgdvdjfnqfbxqy`. API: https://wkjszhpgdvdjfnqfbxqy.supabase.co/functions/v1/lifecal
- Секреты функции (в Supabase): BOT_TOKEN, WEBHOOK_SECRET, WEBAPP_URL, REPORT_HOUR, DAILY_REMINDER. Никогда не коммитить их значения.

## Правила
- Вопросы заданы массивом `QUESTIONS` в двух местах: `docs/index.html` и `index.ts` — id должны совпадать.
- Ответы: 0 / 0.5 / 1, оценка дня = среднее. Данные клиента: localStorage `lifecal.v1` + синк через API (заголовок `X-Telegram-Init-Data`, проверка подписи на сервере).
- Дизайн: тёмный, янтарно-неоновый (Unbounded + Manrope), «богато и со вкусом». Сохранять стиль при любых изменениях.
- Перед коммитом: проверить фронт в headless Chrome (скриншоты, отсутствие ошибок JS), бэкенд — синтаксис/логика.
- Коммитить прямо в main (проект личный, деплой идёт с main), понятными сообщениями на русском.
