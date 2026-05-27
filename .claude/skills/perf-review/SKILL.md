---
name: perf-review
description: "Performance review for HRMS — API latency, frontend rendering, cron efficiency. Use for 'make it faster', 'slow', 'performance', 'optimize'."
allowed-tools: Read, Grep, Glob
---

Analyze $ARGUMENTS for performance bottlenecks in HRMS.

## Backend (Express.js)

### API Response Time
- Sequential DB queries that could be parallelized with `Promise.all()`
- Unnecessary data fetching — check if API returns more data than the frontend needs
- Missing pagination on list endpoints
- Heavy computation in request handlers — move to background/cron

### Database
- Connection pool size (currently 20) — adequate for load?
- Slow queries: missing indexes, full table scans
- Transaction scope too wide — hold connections shorter
- See `/sql-optimize` for detailed query analysis

### Cron Jobs
- Leave credit cron processes ALL employees sequentially — batch operations
- Cycle end cron: multiple queries per employee in loop — consolidate
- Add timing logs: `console.time()`/`console.timeEnd()` for each phase

### File Operations
- S3 uploads: use multipart for large files
- PDF generation (pdfkit): memory usage for large contracts
- Image processing (sharp): resize before S3 upload

## Frontend (Next.js + React)

### Rendering
- Components re-rendering unnecessarily — missing `React.memo`, `useMemo`, `useCallback`
- Large lists without virtualization (employee lists, leave tables)
- Client components that should be server components (no interactivity needed)

### Data Fetching
- Fetch waterfalls: sequential fetches in useEffect — parallelize or lift to server component
- Missing SWR/cache: same data fetched on every navigation
- Large payloads: API returning full objects when summary suffices

### Bundle Size
- Check imports: `import { X } from 'large-lib'` vs `import X from 'large-lib/X'`
- Next.js Image component for all images
- Dynamic imports for heavy components (modals, charts)

### TailwindCSS
- Purge config correct — no unused CSS in production
- Avoid runtime style computation — use Tailwind classes directly

## Output Format
| Priority | Area | Issue | Fix | Impact |
|----------|------|-------|-----|--------|
