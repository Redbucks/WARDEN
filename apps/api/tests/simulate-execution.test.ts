// Automated tests for the WARDEN simulation execution gate:
//   POST /api/transfers/:id/simulate-execution
//
// How it works
// - Uses Node's built-in test runner (node:test) through the existing `tsx`
//   dev dependency, so there is no new framework or dependency.
// - Starts the REAL server (src/server.ts) as a child process whose working
//   directory is a throwaway temp folder. server.ts builds its database path
//   from process.cwd(), so the tests use a temporary data/warden.db and never
//   touch your real data/warden.db (or any .env file).
// - Fixture rows are inserted straight into SQLite, so the tests do not depend
//   on PolicyEngine thresholds, and every request goes through the real HTTP
//   endpoint, so the actual gate code is what is being tested.
// - Nothing here talks to NEAR or any network other than 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const apiRoot = resolve(__dirname, "../..");
const serverEntry = join(apiRoot, "dist", "server.js");

let workDir: string;
let dbPath: string;
let baseUrl: string;
let child: ChildProcess;
let serverLog = "";

const TEST_API_TOKEN =
  "warden-integration-test-token-0123456789abcdef";
const TEST_REVIEWER = "WARDEN Test Operator";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}


// ---- local NEAR RPC mock ----------------------------------------------------

let rpcServer: ReturnType<typeof createHttpServer> | undefined;

function startMockRpc(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    rpcServer = createHttpServer((req, res) => {
      let rawBody = "";

      req.on("data", chunk => {
        rawBody += chunk.toString();
      });

      req.on("end", () => {
        let payload: {
          method?: string;
          params?: {
            account_id?: string;
            tx_hash?: string;
            sender_account_id?: string;
            wait_until?: string;
          };
        };

        try {
          payload = JSON.parse(rawBody);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }

        res.setHeader("Content-Type", "application/json");

        // Transaction lookup mock. No public RPC is contacted.
        if (payload.method === "tx") {
          const txHash = payload.params?.tx_hash ?? "";
          const senderId =
            payload.params?.sender_account_id ?? "warden-signer.testnet";

          if (txHash.startsWith("3")) {
            res.writeHead(503);
            res.end("Mock transaction RPC unavailable");
            return;
          }

          const result = {
            final_execution_status: txHash.startsWith("2")
              ? "EXECUTED"
              : "FINAL",
            transaction: {
              hash: txHash,
              signer_id: txHash.startsWith("4")
                ? "wrong-signer.testnet"
                : senderId,
              receiver_id: txHash.startsWith("6")
                ? "wrong-recipient.testnet"
                : "tx-recipient.testnet",
              actions: [{
                Transfer: {
                  deposit: txHash.startsWith("7")
                    ? "6000000000000000000000"
                    : "5000000000000000000000"
                }
              }]
            },
            transaction_outcome: {
              outcome: {
                status: txHash.startsWith("5")
                  ? { Failure: { error_message: "Mock execution failure" } }
                  : { SuccessReceiptId: "mock-success-receipt" }
              }
            },
            receipts_outcome: [{
              outcome: {
                status: txHash.startsWith("5") || txHash.startsWith("8")
                  ? { Failure: { error_message: "Mock receipt failure" } }
                  : { SuccessValue: "" }
              }
            }],
            status: txHash.startsWith("5")
              ? { Failure: { error_message: "Mock execution failure" } }
              : { SuccessValue: "" }
          };

          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: "warden-testnet-finality-verification",
            result
          }));
          return;
        }

        // Existing read-only account verification mock.
        const accountId = payload.params?.account_id;

        if (accountId === "rpc-http-error.testnet") {
          res.writeHead(503);
          res.end("Mock RPC unavailable");
          return;
        }

        if (accountId === "account-not-found.testnet") {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: "warden-read-only-account-check",
            error: {
              code: -32000,
              message: "Account does not exist"
            }
          }));
          return;
        }

        if (accountId === "rpc-error.testnet") {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: "warden-read-only-account-check",
            error: {
              code: -32000,
              message: "Mock internal RPC failure"
            }
          }));
          return;
        }

        if (accountId === "invalid-rpc-response.testnet") {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: "warden-read-only-account-check",
            result: {
              amount: "invalid",
              block_height: 100,
              block_hash: "mock-block"
            }
          }));
          return;
        }

        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: "warden-read-only-account-check",
          result: {
            amount: "1000000000000000000000000",
            locked: "0",
            storage_usage: 182,
            block_height: 276361018,
            block_hash: "mock-final-block-hash"
          }
        }));
      });
    });

    rpcServer.once("error", reject);

    rpcServer.listen(0, "127.0.0.1", () => {
      const address = rpcServer?.address();
      const port =
        typeof address === "object" && address
          ? address.port
          : 0;

      if (!port) {
        reject(new Error("Could not allocate mock RPC port."));
        return;
      }

      resolvePort(port);
    });
  });
}
before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "warden-test-"));
  dbPath = join(workDir, "data", "warden.db");
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const rpcPort = await startMockRpc();
  child = spawn(process.execPath, [serverEntry], {
    cwd: workDir, // isolates data/warden.db and .env lookup
    env: {
      ...process.env,
      PORT: String(port),
      WARDEN_API_TOKEN: TEST_API_TOKEN,
      WARDEN_REVIEWER: TEST_REVIEWER,
      NEAR_TESTNET_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      NEAR_TESTNET_TX_RPC_URL: `http://127.0.0.1:${rpcPort}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", chunk => (serverLog += chunk));
  child.stderr?.on("data", chunk => (serverLog += chunk));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`WARDEN API did not start.\n${serverLog}`);
});

after(async () => {
  child?.kill();

  if (rpcServer) {
    await new Promise<void>(resolveClose => {
      rpcServer?.close(() => resolveClose());
    });
  }

  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the SQLite file briefly; the temp dir is disposable.
    }
  }
});

// ---- fixture + query helpers -----------------------------------------------

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface TransferSeed {
  decision?: "ALLOW" | "REQUIRES_APPROVAL" | "BLOCK";
  status?: string;
  amount?: number;
  amountYocto?: string | null;
  currency?: string;
  recipient?: string;
}

function seedTransfer(seed: TransferSeed = {}): number {
  const {
    decision = "REQUIRES_APPROVAL",
    status = "APPROVED",
    amount = 5000,
    amountYocto = null,
    currency = "USD",
    recipient = "alice.testnet"
  } = seed;

  return withDb(db =>
    Number(
      db
        .prepare(
          `INSERT INTO transfer_requests
             (amount, amount_yocto, currency, recipient, is_new_recipient,
              policy_decision, reason_code, status)
           VALUES (?, ?, ?, ?, 1, ?, 'TEST', ?)`
        )
        .run(amount, amountYocto, currency, recipient, decision, status).lastInsertRowid
    )
  );
}

interface ApprovalSeed {
  transferId: number;
  status?: string;
  amount?: number;
  amountYocto?: string | null;
  currency?: string;
  recipient?: string;
}

function seedApproval(seed: ApprovalSeed): number {
  const {
    transferId,
    status = "APPROVED",
    amount = 5000,
    amountYocto = null,
    currency = "USD",
    recipient = "alice.testnet"
  } = seed;

  return withDb(db =>
    Number(
      db
        .prepare(
          `INSERT INTO approvals
             (amount, amount_yocto, currency, recipient, reason_code, status, transfer_id)
           VALUES (?, ?, ?, ?, 'TEST', ?, ?)`
        )
        .run(amount, amountYocto, currency, recipient, status, transferId).lastInsertRowid
    )
  );
}

type SimResult = { status: number; body: Record<string, unknown> };

async function authorizedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${TEST_API_TOKEN}`);

  return fetch(url, {
    ...options,
    headers
  });
}

// Verify the GET health endpoint remains public.
test("API authentication: GET health endpoint is public", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
});

