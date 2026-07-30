-- Part 2, step 1-2: companies table + company_id on projects/crew_members.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into companies (name) values ('Keywest Asphalt');

alter table projects add column company_id uuid references companies (id) on delete restrict;
alter table crew_members add column company_id uuid references companies (id) on delete restrict;

update projects set company_id = (select id from companies where name = 'Keywest Asphalt')
where company_id is null;

update crew_members set company_id = (select id from companies where name = 'Keywest Asphalt')
where company_id is null;

alter table projects alter column company_id set not null;
alter table crew_members alter column company_id set not null;

create index idx_projects_company_id on projects (company_id);
create index idx_crew_members_company_id on crew_members (company_id);

-- companies is a reference/config table like projects/jobs — same broad-access
-- treatment (no per-role restriction possible at the DB level, same accepted
-- gap noted for the rest of that group).
alter table companies enable row level security;

create policy companies_select on companies for select to anon, authenticated using (true);
create policy companies_insert on companies for insert to anon, authenticated with check (true);
create policy companies_update on companies for update to anon, authenticated using (true) with check (true);
create policy companies_delete on companies for delete to anon, authenticated using (true);

grant select, insert, update, delete on companies to anon, authenticated;
