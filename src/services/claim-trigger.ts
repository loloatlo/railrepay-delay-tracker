/**
 * Claim Trigger Service
 *
 * Triggers compensation claims via the Eligibility Engine
 * Threshold: >=15 minutes for claim eligibility
 */

import {
  ClaimTriggerResult,
  ClaimTriggerReason,
  ClaimTriggerApiResponse,
} from '../types.js';

interface ClaimTriggerConfig {
  eligibilityClient: EligibilityClient;
  thresholdMinutes?: number;
}

// Eligibility Client interface for dependency injection
interface EligibilityClient {
  triggerClaim(params: {
    userId: string;
    journeyId: string;
    delayMinutes: number;
  }): Promise<ClaimTriggerApiResponse>;
}

// Delay alert input (matches test fixture structure)
interface DelayAlertInput {
  id: string;
  monitored_journey_id: string;
  delay_minutes: number;
  user_id: string;
  claim_triggered?: boolean;
  claim_reference_id?: string;
}

// Re-export types for test imports
export { ClaimTriggerResult };

export class ClaimTrigger {
  private eligibilityClient: EligibilityClient;
  private thresholdMinutes: number;

  constructor(config: ClaimTriggerConfig) {
    this.eligibilityClient = config.eligibilityClient;
    this.thresholdMinutes = config.thresholdMinutes ?? 15;
  }

  /**
   * Get the current claim threshold
   */
  getThreshold(): number {
    return this.thresholdMinutes;
  }

  /**
   * Trigger a claim for a single delay alert
   */
  async triggerClaim(delayAlert: DelayAlertInput): Promise<ClaimTriggerResult> {
    const now = new Date();

    // Check if already triggered
    if (delayAlert.claim_triggered) {
      return {
        success: false,
        reason: 'ALREADY_TRIGGERED',
        existingClaimReferenceId: delayAlert.claim_reference_id,
        triggeredAt: now,
        delayAlertId: delayAlert.id,
      };
    }

    // Check threshold
    if (delayAlert.delay_minutes < this.thresholdMinutes) {
      return {
        success: false,
        reason: 'BELOW_THRESHOLD',
        triggeredAt: now,
        delayAlertId: delayAlert.id,
      };
    }

    try {
      const response = await this.eligibilityClient.triggerClaim({
        userId: delayAlert.user_id,
        journeyId: delayAlert.monitored_journey_id,
        delayMinutes: delayAlert.delay_minutes,
      });

      // Handle duplicate claim response (check for existing claim_reference_id in response)
      if (!response.success && response.claim_reference_id) {
        return {
          success: false,
          reason: 'DUPLICATE_CLAIM',
          existingClaimReferenceId: response.claim_reference_id,
          triggeredAt: now,
          delayAlertId: delayAlert.id,
        };
      }

      // Handle not eligible response
      if (response.eligible === false) {
        return {
          success: false,
          reason: 'NOT_ELIGIBLE',
          claimReferenceId: null,
          triggeredAt: now,
          delayAlertId: delayAlert.id,
        };
      }

      // Handle service error (success: false with no claim_reference_id)
      if (!response.success) {
        return {
          success: false,
          reason: 'SERVICE_ERROR',
          error: response.message,
          retryable: false,
          triggeredAt: now,
          delayAlertId: delayAlert.id,
        };
      }

      // Success
      return {
        success: true,
        claimReferenceId: response.claim_reference_id,
        estimatedCompensation: response.estimated_compensation,
        triggeredAt: now,
        delayAlertId: delayAlert.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isNetworkError = errorMessage.toLowerCase().includes('network') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.toLowerCase().includes('timeout');

      return {
        success: false,
        reason: 'NETWORK_ERROR',
        error: errorMessage,
        retryable: isNetworkError,
        triggeredAt: now,
        delayAlertId: delayAlert.id,
      };
    }
  }

  /**
   * Trigger claims for multiple delay alerts in batch
   */
  async triggerClaimsBatch(delayAlerts: DelayAlertInput[]): Promise<ClaimTriggerResult[]> {
    if (delayAlerts.length === 0) {
      return [];
    }

    const results: ClaimTriggerResult[] = [];

    for (const alert of delayAlerts) {
      const result = await this.triggerClaim(alert);
      results.push(result);
    }

    return results;
  }
}
