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
