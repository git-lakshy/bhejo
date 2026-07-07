# Bhejo

<p align="center">
  <strong>Peer-to-peer file sharing with WebRTC, QR room join, and relay fallback.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/WebRTC-P2P-0A84FF?style=for-the-badge" alt="WebRTC P2P">
  <img src="https://img.shields.io/badge/WebSocket-Signaling-111827?style=for-the-badge" alt="WebSocket Signaling">
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready">
  <img src="https://img.shields.io/badge/Monitoring-Prometheus%20%2B%20Grafana-E6522C?style=for-the-badge&logo=grafana&logoColor=white" alt="Monitoring">
  <img src="https://img.shields.io/badge/License-MIT-16A34A?style=for-the-badge" alt="MIT License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tag-webrtc-blue?style=flat-square" alt="webrtc">
  <img src="https://img.shields.io/badge/Tag-p2p-blue?style=flat-square" alt="p2p">
  <img src="https://img.shields.io/badge/Tag-file--sharing-blue?style=flat-square" alt="file sharing">
  <img src="https://img.shields.io/badge/Tag-render-blue?style=flat-square" alt="render">
  <img src="https://img.shields.io/badge/Tag-redis-blue?style=flat-square" alt="redis">
  <img src="https://img.shields.io/badge/Tag-grafana-blue?style=flat-square" alt="grafana">
</p>

---

## Overview

Bhejo is a browser-based file sharing application built around WebRTC data channels for direct peer-to-peer transfer. It uses a lightweight Node.js signaling server for room creation and negotiation, QR-based room sharing for cross-device join, and a constrained WebSocket relay fallback for deployments without TURN.

## Looks something like this when using 
![First successful transfer](https://github.com/user-attachments/assets/9c4c4ab8-85ca-47ef-b27d-8d03d676749d)

## Highlights

- Direct file transfer over WebRTC data channels
- Room-based join flow with 6-character room codes
- QR code generation for room sharing
- QR scan join flow for supported browsers
- Runtime ICE configuration from the backend
- Small-file relay fallback for unreliable network paths
- Redis-backed room coordination for multi-instance deployments
- Prometheus metrics and Grafana-ready monitoring setup

## Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js, Express, `ws`
- Realtime: WebRTC, WebSocket
- Infrastructure: Redis, Docker, Prometheus, Grafana


## Quick Start

### Local

```bash
npm install
npm start
```

Open `http://localhost:3000`.

### Docker

```bash
docker compose up --build
```

Services:

- App: `http://localhost:3000`
- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`


## Monitoring

Prometheus metrics are exposed at:

- `/metrics`

Operational endpoints:

- `/health`
- `/api/config`
- `/metrics`



## Notes

- Direct P2P depends on browser, router, and network path quality.
- Relay mode is intentionally capped for low-cost hosting.
- Redis is optional for single-instance deployments.

## License

MIT
