# Task 3: Add the Supabase warranty schema and policies

Read `docs/superpowers/specs/2026-10-10-parts-warranty-design.md` first. The approved plan is `docs/superpowers/plans/2026-10-10-parts-warranty.md`.

Files: modify `supabase/migrations/20261010000000_multiuser_inventory.sql`, create `supabase/migrations/20261010000003_add_parts_warranties.sql`, modify `supabase/tests/multiuser_inventory.test.sql`, and modify `docs/superpowers/runbooks/supabase-setup.md` only.

Ruling: despite the original plan text, use migration number `00003` because it is the next unused migration. Do not alter browser files.

Requirements:

- Add `items.warranty_months integer not null default 0 check (warranty_months >= 0)` and nullable `sales.customer_id`.
- Create `warranties` and `warranty_cases` with proper FK/snapshot fields.
- Enable RLS on both, add explicit grants/policies: active staff may read/create/update; only admin may delete.
- Update the cloud sales contract to `create_sale(p_lines jsonb, p_customer_id uuid)`, including the public wrapper and private implementation, and create warranties only if p_customer_id is non-null and item warranty months > 0.
- Keep base migration behavior identical for a fresh project.
- Extend SQL checks to validate tables, columns, RLS enabled, and no clerk delete grant/policy.
- Use Supabase documentation/search before writing SQL. Use apply_migration for DDL and security advisor after application.

TDD:

1. Add failing SQL shape/RLS checks.
2. Run those checks against project `uezwoxoikfeapkrekqzg` and record expected failure.
3. Implement and apply non-destructive migration.
4. Rerun SQL checks, security advisor, and `node --test` once.

Write detailed report to `.superpowers/sdd/2026-10-10-parts-warranty/task-3-report.md`, including migration result, RED/GREEN SQL evidence, advisor output summary, tests, changed files, self-review and concerns. Do not create subagents. There is no Git repository: do not commit.
