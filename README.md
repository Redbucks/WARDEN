# WARDEN

**Autonomous Treasury Security**

WARDEN is a policy-enforcement and decision-audit layer for NEAR treasury operations. It evaluates proposed transfers, checks recipient eligibility, applies deterministic spending limits, routes higher-risk proposals for human approval, and records decisions.

> **Current status: MVP / NEAR Testnet / Simulation only.** WARDEN can connect a Testnet wallet and verify account information through the NEAR RPC. It does not currently sign or submit blockchain transactions, and simulated executions do not move funds.

## What WARDEN does

- **Evaluate transfer proposals:** Apply deterministic policy rules before a transfer can proceed.
- **Enforce spending boundaries:** Use exact yoctoNEAR integer arithmetic to avoid floating-point errors.
- **Verify recipients:** Check NEAR Testnet account existence using finalized RPC account data.
- **Control recipient trust:** Use a server-managed trusted-recipient registry rather than trusting caller-supplied trust flags.
- **Require human approval:** Route proposals requiring additional authorization into an approval queue.
- **Protect execution:** Revalidate policy, approval state, recipient trust, and transfer details before allowing a simulation.
- **Maintain an audit trail:** Record policy evaluations, approval decisions, and simulated execution events.
- **Authenticate API access:** Require a server-configured bearer token for protected API routes.

## Policy boundaries

The current policy configuration includes:

| Rule | Current behaviour |
|---|---|
| Autonomous threshold | Up to 0.01 NEAR, subject to recipient trust and policy checks |
| Approval threshold | Transfers requiring additional authorization are routed for review |
| Hard transfer limit | 1 NEAR |
| Invalid amount or recipient | Blocked |
| Unverified or nonexistent Testnet recipient | Fails closed |
| Blocked or rejected proposal | Cannot be simulated |
| Duplicate simulated execution | Rejected |

The policy engine uses yoctoNEAR integer values for amount comparisons and persistence. These limits are application policy settings, not guarantees about network-level transaction limits.

## Architecture

```text
NEAR Testnet wallet
        |
        v
React + TypeScript frontend
        |
        | Bearer-token authenticated API requests
        v
Express + TypeScript API
        |
        +---- Policy evaluation
        |
        +---- NEAR Testnet RPC verification
        |
        +---- Trusted-recipient registry
        |
        +---- Approval workflow
        |
        +---- Simulation execution gate
        |
        v
SQLite persistence
        |
        +---- Transfer requests
        +---- Approvals
        +---- Simulated executions
        +---- Audit events
```

### Technology

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Wallet integration | `@hot-labs/near-connect` |
| Charts and icons | Recharts, Lucide React |
| Backend | Node.js, Express 5, TypeScript |
| Database | SQLite using Node's built-in `node:sqlite` |
| Network verification | NEAR Testnet JSON-RPC |
| Tests | Node.js native test runner |

## Repository structure

```text
WARDEN/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   └── server.ts
│   │   ├── tests/
│   │   │   └── simulate-execution.test.ts
│   │   ├── .env.example
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── App.css
│       │   ├── index.css
│       │   └── main.tsx
│       └── package.json
└── README.md
```

## Requirements

- Node.js 24 or a compatible recent Node.js release
- npm
- Windows, macOS, or Linux
- A NEAR Testnet-compatible wallet for wallet connection and account verification

## Local setup

### 1. Configure the API

Open a terminal:

```powershell
cd apps/api
npm install
Copy-Item .env.example .env
```

Generate a random API token of at least 32 characters. For example, in PowerShell:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes)
$token
```

Put the generated value in `apps/api/.env`:

```dotenv
WARDEN_API_TOKEN=YOUR_GENERATED_SECRET
WARDEN_REVIEWER=WARDEN Operator
PORT=3001
WEB_ORIGIN=http://localhost:5173
```

Keep `.env` private. Do not commit it, expose it in screenshots, or place the API token in frontend source code or a `VITE_*` environment variable.

### 2. Build and start the API

```powershell
npm run build
npm start
```

The API listens on:

```text
http://localhost:3001
```

Health endpoint:

```text
http://localhost:3001/api/health
```

The health endpoint is public. Other `/api` routes require a valid bearer token.

### 3. Start the frontend

Open a second terminal:

```powershell
cd apps/web
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Enter the API token through the application's access-control interface. The frontend keeps the token in application memory; refreshing the page requires authentication again.

