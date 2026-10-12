# SDD ledger — plan: docs/superpowers/plans/2026-10-10-parts-warranty.md

## Environment

Ruling: This workspace has no Git repository, so no isolated worktree, commits, or Git diff packages can be created. Task reviews will use a read-only file list and `diff -u` snapshots captured before/after each task. This costs Git-history reviewability but preserves the requested independent implementer/reviewer gates.

## Pre-flight interface scan

| Tasks/interfaces | Producer → consumer | Finding |
| --- | --- | --- |
| Task 1 → Task 2 | Warranty helpers, extended `recordSaleBatch`, state arrays → UI controls | Compatible: Task 2 consumes names defined by Task 1. |
| Task 1 → Task 3 | Browser `warrantyMonths`/warranty snapshots → cloud schema | Compatible: plan explicitly translates camelCase to snake_case. |
| Task 2 → Task 3 | Optional sale customer ID → cloud sale customer ID | Compatible after plan ruling: cloud function accepts nullable `p_customer_id`. |
| Task 1 | Tests, state actions, normalization | Internally consistent; calendar arithmetic must be covered by tests. |
| Task 2 | Controls, role UI, existing app shell | Internally consistent; RLS enforcement belongs to Task 3. |
| Task 3 | Migration, RLS, cloud sale function | Internally consistent; public wrapper signature must be updated with private function. |

## Task 1: complete

Implementer: `/root/warranty_task1`. TDD evidence: initial RED 23/32 passing with 9 expected failures; GREEN focused 34/34 and complete suite 61/61 passing after the date fix.

Review: initial reviewer identified a real UTC/Taipei calendar-date mismatch. Fix round replaced UTC-derived purchase/filter dates with Asia/Taipei dates and added frozen-clock coverage. Scoped re-review approved with no findings.

## Task 2: complete

Implementer: `/root/warranty_task2`. TDD evidence: initial navigation RED, then 23/23 focused and 64/64 full tests; fix round finished with 27/27 navigation and 68/68 full tests plus syntax check.

Review: reviewer found a cross-warranty stale case-editor update bug. Fix reset the editor on warranty changes, checks selected-warranty ownership before update, and added behavioral event-handler regressions. Scoped re-review approved with no findings.

## Task 3 ruling

Ruling: use migration `20261010000003_add_parts_warranties.sql`, not `00004`. The separately planned monthly-profit migration `00003` has not been implemented, so `00003` is the next unused migration slot. This changes only file ordering, not schema behavior; if the monthly-profit work is later executed, it must use the next available migration number.

Ruling: preserve `create_sale(jsonb)` as a public compatibility wrapper and add `create_sale(jsonb, uuid)` for optional customer-linked warranties. Existing migrations reference the one-argument function; removing it would break the current contract. Cost if wrong: cloud clients using the former signature fail.

Ruling: create the parent `sales` row before inserting `sale_lines` in the private sale transaction. The previous order violates the foreign key. Cost if wrong: every cloud sale transaction fails once cloud writes are enabled.

Ruling: retain table DELETE grants to `authenticated` where PostgREST needs the privilege, but enforce admin-only delete through RLS and an explicit clerk rollback test. Cost if wrong: a future policy mistake could widen delete access, so advisor/tests must remain part of verification.

## Task 3: complete

Implementer: `/root/warranty_task3`. TDD evidence: SQL RED then GREEN with warranty schema/RLS checks; full Node suite 68/68 passed; database advisor had no new schema/RLS findings.

Review: core schema and RLS approved. Follow-up strengthened the clerk update test to reject zero-row updates and documented the hosted/local migration-history mapping. Scoped re-review approved. Existing Supabase Auth leaked-password protection warning is unrelated to this schema and remains open.

## Final review: complete

Whole-feature review found one gap: automatic warranties did not save the signed-in creator. The final fix passes the bootstrap user ID to `recordSaleBatch`, stores it in automatic warranties, and adds state/UI integration coverage. Scoped final re-review approved.

Final verification: `node --test` and syntax checks passed with 70/70 tests. Supabase security advisor reports only the pre-existing Auth leaked-password protection warning.

