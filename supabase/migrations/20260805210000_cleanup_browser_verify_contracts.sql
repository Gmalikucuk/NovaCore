-- =============================================================================
-- NovaCore v1 — Migration 0034: clean up end-to-end browser verification runs
--
-- Two contracts created while browser-verifying CreateContractScreen and
-- SeatMembersScreen end-to-end (0028-0031's own final check): one before
-- realizing the sandbox checkbox needed a real click rather than the
-- browser tool's checkbox helper (TEST-VERIFY-0001, is_sandbox left at its
-- false default), one after (TEST-VERIFY-0002, is_sandbox = true,
-- confirming the checkbox itself works correctly — a tool-interaction
-- artifact, not an app bug). Both otherwise real: real Items on
-- TEST-VERIFY-0001, a real seated "Test field" membership on
-- TEST-VERIFY-0002. Neither is a fixture anything else depends on.
--
-- Requires migrations through 0033.
-- =============================================================================

delete from public.contracts
where id in (
  'a5247317-dfe4-4982-97b6-18fdbe16ce78', -- TEST-VERIFY-0001
  'c73ddcc3-2994-493f-a7e9-2e4562a9dbf5'  -- TEST-VERIFY-0002
);
