# Bhejo

Browser-to-browser file transfer using WebRTC. The server only handles signaling, room coordination, runtime ICE config, and metrics.

## What changed

- Runtime STUN/TURN config now comes from `/api/config` instead of hardcoded browser values.
- Redis-backed rooms are supported through `REDIS_URL`, so multiple app instances can share room state.
- Prometheus metrics are available at `/metrics`.
- Transfer telemetry is reported from the browser to the server for file and byte counters.
- Docker, Prometheus, and Grafana files are included for self-hosted deployment.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Why deployed peers often fail to connect

When the app is deployed, the signaling server may be healthy while WebRTC still fails. The most common cause is TURN reliability, not rooms or WebSockets.

- Same Wi-Fi or same LAN usually works with STUN and host candidates.
- Different networks often need a real TURN service.
- Public demo TURN relays are fine for testing, but they are not reliable enough for production.

## Environment variables

```env
PORT=3000
NODE_ENV=production
ROOM_EXPIRY=600000

# Optional Redis room store
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=bhejo

# Optional ICE runtime config
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:443?transport=tcp
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-password
ICE_TRANSPORT_POLICY=all
ICE_CANDIDATE_POOL_SIZE=10

# Metrics
METRICS_ENABLED=true
```

## Deployment notes

### Render or Railway

- Keep a single instance if you do not have Redis yet.
- Set `REDIS_URL` only after provisioning Redis.
- Set TURN credentials through environment variables.
- Use HTTPS so the app can use secure browser APIs consistently.

### Docker

Docker is a good deployment option here because it gives you one repeatable package for:

- the Node signaling app
- Redis
- Prometheus
- Grafana

It does not solve WebRTC traversal by itself. You still need good TURN credentials for cross-network reliability.

## Monitoring

- Prometheus scrape target: `http://app:3000/metrics`
- Grafana default local URL with Docker Compose: `http://localhost:3001`
- Prometheus local URL with Docker Compose: `http://localhost:9090`

Tracked metrics include:

- websocket connections
- local room count
- room create and join events
- signaling message counts
- file sent and file received events
- transferred bytes reported by clients

## Free-ish stack suggestion

- App hosting: Render free web service or a single low-cost container host
- Redis: Upstash free Redis (`256 MB`, `500K` commands/month at the time of writing)
- Monitoring: Grafana Cloud free, or the included local Grafana + Prometheus stack
- TURN: Metered free trial is usable for testing, but not a forever-free production answer
