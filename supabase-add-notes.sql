-- Совместимое расширение public.norms для URALSTORE v0.6.
-- Существующие строки и значения не изменяются.
alter table public.norms
  add column if not exists notes text not null default '';
