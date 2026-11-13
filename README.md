# WARDEN

**Autonomous Treasury Security**

WARDEN is a policy-enforcement and execution-verification layer for NEAR treasury operations. It helps constrain autonomous treasury activity through deterministic spending policies, trusted-recipient checks, human approval, wallet-authorized Testnet execution, and an auditable decision trail.

> **Status: MVP | NEAR Testnet | Experimental**
>
> WARDEN supports both guarded simulation and a separate wallet-authorized NEAR Testnet transaction flow. Testnet execution requires explicit wallet approval. WARDEN does not custody private keys or sign transactions server-side. This is not a production treasury deployment.

## The problem

Autonomous agents can make financial decisions quickly, but treasury systems need enforceable boundaries around where funds go, how much can be transferred, who authorizes exceptions, and whether an execution actually happened.

WARDEN provides a control layer between a proposed transfer and its execution.

## What WARDEN does

- **Evaluate proposals:** Apply deterministic policy rules before execution.
- **Enforce spending limits:** Use exact yoctoNEAR integer arithmetic rather than floating-point comparisons.
- **Verify recipients:** Check NEAR Testnet account information through RPC.
- **Control recipient trust:** Consult a server-managed trusted-recipient registry rather than caller-supplied trust flags.
- **Require human approval:** Route proposals outside autonomous policy boundaries into an approval workflow.
- **Authorize Testnet execution:** Create a time-limited execution intent and request the user's approval through their connected wallet.
- **Verify on-chain results:** Independently validate transaction details and execution outcomes through NEAR RPC at finality.
- **Prevent duplicate execution:** Apply intent, transaction-hash, and transfer-state protections.
- **Maintain an audit trail:** Record policy evaluations, approval decisions, execution intents, submitted hashes, and verification outcomes.
- **Authenticate API access:** Protect API routes with a server-configured bearer token.

## How it works

```text
Transfer proposal
       |
       v
Deterministic policy evaluation
       |
       +------ BLOCK ----------------> Denied
       |
       +------ REQUIRES_APPROVAL ----> Human review
       |                                   |
       |                                   v
       |                              Approved?
       |                                   |
       +-----------------------------------+
                                           |
                                           v
                              Server-side execution checks
                                           |
                                           v
                               Time-limited execution intent
                                           |
                                           v
                                Connected NEAR wallet
                                           |
                                  User reviews and signs
                                           |
                                           v
                                  NEAR Testnet transaction
                                           |
                                           v
                               Backend RPC verification
                                      at finality
                                           |
                              +------------+------------+
                              |                         |
                              v                         v
                           VERIFIED                  FAILED
                              |
                              v
                         Audit trail
```

The wallet controls transaction signing. WARDEN's backend independently verifies the submitted transaction; it does not possess the user's private key.

## Policy boundaries

The current policy configuration includes:

| Rule | Behaviour |
|---|---|
| Autonomous threshold | Up to 0.01 NEAR, subject to recipient trust and policy checks |
| Approval threshold | Proposals requiring additional authorization enter human review |
| Hard transfer limit | 1 NEAR |
| Invalid amount or recipient | Blocked |
| Unverified or nonexistent Testnet recipient | Fails closed |
| Untrusted recipient | Cannot proceed through the trusted-recipient execution path |
| Blocked or rejected proposal | Cannot execute |
| Duplicate execution | Rejected |

Amounts are represented and compared using yoctoNEAR integer values. These are application policy settings, not network-level guarantees.

## Execution modes

### 1. Guarded simulation

The simulation endpoint tests the policy and approval gates without broadcasting a blockchain transaction.

A successful simulation is explicitly recorded as `SIMULATED`, with `realFundsMoved: false`.

### 2. Wallet-authorized NEAR Testnet execution

The separate on-chain flow:

1. Revalidates the transfer, policy decision, approval, recipient trust, and amount.
2. Creates a time-limited, single-use execution intent.
3. Passes the transaction details to the connected wallet.
4. Requires the wallet user to approve and sign the transaction.
5. Receives the submitted transaction hash.
6. Independently verifies the transaction through NEAR RPC at finality.
7. Checks the signer, receiver, transfer action, exact yoctoNEAR deposit, transaction outcome, and receipt outcomes.
8. Persists the verification state and corresponding audit events.

