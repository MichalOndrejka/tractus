# n8n orchestration

n8n is the **trigger**. On a schedule it calls the backend's
`POST /api/dispatch/tick`. The backend does the actual dispatch decision: it
scans each project's **Ready** column (top = highest priority = the queue) and
starts the **Architect** on the next item whenever a slot is free, respecting
the concurrency + budget limits. Anything that doesn't fit a slot waits in
Ready until the next tick — that's your queue, no extra infra needed.

```
n8n (Schedule trigger)  ──POST /api/dispatch/tick──▶  backend
                                                       ├─ Ready column = queue
                                                       ├─ canDispatch() = admission control
                                                       └─ launches Architect container
```

Only the Architect auto-picks-up (it's first in the flow). Developer/Tester
run after the plan/merge approval gates, which are the next n8n workflows to
build.

## One-time setup

1. **Pick a shared secret** and put it in the backend env (`apps/backend/.env`):

   ```
   DISPATCH_TOKEN=<some-long-random-string>
   ```

   Restart the backend so it picks this up. Without it set, `/api/dispatch/tick`
   requires a logged-in browser session and n8n can't call it.

2. **Start n8n:**

   ```bash
   cd infra/n8n
   docker compose up -d
   ```

   Open http://localhost:5678 and create the local n8n owner account.

3. **Import the workflow:** in n8n, *Workflows → ⋯ → Import from File* and pick
   `dispatch-workflow.json`.

4. **Set the token:** open the **Dispatch tick** node and replace
   `REPLACE_WITH_DISPATCH_TOKEN` in the `x-dispatch-token` header with the same
   value you used for `DISPATCH_TOKEN`. Save.

   > The URL is `http://host.docker.internal:8787/...` on purpose — inside the
   > container `localhost` is the container itself, not your PC. If your backend
   > runs on a different port, change it here.

5. **Activate** the workflow (toggle, top-right). It now ticks every minute.

6. In the app, open a project Board and turn **Auto-dispatch ON** (header
   button). The tick is a no-op while this switch is off, so this is your master
   on/off.

## Try it

- Drop a work item in **Ready**, ranked at the top.
- Within ~a minute (or hit **Run dispatch now** on the board to skip the wait),
  the Architect picks it up, the item moves to **In Progress**, and the card
  shows the working agent live.

## Cost / safety

- With **no `ANTHROPIC_API_KEY`** or with **`AGENT_DRY_RUN=1`** in the backend
  env, ticks are free rehearsals — containers simulate, nothing is pushed, no
  tokens spent. Use this to verify the loop end-to-end.
- With a real key and dry-run off, a pickup spends tokens and opens a PR. The
  master **Auto-dispatch** switch and the `CONCURRENCY_LIMIT` / `DAILY_BUDGET_USD`
  limits are your guardrails.

## Manual tick (without n8n)

You don't need n8n to test dispatch — the board's **Run dispatch now** button
calls the same endpoint with your session. n8n just automates that call on a
timer.
