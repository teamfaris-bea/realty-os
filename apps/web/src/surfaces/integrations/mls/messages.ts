// Error code → sentence for the codes the Connect MLS page shows (CONVENTIONS §7: never a raw code).
// Registered on this surface's `errorMessages`. Shared codes (REAUTH_REQUIRED, RATE_LIMITED,
// VALIDATION_FAILED, NOT_FOUND, ...) come from shell/errorMessages.ts and are not repeated here.
export const INTEGRATION_ERROR_MESSAGES: Record<string, string> = {
  MLS_PROVIDER_NOT_SPARK:
    "This deployment isn't set up to use Spark yet (it uses the built-in test listings), so a Spark key can't be saved here. Nothing was stored. Ask whoever runs your deployment to switch the MLS provider to Spark first.",
  MLS_CREDENTIAL_MISSING: 'No Spark key is saved yet, so there is nothing to validate. Save the access token first, then validate it.',
};
