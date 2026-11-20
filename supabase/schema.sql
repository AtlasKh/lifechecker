-- «Мой год»: таблицы. Вставь в Supabase → SQL Editor → Run.

create table if not exists public.users (
  id          bigint primary key,                 -- Telegram user id (= chat id в личке)
  first_name  text,
  tz_offset   int not null default 120,           -- смещение от UTC в минутах (Киев зимой = 120)
  notify      boolean not null default false,     -- присылать отчёты (включается командой /start)
  created_at  timestamptz not null default now()
);

create table if not exists public.entries (
  user_id     bigint not null references public.users(id) on delete cascade,
  date        date   not null,                    -- локальная дата пользователя
  answers     jsonb  not null,                    -- {"food":1,"sleep":0.5,...}
  score       real   not null,                    -- 0..1
  updated_at  bigint not null,                    -- мс с 1970
  primary key (user_id, date)
);

-- защита от двойной отправки отчётов
create table if not exists public.sent (
  user_id bigint not null,
  kind    text   not null,                        -- remind / week / month / year
  period  text   not null,
  primary key (user_id, kind, period)
);

-- RLS без политик: снаружи (anon-ключом) таблицы недоступны,
-- работать с ними может только Edge Function через service role.
alter table public.users   enable row level security;
alter table public.entries enable row level security;
alter table public.sent    enable row level security;
