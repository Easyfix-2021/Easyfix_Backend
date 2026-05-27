---
name: code-review
description: "Reviews code for quality, patterns, and HRMS conventions. Use for 'review', 'check this code', 'PR review'."
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*)
---

## Changed Files
!`git diff --name-only HEAD~1`

## Detailed Changes
!`git diff HEAD~1`

## Review Checklist

### Express.js Backend (server/api/*.js)
- API response format: `{ success: boolean, error?: string, data?: any }`
- MySQL queries use parameterized `?` placeholders (never string concatenation)
- Connection pool from `server/db.js` — never create standalone connections
- Error handling: try/catch in every route handler, log errors, return 500
- Screen access middleware applied where needed: `checkScreenAccess(screenId, actionId)`
- Reuse existing utilities from `server/utils/` before writing new ones

### Next.js Frontend (src/)
- Functional components + hooks only
- Server components by default — 'use client' only when needed (interactivity, hooks, browser APIs)
- TailwindCSS for styling — no inline styles or CSS modules
- Path alias: `@/*` for `src/*` imports
- Screen access: use `ScreenAccessContext` for conditional UI rendering

### Shared Code (shared/)
- `shared/screens.js` is the SINGLE SOURCE OF TRUTH for screen/action definitions
- Changes here affect both frontend and backend — verify both sides

### Cron Jobs (server/scheduler.js, server/api/cron.js)
- All cron jobs must use IST timezone (`Asia/Kolkata`)
- Feature flags in `channelplay_properties` table must gate cron execution
- Log start/end with timestamps for debugging
- Use database transactions for multi-step operations

### Database Queries
- Always use `const [rows] = await pool.query(sql, [params])`
- No `SELECT *` — list specific columns
- Add indexes for new WHERE/JOIN columns (document in migration file)
- Date handling: store in DB timezone, convert to IST for display

### General
1. No secrets/credentials in code
2. No console.log in production paths — use structured logging
3. Error messages: specific enough to debug, generic enough for clients
4. Input validation on all API endpoints
5. TypeScript types for new data structures

Rate: CRITICAL | WARNING | SUGGESTION
Include file:line references.
