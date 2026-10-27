# Maths Exhibition Feedback System

A mobile-friendly, QR-based visitor review website for school exhibitions. It includes a public feedback form, private organiser dashboard, stall/question management, per-stall QR codes, and CSV/HTML exports.

## What is included

- **One QR per stall:** start with 50 starter stalls, then add more in the dashboard.
- **No visitor login or personal details:** visitors are not asked for their name, phone number or email.
- **Duplicate-review check:** a random device token is stored in a signed, `HttpOnly` browser cookie. A database uniqueness constraint permits one review for that cookie token per stall. Clearing cookies, using a different browser or another device can bypass this; it cannot prove a real-world person's identity.
- **Configurable question sets:** add multiple-choice, short-text and 1–5 rating questions to individual stalls.
- **Organiser sign-in:** username/password live in hosting environment variables, not in the visitor-facing code.
- **Dashboard:** review totals, per-stall ratings, written suggestions and paginated feedback.
- **Exports:** download feedback as CSV or a standalone HTML report.
- **QR tools:** produce a printable QR sheet and download stall URLs as CSV.

This is a deployable starter project, not a published website yet. You must connect a PostgreSQL database and deploy the Node.js server before reviews can be collected online.

## Before you start

You need a GitHub account, a Supabase project, and a Render account. The intended setup uses the free plans to get started, but free plans have usage limits and may sleep or pause. They should not be treated as a guarantee of uninterrupted service or unlimited traffic. Test the complete setup before an exhibition. Render's free web services sleep after 15 minutes without incoming traffic; the next visit may take about a minute to wake up. Supabase can pause free projects after low activity. See the current official limits:

- Render: https://render.com/docs/free
- Supabase free-project pausing: https://supabase.com/docs/guides/platform/free-project-pausing

## Setup, step by step

### 1. Create the database

1. Sign in to Supabase and create a new project.
2. Save the database password somewhere private.
3. Open **SQL Editor → New query**.
4. Open this project's `schema.sql`, copy all its contents, paste it into the SQL editor and run it.
5. The script creates the tables and seeds 50 placeholder stalls with the built-in overall rating question.

The website does not use a Supabase browser key. The server connects to PostgreSQL directly, so the database connection string must stay private.

### 2. Copy the database connection string

1. In Supabase, open **Connect** and choose **Session pooler** for a persistent Node.js backend that may be running on an IPv4-only host.
2. Copy the full PostgreSQL connection string. Do not guess the pooler hostname or username; copy the value shown in your project.
3. The connection string has a password in it. Never put it in a public file, a screenshot, or GitHub.

Official guide: https://supabase.com/docs/guides/database/connecting-to-postgres

### 3. Put the project into GitHub

1. Download and extract the ZIP file on your device.
2. Create a new **private** repository on GitHub.
3. Upload the extracted project contents, keeping the `public` folder and its files in that folder. At the top level, `server.js`, `package.json`, `schema.sql`, `render.yaml`, and `public/` should be visible.
4. Do **not** upload a real `.env` file or any database password. The included `.env.example` only contains placeholders.

If uploading folders from a phone is awkward, don't publish a partial repository. Ask for help with the exact screen you see and continue from there.

### 4. Create the web service on Render

The included `render.yaml` describes the Node.js web service. In Render, create a new Blueprint from your GitHub repository if that option is shown, or create a **Web Service** connected to that repository with:

- **Runtime:** Node
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/health`

Choose the Free plan to try it. If you use the `render.yaml` Blueprint, add the requested environment values to the service when Render asks for them.

### 5. Add environment variables on Render

Open your Render service's **Environment** settings and set these values:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | The private Supabase Session Pooler connection string from Step 2 |
| `COOKIE_SECRET` | A long, random secret of at least 32 characters, different from every password |
| `ADMIN_USERNAME` | A private organiser username, for example `expo-organiser` |
| `ADMIN_PASSWORD` | A strong, unique organiser password |
| `SCHOOL_NAME` | The school name displayed on the pages |
| `EXHIBITION_NAME` | For example, `Mathematics Exhibition 2026` |

Use your own values. Keep all secrets private and do not send them in chat. Save the values and deploy/redeploy the service.

### 6. Verify that it is online

Once Render displays the service URL, open:

- `https://YOUR-SERVICE.onrender.com/health` — expected result: `{"ok":true,"database":"connected"}`
- `https://YOUR-SERVICE.onrender.com/admin` — organiser sign-in
- `https://YOUR-SERVICE.onrender.com/?stall=1` — test visitor form for the first stall (after the database is connected)

Replace `YOUR-SERVICE` with your actual service name. If `/health` reports a database problem, recheck the private connection string and environment variables before collecting feedback.

### 7. Personalise the stalls and questions

1. Sign in at `/admin` using `ADMIN_USERNAME` and `ADMIN_PASSWORD` from Render's environment settings.
2. Open **Stalls** and replace `Stall 1`, `Stall 2`, etc. with the real project names and descriptions. Add any additional stalls as needed.
3. Open **Questions**, select a stall, and add its questions. Each stall can have its own question set. The built-in overall rating question is protected so the dashboard can compare results consistently.
4. In **QR codes**, generate the QR sheet and print it. A QR code is unique to that stall's internal link, even when you add new stalls.

### 8. Test before the event

Use the same phone and same browser to submit a test review for one stall. Reopen that same stall's QR link in the same browser: it should report that feedback was already received. Open a different stall's link: it should allow a separate review. Also test on a second phone, download both export formats, and confirm that all feedback appears in the dashboard.

Do not rely on the duplicate check as proof of a unique person. The mechanism limits repeated reviews from the same retained browser cookie. Clearing browser cookies, using another browser or another device creates a new anonymous browser identity.

## Data and operational notes

- An internet connection is required at each stall while reviews are submitted.
- PostgreSQL stores the feedback; the app does not write reviews to Render's local filesystem.
- A free Render web service may sleep during quiet periods and the first request after sleep may be slow. Open and test the site well before visitors arrive. For a high-stakes event, consider a reliable paid hosting arrangement or a paper backup.
- Free plans have limits; review current hosting usage and test the planned visitor load. Do not promise unlimited visitors or uninterrupted availability.
- Feedback exports may contain comments written by visitors. Keep them within the school and handle them responsibly.
- The organiser password is checked by this app and must be strong. Keep the GitHub repository private during setup and never commit database credentials.