// Verify other methods cannot use the public health bypass.
test("API authentication: non-GET health requests require a token", async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    method: "POST"
  });

  assert.equal(response.status, 401);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.error, "UNAUTHORIZED");
});
// Verify protected routes reject requests without credentials.
test("API authentication: protected routes reject missing tokens", async () => {
  const response = await fetch(`${baseUrl}/api/transfers`);

  assert.equal(response.status, 401);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.error, "UNAUTHORIZED");
});

// Verify the configured test token grants access.
test("API authentication: valid token grants access", async () => {
  const response = await authorizedFetch(`${baseUrl}/api/transfers`);

  assert.equal(response.status, 200);
});

// Verify an incorrect bearer token cannot access protected routes.
test("API authentication: invalid token is rejected", async () => {
  const response = await fetch(`${baseUrl}/api/transfers`, {
    headers: {
      Authorization: "Bearer invalid-warden-token-0123456789"
    }
  });

  assert.equal(response.status, 401);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.error, "UNAUTHORIZED");
});

// Verify approval attribution cannot be forged through the request body.
test("approval security: caller cannot impersonate the configured reviewer", async () => {
  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "AWAITING_APPROVAL"
  });

  const approvalId = seedApproval({
    transferId,
    status: "PENDING"
  });

  const response = await authorizedFetch(
    `${baseUrl}/api/approvals/${approvalId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "APPROVE",
        reviewer: "Mallory Unauthorized Reviewer"
      })
    }
  );

  assert.equal(response.status, 200);

  const body = await response.json() as Record<string, unknown>;

  assert.equal(body.success, true);
  assert.equal(body.status, "APPROVED");
  assert.equal(body.reviewer, TEST_REVIEWER);

  const stored = withDb(db =>
    db.prepare(`
      SELECT status, reviewer
      FROM approvals
      WHERE id = ?
    `).get(approvalId) as { status: string; reviewer: string }
  );

  assert.equal(stored.status, "APPROVED");
  assert.equal(stored.reviewer, TEST_REVIEWER);
  assert.equal(transferStatus(transferId), "APPROVED");
});

test("approval security: unlinked legacy approval cannot be decided", async () => {
  const approvalId = withDb(db =>
    Number(
      db.prepare(`
        INSERT INTO approvals
          (amount, amount_yocto, currency, recipient, reason_code, status, transfer_id)
        VALUES (5000, NULL, 'USD', 'alice.testnet', 'LEGACY', 'PENDING', NULL)
      `).run().lastInsertRowid
    )
  );

  const auditBefore = withDb(db =>
    Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_events
      WHERE event_type = 'APPROVAL_DECIDED'
    `).get() as { count: number }).count)
  );

  const response = await authorizedFetch(
    `${baseUrl}/api/approvals/${approvalId}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "APPROVE" })
    }
  );

  assert.equal(response.status, 409);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.success, false);
  assert.equal(body.error, "UNLINKED_APPROVAL");

  const stored = withDb(db =>
    db.prepare(`
      SELECT status, reviewer, reviewed_at, transfer_id
      FROM approvals
      WHERE id = ?
    `).get(approvalId) as {
      status: string;
      reviewer: string | null;
      reviewed_at: string | null;
      transfer_id: number | null;
    }
  );

  assert.equal(stored.status, "PENDING");
  assert.equal(stored.reviewer, null);
  assert.equal(stored.reviewed_at, null);
  assert.equal(stored.transfer_id, null);

  const auditAfter = withDb(db =>
    Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_events
      WHERE event_type = 'APPROVAL_DECIDED'
    `).get() as { count: number }).count)
  );

  assert.equal(auditAfter, auditBefore);
});

