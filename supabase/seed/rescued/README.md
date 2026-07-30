# Rescued data — pre-reset snapshot of the old "Field Tracker"/NovaCore project

Dumped 2026-07-30, immediately before `drop schema public cascade` reset the linked
Supabase project (`lmtgwekuqzhfewspnldq`) for the v1 foundation build. This is a
**reference snapshot**, not an importable seed for the new schema — the old and new
table shapes don't correspond (no `road_segments`/`project_config` concept exists in
the v1 spec), so these files exist so the real-world facts below aren't lost, to be
manually re-entered wherever the new schema needs them.

## ⚠️ Gap found — flagging explicitly, not silently skipping

**"Job B Reach 1 (Henning–Juliet)" and "Job B Reach 2 (Brodie–Larson)" do not exist
anywhere in this database.** The only project data present was:

- **Venables Valley** — contract `26754-0000`, job code `1`, Hwy 1 / Hwy 1+97, three
  `road_segment_groups` (station ranges below).
- **UI Test Sandbox** — contract `UI-TEST-SANDBOX`, explicitly test data, Sandbox Hwy
  0–1000.

No "Job B", no "Reach 1"/"Reach 2", no Henning/Juliet/Brodie/Larson naming exists in
any table (`jobs`, `road_segment_groups`, `road_segments`, `projects`). If those
station bounds are needed, they'll need to come from wherever they actually live —
they were never in this Supabase project.

## What's here

| File | Rows | Notes |
|---|---|---|
| `companies.sql` | 1 | Keywest Asphalt |
| `projects.sql` | 2 | Venables Valley (real), UI Test Sandbox (test) |
| `jobs.sql` | 2 | One per project above |
| `road_segment_groups.sql` | 3 | Station ranges — see table below |
| `road_segments.sql` | 6 | Per-direction rows (NB/SB) for each group above |
| `project_config.sql` | 1 | **Highest-value row** — SS 502 Table 502-H bands, target application rate, tack coat rate, all deliberately not-hardcoded values from the old build |
| `crew_members.sql` | 1 | Mehmet (coordinator) — real row, not a test row, still linked to a real `auth.users` id that no longer resolves post-reset |

## road_segment_groups — station ranges (the thing most likely to be needed again)

| Highway | Highway 2 | From | To | Job |
|---|---|---:|---:|---|
| Hwy 1 | — | 25340 | 35235 | Venables Valley |
| Hwy 1 | Hwy 97 (0–11225) | 43170 | 45060 | Venables Valley |
| Sandbox Hwy | — | 0 | 1000 | UI Test Sandbox |

## project_config — the SS 502 bands (highest-value row, shown in full)

```
project:                    Venables Valley (26754-0000)
target_application_rate:    124.35 kg/m²
mix_density:                2.487
lift_thickness:              0.05 m
tack_coat_rate:              0.26 L/m²
mill_to_pave_days_allowed:   7
shouldering_days_allowed:   10
joint_sealant_strategy:     single_project_closeout
joint_sealant_band_width:    0.4 m
joint_sealant_rate:          0.4 L/m²
stationing_format:          lki_station
bonus_band:                 96%–104%
reject_band:                <85% or ≥110%
```
