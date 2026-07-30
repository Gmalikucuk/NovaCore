# Amendments to NovaCore-v1-foundation-spec.md

Running, dated log of decisions that adjust or extend the foundation spec
outside of its own text. The spec fixes schema and access rules; this file
tracks what's changed or been clarified since, so a fresh session doesn't
have to reconstruct it from chat history.

## 2026-07-30 — Line item creation: manual entry + optional .xlsx upload

Line item creation in v1 is **manual single-item entry**, plus an
**optional `.xlsx` upload** that reads a schedule of quantities from a
spreadsheet.

- The upload is a PM-side screen, parsed **client-side with SheetJS, no
  backend**.
- It **is** in v1 scope, but it is **not** part of the field-entry-path task
  (§8 step 4) — it comes after, as its own brief. Not built yet. Do not
  build a paste-a-text-blob variant instead of the file upload — the
  reasoning is that real spreadsheet cells mean no delimiter-guessing and no
  wrapped descriptions splitting into phantom rows. The hard part is column
  mapping (headers vary between spreadsheets), which is a UI problem, not a
  parsing gamble a paste-box would trade for a worse one.

## 2026-07-30 — Do not invent the Hwy 5 Snowshed Hill seed data

The 48-item line-item schedule for Hwy 5 Snowshed Hill (contract
`26607-0000`) will arrive as **its own seed migration**, once it has been
checked line by line against the contract PDF.

- A spreadsheet transcription of this schedule already exists (it's the
  `SEED` array in `novacore_v1_prototype.jsx`, the layout-reference
  prototype) — **that transcription is unverified and must not become the
  database's source of truth** until someone has read it against the
  original contract.
- **Prices stay null** on every line item until estimating's priced bid
  file surfaces. Do not fabricate cost/sell prices to make a demo look more
  complete.
- The project row itself (`Hwy 5 Snowshed Hill`, `26607-0000`) and a small
  number of throwaway/test line items (for RLS probe purposes only, see
  `scripts/probe-rls.sh` and `supabase/seed/v1_minimal_seed.sql`) are fine
  to seed directly — it's specifically the *real 48-item contract schedule*
  that must wait for verification.

## 2026-07-29 — Device targets and layout density: task-driven, not role-driven

Two usage contexts, mapped to **tasks, not roles** — the same person (owner,
GM) can be in either one depending on what they're doing, so layout must key
off task + viewport, not off `member_role`.

| Context | Device | Surface | Density |
|---|---|---|---|
| Field capture | Phone, offline-capable, Capacitor | This entry screen | Mobile-primary: large touch targets, `inputMode="decimal"` on every numeric field, works in sunlight/gloves-off. |
| Entry review/confirm | Desktop-primary, mobile gets a short list | §8 dashboard work | A PM confirming many entries wants a keyboard-operable table (tab order, Enter to confirm) on desktop; mobile is a short list with one confirm action per row, not a squeezed table. |
| Full dashboard | Desktop-primary, mobile is a **different view** | §8 dashboard work | Desktop: all items/columns/finance. Mobile: a handful of summary figures + a per-item progress list — not the same table reflowed. |
| Schedule-of-quantities import | Desktop only | Line-item upload (see entry above) | No mobile variant — hide below the breakpoint with an explanatory line. |

One codebase, one component tree, responsive — but responsive means
**different density per surface**, not the same content reflowed. A
48-row×8-column table doesn't become usable on a phone by scrolling
horizontally; a single-column mobile form doesn't become a desktop screen by
centering it in whitespace.

Practical constraints that apply to all of it: use `src/tokens.ts`'s
existing `mobileOverrides` breakpoint system (contrast tests already depend
on it) rather than inventing a new one; desktop surfaces must be fully
keyboard-operable (visible focus, logical tab order, Enter to submit, no
hover-only actions); test at both a 380px and a 2560px viewport, not just
1280px — a table that must scroll horizontally on mobile is a signal that
surface needs a distinct mobile component, not a scrolling table.

**Scope note:** this did not expand the field-entry-path task (§8 step 4,
mobile-first, already underway when this amendment arrived) — audited the
CSS written for it and found nothing that assumed a phone viewport in a way
that would need undoing (no fixed widths keyed to 375px, `inputMode` already
set, native `<form>` semantics already give tab order and Enter-to-submit
for free). The desktop review table and the mobile-vs-desktop dashboard
split belong to §8 step 5 and get built there.