async function evaluatePolicy(payload: Record<string, unknown>): Promise<SimResult> {
  const res = await authorizedFetch(`${baseUrl}/api/policy/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>
  };
}
async function simulate(transferId: number): Promise<SimResult> {
  const res = await authorizedFetch(`${baseUrl}/api/transfers/${transferId}/simulate-execution`, {
    method: "POST"
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface ExecutionRow {
  id: number;
  transfer_id: number;
  amount: number;
  currency: string;
  recipient: string;
  execution_status: string;
}

function executionRows(transferId: number): ExecutionRow[] {
  return withDb(
    db =>
      db
        .prepare("SELECT * FROM simulated_executions WHERE transfer_id = ?")
        .all(transferId) as unknown as ExecutionRow[]
  );
}

function transferStatus(transferId: number): string {
  return withDb(
    db =>
      (
        db.prepare("SELECT status FROM transfer_requests WHERE id = ?").get(transferId) as {
          status: string;
        }
      ).status
  );
}

function auditEvents(eventType: string, transferId: number): Array<Record<string, unknown>> {
  return withDb(db => {
    const rows = db
      .prepare("SELECT details FROM audit_events WHERE event_type = ?")
      .all(eventType) as Array<{ details: string }>;
    return rows
      .map(row => JSON.parse(row.details) as Record<string, unknown>)
      .filter(details => details.transferId === transferId);
  });
}

// ---- shared assertions -----------------------------------------------------

function assertSimulated(result: SimResult, transferId: number, expected: {
  amount: number;
  currency: string;
  recipient: string;
}) {
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.transferId, transferId);
  assert.equal(result.body.executionStatus, "SIMULATED");
  assert.equal(result.body.realFundsMoved, false);

  const rows = executionRows(transferId);
  assert.equal(rows.length, 1, "exactly one simulated execution row");
  assert.equal(rows[0].id, result.body.executionId);
  assert.equal(rows[0].execution_status, "SIMULATED");
  assert.equal(rows[0].amount, expected.amount);
  assert.equal(rows[0].currency, expected.currency);
  assert.equal(rows[0].recipient, expected.recipient);

  assert.equal(transferStatus(transferId), "SIMULATED_EXECUTED");

  const audit = auditEvents("SIMULATED_EXECUTION", transferId);
  assert.equal(audit.length, 1, "exactly one SIMULATED_EXECUTION audit event");
  assert.equal(audit[0].realFundsMoved, false);
  assert.equal(audit[0].executionStatus, "SIMULATED");
}

function assertDenied(
  result: SimResult,
  transferId: number,
  expected: { httpStatus: number; error: string; statusUnchanged: string }
) {
  assert.equal(result.status, expected.httpStatus);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, expected.error);
  assert.notEqual(result.body.realFundsMoved, true);
  assert.equal(executionRows(transferId).length, 0, "denied attempt must not create a simulated execution");
  assert.equal(transferStatus(transferId), expected.statusUnchanged, "denied attempt must not change transfer status");
  assert.equal(auditEvents("SIMULATED_EXECUTION", transferId).length, 0, "denied attempt must not write an execution audit event");
}

const APPROVAL_DENIED = { httpStatus: 403, error: "APPROVAL_REQUIRED_OR_MISMATCHED" };


async function validateRecipient(recipient: unknown): Promise<SimResult> {
  const res = await authorizedFetch(`${baseUrl}/api/near/validate-recipient`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient })
  });

  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>
  };
}

test("NEAR recipient validation: existing finalized account is verified", async () => {
  const result = await validateRecipient("existing.testnet");

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.network, "testnet");
  assert.equal(result.body.accountId, "existing.testnet");
  assert.equal(result.body.exists, true);
  assert.equal(result.body.finality, "final");
  assert.equal(result.body.blockHeight, 276361018);
  assert.equal(result.body.blockHash, "mock-final-block-hash");
});

test("NEAR recipient validation: nonexistent account returns 404", async () => {
  const result = await validateRecipient("account-not-found.testnet");

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "NEAR_ACCOUNT_NOT_FOUND");
});

test("NEAR recipient validation: malformed account is rejected", async () => {
  const result = await validateRecipient("not a valid account");

  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "INVALID_TESTNET_ACCOUNT");
});

test("NEAR recipient validation: RPC query failure returns 502", async () => {
  const result = await validateRecipient("rpc-error.testnet");

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "NEAR_RPC_QUERY_FAILED");
});

test("NEAR recipient validation: RPC HTTP failure returns 502", async () => {
  const result = await validateRecipient("rpc-http-error.testnet");

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "NEAR_RPC_HTTP_ERROR");
});

test("NEAR recipient validation: malformed RPC data fails closed", async () => {
  const result = await validateRecipient("invalid-rpc-response.testnet");

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "INVALID_NEAR_RPC_RESPONSE");
});
// ---- the ten required test cases -------------------------------------------

test("policy evaluation: valid NEAR recipient includes finalized RPC verification", async () => {
  const result = await evaluatePolicy({
    amount: "0.005",
    currency: "NEAR",
    recipient: "verified-policy.testnet"
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);

  const verification = result.body.recipientVerification as Record<string, unknown>;

  assert.equal(verification.exists, true);
  assert.equal(verification.accountId, "verified-policy.testnet");
  assert.equal(verification.finality, "final");
  assert.equal(verification.blockHeight, 276361018);
  assert.equal(verification.blockHash, "mock-final-block-hash");
});

test("policy evaluation: nonexistent NEAR recipient creates no transfer or approval", async () => {
  const before = withDb(db => ({
    transfers: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_requests"
    ).get() as { count: number }).count),
    approvals: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM approvals"
    ).get() as { count: number }).count)
  }));

  const result = await evaluatePolicy({
    amount: "0.005",
    currency: "NEAR",
    recipient: "account-not-found.testnet"
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "NEAR_ACCOUNT_NOT_FOUND");

  const after = withDb(db => ({
    transfers: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_requests"
    ).get() as { count: number }).count),
    approvals: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM approvals"
    ).get() as { count: number }).count)
  }));

  assert.deepEqual(after, before);
});

test("policy evaluation: unavailable NEAR RPC creates no transfer or approval", async () => {
  const before = withDb(db => ({
    transfers: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_requests"
    ).get() as { count: number }).count),
    approvals: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM approvals"
    ).get() as { count: number }).count)
  }));

  const result = await evaluatePolicy({
    amount: "0.005",
    currency: "NEAR",
    recipient: "rpc-error.testnet"
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "NEAR_RPC_QUERY_FAILED");

  const after = withDb(db => ({
    transfers: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_requests"
    ).get() as { count: number }).count),
    approvals: Number((db.prepare(
      "SELECT COUNT(*) AS count FROM approvals"
    ).get() as { count: number }).count)
  }));

  assert.deepEqual(after, before);
});
test("recipient trust: caller cannot mark an unregistered recipient as trusted", async () => {
  const result = await evaluatePolicy({
    amount: "0.005",
    currency: "NEAR",
    recipient: "untrusted.testnet",
    isNewRecipient: false
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.recipientTrust, "UNREGISTERED");
  assert.equal(result.body.trustSource, "SERVER_REGISTRY");
  assert.equal(result.body.transferStatus, "AWAITING_APPROVAL");

  const policy = result.body.policy as {
    decision: string;
    reasonCode: string;
  };

  assert.equal(policy.decision, "REQUIRES_APPROVAL");
  assert.equal(policy.reasonCode, "NEW_RECIPIENT_APPROVAL");
  assert.equal(typeof result.body.approvalId, "number");

  const transferId = result.body.transferId as number;

  const stored = withDb(db =>
    db.prepare(`
      SELECT is_new_recipient, policy_decision, status
      FROM transfer_requests
      WHERE id = ?
    `).get(transferId) as {
      is_new_recipient: number;
      policy_decision: string;
      status: string;
    }
  );

  assert.equal(stored.is_new_recipient, 1);
  assert.equal(stored.policy_decision, "REQUIRES_APPROVAL");
  assert.equal(stored.status, "AWAITING_APPROVAL");
});

test("recipient trust: server registry overrides caller's new-recipient claim", async () => {
  withDb(db => {
    db.prepare(`
      INSERT INTO trusted_recipients (
        account_id,
        network,
        status,
        created_by
      )
      VALUES (?, 'testnet', 'ACTIVE', 'integration-test-fixture')
    `).run("trusted.testnet");
  });

  const result = await evaluatePolicy({
    amount: "0.005",
    currency: "NEAR",
    recipient: "trusted.testnet",
    isNewRecipient: true
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.recipientTrust, "TRUSTED_REGISTRY");
  assert.equal(result.body.trustSource, "SERVER_REGISTRY");
  assert.equal(result.body.transferStatus, "AUTHORIZED");
  assert.equal(result.body.approvalId, null);

  const policy = result.body.policy as {
    decision: string;
    reasonCode: string;
  };

  assert.equal(policy.decision, "ALLOW");
  assert.equal(policy.reasonCode, "WITHIN_POLICY_LIMITS");

  const transferId = result.body.transferId as number;

  const stored = withDb(db =>
    db.prepare(`
      SELECT is_new_recipient, policy_decision, status
      FROM transfer_requests
      WHERE id = ?
    `).get(transferId) as {
      is_new_recipient: number;
      policy_decision: string;
      status: string;
    }
  );

  assert.equal(stored.is_new_recipient, 0);
  assert.equal(stored.policy_decision, "ALLOW");
  assert.equal(stored.status, "AUTHORIZED");
});
test("1. authorized ALLOW transfer can be simulated", async () => {
  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 100,
    currency: "USD",
    recipient: "bob.testnet"
  });

  const result = await simulate(transferId);

  assertSimulated(result, transferId, { amount: 100, currency: "USD", recipient: "bob.testnet" });
});

test("2. approved transfer with matching approved approval can be simulated", async () => {
  const transferId = seedTransfer({ status: "APPROVED" });
  seedApproval({ transferId, status: "APPROVED" });

  const result = await simulate(transferId);

  assertSimulated(result, transferId, { amount: 5000, currency: "USD", recipient: "alice.testnet" });
});

test("recipient trust at simulation: active NEAR recipient permits autonomous ALLOW", async () => {
  withDb(db => {
    db.prepare(`
      INSERT INTO trusted_recipients (
        account_id, network, status, created_by
      )
      VALUES (?, 'testnet', 'ACTIVE', 'simulation-test')
    `).run("trusted-near.testnet");
  });

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "trusted-near.testnet"
  });

  const result = await simulate(transferId);

  assertSimulated(result, transferId, {
    amount: 0.005,
    currency: "NEAR",
    recipient: "trusted-near.testnet"
  });
});

test("recipient trust at simulation: unregistered NEAR recipient cannot use autonomous ALLOW", async () => {
  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "unregistered-near.testnet"
  });

  assertDenied(await simulate(transferId), transferId, {
    httpStatus: 403,
    error: "RECIPIENT_NOT_TRUSTED",
    statusUnchanged: "AUTHORIZED"
  });
});

test("recipient trust at simulation: revoked NEAR recipient cannot use stale ALLOW", async () => {
  withDb(db => {
    db.prepare(`
      INSERT INTO trusted_recipients (
        account_id, network, status, created_by
      )
      VALUES (?, 'testnet', 'REVOKED', 'simulation-test')
    `).run("revoked-near.testnet");
  });

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "revoked-near.testnet"
  });

  assertDenied(await simulate(transferId), transferId, {
    httpStatus: 403,
    error: "RECIPIENT_TRUST_REVOKED",
    statusUnchanged: "AUTHORIZED"
  });
});

test("recipient trust at simulation: unregistered NEAR recipient can proceed with matching human approval", async () => {
  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "APPROVED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "new-recipient.testnet"
  });

  seedApproval({
    transferId,
    status: "APPROVED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "new-recipient.testnet"
  });

  const result = await simulate(transferId);

  assertSimulated(result, transferId, {
    amount: 0.005,
    currency: "NEAR",
    recipient: "new-recipient.testnet"
  });
});

test("recipient trust at simulation: revoked NEAR recipient cannot bypass revocation with approval", async () => {
  withDb(db => {
    db.prepare(`
      INSERT INTO trusted_recipients (
        account_id, network, status, created_by
      )
      VALUES (?, 'testnet', 'REVOKED', 'simulation-test')
    `).run("revoked-approved.testnet");
  });

  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "APPROVED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "revoked-approved.testnet"
  });

  seedApproval({
    transferId,
    status: "APPROVED",
    amount: 0.005,
    amountYocto: "5000000000000000000000",
    currency: "NEAR",
    recipient: "revoked-approved.testnet"
  });

  assertDenied(await simulate(transferId), transferId, {
    httpStatus: 403,
    error: "RECIPIENT_TRUST_REVOKED",
    statusUnchanged: "APPROVED"
  });
});
test("3. transfer still awaiting approval is denied", async (t) => {
  await t.test("natural state: AWAITING_APPROVAL transfer, PENDING approval", async () => {
    const transferId = seedTransfer({ status: "AWAITING_APPROVAL" });
    seedApproval({ transferId, status: "PENDING" });

    assertDenied(await simulate(transferId), transferId, {
      ...APPROVAL_DENIED,
      statusUnchanged: "AWAITING_APPROVAL"
    });
  });

  await t.test("approval row says APPROVED but transfer is still AWAITING_APPROVAL", async () => {
    const transferId = seedTransfer({ status: "AWAITING_APPROVAL" });
    seedApproval({ transferId, status: "APPROVED" });

    assertDenied(await simulate(transferId), transferId, {
      ...APPROVAL_DENIED,
      statusUnchanged: "AWAITING_APPROVAL"
    });
  });

  await t.test("AWAITING_APPROVAL transfer with no approval record at all", async () => {
    const transferId = seedTransfer({ status: "AWAITING_APPROVAL" });

    assertDenied(await simulate(transferId), transferId, {
      ...APPROVAL_DENIED,
      statusUnchanged: "AWAITING_APPROVAL"
    });
  });
});

test("4. transfer marked APPROVED but approval is PENDING is denied", async () => {
  const transferId = seedTransfer({ status: "APPROVED" });
  seedApproval({ transferId, status: "PENDING" });

  assertDenied(await simulate(transferId), transferId, {
    ...APPROVAL_DENIED,
    statusUnchanged: "APPROVED"
  });
});

test("5. approval belonging to a different transfer is denied", async () => {
  const transferA = seedTransfer({ status: "APPROVED" });
  const transferB = seedTransfer({ status: "APPROVED" });
  // A fully matching, APPROVED approval, but linked to transfer B only.
  seedApproval({ transferId: transferB, status: "APPROVED" });

  assertDenied(await simulate(transferA), transferA, {
    ...APPROVAL_DENIED,
    statusUnchanged: "APPROVED"
  });

  // Transfer B legitimately owns that approval and is unaffected by the denial.
  assert.equal(executionRows(transferB).length, 0);
  assert.equal(transferStatus(transferB), "APPROVED");
});

test("6. approval with mismatched amount is denied", async () => {
  const transferId = seedTransfer({ status: "APPROVED", amount: 5000 });
  seedApproval({ transferId, status: "APPROVED", amount: 4999.99 });

  assertDenied(await simulate(transferId), transferId, {
    ...APPROVAL_DENIED,
    statusUnchanged: "APPROVED"
  });
});

test("7. approval with mismatched currency is denied", async () => {
  const transferId = seedTransfer({ status: "APPROVED", currency: "USD" });
  seedApproval({ transferId, status: "APPROVED", currency: "EUR" });

  assertDenied(await simulate(transferId), transferId, {
    ...APPROVAL_DENIED,
    statusUnchanged: "APPROVED"
  });
});

test("8. approval with mismatched recipient is denied", async () => {
  const transferId = seedTransfer({ status: "APPROVED", recipient: "alice.testnet" });
  seedApproval({ transferId, status: "APPROVED", recipient: "mallory.testnet" });

  assertDenied(await simulate(transferId), transferId, {
    ...APPROVAL_DENIED,
    statusUnchanged: "APPROVED"
  });
});

test("9. BLOCKED transfer is denied", async (t) => {
  const blockedDenied = { httpStatus: 403, error: "POLICY_BLOCKED" };

  await t.test("normal BLOCKED transfer", async () => {
    const transferId = seedTransfer({ decision: "BLOCK", status: "BLOCKED" });

    assertDenied(await simulate(transferId), transferId, {
      ...blockedDenied,
      statusUnchanged: "BLOCKED"
    });
  });

  await t.test("tampered BLOCK row marked APPROVED with a matching approved approval", async () => {
    const transferId = seedTransfer({ decision: "BLOCK", status: "APPROVED" });
    seedApproval({ transferId, status: "APPROVED" });

    assertDenied(await simulate(transferId), transferId, {
      ...blockedDenied,
      statusUnchanged: "APPROVED"
    });
  });
});

test("10. already-simulated transfer is denied on a second attempt", async (t) => {
  await t.test("ALLOW transfer", async () => {
    const transferId = seedTransfer({ decision: "ALLOW", status: "AUTHORIZED" });

    const first = await simulate(transferId);
    assert.equal(first.status, 200);

    const second = await simulate(transferId);
    assert.equal(second.status, 409);
    assert.equal(second.body.success, false);
    assert.equal(second.body.error, "DUPLICATE_EXECUTION");
    assert.equal(executionRows(transferId).length, 1, "still exactly one execution row");
    assert.equal(auditEvents("SIMULATED_EXECUTION", transferId).length, 1, "still exactly one audit event");
    assert.equal(transferStatus(transferId), "SIMULATED_EXECUTED");
  });

  await t.test("approved REQUIRES_APPROVAL transfer", async () => {
    const transferId = seedTransfer({ status: "APPROVED" });
    seedApproval({ transferId, status: "APPROVED" });

    assert.equal((await simulate(transferId)).status, 200);

    const second = await simulate(transferId);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "DUPLICATE_EXECUTION");
    assert.equal(executionRows(transferId).length, 1);
    assert.equal(auditEvents("SIMULATED_EXECUTION", transferId).length, 1);
  });
});

// ---- extra coverage beyond the ten required cases --------------------------

test("extra: ALLOW decision with a non-AUTHORIZED status, or an unknown decision, is denied", async (t) => {
  const notAuthorized = { httpStatus: 403, error: "TRANSFER_NOT_AUTHORIZED" };

  await t.test("ALLOW decision but status REJECTED", async () => {
    const transferId = seedTransfer({ decision: "ALLOW", status: "REJECTED" });

    assertDenied(await simulate(transferId), transferId, {
      ...notAuthorized,
      statusUnchanged: "REJECTED"
    });
  });

  await t.test("unknown policy decision with AUTHORIZED status", async () => {
    const transferId = seedTransfer({
      decision: "SOMETHING_ELSE" as unknown as "ALLOW",
      status: "AUTHORIZED"
    });

    assertDenied(await simulate(transferId), transferId, {
      ...notAuthorized,
      statusUnchanged: "AUTHORIZED"
    });
  });
});

test("extra: rejected approval and rejected transfer is denied", async () => {
  const transferId = seedTransfer({ status: "REJECTED" });
  seedApproval({ transferId, status: "REJECTED" });

  assertDenied(await simulate(transferId), transferId, {
    ...APPROVAL_DENIED,
    statusUnchanged: "REJECTED"
  });
});

test("extra: nonexistent transfer returns 404 and invalid id returns 400", async () => {
  const missing = await simulate(999999);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "TRANSFER_NOT_FOUND");

  const invalid = await authorizedFetch(`${baseUrl}/api/transfers/abc/simulate-execution`, { method: "POST" });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as Record<string, unknown>).error, "INVALID_TRANSFER_ID");
});




test("exact NEAR amounts: policy boundaries use yoctoNEAR integers", async () => {
  withDb(db => {
    db.prepare(`
      INSERT INTO trusted_recipients (
        account_id, network, status, created_by
      )
      VALUES (?, 'testnet', 'ACTIVE', 'precision-test')
    `).run("precision.testnet");
  });

  const cases = [
    {
      amount: "0.005",
      decision: "ALLOW",
      yocto: "5000000000000000000000"
    },
    {
      amount: "0.01",
      decision: "ALLOW",
      yocto: "10000000000000000000000"
    },
    {
      amount: "0.010000000000000000000001",
      decision: "REQUIRES_APPROVAL",
      yocto: "10000000000000000000001"
    },
    {
      amount: "1",
      decision: "REQUIRES_APPROVAL",
      yocto: "1000000000000000000000000"
    },
    {
      amount: "1.000000000000000000000001",
      decision: "BLOCK",
      yocto: "1000000000000000000000001"
    }
  ];

  for (const item of cases) {
    const result = await evaluatePolicy({
      amount: item.amount,
      currency: "NEAR",
      recipient: "precision.testnet",
      isNewRecipient: false
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.amountYocto, item.yocto);

    const policy = result.body.policy as {
      decision: string;
      amountYocto: string;
    };

    assert.equal(policy.decision, item.decision, item.amount);
    assert.equal(policy.amountYocto, item.yocto, item.amount);

    const transferId = result.body.transferId as number;

    const stored = withDb(db =>
      db.prepare(`
        SELECT amount_yocto
        FROM transfer_requests
        WHERE id = ?
      `).get(transferId) as { amount_yocto: string }
    );

    assert.equal(stored.amount_yocto, item.yocto);
  }
});

test("exact NEAR amounts: malformed amounts fail closed", async () => {
  const invalidAmounts: unknown[] = [
    undefined,
    0.005,
    0,
    -1,
    "0",
    "-0.005",
    "1e-3",
    "1,000",
    ".5",
    "0.0000000000000000000000001"
  ];

  for (const amount of invalidAmounts) {
    const result = await evaluatePolicy({
      amount,
      currency: "NEAR",
      recipient: "invalid-amount.testnet",
      isNewRecipient: false
    });

    assert.equal(result.status, 200);

    const policy = result.body.policy as {
      decision: string;
      reasonCode: string;
      amountYocto: string | null;
    };

    assert.equal(policy.decision, "BLOCK", String(amount));
    assert.equal(policy.reasonCode, "INVALID_AMOUNT_FORMAT");
    assert.equal(policy.amountYocto, null);
  }
});

test("exact NEAR amounts: approval and transfer store identical yoctoNEAR", async () => {
  const result = await evaluatePolicy({
    amount: "0.2",
    currency: "NEAR",
    recipient: "new-precision-recipient.testnet",
    isNewRecipient: false
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.transferStatus, "AWAITING_APPROVAL");

  const transferId = result.body.transferId as number;
  const approvalId = result.body.approvalId as number;

  const records = withDb(db => ({
    transfer: db.prepare(`
      SELECT amount_yocto
      FROM transfer_requests
      WHERE id = ?
    `).get(transferId) as { amount_yocto: string },
    approval: db.prepare(`
      SELECT amount_yocto
      FROM approvals
      WHERE id = ?
    `).get(approvalId) as { amount_yocto: string }
  }));

  assert.equal(records.transfer.amount_yocto, "200000000000000000000000");
  assert.equal(records.approval.amount_yocto, records.transfer.amount_yocto);
});


// ---- on-chain execution intent tests ---------------------------------------

function seedTrustedRecipient(accountId: string, status = "ACTIVE"): void {
  withDb(db => {
    db.prepare(`
      INSERT OR IGNORE INTO trusted_recipients (
        account_id, network, status, created_by
      )
      VALUES (?, 'testnet', ?, 'onchain-intent-test')
    `).run(accountId, status);
  });
}

async function createOnchainIntent(
  transferId: number,
  senderAccountId: unknown = "warden-signer.testnet"
): Promise<SimResult> {
  const response = await authorizedFetch(
    `${baseUrl}/api/transfers/${transferId}/onchain-intent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderAccountId })
    }
  );

  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>
  };
}