The backend does not sign transactions or store private keys.

## Verified Testnet demonstration

WARDEN has completed an independently verified NEAR Testnet transfer:

| Field | Verified result |
|---|---|
| Transfer | #10 |
| Network | NEAR Testnet |
| Sender | `datitan.testnet` |
| Recipient | `redbucks.testnet` |
| Amount | 0.001 NEAR |
| Policy | `REQUIRES_APPROVAL` |
| Approval | #9 — approved |
| On-chain state | `VERIFIED` |
| Transaction hash | `FZPbXMb27Qm29Pqfh5mWKURGJ2pXrPUE7nXkf5wnCSvq` |

[View the transaction on NEAR Testnet Explorer](https://testnet.nearblocks.io/txns/FZPbXMb27Qm29Pqfh5mWKURGJ2pXrPUE7nXkf5wnCSvq).

This is Testnet evidence only. It is not a Mainnet transaction or a claim of production readiness.

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Wallet integration | `@hot-labs/near-connect` |
| Backend | Node.js, Express 5, TypeScript |
| Database | SQLite using Node's built-in `node:sqlite` |
| Blockchain | NEAR Testnet JSON-RPC |
| Testing | TypeScript and Node.js native test runner |

### Repository structure

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

- Node.js 24
- npm
- A NEAR Testnet-compatible wallet for wallet connection and Testnet execution

## How Hackathon Judges Can Run WARDEN

Judges do **not** need the project owner's API token or wallet credentials. Each reviewer running WARDEN locally creates their own API token and uses their own optional NEAR Testnet wallet.

The API token is a local development credential. It is not included in the repository and must never be shared in a submission, issue, screenshot, or demo recording.

### Quick start (Windows PowerShell)

Clone the public repository and open the project folder:

```powershell
git clone https://github.com/Redbucks/WARDEN.git
cd WARDEN
```

**Terminal 1 — API**

```powershell
cd apps/api
npm ci
Copy-Item .env.example .env
```

Open `apps/api/.env`, replace the example `WARDEN_API_TOKEN` with a unique random secret of at least 32 characters, and save the file. Keep this token private.

Then build and start the API:

```powershell
npm run build
npm start
```

**Terminal 2 — frontend**

From the repository root in a second PowerShell window:

```powershell
cd apps/web
npm ci
npm run dev
```

Open `http://localhost:5173` and enter the same locally generated API token in WARDEN's access screen.

The API health endpoint is available at `http://localhost:3001/api/health`. Protected API routes require the reviewer's own bearer token.

### Wallet and execution notes

- A judge can inspect the code and run the local application using their own API token; the project owner's token is not required.
- Connecting a NEAR Testnet-compatible wallet is only needed for wallet-dependent features.
- Any Testnet transaction requires the reviewer to use their own wallet and explicitly approve the transaction. Never use another person's seed phrase or private key.
- Simulation is separate from on-chain execution and does not move funds.
- WARDEN is an experimental Testnet MVP, not a production treasury service.

## Local setup

### 1. Configure the API

```powershell
cd apps/api
npm ci
Copy-Item .env.example .env
```

Generate a random API token of at least 32 characters:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes)
$token
```

Set the generated token in `apps/api/.env`. Keep the other values consistent with `.env.example`.

Example:

```dotenv
WARDEN_API_TOKEN=YOUR_GENERATED_SECRET
WARDEN_REVIEWER=WARDEN Operator
PORT=3001
WEB_ORIGIN=http://localhost:5173
NEAR_TESTNET_TX_RPC_URL=https://archival-rpc.testnet.fastnear.com
```

Never commit `.env`, expose the API token, or put secrets in frontend `VITE_*` variables.

### 2. Build and start the API

From `apps/api`:

```powershell
npm run build
npm start
```

The API runs at:

```text
http://localhost:3001
```

Health endpoint:

```text
http://localhost:3001/api/health
```

The health endpoint is public. Protected API routes require a valid bearer token.

### 3. Start the frontend

Open a second terminal:

```powershell
cd apps/web
npm ci
npm run dev
```

Open:

```text
http://localhost:5173
```

Authenticate through the application's access-control interface. The frontend keeps the API token in application memory, so refreshing the page requires authentication again.

The frontend API base defaults to `http://localhost:3001`. `VITE_API_URL` can override the API origin. Never use a `VITE_*` variable for secrets.