The frontend's API base defaults to `http://localhost:3001` and can be overridden with `VITE_API_URL` when configuring a different API origin. Never use a `VITE_*` variable for secrets.

## API overview

Protected routes require:

```http
Authorization: Bearer YOUR_API_TOKEN
```

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Public service and execution-mode health |
| GET | `/api/audit` | Retrieve audit events |
| POST | `/api/policy/evaluate` | Evaluate and persist a transfer proposal |
| GET | `/api/transfers` | List transfer requests |
| GET | `/api/transfers/:id` | Retrieve a transfer and its approval information |
| GET | `/api/approvals` | List approval records |
| POST | `/api/approvals/:id/decision` | Record an approval or rejection |
| POST | `/api/transfers/:id/simulate-execution` | Attempt guarded simulated execution |
| GET | `/api/executions` | List simulated execution records |
| POST | `/api/near/validate-recipient` | Validate a NEAR Testnet recipient |
| GET | `/api/near/account/:accountId` | Read Testnet account information through RPC |

The server determines reviewer identity from configuration. A caller cannot choose an arbitrary reviewer identity in an approval decision request.

## Security and execution model

WARDEN is designed to fail closed when required checks cannot be completed.

Before a simulation can proceed, the API checks relevant transfer state, policy decision, approval linkage and status, amount, currency, recipient, and current recipient trust. A previously simulated transfer cannot be simulated again.

The execution endpoint is deliberately simulation-only. A successful simulation is recorded with an explicit simulated status and `realFundsMoved: false`.

**WARDEN does not currently implement:**
- NEAR transaction signing
- Private-key custody or management
- On-chain transaction submission
- On-chain execution confirmation
- Production-grade user identity, roles, or multi-operator authorization

The shared bearer token is a demo access-control mechanism, not a complete production identity system.

## Testing

From `apps/api`:

```powershell
npm test
```

The test command builds the API, compiles the test TypeScript, and runs the compiled tests with Node's native test runner.

The suite covers API authentication, reviewer identity protection, legacy unlinked approval protection, NEAR recipient validation and RPC failures, policy evaluation, trusted-recipient enforcement, approval integrity, simulation execution gates, duplicate protection, and exact yoctoNEAR amount handling.

Latest recorded verification: **46 tests passed, 0 failed.**

From `apps/web`:

```powershell
npm run lint
npm run build
```

Latest recorded verification: Oxlint reported zero warnings and zero errors; the TypeScript and Vite production build completed successfully.

## Known limitations

- This is an MVP and local test environment, not a production treasury deployment.
- NEAR RPC access is read-only.
- Execution is simulated; no real funds move.
- The API uses a shared bearer token rather than individual operator accounts.
- Trusted-recipient management is server-side and should be administered carefully.
- Local database records include historical demo data; they should not be interpreted as live on-chain transaction history.
- The API's local development workflow may require building before starting the compiled server on Windows environments where the `tsx`/esbuild watcher cannot start.

## Demo flow

A reviewer can:

1. Open the WARDEN control centre.
2. Authenticate with the configured API token.
3. Connect a NEAR Testnet-compatible wallet.
4. Inspect the account's finalized RPC verification.
5. Submit a transfer proposal.
6. Review the policy decision and any generated approval.
7. Approve or reject a linked proposal.
8. Inspect the audit trail and simulated execution history.
9. Confirm that rejected, blocked, invalid, or duplicate execution attempts are denied.

No step in this demo transfers real funds.

## Project objective

WARDEN demonstrates how an autonomous treasury system can be constrained by deterministic policy, recipient verification, human approval, and an auditable execution boundary—before real transaction signing and submission are introduced.

---

**WARDEN — Autonomous Treasury Security**
*MVP · NEAR Testnet · Simulation only*