function onchainIntentCount(transferId: number): number {
  return withDb(db =>
    Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM onchain_executions
      WHERE transfer_id = ?
    `).get(transferId) as { count: number }).count)
  );
}

async function submitOnchainExecution(
  intentId: string,
  txHash: string
): Promise<SimResult> {
  const response = await authorizedFetch(
    `${baseUrl}/api/onchain-executions/${intentId}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash })
    }
  );

  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>
  };
}

function onchainExecutionState(intentId: string): {
  state: string;
  tx_hash: string | null;
  failure_code: string | null;
} {
  return withDb(db =>
    db.prepare(`
      SELECT state, tx_hash, failure_code
      FROM onchain_executions
      WHERE intent_id = ?
    `).get(intentId) as {
      state: string;
      tx_hash: string | null;
      failure_code: string | null;
    }
  );
}

async function createTrustedTestnetIntent(
  recipient = "tx-recipient.testnet"
): Promise<{ transferId: number; intentId: string }> {
  seedTrustedRecipient(recipient);

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient
  });

  const created = await createOnchainIntent(transferId);
  assert.equal(created.status, 201);

  const intent = created.body.intent as Record<string, unknown>;

  return {
    transferId,
    intentId: intent.intentId as string
  };
}
const INTENT_AMOUNT_YOCTO = "5000000000000000000000";