## API overview

Protected routes require:

```http
Authorization: Bearer YOUR_API_TOKEN
```

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Service and execution-mode health |
| GET | `/api/audit` | Retrieve audit events |
| POST | `/api/policy/evaluate` | Evaluate and persist a transfer proposal |
| GET | `/api/transfers` | List transfers and persisted execution information |
| GET | `/api/transfers/:id` | Retrieve transfer details |
| GET | `/api/approvals` | List approval records |
| POST | `/api/approvals/:id/decision` | Record an approval or rejection |
| POST | `/api/transfers/:id/simulate-execution` | Attempt guarded simulation |
| GET | `/api/executions` | List simulated execution records |
| POST | `/api/near/validate-recipient` | Validate a NEAR Testnet recipient |
| GET | `/api/near/account/:accountId` | Retrieve Testnet account information |
| POST | `/api/transfers/:id/onchain-intent` | Create a guarded Testnet execution intent |
| POST | `/api/onchain-executions/:intentId/submit` | Submit a wallet-returned transaction hash for verification |

The server determines reviewer identity from configuration. A caller cannot choose an arbitrary reviewer identity in an approval decision request.

## Security model and limitations

WARDEN is designed to fail closed when required checks cannot be completed.

Important boundaries:

- Wallet signing is user-authorized; the backend does not custody or use private keys.
- The on-chain execution flow is for NEAR Testnet, not Mainnet.
- The simulation endpoint does not move funds.
- The backend independently verifies transaction details rather than trusting a frontend success message.
- Execution intents are time-limited and designed for single use.
- The API uses a shared bearer token for this MVP, not a complete production identity and role-management system.
- Trusted-recipient management is server-side.
- Test coverage includes mocked RPC scenarios; passing tests do not replace live network verification.
- Local database records may include historical demo data and should not be treated as blockchain history.

This project is an experimental MVP, not a production-ready custody system or a guarantee against all smart-contract, wallet, RPC, or operational risks.

## Testing

From `apps/api`:

```powershell
npm test
```

The test script builds the API, compiles the TypeScript tests, and runs them using Node's native test runner.

The test suite covers API authentication, reviewer identity protection, recipient validation, policy evaluation, trusted-recipient enforcement, approval integrity, simulation execution, duplicate protection, exact yoctoNEAR arithmetic, and on-chain execution verification scenarios.

From `apps/web`:

```powershell
npm run lint
npm run build
```

These commands run Oxlint and the TypeScript/Vite production build.

Test counts and build results should be taken from the latest actual run, not assumed from an earlier development session.

## Demo flow

A reviewer can:

1. Open the WARDEN control centre.
2. Authenticate with the configured API token.
3. Connect a NEAR Testnet-compatible wallet.
4. Inspect the account's RPC verification.
5. Submit a transfer proposal.
6. Review the policy decision and any required approval.
7. Approve or reject the linked proposal.
8. Inspect the audit trail.
9. For an eligible transfer, request an execution intent and review the transaction in the wallet.
10. Approve the transaction in the wallet and inspect WARDEN's independent verification result.
11. Open the transaction hash in the Testnet explorer.

The simulation flow and wallet-authorized Testnet flow are separate execution paths.

## Project objective

WARDEN demonstrates how autonomous treasury operations can be constrained by deterministic policy, recipient trust, human approval, explicit wallet authorization, independent execution verification, and an auditable decision trail.

**WARDEN — Autonomous Treasury Security**

*MVP · NEAR Testnet · Wallet-authorized execution · Independent verification*
