-- Схема базы D1 для «Мой год»
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,          -- Telegram user id (= chat id в личке)
  first_name  TEXT,
  tz_offset   INTEGER NOT NULL DEFAULT 120, -- смещение от UTC в минутах (Киев зимой = 120)
  notify      INTEGER NOT NULL DEFAULT 0,   -- 1 = присылать отчёты (включается командой /start)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  user_id     INTEGER NOT NULL,
  date        TEXT    NOT NULL,             -- YYYY-MM-DD (локальная дата пользователя)
  answers     TEXT    NOT NULL,             -- JSON: {"food":1,"sleep":0.5,...}
  score       REAL    NOT NULL,             -- 0..1
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- защита от двойной отправки отчётов
CREATE TABLE IF NOT EXISTS sent (
  user_id INTEGER NOT NULL,
  kind    TEXT    NOT NULL,                 -- remind / week / month / year
  period  TEXT    NOT NULL,                 -- дата/период, к которому относится
  PRIMARY KEY (user_id, kind, period)
);
