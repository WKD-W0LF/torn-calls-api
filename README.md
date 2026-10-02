# torn-calls-api

TWI Faction Calls backend API (v2) — deployed on OpenShift (GPU4 cluster, `discord-dev` namespace) as the `twi-chain-portal` service.

Provides the server-side API for the TWI Faction Calls feature in the `TWI_Faction_Calls_Universal.user.js` userscript. Handles target call management with priority and assist-request flags.

## Architecture

- **Runtime**: Node.js 22 on `ubi9/nodejs-22-minimal`
- **Database**: PostgreSQL (`torn_calls` database, `twi_chain_portal` user)
- **Auth**: Per-request Torn API faction membership verification — the user's Torn API key is validated against faction **56966 (Twilight – Reborn)** on each request, with a 60-second result cache to avoid hammering the Torn API
- **Replicas**: 2 (HA across nodes)
- **Route**: `https://twi-chain-portal-discord-dev.apps.gpu4.fusion.isys.hpc.dc.uq.edu.au`

## API

All endpoints except `/health` and `/ready` require `Authorization: Bearer <torn-api-key>` where the key is the caller's 16-character Torn API key.

### List active calls

```http
GET /api/v1/calls
Authorization: Bearer <torn-api-key>
```

### Claim a target

```http
POST /api/v1/calls
Authorization: Bearer <torn-api-key>
Content-Type: application/json

{
  "targetId": "1234567",
  "targetName": "Enemy",
  "calledById": "7654321",
  "calledByName": "WKD-W0LF",
  "priority": false,
  "assistRequested": false
}
```

Calls expire after `CLAIM_TTL_SECONDS` seconds (default 90).

### Update a call (priority / assist flag)

```http
PATCH /api/v1/calls/:targetId
Authorization: Bearer <torn-api-key>
Content-Type: application/json

{ "priority": true }
```

### Release a target

```http
DELETE /api/v1/calls/:targetId
Authorization: Bearer <torn-api-key>
```

### Clear all calls

```http
DELETE /api/v1/calls
Authorization: Bearer <torn-api-key>
```

## Environment variables

| Variable | Source | Description |
|----------|--------|-------------|
| `PGHOST` | `twi-chain-portal-db` | PostgreSQL hostname (`postgresql`) |
| `PGPORT` | `twi-chain-portal-db` | PostgreSQL port (`5432`) |
| `PGDATABASE` | `twi-chain-portal-db` | Database name (`torn_calls`) |
| `PGUSER` | `twi-chain-portal-db` | DB user (`twi_chain_portal`) |
| `PGPASSWORD` | `twi-chain-portal-db` | DB password |
| `FACTION_ID` | env | Torn faction ID to verify membership against (default `56966`) |
| `CLAIM_TTL_SECONDS` | env | Call expiry in seconds (default `90`) |
| `AUTH_CACHE_TTL_MS` | env | How long to cache a valid Torn API key result in ms (default `60000`) |
| `ALLOWED_ORIGIN` | env | CORS allowed origin (default `https://www.torn.com`) |

## Building and deploying

This is a **binary build** — source is pushed directly from a local directory:

```bash
oc start-build twi-chain-portal -n discord-dev --from-dir=. --follow
oc rollout restart deployment/twi-chain-portal -n discord-dev
```

## Database schema

The app auto-creates tables on startup (requires table owner permissions):

```sql
CREATE TABLE torn_target_calls (
  target_id        BIGINT       PRIMARY KEY,
  target_name      VARCHAR(64)  NOT NULL,
  called_by_id     BIGINT       NOT NULL,
  called_by_name   VARCHAR(64)  NOT NULL,
  called_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  priority         BOOLEAN      NOT NULL DEFAULT FALSE,
  assist_requested BOOLEAN      NOT NULL DEFAULT FALSE
);
```

The `twi_chain_portal` PostgreSQL user must own this table. Run once as `postgres`:

```sql
ALTER TABLE torn_target_calls OWNER TO twi_chain_portal;
ALTER INDEX torn_target_calls_expires_at_idx OWNER TO twi_chain_portal;
```

## Changelog

### 2026-10-02
- **Added `Dockerfile`** and restructured source into `src/server.js` to match expected build layout
- **Replaced static `API_TOKEN` auth** with per-request Torn API faction membership verification (faction 56966) with 60-second result cache
- **Added `priority` and `assistRequested` fields** to calls with full PATCH support
- **Fixed deployment probes**: updated readiness/liveness/startup probes from old `/login:8080` to `/ready:3000` and `/health:3000`
- **Fixed deployment command override**: removed old `node server.js` shell command override, now uses Dockerfile `CMD`
- **Created `twi_chain_portal` PostgreSQL user** and granted ownership of `torn_target_calls` table
- **Scaled to 2 replicas** for high availability