// Verify an active trusted recipient can receive an authorized ALLOW intent.
test("onchain intent: active trusted ALLOW transfer creates exact intent", async () => {
  seedTrustedRecipient("intent-trusted.testnet");

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-trusted.testnet"
  });

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.body.network, "testnet");

  const intent = result.body.intent as Record<string, unknown>;
  assert.equal(typeof intent.intentId, "string");
  assert.equal(intent.transferId, transferId);
  assert.equal(intent.senderAccountId, "warden-signer.testnet");
  assert.equal(intent.receiverId, "intent-trusted.testnet");
  assert.equal(intent.amountYocto, INTENT_AMOUNT_YOCTO);
  assert.equal(intent.state, "CREATED");
  assert.equal(typeof intent.expiresAt, "string");

  const transaction = result.body.transaction as {
    network: string;
    signerId: string;
    receiverId: string;
    actions: Array<{
      type: string;
      params: { deposit: string };
    }>;
  };

  assert.equal(transaction.network, "testnet");
  assert.equal(transaction.signerId, "warden-signer.testnet");
  assert.equal(transaction.receiverId, "intent-trusted.testnet");
  assert.deepEqual(transaction.actions, [{
    type: "Transfer",
    params: { deposit: INTENT_AMOUNT_YOCTO }
  }]);

  assert.equal(onchainIntentCount(transferId), 1);
  assert.equal(transferStatus(transferId), "AUTHORIZED");

  const audit = auditEvents(
    "ONCHAIN_EXECUTION_INTENT_CREATED",
    transferId
  );

  assert.equal(audit.length, 1);
  assert.equal(audit[0].intentId, intent.intentId);
  assert.equal(audit[0].amountYocto, INTENT_AMOUNT_YOCTO);
});

