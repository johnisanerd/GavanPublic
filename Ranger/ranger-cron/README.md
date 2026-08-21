# ranger-cron

Minimal cron trigger for Ranger (Trailhead's autonomous research agent).

Runs daily at noon Pacific. Just pokes Trailhead's `/api/ranger/run` endpoint.

## How it works

```
Railway Cron (noon Pacific) → trigger.sh → curl POST → Trailhead
```

All the interesting logic lives in Trailhead. This repo is just the alarm clock.

## Environment Variables

Set in Railway dashboard:

| Variable | Description |
|----------|-------------|
| `TRAILHEAD_URL` | Trailhead server URL (e.g., `https://trailhead.example.railway.app`) |
| `TRAILHEAD_SECRET` | Auth secret for Trailhead API |

## Deployment

```bash
railway up
```
