# Try Realty OS in your browser

The first start takes a few minutes (installing, creating the database, loading the demo team).
When it is ready, a browser tab opens with the sign-in page. If it doesn't, open the **Ports** tab
at the bottom and click the globe icon next to **Realty OS (open this)**.

Every demo account uses the password **`harbor-pine-demo-2026`**.

| Try as | Email |
|---|---|
| Agent (best on a phone-sized window) | `avery@demo.realty-os.test` |
| Team Lead | `lead@demo.realty-os.test` |
| Owner | `owner@demo.realty-os.test` |

The Owner login asks for a 6-digit code. Get one by typing this in the **Terminal** tab and
pressing Enter (it changes every 30 seconds):

```
pnpm demo:totp
```

Texts, emails, calls and the assistant are simulated: nothing reaches a real person.

Start the demo over with fresh data: `pnpm seed --reset`, then `bash .devcontainer/start.sh`.
Logs are in `.devcontainer/logs/`.
