/**
 * Unit Tests: Claim Trigger Logic
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the claim trigger logic that:
 * 1. Calls eligibility-engine for eligible delays
 * 2. Handles success/failure responses
 * 3. Records claim trigger status
 *
 * NOTE: These tests should FAIL until Blake implements the claim trigger module.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { ClaimTrigger, ClaimTriggerResult } from '../../src/services/claim-trigger.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { EligibilityEngineClient } from '../../src/clients/eligibility-engine.js';

// Import fixtures
import {
  claimTriggerSuccess,
  notEligibleResponse,
  claimTriggerError,
  duplicateClaimResponse,
  largeDelayClaimResponse,
} from '../fixtures/api/eligibility-engine-responses.fixtures.js';

import {
  delayWithClaimTriggered,
  delayPendingClaimTrigger,
  delayAtThreshold,
} from '../fixtures/db/delay-alerts.fixtures.js';

describe('ClaimTrigger', () => {
  let claimTrigger: ClaimTrigger;
  let mockEligibilityClient: EligibilityEngineClient;

  beforeEach(() => {
    mockEligibilityClient = {
      triggerClaim: vi.fn().mockResolvedValue(claimTriggerSuccess),
      checkEligibility: vi.fn().mockResolvedValue({ eligible: true }),
    } as unknown as EligibilityEngineClient;

    claimTrigger = new ClaimTrigger({
      eligibilityClient: mockEligibilityClient,
    });
  });

  describe('Claim Trigger Execution', () => {
    it('should trigger claim for eligible delay', async () => {
      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 25,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(mockEligibilityClient.triggerClaim).toHaveBeenCalledWith({
        userId: 'user-001',
        journeyId: 'journey-001',
        delayMinutes: 25,
      });
      expect(result.success).toBe(true);
      expect(result.claimReferenceId).toBe('claim-ref-001-abc123');
    });

    it('should not trigger claim for delay below threshold', async () => {
      const delayAlert = {
        id: 'alert-002',
        monitored_journey_id: 'journey-002',
        delay_minutes: 10,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(mockEligibilityClient.triggerClaim).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.reason).toBe('BELOW_THRESHOLD');
    });

    it('should handle eligibility engine success response', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue(claimTriggerSuccess);

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(true);
      expect(result.claimReferenceId).toBe('claim-ref-001-abc123');
      expect(result.estimatedCompensation).toBe(25.5);
    });

    it('should handle not eligible response', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue(notEligibleResponse);

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NOT_ELIGIBLE');
      expect(result.claimReferenceId).toBeNull();
    });

    it('should handle eligibility engine error response', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue(claimTriggerError);

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('SERVICE_ERROR');
    });

    it('should handle duplicate claim response', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue(duplicateClaimResponse);

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('DUPLICATE_CLAIM');
      expect(result.existingClaimReferenceId).toBe('existing-claim-ref-999');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockRejectedValue(new Error('Network error'));

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NETWORK_ERROR');
      expect(result.error).toBeDefined();
    });

    it('should handle timeout errors', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockRejectedValue(new Error('Request timeout'));

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('should mark non-retryable errors appropriately', async () => {
      mockEligibilityClient.triggerClaim = vi.fn().mockResolvedValue({
        success: false,
        message: 'Invalid journey data',
      });

      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 20,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple delays in batch', async () => {
      const delays = [
        { id: 'alert-1', monitored_journey_id: 'journey-1', delay_minutes: 20, user_id: 'user-1' },
        { id: 'alert-2', monitored_journey_id: 'journey-2', delay_minutes: 30, user_id: 'user-2' },
        { id: 'alert-3', monitored_journey_id: 'journey-3', delay_minutes: 25, user_id: 'user-3' },
      ];

      const results = await claimTrigger.triggerClaimsBatch(delays);

      expect(results).toHaveLength(3);
      expect(mockEligibilityClient.triggerClaim).toHaveBeenCalledTimes(3);
    });

    it('should continue processing after individual failure', async () => {
      mockEligibilityClient.triggerClaim = vi
        .fn()
        .mockResolvedValueOnce(claimTriggerSuccess)
        .mockRejectedValueOnce(new Error('Service error'))
        .mockResolvedValueOnce(claimTriggerSuccess);

      const delays = [
        { id: 'alert-1', monitored_journey_id: 'journey-1', delay_minutes: 20, user_id: 'user-1' },
        { id: 'alert-2', monitored_journey_id: 'journey-2', delay_minutes: 30, user_id: 'user-2' },
        { id: 'alert-3', monitored_journey_id: 'journey-3', delay_minutes: 25, user_id: 'user-3' },
      ];

      const results = await claimTrigger.triggerClaimsBatch(delays);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });

    it('should return empty array for empty input', async () => {
      const results = await claimTrigger.triggerClaimsBatch([]);

      expect(results).toEqual([]);
      expect(mockEligibilityClient.triggerClaim).not.toHaveBeenCalled();
    });
  });

  describe('Skip Already Triggered', () => {
    it('should skip delays that have already been triggered', async () => {
      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 25,
        user_id: 'user-001',
        claim_triggered: true,
        claim_reference_id: 'existing-ref',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(mockEligibilityClient.triggerClaim).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.reason).toBe('ALREADY_TRIGGERED');
    });
  });

  describe('Threshold Enforcement', () => {
    it('should enforce 15 minute threshold by default', async () => {
      const delayAt14 = { id: '1', monitored_journey_id: 'j1', delay_minutes: 14, user_id: 'u1' };
      const delayAt15 = { id: '2', monitored_journey_id: 'j2', delay_minutes: 15, user_id: 'u2' };
      const delayAt16 = { id: '3', monitored_journey_id: 'j3', delay_minutes: 16, user_id: 'u3' };

      const result14 = await claimTrigger.triggerClaim(delayAt14);
      const result15 = await claimTrigger.triggerClaim(delayAt15);
      const result16 = await claimTrigger.triggerClaim(delayAt16);

      expect(result14.success).toBe(false);
      expect(result14.reason).toBe('BELOW_THRESHOLD');
      expect(result15.success).toBe(true);
      expect(result16.success).toBe(true);
    });

    it('should allow configurable threshold', () => {
      const customTrigger = new ClaimTrigger({
        eligibilityClient: mockEligibilityClient,
        thresholdMinutes: 30,
      });

      expect(customTrigger.getThreshold()).toBe(30);
    });
  });

  describe('Result Structure', () => {
    it('should return complete result structure on success', async () => {
      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 25,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('claimReferenceId');
      expect(result).toHaveProperty('triggeredAt');
      expect(result).toHaveProperty('delayAlertId');
    });

    it('should include timestamp in result', async () => {
      const delayAlert = {
        id: 'alert-001',
        monitored_journey_id: 'journey-001',
        delay_minutes: 25,
        user_id: 'user-001',
      };

      const result = await claimTrigger.triggerClaim(delayAlert);

      expect(result.triggeredAt).toBeInstanceOf(Date);
    });
  });
});
