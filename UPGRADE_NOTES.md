# CivicTrack upgrade notes

## Step 0 — what the project looked like before the upgrade

**Layout.** Flat project, not split into `backend/` and `frontend/` folders:

| Path | Role |
|------|------|
| `server.js` | Express app, all routes, Socket.io, Naive Bayes classifier, duplicate detection, Cloudinary upload |
| `auth.js` | JWT sign/verify, in-memory logout revocation, `requireRole`, email/mobile checks |
| `public/` | Frontend, served statically by Express |
| `supabase-schema.sql` | `users`, `complaints` tables (RLS on, no policies; backend uses service key) |

**Frontend.** No framework and no build step: plain `index.html` + `app.js` + `landing.js` + `style.css`. Leaflet and Socket.io client are loaded as scripts. Styling is one hand-written dark-theme stylesheet (gold/slate palette, system font). Navigation is show/hide of `<section>` blocks.

**Auth routes.** `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` (adds token to a revocation `Set`). Both signup and login share `authLimiter` (20 requests / 15 min / IP). Errors come back as `{ error: "..." }` with one message at a time. Signup restricts email to six domains (gmail, yahoo, outlook, hotmail, icloud, rediffmail) and requires a 10-digit mobile number. Password rule was only "6+ chars with a letter and a number".

**Complaint routes.** `GET /api/complaints` (search/category/status filters), `GET /api/complaints/mine` (citizen), `GET /api/stats`, `POST /api/complaints` (citizen, one `photo`, description >= 10 chars, location optional), `PATCH /api/complaints/:id/status` (authority, any of Pending / In Progress / Resolved, no remark).

**Gaps against the new spec.**
- No complaint title, address, multi-image upload, "Rejected" status or authority remark (needs DB columns, see `migrations/`).
- Image type is checked only by the browser-supplied MIME type.
- No HTML stripping on the backend; no field-level errors.
- UI uses no toasts, the location map is hidden until you press the locate button, and there is no navbar.
- No build step and no type-checker exist, so "build" in Part 4 means a syntax check of every JS file plus starting the server.

**Constraints I am working under.** `.env`/`.env.local` are never read. All verification runs against an in-memory fake of Supabase and Cloudinary (`test/`), never the live database. Nothing is pushed or deployed.

## Decisions made while upgrading
- **Shared rules.** `shared/rules.js` is one UMD file: the backend `require`s it, the browser loads it from `/shared/rules.js`. No mirrored copy exists, so nothing can drift.
- **Email provider list kept.** Signup still only accepts the six providers the original app allowed (gmail, yahoo, outlook, hotmail, icloud, rediffmail); login only checks the format. Change `ALLOWED_EMAIL_DOMAINS` in `shared/rules.js` to open this up.
- **Password vs. name/email.** The "must not contain your name or email prefix" check ignores pieces shorter than 3 characters, otherwise a name like "Jo" would ban most passwords.
- **Status flow.** Pending -> In Progress -> Resolved, and Rejected from Pending or In Progress. Resolved and Rejected are final. Remarks (10-500 chars) are required for Resolved and Rejected.
- **Login errors.** Wrong email, wrong password and over-long password all return 401 "Invalid email or password". Rate limit returns 429 "Too many attempts, try again in X minutes."
- **Bug found and fixed on the way.** Two logins in the same second produced byte-identical JWTs, so logging out one revoked the other. Tokens now carry a unique `jwtid`.
- **No build step exists.** "Build" = `npm run check` (every JS file parses) plus `npm test` (19 API checks against in-memory fakes).

## Before deploying (required)
Run `migrations/001_title_address_photos_remarks.sql` once in the Supabase SQL editor. The new backend writes `title`, `address`, `photo_urls`, `authority_remark` and the `Rejected` status, and complaint submission fails until those columns exist. It was **not** run by me.

## Local testing without any credentials
`node test/mock-server.js` serves the real app on http://127.0.0.1:4010 over an in-memory database with demo users (citizen `meera.reddy@gmail.com`, authority `arjun.nair@gmail.com`, password `Demo#Pass2025`; fixture only).

