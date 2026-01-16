/**
 * Test Fixtures: Eligibility Engine API Responses
 *
 * Source: Service Layer specification
 * Purpose: Mock responses from eligibility-engine service for claim triggers
 */

export interface ClaimTriggerResponse {
  success: boolean;
  claim_reference_id: string | null;
  message: string;
  eligible: boolean;
  estimated_compensation?: number;
}

/**
 * Successful claim trigger response
 */
export const claimTriggerSuccess: ClaimTriggerResponse = {
  success: true,
  claim_reference_id: 'claim-ref-001-abc123',
  message: 'Claim successfully initiated',
  eligible: true,
  estimated_compensation: 25.5,
};

/**
 * Journey not eligible for claim
 */
export const notEligibleResponse: ClaimTriggerResponse = {
  success: true,
  claim_reference_id: null,
  message: 'Journey does not meet eligibility criteria',
  eligible: false,
};

/**
 * Claim trigger failed due to system error
 */
export const claimTriggerError: ClaimTriggerResponse = {
  success: false,
  claim_reference_id: null,
  message: 'Unable to process claim at this time',
  eligible: true, // Was eligible but processing failed
};

/**
 * Duplicate claim attempt
 */
export const duplicateClaimResponse: ClaimTriggerResponse = {
  success: false,
  claim_reference_id: 'existing-claim-ref-999',
  message: 'Claim already exists for this journey',
  eligible: true,
};

/**
 * Response for large delay (higher compensation)
 */
export const largeDelayClaimResponse: ClaimTriggerResponse = {
  success: true,
  claim_reference_id: 'claim-ref-large-delay-002',
  message: 'Claim successfully initiated for significant delay',
  eligible: true,
  estimated_compensation: 75.0,
};

export default {
  claimTriggerSuccess,
  notEligibleResponse,
  claimTriggerError,
  duplicateClaimResponse,
  largeDelayClaimResponse,
};