// An unregistered recipient may proceed only with a matching human approval.
test("onchain intent: matching human approval permits unregistered recipient", async () => {
  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "APPROVED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-unregistered.testnet"
  });

  seedApproval({
    transferId,
    status: "APPROVED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-unregistered.testnet"
  });

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 201);
  assert.equal(result.body.success, true);
  assert.equal(onchainIntentCount(transferId), 1);
});

// A revoked recipient cannot bypass revocation through human approval.
test("onchain intent: revoked recipient is denied even with matching approval", async () => {
  seedTrustedRecipient("intent-revoked.testnet", "REVOKED");

  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "APPROVED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-revoked.testnet"
  });

  seedApproval({
    transferId,
    status: "APPROVED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-revoked.testnet"
  });

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "RECIPIENT_TRUST_REVOKED");
  assert.equal(onchainIntentCount(transferId), 0);
});

// A transfer cannot create an intent while approval is pending.
test("onchain intent: pending approval is denied", async () => {
  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "AWAITING_APPROVAL",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-pending.testnet"
  });

  seedApproval({
    transferId,
    status: "PENDING",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-pending.testnet"
  });

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 403);
  assert.equal(result.body.error, "TRANSFER_NOT_AUTHORIZED");
  assert.equal(onchainIntentCount(transferId), 0);
});

