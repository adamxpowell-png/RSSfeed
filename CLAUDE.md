# RSS Feed Reader

Express + Postgres RSS reader with daily email digests. Backend in `src/` (ES modules), single-page vanilla JS frontend in `public/index.html`. Deployed on Railway at https://rssfeed-production-8f03.up.railway.app.

## Commands

- `npm start` — run the server (`src/server.js`)
- `npm run dev` — run with `--watch`

## Deployment rules

- **Reviewer gate:** hold all pushes until Adam approves. Build and commit locally, report a diff summary, and push only on an explicit go.
- **Push to `main` auto-deploys on Railway.** A push is a production deploy — there is no staging step.
- **Env vars only bind on deploy.** After adding or changing a variable in Railway, use "Apply changes" in the Raw Editor, and use the exact variable name. A variable saved without a redeploy is not visible to the running app.
