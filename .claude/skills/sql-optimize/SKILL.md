---
name: sql-optimize
description: "Optimizes MySQL queries and database access patterns in HRMS. Use for 'slow query', 'optimize SQL', 'DB performance', 'N+1'."
allowed-tools: Read, Grep, Glob
---

Analyze $ARGUMENTS for MySQL query performance issues in the HRMS codebase.

## Query Patterns to Check

### Connection Pool Usage
- All queries must use the shared pool from `server/db.js`
- Never create standalone `mysql.createConnection()`
- Use `pool.query()` for single queries, `pool.getConnection()` + `connection.release()` for transactions

### Common MySQL Issues
- **SELECT ***: Always specify columns — reduces network transfer and allows covering indexes
- **Missing indexes**: Check WHERE, JOIN, ORDER BY columns — add to `server/migrations/`
- **N+1 queries**: Loop calling DB inside a for-loop — batch with IN clause or JOIN
- **Unbounded queries**: Missing LIMIT on potentially large result sets
- **OFFSET pagination**: On large tables, use keyset pagination (`WHERE id > ?` + `LIMIT`)

### HRMS-Specific Tables (High Volume)
- `cp_hr_employee_leave_application` — leave requests, queried by emp_code + date range
- `shift_attendance` — attendance records, queried by emp_code + month
- `cp_cm_user` — user master, JOINed frequently — ensure indexes on user_id, user_name, active
- `cp_hr_employee_avail_policy` — leave balances, queried by emp_code + policy_id + type_id

### Date/Time Queries
- Use `DATE()` or date range (`>= ? AND < ?`) instead of `LIKE '2026-04%'`
- Index date columns used in WHERE clauses
- IST conversion: do in application code, not SQL (avoids function-on-column index bypass)

### Cron Job Queries (server/api/cron.js)
- These run on ALL employees — must be optimized
- Batch INSERT/UPDATE instead of row-by-row
- Use transactions for multi-step operations
- Add progress logging for long-running queries

### JOIN Optimization
- Verify JOIN columns have matching types and indexes
- Use INNER JOIN when possible (vs LEFT JOIN)
- Avoid JOINing on computed/cast columns

## Output Format
Show: Original query -> Optimized query -> Expected improvement (index suggestion, estimated speedup)
