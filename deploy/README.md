# Deploying Plainvote

The local demo (`npm run demo`) generates `.data/` with absolute paths and fixed
localhost ports. None of that survives a container, so a hosted network is
assembled differently: **every service takes its configuration from environment
variables**, and the keys are generated once, up front, outside the repo.

This directory holds the container definitions and a provisioning script for
Railway. Nothing here is Railway-specific except `railway-up.mjs` - the
Dockerfiles and the entrypoints in `scripts/railway/` run anywhere.

## The services

| Service | Image | Public? | Why |
|---|---|---|---|

| `node1` `node2` `node3` | `chain-node.Dockerfile` | yes | The public record. Browsers read tallies and submit ballots directly, and anyone can recount from them. |
| `registrar` | `registrar.Dockerfile` | yes | Voters' browsers request blind-signed credentials from it. |
| `voter-ui` | `voter-ui.Dockerfile` | yes | Cast a ballot. |
| `commission-ui` | `commission-ui.Dockerfile` | yes | Create and manage elections. |
| `results-ui` | `results-ui.Dockerfile` | yes | Public tallies, block explorer, receipt verification. |

Nodes gossip over the **private** network (`node2.railway.internal:8080`), never
the public internet, and the registrar submits its transactions the same way.
Only browser-facing traffic uses the public domains. Services bind `::` because
Railway's private network is IPv6-only; that is dual-stack, so the public HTTP
proxy still reaches them over IPv4.

`node1`–`node3` and `registrar` each mount a volume at `/data` - chain blocks
and the registrar's SQLite database must survive a redeploy.

## Runtime configuration, not build-time

Vite bakes `import.meta.env` into the bundle. Baking service URLs in would mean
rebuilding all three apps to repoint one service, and a deadlock on first
deploy: the apps must be built before the services they point at have domains.

Instead `scripts/railway/serve-static.mjs` injects `window.__PLAINVOTE_CONFIG__`
into `index.html` on the way out, and the apps prefer it over `import.meta.env`.
`VITE_*` still works for local development.

## Deploying a new network

```bash
tsx scripts/provision-network.ts --out ../plainvote-network.json --validators 3 --slot-seconds 5
```

Writes the genesis and **every secret key in the network** to one file, mode
`600`. It is the thing an attacker most wants: keep it out of the repo, back it
up, and note that losing it means the commission can never sign another
election on this chain.

```bash
railway init --name Plainvote
node deploy/railway-up.mjs ../plainvote-network.json --repo cnyako/plainvote
```

Idempotent - it skips services, volumes, and domains that already exist, so
re-run it to repoint or repair a deployment. Then seed, if you want the network
immediately demonstrable:

```bash
COMMISSION_SECRET_KEY=… ADMIN_API_KEY=… tsx scripts/seed-demo-election.ts \
  --node https://…  --registrar https://… --codes 25 --out ../demo-codes.txt
```

Seeding runs from an operator's machine against the public URLs. **For a
concierge election the commission signing key is never uploaded to a server** -
that is the point: the commission signs, the host only hosts.



## What this deployment does and does not prove

The engine's central claim is that the record is kept in parallel by
organizations that would have to collude to alter it. **A network whose three
nodes run in one Railway project, on one account, paid by one card, does not
have that property.** It is a correct, fully functional deployment of the
software, and it demonstrates every mechanism - blind-signed credentials,
public recount, stuffing detection, cross-node agreement - but the three
record-keepers are not independent, and copy about this deployment must not
say they are.

Real independence means `PEERS` pointing at nodes run by other organizations,
on their own infrastructure, with their own validator keys in genesis. The
software is already built for that; only the deployment topology has to change.

Two other things to know before pointing a real election at this:

- **The commission app is public and unauthenticated.** It is only inert
  because the commission secret key and the registrar admin key live in the
  operator's browser (`localStorage`), pasted in via the Setup tab. Anyone can
  load the page; nobody can do anything without those keys. Restricting it at
  the edge is worth doing before a real election.
- **Ballots are plaintext on-chain.** That is what makes a public recount
  possible, and it is the deliberate tradeoff against Helios/Belenios-style
  encrypted tallies. `resultsVisibility: afterClose` hides interim results by
  convention only. See `docs/SECURITY.md`.
