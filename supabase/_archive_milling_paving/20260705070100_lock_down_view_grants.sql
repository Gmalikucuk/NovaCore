-- lifecycle_deadline_status is a read-only view (joins + computed columns,
-- not updatable without an INSTEAD OF trigger), but it still carried the
-- default INSERT/UPDATE/DELETE/TRUNCATE grants views get on creation. Locking
-- it to SELECT-only explicitly, consistent with the rest of this schema.

revoke insert, update, delete, truncate on lifecycle_deadline_status from anon, authenticated;
grant select on lifecycle_deadline_status to anon, authenticated;