// Approval must match the exact yoctoNEAR amount.
test("onchain intent: mismatched approval amount is denied", async () => {
  const transferId = seedTransfer({
    decision: "REQUIRES_APPROVAL",
    status: "APPROVED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-mismatch.testnet"
  });

  seedApproval({
    transferId,
    status: "APPROVED",
    amount: 0.005,
    amountYocto: "6000000000000000000000",
    currency: "NEAR",
    recipient: "intent-mismatch.testnet"
  });

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 403);
  assert.equal(result.body.error, "MATCHING_APPROVAL_REQUIRED");
  assert.equal(onchainIntentCount(transferId), 0);
});

// Sender must be a valid named Testnet account.
test("onchain intent: malformed sender is rejected before RPC lookup", async () => {
  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-invalid-sender.testnet"
  });

  seedTrustedRecipient("intent-invalid-sender.testnet");

  const result = await createOnchainIntent(transferId, "not-a-testnet-account");

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "INVALID_SENDER_ACCOUNT");
  assert.equal(onchainIntentCount(transferId), 0);
});

// Sender account verification must fail closed when RPC is unavailable.
test("onchain intent: sender RPC failure prevents intent creation", async () => {
  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-rpc-failure.testnet"
  });

  seedTrustedRecipient("intent-rpc-failure.testnet");

  const result = await createOnchainIntent(
    transferId,
    "rpc-error.testnet"
  );

  assert.equal(result.status, 502);
  assert.equal(result.body.error, "NEAR_RPC_QUERY_FAILED");
  assert.equal(onchainIntentCount(transferId), 0);
});

// A transfer can have only one intent, even if the first request is repeated.
test("onchain intent: duplicate creation is rejected", async () => {
  seedTrustedRecipient("intent-duplicate.testnet");

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-duplicate.testnet"
  });

  const first = await createOnchainIntent(transferId);
  assert.equal(first.status, 201);

  const second = await createOnchainIntent(transferId);

  assert.equal(second.status, 409);
  assert.equal(second.body.error, "ONCHAIN_INTENT_ALREADY_EXISTS");
  assert.equal(onchainIntentCount(transferId), 1);
});

// Simulation and real Testnet intent are mutually exclusive for one transfer.
test("onchain intent: previously simulated transfer cannot create intent", async () => {
  seedTrustedRecipient("intent-simulated.testnet");

  const transferId = seedTransfer({
    decision: "ALLOW",
    status: "AUTHORIZED",
    amount: 0.005,
    amountYocto: INTENT_AMOUNT_YOCTO,
    currency: "NEAR",
    recipient: "intent-simulated.testnet"
  });

  const simulation = await simulate(transferId);
  assert.equal(simulation.status, 200);
  assert.equal(simulation.body.realFundsMoved, false);

  const result = await createOnchainIntent(transferId);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "TRANSFER_ALREADY_SIMULATED");
  assert.equal(onchainIntentCount(transferId), 0);
});

