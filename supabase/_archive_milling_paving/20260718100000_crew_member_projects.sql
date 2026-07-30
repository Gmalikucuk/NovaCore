-- Assigns crew members to the project(s) they work on. Purely a
-- visibility/UX input for the client (see useProjectAssignment.ts): it
-- drives whether the header's ProjectSelector shows at all and, if so,
-- which projects it offers. It is NOT a security boundary — RLS already
-- governs what operations are actually allowed regardless of which project
-- a crew member has "current", and this table adds no new restriction at
-- the database level.
create table crew_member_projects (
  crew_member_id uuid not null references crew_members (id) on delete restrict,
  project_id uuid not null references projects (id) on delete restrict,
  primary key (crew_member_id, project_id)
);

create index idx_crew_member_projects_project on crew_member_projects (project_id);

-- Same "Group 3" reference/config posture as projects/crew_members
-- themselves (see 20260705070000): select+insert+update, no delete —
-- correcting a bad assignment is a manual/direct-SQL operation for now,
-- consistent with how the rest of this schema's reference data is fixed up.
alter table crew_member_projects enable row level security;

create policy crew_member_projects_select on crew_member_projects for select to anon, authenticated using (true);
create policy crew_member_projects_insert on crew_member_projects for insert to anon, authenticated with check (true);
create policy crew_member_projects_update on crew_member_projects for update to anon, authenticated using (true) with check (true);

grant select, insert, update on crew_member_projects to anon, authenticated;
revoke delete on crew_member_projects from anon, authenticated;

-- Seed: Mehmet works across both projects that exist today (Venables, the
-- real contract, and the UI test sandbox) — assigning both keeps his own
-- login experience exactly as it is now (multi-project, full
-- ProjectSelector), rather than regressing him into the new single-project
-- auto-lock behavior.
insert into crew_member_projects (crew_member_id, project_id)
select cm.id, p.id
from crew_members cm
cross join projects p
where cm.name = 'Mehmet'
  and p.contract_number in ('26754-0000', 'UI-TEST-SANDBOX');
