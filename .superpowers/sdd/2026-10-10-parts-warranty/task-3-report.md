# Task 3 report — Supabase warranty schema

Status: COMPLETE. Implemented and applied the authorized non-destructive warranty migration to project `uezwoxoikfeapkrekqzg`. No browser files were changed and no Git commands/commits were used.

## Changed files

- `supabase/migrations/20261010000000_multiuser_inventory.sql`: replaced the original sales-function tail with the same warranty DDL and RPC definitions used by the incremental migration, giving a fresh base the same contract.
- `supabase/migrations/20261010000003_add_parts_warranties.sql`: new warranty columns, tables, indexes, triggers, grants, RLS policies, and customer-aware sale RPC.
- `supabase/tests/multiuser_inventory.test.sql`: executable schema/RLS assertions and transaction-scoped behavior tests with rollback.
- `docs/superpowers/runbooks/supabase-setup.md`: migration order, grants/RLS explanation, RPC compatibility, date semantics, verification, and local/cloud boundary.
- This report.

## Implementation

`items.warranty_months` is a nonnegative integer, NOT NULL, default 0. `sales.customer_id` is an optional customer FK. Neither existing sales nor local data is backfilled.

`warranties` stores customer and item references, customer/item/barcode snapshots, manual/sale source, sale and unique sale-line references, sale-number snapshot, purchase/expiry dates, notes, creator and timestamps. Source/reference and date-order constraints reject invalid records. `warranty_cases` stores its warranty FK, issue, one of four statuses, handling date/notes, item and warranty-date snapshots, creator and timestamps. Deleting a warranty cascades to its cases.

Both tables enable RLS and revoke inherited/public/anonymous access. Explicit authenticated grants are paired with active-staff SELECT/INSERT/UPDATE policies and active-admin-only DELETE policies. INSERT requires the caller as creator; existing immutable-creator and timestamp trigger patterns are reused. Existing item policies continue to restrict warranty-month changes to admins.

The private two-argument `create_sale(jsonb, uuid)` requires active staff, validates nonempty arrays and customer references, locks item rows, records snapshots, and creates one warranty per eligible sale line only when customer is non-null and item warranty months are positive. Dates use Asia/Taipei and PostgreSQL calendar-month intervals. Stock, sale lines, warranties, total and audit history remain one transaction.

The public two-argument function is SECURITY INVOKER. The necessary SECURITY DEFINER transaction stays in `app_private`, has an empty search_path, fully qualifies application objects, validates staff inside the function, and denies anonymous/PUBLIC execution. Both old one-argument signatures remain SECURITY INVOKER wrappers passing null customer, with no second-argument default that could create overload ambiguity.

## Scope rulings and findings

The parent authorized retaining single-argument compatibility because migrations 00001 and 00002 explicitly refer to that signature. Migration 00003 safely follows the updated base: columns/tables/indexes use IF NOT EXISTS and named warranty triggers/policies are replaced. The base and incremental warranty SQL were checked to match exactly.

The parent also authorized correction of an existing sales defect: child sale_lines were inserted before their parent sales row despite the immediate FK. The updated function creates the parent first, then lines, and updates the total at the end. Failure still rolls back the complete statement.

Admin and clerk are application roles stored in profiles, not separate PostgreSQL roles. They both use authenticated, so a literal absence of authenticated DELETE grants would also block admin deletion. The accepted implementation grants DELETE to authenticated and restricts effective deletion to admins through RLS, verified with an actual clerk JWT subject and SET LOCAL ROLE authenticated. Neither anon access nor authenticated TRUNCATE is granted.

## RED evidence

The extended SQL test file was written before implementation and executed through Supabase execute_sql against the target project. It failed as expected:

```text
ERROR: P0001: warranties table is missing
CONTEXT: PL/pgSQL function inline_code_block line 22 at RAISE
```

No schema mutations were performed through execute_sql.

## Migration and GREEN evidence

