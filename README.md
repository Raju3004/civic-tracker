# CivicTrack — Smart Complaint & Civic Issue Tracker (v3: live services)

Same app as before, now backed by real cloud services instead of a local
JSON file: **Supabase** (Postgres database) and **Cloudinary** (photo
storage). This is the "going live" version — treat the local-only build
(`civic-tracker-v2.zip`) as your safety net if anything here doesn't come
together in time.

## One-time setup (do this before touching the code)

### 1. Supabase

1. Go to supabase.com, sign in (or create an account), create a new project.
2. Once it's ready: **Dashboard → SQL Editor → New query**, paste the
   entire contents of `supabase-schema.sql` (included in this folder), and
   click **Run**. This creates the `users` and `complaints` tables.
3. Go to **Project Settings → API**. You need two values:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role secret** (not the `anon`/`public` key) → this is
     `SUPABASE_KEY`. The service_role key is meant for trusted server code
     like this backend — never put it in frontend JS, but it's exactly
     right here.

### 2. Cloudinary

1. Go to cloudinary.com, sign up for a free account.
2. Your **Dashboard home page** shows all three values you need directly:
   Cloud name, API Key, API Secret.

### 3. Wire up the credentials

1. Copy `.env.example` to a new file named `.env` in the same folder.
2. Fill in the 5 values from steps above.
3. **Never commit `.env` or share it** — it has real secrets. `.gitignore`
   is already set up to exclude it if you push this to GitHub.

## Run it

```
npm install
npm start
```

You should see `Civic Issue Tracker (Supabase + Cloudinary) running at
http://localhost:3000`. If instead you see `Missing required environment
variables`, your `.env` file is missing, misnamed, or missing a value —
double check it's named exactly `.env` (not `.env.txt`) and sits next to
`server.js`.

## Important — this part needs a real test run together

Everything that talks to Supabase or Cloudinary could not be tested by me
directly — my sandbox's network access doesn't reach those domains, only
package registries. What I did verify locally, without needing real
credentials: the server boots cleanly and fails with a clear message when
credentials are missing, rate limiting actually triggers after the
threshold (tested with 22 rapid requests), and the Naive Bayes
categorization + text-similarity duplicate logic both produce correct
results on a battery of test phrases — including "there's a big hole in
the road," which the old keyword-only version would have handled less
reliably. The full signup → submit → real-time dashboard update flow
needs a run-through on your end, same as before.

## What's implemented

- ✅ Real Postgres database via Supabase, real cloud photo storage via
  Cloudinary — same as before
- ✅ Signup/login with bcrypt, JWT, `citizen`/`authority` roles, and strict
  validation everywhere — same as before
- ✅ High-accuracy GPS with a correctable map pin — same as before
- ✅ **Real-time dashboard updates** — Socket.io pushes `complaint:new` and
  `complaint:updated` events to all connected clients, so the authority
  dashboard (and a citizen's "My Complaints" list) update live without a
  manual refresh. A green "Live" indicator shows the connection is active.
- ✅ **Smarter categorization** — replaced pure keyword matching with a
  real Naive Bayes text classifier (via the `natural` library), trained
  locally on example phrases per category. No external API or network
  call required — it runs entirely in-process.
- ✅ **Smarter duplicate detection** — now also catches complaints that are
  a bit further apart geographically (up to 150m, vs. the original 50m)
  if their descriptions are highly similar (word-overlap similarity),
  in addition to the original strict-radius check.
- ✅ **"My Complaints" view** — citizens see a live list of their own past
  submissions and current status, separate from the full list.
- ✅ **Search & filter on the dashboard** — authorities can filter by
  category, status, or search complaint descriptions.
- ✅ **Rate limiting** — 20 auth attempts per 15 minutes, 10 complaint
  submissions per minute, both tested and confirmed working.
- ✅ **Logout token revocation** — logging out now actually invalidates
  the JWT server-side (in-memory list), not just clearing it from the
  browser. Note: this list resets if the server restarts, which is a
  reasonable limitation for a demo but wouldn't be production-grade.

## Deliberately not built tonight

- **Email/SMS notifications** and **password reset** both need a new
  external service account (an email provider or SMS gateway) — same kind
  of setup overhead Cloudinary took earlier, and not a good time trade this
  close to a deadline. These remain genuine future-scope items.
- **Deployment to a public URL** — set aside for now per your instruction;
  the steps are ready whenever you want to pick it back up.
- **ML-based categorization** is now real (see above) — though it's a
  small, hand-trained classifier, not a large pretrained model. Worth
  describing accurately as "a lightweight statistical classifier" rather
  than overselling it if asked.
