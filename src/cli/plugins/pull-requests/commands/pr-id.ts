export interface PullRequestIdValidation {
  readonly valid: boolean;
  readonly value?: number;
  readonly error?: string;
}

export function validatePullRequestId(
  prId: string | number
): PullRequestIdValidation {
  const id = typeof prId === 'string' ? parseInt(prId, 10) : prId;

  if (Number.isNaN(id) || id <= 0) {
    return {
      valid: false,
      error: `Invalid PR ID: ${prId}. Must be a positive integer.`,
    };
  }

  return {
    valid: true,
    value: id,
  };
}
