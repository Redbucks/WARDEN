export type PolicyDecision =
  | "ALLOW"
  | "REQUIRES_APPROVAL"
  | "BLOCK";

export interface TransferRequest {
  amount: unknown;
  currency: string;
  recipient: string;
  isNewRecipient: boolean;
}

export interface ParsedNearAmount {
  amountNear: string;
  amountYocto: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  reasonCode: string;
  evaluatedAt: string;
  amountYocto: string | null;
  limits: {
    maxAutonomousTransfer: number;
    approvalThreshold: number;
    hardTransferLimit: number;
    maxAutonomousTransferYocto: string;
    hardTransferLimitYocto: string;
  };
}

const YOCTO_PER_NEAR = 10n ** 24n;

const POLICY_LIMITS = {
  maxAutonomousTransfer: 0.01,
  approvalThreshold: 0.01,
  hardTransferLimit: 1,
  maxAutonomousTransferYocto: "10000000000000000000000",
  hardTransferLimitYocto: "1000000000000000000000000"
};

/**
 * Accepts a decimal NEAR string and converts it to exact yoctoNEAR.
 * Numbers, scientific notation, signs, commas and >24 decimals fail closed.
 */
export function parseNearAmount(value: unknown): ParsedNearAmount | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80
  ) {
    return null;
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d{1,24}))?$/.exec(value);

  if (!match) {
    return null;
  }

  const whole = match[1];
  const fraction = match[2] ?? "";

  const fractionalYocto = fraction.padEnd(24, "0");
  const amountYocto =
    BigInt(whole) * YOCTO_PER_NEAR +
    BigInt(fractionalYocto || "0");

  if (amountYocto <= 0n) {
    return null;
  }

  const normalizedFraction = fraction.replace(/0+$/, "");
  const amountNear = normalizedFraction
    ? `${whole}.${normalizedFraction}`
    : whole;

  return {
    amountNear,
    amountYocto: amountYocto.toString()
  };
}

export function evaluateTransferPolicy(
  request: TransferRequest
): PolicyResult {
  const evaluatedAt = new Date().toISOString();
  const parsedAmount = parseNearAmount(request.amount);

  const result = (
    decision: PolicyDecision,
    reasonCode: string,
    reason: string
  ): PolicyResult => ({
    decision,
    reasonCode,
    reason,
    evaluatedAt,
    amountYocto: parsedAmount?.amountYocto ?? null,
    limits: { ...POLICY_LIMITS }
  });

  if (!parsedAmount) {
    return result(
      "BLOCK",
      "INVALID_AMOUNT_FORMAT",
      "Amount must be a positive decimal NEAR string with at most 24 fractional digits."
    );
  }

  const amountYocto = BigInt(parsedAmount.amountYocto);

  // Basic format check only; this is not full NEAR protocol validation.
  const validRecipient =
    typeof request.recipient === "string" &&
    /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(
      request.recipient
    );

  if (!validRecipient) {
    return result(
      "BLOCK",
      "INVALID_RECIPIENT",
      "Recipient account ID has an invalid format."
    );
  }

  if (request.currency !== "NEAR") {
    return result(
      "BLOCK",
      "UNSUPPORTED_CURRENCY",
      "This policy currently supports NEAR transfers only."
    );
  }

  if (typeof request.isNewRecipient !== "boolean") {
    return result(
      "BLOCK",
      "INVALID_RECIPIENT_STATUS",
      "Recipient status must be explicitly provided."
    );
  }

  // Hard limit takes priority over approval requirements.
  if (amountYocto > BigInt(POLICY_LIMITS.hardTransferLimitYocto)) {
    return result(
      "BLOCK",
      "HARD_TRANSFER_LIMIT_EXCEEDED",
      "Transfer exceeds the configured hard limit."
    );
  }

  if (request.isNewRecipient) {
    return result(
      "REQUIRES_APPROVAL",
      "NEW_RECIPIENT_APPROVAL",
      "Transfers to new recipients require human approval."
    );
  }

  if (amountYocto > BigInt(POLICY_LIMITS.maxAutonomousTransferYocto)) {
    return result(
      "REQUIRES_APPROVAL",
      "APPROVAL_THRESHOLD",
      "Transfer exceeds the autonomous transfer limit."
    );
  }

  return result(
    "ALLOW",
    "WITHIN_POLICY_LIMITS",
    "Transfer is within the configured autonomous policy limits."
  );
}
