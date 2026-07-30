# Milling/Paving field-tracking build (archived 2026-07-30)

The working app that occupied `src/` before the NovaCore v1 foundation
rebuild (line items, daily entries, RLS-enforced finance wall — see
`NovaCore-v1-foundation-spec.md` and `PROJECT_HANDOFF.md` at the repo root).
Reference material, not a foundation to build on — the schema this code
talks to no longer exists (see `supabase/_archive_milling_paving/` for the
matching database migrations, and the `milling-paving-v1-archive` git tag
for the exact pre-pivot commit).

Kept out of `src/` rather than deleted so it stays visible and diffable,
same reasoning as `archive/prototype-2026/` — an earlier rebuild of this
same repo made the identical call.
