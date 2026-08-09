# IRL Among Us — Cloudflare Pages + D1

This version is specifically for **Cloudflare Pages**, not a standalone Worker.

## GitHub structure

```text
/
├── functions/
│   └── api/
│       └── [[path]].js
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── schema.sql
└── README.md
```

Do **not** create or use a `src/` folder for this Pages version.

## Cloudflare Pages build settings

- Framework preset: **None**
- Build command: leave blank
- Build output directory: **public**

Cloudflare Pages automatically detects the root-level `functions/` directory and deploys those files as Pages Functions.

## D1 binding

In Cloudflare Dashboard:

1. Open your Pages project.
2. Go to **Settings → Bindings**.
3. Add a **D1 database** binding.
4. Variable name / binding name: `DB`
5. Select your IRL Among Us database.
6. Add the same binding to Production (and Preview too if you want branch previews to work).
7. Redeploy after changing bindings.

The JavaScript intentionally does not contain a D1 database ID. Pages injects the selected database as `context.env.DB`.

## Create the database tables

Open your D1 database in Cloudflare, go to **Console**, paste the contents of `schema.sql`, and run it.

You only need to do this once per new database.

## API routing

`functions/api/[[path]].js` is a catch-all Pages Function and handles:

- POST `/api/create`
- POST `/api/join`
- GET `/api/state`
- POST `/api/settings`
- POST `/api/tasks`
- DELETE `/api/tasks/:id`
- POST `/api/start`
- POST `/api/task/:id`
- POST `/api/report`
- POST `/api/vote`
- POST `/api/end-voting`
- POST `/api/resume`
- POST `/api/end-game`

## Troubleshooting

If the site loads but creating a game fails:

- Confirm the D1 binding is named exactly `DB`.
- Confirm `schema.sql` has been run against that database.
- Confirm `functions/api/[[path]].js` exists at the repository root (not inside `public`).
- Redeploy the Pages project after adding/changing the binding.
