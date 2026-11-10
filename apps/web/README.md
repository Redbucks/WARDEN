# WARDEN Web

The WARDEN frontend is a React and TypeScript dashboard for autonomous treasury policy monitoring and approval workflows.

## Development

Install dependencies:

```powershell
npm install
```

Start the Vite development server:

```powershell
npm run dev
```

Open `http://localhost:5173`.

The frontend expects the WARDEN API at `http://localhost:3001` by default. Set `VITE_API_URL` to override the API origin if required.

## Available scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run lint` | Run Oxlint |
| `npm run build` | Run TypeScript checks and create a production build |
| `npm run preview` | Preview the production build |

## Main features

- API access control using a bearer token entered through the application.
- NEAR Testnet wallet connection.
- Read-only NEAR Testnet account verification.
- Transfer proposal submission and policy evaluation.
- Approval queue and decision review.
- Transfer history, audit trail, and simulated execution visibility.

## Security notes

The API token is kept in frontend application memory and is not stored in browser local storage. Do not put API secrets in frontend environment variables, source files, or committed configuration.

Wallet connection and RPC account verification do not mean that a blockchain transaction has been signed or submitted.

WARDEN currently operates in simulation-only mode. No real funds are moved.
