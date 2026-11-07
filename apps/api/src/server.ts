import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { evaluateTransferPolicy, parseNearAmount } from "./policy/PolicyEngine.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: process.env.WEB_ORIGIN ?? "http://localhost:5173"
}));

app.use(express.json());

const dataDirectory = join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const db = new DatabaseSync(join(dataDirectory, "warden.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    recipient TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewer TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS transfer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL,
    currency TEXT,
    recipient TEXT,
    is_new_recipient INTEGER,
    policy_decision TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS simulated_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL UNIQUE,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    recipient TEXT NOT NULL,
    execution_status TEXT NOT NULL DEFAULT 'SIMULATED',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transfer_id) REFERENCES transfer_requests(id)
  );
`);

db.exec("PRAGMA foreign_keys = ON");

const approvalColumns = db.prepare(
  "PRAGMA table_info(approvals)"
).all() as Array<{ name: string }>;

if (!approvalColumns.some(column => column.name === "transfer_id")) {
  db.exec("ALTER TABLE approvals ADD COLUMN transfer_id INTEGER");
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_transfer_id
  ON approvals(transfer_id)
  WHERE transfer_id IS NOT NULL;
`);

// Exact NEAR amount storage. Existing historical rows remain nullable.
for (const table of [
  "transfer_requests",
  "approvals",
  "simulated_executions"
]) {
  const columns = db.prepare(
    `PRAGMA table_info(${table})`
  ).all() as Array<{ name: string }>;

  if (!columns.some(column => column.name === "amount_yocto")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN amount_yocto TEXT`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS trusted_recipients (
    account_id TEXT PRIMARY KEY COLLATE NOCASE,
    network TEXT NOT NULL CHECK (network = 'testnet'),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE', 'REVOKED')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (account_id = lower(account_id))
  );
`);
const NEAR_TESTNET_RPC_URL =
  process.env.NEAR_TESTNET_RPC_URL ?? "https://rpc.testnet.near.org";

const YOCTO_PER_NEAR = 10n ** 24n;

type NearAccountVerification =
  | {
      success: true;
      accountId: string;
      amount: string;
      locked: string;
      storageUsage: number | null;
      blockHeight: number;
      blockHash: string;
      verifiedAt: string;
    }
  | {
      success: false;
      status: number;
      error: string;
      message: string;
    };

function isNamedTestnetAccount(accountId: string): boolean {
  return /^(?=.{2,55}\.testnet$)[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/.test(
    accountId
  );
}

function yoctoToNear(value: string): string {
  const amount = BigInt(value);
  const whole = amount / YOCTO_PER_NEAR;
  const remainder = amount % YOCTO_PER_NEAR;
  const fraction = remainder.toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

/**
 * Checks a named NEAR Testnet account against finalized RPC state.
 * This function is read-only: it never signs or submits transactions.
 */
async function verifyNearTestnetAccount(
  rawAccountId: unknown
): Promise<NearAccountVerification> {
  if (typeof rawAccountId !== "string") {
    return {
      success: false,
      status: 400,
      error: "INVALID_TESTNET_ACCOUNT",
      message: "Provide a valid named NEAR Testnet account ID."
    };
  }

  const accountId = rawAccountId.trim().toLowerCase();

  if (!isNamedTestnetAccount(accountId)) {
    return {
      success: false,
      status: 400,
      error: "INVALID_TESTNET_ACCOUNT",
      message: "Provide a valid named NEAR Testnet account ID."
    };
  }

  try {
    const rpcResponse = await fetch(NEAR_TESTNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "warden-read-only-account-check",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId
        }
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!rpcResponse.ok) {
      return {
        success: false,
        status: 502,
        error: "NEAR_RPC_HTTP_ERROR",
        message: `NEAR Testnet RPC returned HTTP ${rpcResponse.status}.`
      };
    }

    const rpcData = await rpcResponse.json() as {
      error?: { code?: number; message?: string; data?: unknown };
      result?: {
        amount?: string;
        locked?: string;
        storage_usage?: number;
        block_height?: number;
        block_hash?: string;
      };
    };

    if (rpcData.error) {
      const rpcMessage = rpcData.error.message ?? "NEAR RPC query failed.";
      const notFound =
        /unknown account|account .* does not exist|account does not exist/i.test(
          rpcMessage
        );

      return {
        success: false,
        status: notFound ? 404 : 502,
        error: notFound ? "NEAR_ACCOUNT_NOT_FOUND" : "NEAR_RPC_QUERY_FAILED",
        message: notFound
          ? "The recipient account does not exist on NEAR Testnet."
          : "NEAR Testnet RPC could not verify the recipient account."
      };
    }

    const result = rpcData.result;

    if (
      !result ||
      typeof result.amount !== "string" ||
      !/^\d+$/.test(result.amount) ||
      typeof result.block_height !== "number" ||
      !Number.isSafeInteger(result.block_height) ||
      result.block_height < 0 ||
      typeof result.block_hash !== "string" ||
      result.block_hash.length === 0
    ) {
      return {
        success: false,
        status: 502,
        error: "INVALID_NEAR_RPC_RESPONSE",
        message: "NEAR RPC returned incomplete or invalid account data."
      };
    }

    const locked =
      typeof result.locked === "string" && /^\d+$/.test(result.locked)
        ? result.locked
        : "0";

    return {
      success: true,
      accountId,
      amount: result.amount,
      locked,
      storageUsage:
        typeof result.storage_usage === "number" &&
        Number.isSafeInteger(result.storage_usage)
          ? result.storage_usage
          : null,
      blockHeight: result.block_height,
      blockHash: result.block_hash,
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    const timedOut =
      error instanceof Error && error.name === "TimeoutError";

    return {
      success: false,
      status: 502,
      error: timedOut ? "NEAR_RPC_TIMEOUT" : "NEAR_RPC_UNAVAILABLE",
      message: timedOut
        ? "NEAR Testnet RPC did not respond within 10 seconds."
        : "Unable to verify the account against NEAR Testnet RPC."
    };
  }
}

// Explicit read-only recipient validation endpoint.
app.post("/api/near/validate-recipient", async (req, res) => {
  const verification = await verifyNearTestnetAccount(req.body?.recipient);

  if (!verification.success) {
    return res.status(verification.status).json({
      success: false,
      error: verification.error,
      message: verification.message
    });
  }

  return res.json({
    success: true,
    network: "testnet",
    accountId: verification.accountId,
    exists: true,
    blockHeight: verification.blockHeight,
    blockHash: verification.blockHash,
    finality: "final",
    verifiedAt: verification.verifiedAt,
    source: "NEAR Testnet RPC"
  });
});

// Read-only finalized account balance endpoint.
app.get("/api/near/account/:accountId", async (req, res) => {
  const verification = await verifyNearTestnetAccount(req.params.accountId);

  if (!verification.success) {
    return res.status(verification.status).json({
      success: false,
      error: verification.error,
      message: verification.message
    });
  }

  return res.json({
    success: true,
    network: "testnet",
    accountId: verification.accountId,
    balanceYocto: verification.amount,
    balanceNear: yoctoToNear(verification.amount),
    lockedYocto: verification.locked,
    storageUsage: verification.storageUsage,
    blockHeight: verification.blockHeight,
    blockHash: verification.blockHash,
    finality: "final",
    verifiedAt: verification.verifiedAt,
    source: "NEAR Testnet RPC"
  });
});
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "WARDEN API",
    status: "operational",
    database: "connected",
    executionMode: "SIMULATION_ONLY",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/audit", (_req, res) => {
  const events = db.prepare(`
    SELECT id, event_type, details, created_at
    FROM audit_events
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json({ success: true, events });
});

// Evaluate a transfer using exact NEAR amounts and server-owned recipient trust.
app.post("/api/policy/evaluate", async (req, res) => {
  const rawRecipient = req.body?.recipient;

  const normalizedRecipient =
    typeof rawRecipient === "string"
      ? rawRecipient.trim().toLowerCase()
      : rawRecipient;

  // Caller-supplied isNewRecipient is deliberately ignored.
  const trustedRecipient =
    typeof normalizedRecipient === "string" &&
    normalizedRecipient.length > 0
      ? db.prepare(`
          SELECT account_id
          FROM trusted_recipients
          WHERE account_id = ?
            AND network = 'testnet'
            AND status = 'ACTIVE'
        `).get(normalizedRecipient)
      : undefined;

  const recipientTrust = trustedRecipient
    ? "TRUSTED_REGISTRY"
    : "UNREGISTERED";

  const request = {
    amount: req.body?.amount,
    currency: req.body?.currency,
    recipient: normalizedRecipient,
    isNewRecipient: !trustedRecipient
  };

  const parsedAmount = parseNearAmount(request.amount);
  const result = evaluateTransferPolicy(request);

  let recipientVerification:
    | Extract<NearAccountVerification, { success: true }>
    | null = null;

  // Only valid NEAR requests reach the RPC. Invalid amounts, invalid
  // recipient formats and unsupported currencies remain policy decisions.
  if (
    parsedAmount &&
    request.currency === "NEAR" &&
    result.reasonCode !== "INVALID_RECIPIENT"
  ) {
    const verification = await verifyNearTestnetAccount(request.recipient);

    if (!verification.success) {
      return res.status(verification.status).json({
        success: false,
        error: verification.error,
        message: verification.message,
        network: "testnet",
        accountId:
          typeof request.recipient === "string"
            ? request.recipient
            : null
      });
    }

    recipientVerification = verification;
  }

  let transferId: number;
  let approvalId: number | null = null;

  const transferStatus =
    result.decision === "ALLOW"
      ? "AUTHORIZED"
      : result.decision === "REQUIRES_APPROVAL"
        ? "AWAITING_APPROVAL"
        : "BLOCKED";

  // Numeric amount is retained for existing dashboard display only.
  // amount_yocto is authoritative for NEAR authorization.
  const displayAmount = parsedAmount
    ? Number(parsedAmount.amountNear)
    : null;

  db.exec("BEGIN IMMEDIATE");

  try {
    const transferInsert = db.prepare(`
      INSERT INTO transfer_requests (
        amount,
        amount_yocto,
        currency,
        recipient,
        is_new_recipient,
        policy_decision,
        reason_code,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      displayAmount,
      result.amountYocto,
      typeof request.currency === "string" ? request.currency : null,
      typeof request.recipient === "string" ? request.recipient : null,
      request.isNewRecipient ? 1 : 0,
      result.decision,
      result.reasonCode,
      transferStatus
    );

    transferId = Number(transferInsert.lastInsertRowid);

    if (result.decision === "REQUIRES_APPROVAL") {
      const approvalInsert = db.prepare(`
        INSERT INTO approvals (
          amount,
          amount_yocto,
          currency,
          recipient,
          reason_code,
          transfer_id
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        displayAmount,
        result.amountYocto,
        request.currency,
        request.recipient,
        result.reasonCode,
        transferId
      );

      approvalId = Number(approvalInsert.lastInsertRowid);
    }

    db.prepare(`
      INSERT INTO audit_events (event_type, details)
      VALUES (?, ?)
    `).run(
      "POLICY_EVALUATED",
      JSON.stringify({
        transferId,
        approvalId,
        request,
        amountYocto: result.amountYocto,
        recipientTrust,
        recipientVerification: recipientVerification ? {
          accountId: recipientVerification.accountId,
          blockHeight: recipientVerification.blockHeight,
          blockHash: recipientVerification.blockHash,
          verifiedAt: recipientVerification.verifiedAt
        } : null,
        trustSource: "SERVER_REGISTRY",
        result
      })
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json({
    success: true,
    transferId,
    approvalId,
    recipientTrust,
    trustSource: "SERVER_REGISTRY",
    recipientVerification: recipientVerification ? {
      exists: true,
      accountId: recipientVerification.accountId,
      blockHeight: recipientVerification.blockHeight,
      blockHash: recipientVerification.blockHash,
      finality: "final",
      verifiedAt: recipientVerification.verifiedAt
    } : null,
    amountYocto: result.amountYocto,
    policy: result,
    transferStatus
  });
});

// View all persisted transfer requests.
app.get("/api/transfers", (_req, res) => {
  const transfers = db.prepare(`
    SELECT
      t.id,
      t.amount,
      t.currency,
      t.recipient,
      t.policy_decision,
      t.reason_code,
      t.status,
      t.created_at,
      a.id AS approval_id,
      a.status AS approval_status
    FROM transfer_requests t
    LEFT JOIN approvals a ON a.transfer_id = t.id
    ORDER BY t.id DESC
    LIMIT 100
  `).all();

  res.json({
    success: true,
    transfers
  });
});

// View the details of one transfer.
app.get("/api/transfers/:id", (req, res) => {
  const transferId = Number(req.params.id);

  if (!Number.isSafeInteger(transferId) || transferId <= 0) {
    return res.status(400).json({
      success: false,
      error: "INVALID_TRANSFER_ID"
    });
  }

  const transfer = db.prepare(`
    SELECT
      t.*,
      a.id AS approval_id,
      a.status AS approval_status,
      a.reviewer,
      a.reviewed_at
    FROM transfer_requests t
    LEFT JOIN approvals a ON a.transfer_id = t.id
    WHERE t.id = ?
  `).get(transferId);

  if (!transfer) {
    return res.status(404).json({
      success: false,
      error: "TRANSFER_NOT_FOUND"
    });
  }

  res.json({
    success: true,
    transfer
  });
});

// Persistent human approval queue.
app.get("/api/approvals", (_req, res) => {
  const approvals = db.prepare(`
    SELECT
      id,
      transfer_id,
      amount,
      currency,
      recipient,
      reason_code,
      status,
      reviewer,
      created_at,
      reviewed_at
    FROM approvals
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json({
    success: true,
    approvals
  });
});

// Record a human approval or rejection.
app.post("/api/approvals/:id/decision", (req, res) => {
  const approvalId = Number(req.params.id);
  const decision = req.body?.decision;

  const reviewer =
    typeof req.body?.reviewer === "string"
      ? req.body.reviewer.trim()
      : "";

  if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
    return res.status(400).json({
      success: false,
      error: "INVALID_APPROVAL_ID"
    });
  }

  if (decision !== "APPROVE" && decision !== "REJECT") {
    return res.status(400).json({
      success: false,
      error: "INVALID_DECISION"
    });
  }

  if (!reviewer || reviewer.length > 100) {
    return res.status(400).json({
      success: false,
      error: "INVALID_REVIEWER"
    });
  }

  const status =
    decision === "APPROVE" ? "APPROVED" : "REJECTED";

  db.exec("BEGIN IMMEDIATE");

  try {
    const approval = db.prepare(`
      SELECT id, transfer_id, status
      FROM approvals
      WHERE id = ?
    `).get(approvalId) as
      | { id: number; transfer_id: number | null; status: string }
      | undefined;

    if (!approval || approval.status !== "PENDING") {
      db.exec("ROLLBACK");

      return res.status(409).json({
        success: false,
        error: "APPROVAL_NOT_PENDING",
        message: "Approval does not exist or has already been decided."
      });
    }

    db.prepare(`
      UPDATE approvals
      SET status = ?,
          reviewer = ?,
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'PENDING'
    `).run(status, reviewer, approvalId);

    if (approval.transfer_id !== null) {
      db.prepare(`
        UPDATE transfer_requests
        SET status = ?
        WHERE id = ?
          AND status = 'AWAITING_APPROVAL'
      `).run(
        decision === "APPROVE" ? "APPROVED" : "REJECTED",
        approval.transfer_id
      );
    }

    db.prepare(`
      INSERT INTO audit_events (event_type, details)
      VALUES (?, ?)
    `).run(
      "APPROVAL_DECIDED",
      JSON.stringify({
        approvalId,
        transferId: approval.transfer_id,
        decision,
        status,
        reviewer
      })
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json({
    success: true,
    approvalId,
    status,
    reviewer,
    message: "Decision recorded. No transfer was executed."
  });
});

// Simulation-only execution gate.
// This endpoint never submits a real NEAR transaction.
app.post("/api/transfers/:id/simulate-execution", (req, res) => {
  const transferId = Number(req.params.id);

  if (!Number.isSafeInteger(transferId) || transferId <= 0) {
    return res.status(400).json({
      success: false,
      error: "INVALID_TRANSFER_ID"
    });
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const transfer = db.prepare(`
      SELECT *
      FROM transfer_requests
      WHERE id = ?
    `).get(transferId) as
      | {
          id: number;
          amount: number | null;
          amount_yocto: string | null;
          currency: string | null;
          recipient: string | null;
          policy_decision: string;
          status: string;
        }
      | undefined;

    if (!transfer) {
      db.exec("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "TRANSFER_NOT_FOUND"
      });
    }

    if (transfer.status === "SIMULATED_EXECUTED") {
      db.exec("ROLLBACK");

      return res.status(409).json({
        success: false,
        error: "DUPLICATE_EXECUTION",
        message: "This transfer has already been simulated."
      });
    }

    if (transfer.policy_decision === "BLOCK") {
      db.exec("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "POLICY_BLOCKED",
        message: "Blocked transfers cannot be executed."
      });
    }

    // Revalidate NEAR Testnet recipient trust at simulation time.
    // This query runs inside BEGIN IMMEDIATE, preventing a concurrent
    // local trust-registry change from racing with the simulation write.
    if (transfer.currency === "NEAR") {
      const currentRecipientTrust = db.prepare(`
        SELECT status
        FROM trusted_recipients
        WHERE account_id = ? COLLATE NOCASE
          AND network = 'testnet'
      `).get(transfer.recipient) as
        | { status: string }
        | undefined;

      if (currentRecipientTrust?.status === "REVOKED") {
        db.exec("ROLLBACK");

        return res.status(403).json({
          success: false,
          error: "RECIPIENT_TRUST_REVOKED",
          message: "Recipient trust has been revoked. This transfer cannot be simulated."
        });
      }

      // Autonomous ALLOW requires current active registry trust.
      // Unregistered recipients may still use the existing human-approval path.
      if (
        transfer.policy_decision === "ALLOW" &&
        currentRecipientTrust?.status !== "ACTIVE"
      ) {
        db.exec("ROLLBACK");

        return res.status(403).json({
          success: false,
          error: "RECIPIENT_NOT_TRUSTED",
          message: "Autonomous NEAR transfers require an actively trusted Testnet recipient."
        });
      }
    }
    if (transfer.policy_decision === "REQUIRES_APPROVAL") {
      const approval = db.prepare(`
        SELECT id, amount, amount_yocto, currency, recipient, status, transfer_id
        FROM approvals
        WHERE transfer_id = ?
      `).get(transferId) as
        | {
            id: number;
            amount: number;
            amount_yocto: string | null;
            currency: string;
            recipient: string;
            status: string;
            transfer_id: number;
          }
        | undefined;

      // Fail closed: BOTH the transfer and its linked approval must be APPROVED.
      if (
        transfer.status !== "APPROVED" ||
        !approval ||
        approval.status !== "APPROVED" ||
        approval.transfer_id !== transferId ||
        (
          transfer.currency === "NEAR"
            ? (
                !transfer.amount_yocto ||
                !approval.amount_yocto ||
                approval.amount_yocto !== transfer.amount_yocto
              )
            : approval.amount !== transfer.amount
        ) ||
        approval.currency !== transfer.currency ||
        approval.recipient !== transfer.recipient
      ) {
        db.exec("ROLLBACK");

        return res.status(403).json({
          success: false,
          error: "APPROVAL_REQUIRED_OR_MISMATCHED",
          message: "A matching human-approved transfer is required."
        });
      }
    } else if (
      transfer.policy_decision !== "ALLOW" ||
      transfer.status !== "AUTHORIZED"
    ) {
      db.exec("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "TRANSFER_NOT_AUTHORIZED"
      });
    }

    if (
      transfer.currency === "NEAR" &&
      (
        typeof transfer.amount_yocto !== "string" ||
        !/^[1-9]\d*$/.test(transfer.amount_yocto)
      )
    ) {
      db.exec("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "INCOMPLETE_EXACT_AMOUNT",
        message: "NEAR transfers require a valid exact yoctoNEAR amount."
      });
    }

    if (
      typeof transfer.amount !== "number" ||
      !transfer.currency ||
      !transfer.recipient
    ) {
      db.exec("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "INCOMPLETE_TRANSFER"
      });
    }

    const execution = db.prepare(`
      INSERT INTO simulated_executions (
        transfer_id,
        amount,
        amount_yocto,
        currency,
        recipient,
        execution_status
      )
      VALUES (?, ?, ?, ?, ?, 'SIMULATED')
    `).run(
      transferId,
      transfer.amount,
      transfer.amount_yocto,
      transfer.currency,
      transfer.recipient
    );

    const executionId = Number(execution.lastInsertRowid);

    db.prepare(`
      UPDATE transfer_requests
      SET status = 'SIMULATED_EXECUTED'
      WHERE id = ?
    `).run(transferId);

    db.prepare(`
      INSERT INTO audit_events (event_type, details)
      VALUES (?, ?)
    `).run(
      "SIMULATED_EXECUTION",
      JSON.stringify({
        executionId,
        transferId,
        amount: transfer.amount,
        amountYocto: transfer.amount_yocto,
        currency: transfer.currency,
        recipient: transfer.recipient,
        executionStatus: "SIMULATED",
        realFundsMoved: false
      })
    );

    db.exec("COMMIT");

    return res.json({
      success: true,
      executionId,
      transferId,
      executionStatus: "SIMULATED",
      realFundsMoved: false,
      message: "Execution gate passed. Simulation recorded; no NEAR transaction was submitted."
    });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

app.get("/api/executions", (_req, res) => {
  const executions = db.prepare(`
    SELECT *
    FROM simulated_executions
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json({
    success: true,
    executions
  });
});

app.listen(PORT, () => {
  console.log(`WARDEN API running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log("Execution mode: SIMULATION ONLY");
});
