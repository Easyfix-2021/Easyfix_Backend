---
name: security-review
description: "Security audit for HRMS — injection, auth, data exposure, PII. Use for 'security check', 'is this secure', 'vulnerability scan'."
allowed-tools: Read, Grep, Glob, Bash(grep:*), Bash(find:*)
---

Scan $ARGUMENTS (or recent changes) for security vulnerabilities.

## HRMS-Specific Checks

### SQL Injection
- All MySQL queries MUST use parameterized `?` placeholders
- Search for string concatenation in queries: `+ req.`, template literals in SQL
- Check `server/api/*.js` for raw user input in queries
- ORM not used — every query is manual SQL, so every query is a risk surface

### Authentication & Authorization
- All API routes must validate auth token (SSO via 1Office Suite)
- Screen access middleware: `checkScreenAccess(screenId, actionId)` on protected routes
- Check for routes missing auth middleware
- Token stored in localStorage — verify no token logging

### PII & Data Exposure
- Employee PII: names, emails, phone numbers, Aadhaar, PAN, salary data
- Check API responses for unnecessary PII fields
- Log files must not contain PII
- Error responses must not leak internal details (stack traces, DB errors)

### File Upload (S3)
- File type validation before S3 upload
- File size limits enforced
- S3 presigned URLs have appropriate expiration
- No path traversal in S3 key construction

### Email Service
- Encrypted credentials in `server/utils/encryption.js` — verify encryption is used
- Email provider credentials never logged
- ZeptoMail API keys in env vars only

### Cron Jobs
- Feature flag checks before execution
- No unbounded queries (always LIMIT)
- Transaction rollback on failure
- Audit logging for bulk operations (leave credits, cycle end actions)

### Frontend
- No `dangerouslySetInnerHTML` without sanitization
- CSP headers configured
- No secrets in `NEXT_PUBLIC_*` env vars (these are client-visible)
- XSS: user input displayed with proper escaping

## Output Format
| Severity | CWE | File:Line | Issue | Fix |
|----------|-----|-----------|-------|-----|