// Invalid and nonexistent transfer IDs are rejected.
test("onchain intent: invalid and missing transfer IDs are rejected", async () => {
  const invalid = await authorizedFetch(
    `${baseUrl}/api/transfers/abc/onchain-intent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderAccountId: "warden-signer.testnet"
      })
    }
  );

  assert.equal(invalid.status, 400);
  assert.equal(
    ((await invalid.json()) as Record<string, unknown>).error,
    "INVALID_TRANSFER_ID"
  );

  const missing = await createOnchainIntent(999999);

  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "TRANSFER_NOT_FOUND");
});

// ---- on-chain Testnet submission verification tests -----------------------

// A matching transaction must be finalized and independently verified.
test("onchain submission: finalized matching transaction", async () => {
  const { transferId, intentId } = await createTrustedTestnetIntent();
  const txHash = "A" + "A".repeat(42);

  const result = await submitOnchainExecution(intentId, txHash);

  assert.equal(result.status, 200);
  assert.equal(result.body.state, "VERIFIED");
  assert.equal(result.body.onchainConfirmed, true);
  assert.equal(result.body.txHash, txHash);
  assert.equal(result.body.network, "testnet");

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "VERIFIED");
  assert.equal(stored.tx_hash, txHash);
  assert.equal(stored.failure_code, null);

  assert.equal(
    auditEvents("ONCHAIN_TRANSACTION_HASH_RECEIVED", transferId).length,
    1
  );
  assert.equal(
    auditEvents("ONCHAIN_EXECUTION_VERIFIED", transferId).length,
    1
  );

  // Repeating the same finalized transaction is idempotent.
  const repeated = await submitOnchainExecution(intentId, txHash);

  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.state, "VERIFIED");
  assert.equal(repeated.body.idempotent, true);
  assert.equal(
    auditEvents("ONCHAIN_EXECUTION_VERIFIED", transferId).length,
    1
  );
});

// The intent is permanently bound to the first submitted transaction hash.
test("onchain submission: transaction hash cannot be replaced", async () => {
  const { intentId } = await createTrustedTestnetIntent();
  const originalHash = "B" + "B".repeat(42);
  const replacementHash = "C" + "C".repeat(42);

  const first = await submitOnchainExecution(intentId, originalHash);
  assert.equal(first.status, 200);

  const replacement = await submitOnchainExecution(
    intentId,
    replacementHash
  );

  assert.equal(replacement.status, 409);
  assert.equal(replacement.body.error, "TRANSACTION_HASH_MISMATCH");

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.tx_hash, originalHash);
  assert.equal(stored.state, "VERIFIED");
});

// Wrong signer, recipient, or exact yoctoNEAR deposit must fail closed.
test("onchain submission: transaction intent mismatches are rejected", async () => {
  const cases = [
    {
      label: "wrong signer",
      hash: "4" + "D".repeat(42)
    },
    {
      label: "wrong recipient",
      hash: "6" + "E".repeat(42)
    },
    {
      label: "wrong exact amount",
      hash: "7" + "F".repeat(42)
    }
  ];

  for (const item of cases) {
    const { intentId } = await createTrustedTestnetIntent();

    const result = await submitOnchainExecution(intentId, item.hash);

    assert.equal(result.status, 409, item.label);
    assert.equal(
      result.body.error,
      "TRANSACTION_INTENT_MISMATCH",
      item.label
    );
    assert.equal(result.body.state, "FAILED", item.label);
    assert.equal(result.body.onchainConfirmed, false, item.label);

    const stored = onchainExecutionState(intentId);
    assert.equal(stored.state, "FAILED", item.label);
    assert.equal(
      stored.failure_code,
      "TRANSACTION_INTENT_MISMATCH",
      item.label
    );
  }
});

// A finalized transaction with failed execution or receipt outcomes is rejected.
test("onchain submission: failed NEAR execution is rejected", async () => {
  const { intentId } = await createTrustedTestnetIntent();
  const txHash = "5" + "G".repeat(42);

  const result = await submitOnchainExecution(intentId, txHash);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "TRANSACTION_EXECUTION_FAILED");
  assert.equal(result.body.state, "FAILED");
  assert.equal(result.body.onchainConfirmed, false);

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "FAILED");
  assert.equal(stored.failure_code, "TRANSACTION_EXECUTION_FAILED");
});

// A successful transaction with a failed receipt must still be rejected.
test("onchain submission: failed receipt is rejected independently", async () => {
  const { intentId } = await createTrustedTestnetIntent();
  const txHash = "8" + "J".repeat(42);

  const result = await submitOnchainExecution(intentId, txHash);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "TRANSACTION_EXECUTION_FAILED");
  assert.equal(result.body.state, "FAILED");
  assert.equal(result.body.onchainConfirmed, false);

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "FAILED");
  assert.equal(stored.failure_code, "TRANSACTION_EXECUTION_FAILED");
});

// A transaction that has not reached FINAL remains SUBMITTED, not VERIFIED.
test("onchain submission: non-final transaction remains retryable", async () => {
  const { intentId } = await createTrustedTestnetIntent();
  const txHash = "2" + "H".repeat(42);

  const result = await submitOnchainExecution(intentId, txHash);

  assert.equal(result.status, 202);
  assert.equal(result.body.state, "SUBMITTED");
  assert.equal(result.body.onchainConfirmed, false);

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "SUBMITTED");
  assert.equal(stored.tx_hash, txHash);
  assert.equal(stored.failure_code, null);
});

// Temporary RPC failure preserves the original hash and allows safe retry.
test("onchain submission: RPC outage preserves submitted state", async () => {
  const { intentId } = await createTrustedTestnetIntent();
  const txHash = "3" + "J".repeat(42);

  const result = await submitOnchainExecution(intentId, txHash);

  assert.equal(result.status, 502);
  assert.equal(result.body.error, "NEAR_TX_RPC_HTTP_ERROR");
  assert.equal(result.body.state, "SUBMITTED");
  assert.equal(result.body.retryable, true);

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "SUBMITTED");
  assert.equal(stored.tx_hash, txHash);
  assert.equal(stored.failure_code, null);

  // The same hash may be retried; a different hash may not.
  const retry = await submitOnchainExecution(intentId, txHash);
  assert.equal(retry.status, 502);
  assert.equal(retry.body.state, "SUBMITTED");

  const replacement = await submitOnchainExecution(
    intentId,
    "K" + "K".repeat(42)
  );
  assert.equal(replacement.status, 409);
  assert.equal(replacement.body.error, "TRANSACTION_HASH_MISMATCH");
});

// Invalid transaction hashes must not bind or mutate an intent.
test("onchain submission: malformed transaction hash is rejected", async () => {
  const { intentId } = await createTrustedTestnetIntent();

  const result = await submitOnchainExecution(intentId, "not-a-valid-hash");

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "INVALID_TRANSACTION_HASH");

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "CREATED");
  assert.equal(stored.tx_hash, null);
});

// An expired, unused intent cannot be submitted.
test("onchain submission: expired intent cannot be submitted", async () => {
  const { intentId } = await createTrustedTestnetIntent();

  withDb(db => {
    db.prepare(`
      UPDATE onchain_executions
      SET expires_at = ?
      WHERE intent_id = ?
    `).run("2000-01-01T00:00:00.000Z", intentId);
  });

  const result = await submitOnchainExecution(
    intentId,
    "L" + "L".repeat(42)
  );

  assert.equal(result.status, 410);
  assert.equal(result.body.error, "ONCHAIN_INTENT_EXPIRED");

  const stored = onchainExecutionState(intentId);
  assert.equal(stored.state, "EXPIRED");
  assert.equal(stored.tx_hash, null);

  // Retrying an already-expired, unbound intent must still return 410.
  const retry = await submitOnchainExecution(
    intentId,
    "M" + "M".repeat(42)
  );

  assert.equal(retry.status, 410);
  assert.equal(retry.body.error, "ONCHAIN_INTENT_EXPIRED");

  const afterRetry = onchainExecutionState(intentId);
  assert.equal(afterRetry.state, "EXPIRED");
  assert.equal(afterRetry.tx_hash, null);
});
// Transfers API must expose the persisted on-chain state after finality verification.
test("transfers API: exposes persisted verified on-chain execution details", async () => {
  const { transferId, intentId } = await createTrustedTestnetIntent();

  const txHash = "N" + "N".repeat(42);
  const submitted = await submitOnchainExecution(intentId, txHash);

  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.state, "VERIFIED");

  const response = await authorizedFetch(`${baseUrl}/api/transfers`);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    success: boolean;
    transfers: Array<Record<string, unknown>>;
  };

  assert.equal(body.success, true);

  const transfer = body.transfers.find(
    item => item.id === transferId
  );

  assert.ok(transfer, "transfer should be returned by the transfers endpoint");
  assert.equal(transfer.onchain_intent_id, intentId);
  assert.equal(transfer.onchain_state, "VERIFIED");
  assert.equal(transfer.onchain_tx_hash, txHash);
  assert.equal(transfer.onchain_failure_code, null);
  assert.ok(transfer.onchain_finalized_at);
});
