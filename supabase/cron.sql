-- «Мой год»: ежечасный запуск отчётов и напоминаний.
-- Перед запуском замени ДВЕ вещи:
--   ТВОЙ_REF          → ref проекта (из адреса supabase.com/dashboard/project/ТВОЙ_REF)
--   ТВОЙ_WEBHOOK_SECRET → тот же секрет, что в Edge Functions → Secrets
-- Потом вставь в SQL Editor → Run.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

select cron.schedule(
  'lifecal-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://ТВОЙ_REF.supabase.co/functions/v1/lifecal/cron',
    headers := '{"Content-Type":"application/json","X-Cron-Key":"ТВОЙ_WEBHOOK_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Проверить задачу:   select * from cron.job;
-- Удалить задачу:     select cron.unschedule('lifecal-hourly');