Supabase apply_migration, project `uezwoxoikfeapkrekqzg`, name `add_parts_warranties`, returned `{"success":true}`. The submitted SQL was the same string written to the incremental migration file.

The hosted migration history records the tool-assigned version `20261010040130` / `add_parts_warranties`; the reviewed local filename remains the explicitly requested `20261010000003_add_parts_warranties.sql`. A future CLI migration-history reconciliation should account for this timestamp difference.

The complete SQL test then passed through execute_sql, returning `create_sale` and no errors. Tests run in BEGIN/ROLLBACK and cover:

- Both warranty tables exist with RLS enabled; warranty-month and nullable sale-customer columns have the expected shapes.
- No anonymous table/RPC access, no authenticated TRUNCATE, and no clerk-compatible DELETE/ALL policy.
- Negative warranty months are rejected.
- A three-line customer sale creates exactly two warranties for eligible lines and calculates the correct total (450).
- Sale purchase date is the Taipei date; expiry uses calendar-month addition, including January 31 to leap-year February 29.
- No-customer checkout and legacy one-argument checkout succeed without automatic warranties.
- NULL sales are rejected; a later insufficient-stock line rolls back the earlier stock change.
- Clerks can manually create an expired warranty and case, edit warranty notes/dates and case progress, and cases keep date snapshots when warranty dates change.
- Invalid case statuses fail.
- Clerk DELETE affects zero warranties/cases and clerk item-warranty UPDATE affects zero items.
- Inactive staff cannot read warranty records or call the sale RPC.
- Admin deletion removes a warranty and cascades its case.

A follow-up read verified zero remaining test items, customers and warranties; all fixtures and the temporary auth row were within the rolled-back transaction.

`node --test` was run once after application: **68 passed, 0 failed, 0 skipped**, exit 0.

A small Node assert verified the base migration ends with exactly the incremental warranty SQL: **passed**.

## Documentation and security advisor

Read the Supabase skill before Supabase calls. Fetched the changelog and reviewed the relevant explicit-Data-API-grants breaking change; queried Supabase search_docs for current function privilege and RLS guidance. Relevant references:

- [Data API explicit grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Database functions](https://supabase.com/docs/guides/database/functions)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Security advisor before and after returned the same single pre-existing WARN: `auth_leaked_password_protection` / Leaked Password Protection Disabled. There were **no new security findings**. Auth configuration was not changed. [Remediation documentation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Self-review and limitations

Reviewed all create_sale callers/migrations before editing, including historical signature dependencies, base schema FKs, current live RPC definitions, and current item/customer policies. Verified the implementation preserves stock checks, audit writes and creator validation, uses snapshots rather than live joins for saved names/dates, leaves clerk item writes blocked, and keeps database changes non-destructive.

No empty second Supabase project/local PostgreSQL instance was provisioned to replay the full migration history; fresh-base consistency was statically asserted and incremental DDL was executed on the configured project. No concurrent-sale stress test or browser/cloud synchronization test was performed. Current browser inventory remains IndexedDB; this task prepares the cloud schema/RPC. Existing leaked-password protection warning remains for the owner to address separately.

## Review follow-up

Addressed both requested follow-ups with apply_patch:

- The clerk warranty-update test now asserts an existing matching row contains both `note = 'Clerk can edit'` and `expires_at = date '2024-03-31'`. This fails if RLS silently causes a zero-row update, or if the values do not persist.
- The setup runbook now documents hosted version `20261010040130` / `add_parts_warranties` as the counterpart of local `20261010000003_add_parts_warranties.sql`, requires history reconciliation before future CLI pushes, and explicitly states that no database repair or migration rerun is needed now.

Reran the complete focused SQL test through execute_sql against `uezwoxoikfeapkrekqzg`: **PASS**, returning `create_sale` with no errors. All test fixtures remain transaction-scoped and rolled back. No schema or application changes were made in this follow-up, so the already-passing 68-test Node run and unchanged advisor result were not repeated.
