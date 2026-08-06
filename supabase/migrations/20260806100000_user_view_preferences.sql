-- Migration: per-user view preferences
--
-- One row per user per scope, holding whatever JSON blob that scope's
-- screen wants to remember (visible columns, sort order, row count, a
-- toggle state). Convenience only, never load-bearing — a missing row, a
-- malformed blob, or a preference referencing something that no longer
-- exists must never break the screen it belongs to; the screen's own
-- default render path has to survive all three, enforced client-side, not
-- by anything in this migration.
--
-- Scope is a plain text key, not a second table per screen, precisely so
-- two things already wanted for this (the active-contract selector and
-- Portfolio's filters, both currently stuck in localStorage and losing
-- state on a device switch) can start writing their own scope value into
-- this same table later without a schema change. Not done in this
-- migration — those two are a separate pass.
--
-- One row per user per scope (the primary key), not one row per saved
-- view — nobody has asked for named/multiple views and it would triple
-- the scope for no requested benefit.
--
-- This table stores DISPLAY preferences only — which columns show, how
-- something is sorted, how many rows are visible, whether a toggle is on.
-- It must never be read as a permission check: a blob that happens to hide
-- a margin column is not a substitute for the rate-visibility right, and
-- every screen consuming this table has to re-run its own rights check
-- regardless of what's saved here. Nothing in this migration enforces that
-- — it's a rule for the client code that reads this table, noted here so
-- the next person extending it sees why the table stays permission-free.

create table public.user_view_preferences (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  scope       text not null,
  preferences jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, scope)
);

alter table public.user_view_preferences enable row level security;

-- Per-user ownership, inlined directly — profiles' and pinned_items' own
-- convention (0001, 0014), not a helper function. is_member()/has_right()
-- exist for CONTRACT membership; this table has no contract_id at all, so
-- neither applies, and every other per-user-owned row in this schema
-- inlines user_id = auth.uid() rather than wrapping it.
create policy user_view_preferences_select_own on public.user_view_preferences
  for select to authenticated
  using (user_id = auth.uid());

-- user_id is still sent explicitly by the client on insert/update (not
-- left to a column default) — the WITH CHECK below is what actually
-- enforces it can only ever be the caller's own id, same pattern as
-- pinned_items.user_id / quantity_records.created_by.
create policy user_view_preferences_insert_own on public.user_view_preferences
  for insert to authenticated
  with check (user_id = auth.uid());

create policy user_view_preferences_update_own on public.user_view_preferences
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.user_view_preferences to authenticated;
