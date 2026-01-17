/**
 * Unit Tests: EligibilityEngineClient
 *
 * Phase: TD-1 - Test Specification (Jessie)
 * TD Item: TD-DELAY-001 - External HTTP Clients Not Tested + Architectural Correction
 * Service: delay-tracker
 *
 * Tests for the EligibilityEngineClient that communicates with eligibility-engine service.
 * These tests prove the coverage gap exists and define expected behavior.
 *
 * ACCEPTANCE CRITERIA:
 * - AC-2.1: triggerClaim() returns success response
 * - AC-2.2: triggerClaim() returns error response on HTTP error
 * - AC-2.3: triggerClaim() throws on timeout
 * - AC-2.4: checkEligibility() returns eligibility response
 * - AC-2.5: checkEligibility() returns eligible: false on HTTP error
 *
 * NOTE: These tests should FAIL until Blake implements the fix.
 * DO NOT modify these tests to make them pass - implement the code instead.
 *
 * TEST LOCK RULE: Blake MUST NOT modify these tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { EligibilityEngineClient } from '../../../src/clients/eligibility-engine.js';
import type { ClaimTriggerApiResponse, EligibilityCheckResponse } from '../../../src/types.js';

// ============================================================================
// Test Fixtures - Real data patterns from eligibility engine responses
// ============================================================================

/**
 * _fixtureMetadata:
 *   source: eligibility-engine API contract
 *   sampledAt: 2026-01-17
 *   description: Successful claim trigger response
 */
const successfulClaimResponse: ClaimTriggerApiResponse = {
  success: true,
  claim_reference_id: 'claim-ref-001-abc123',
  message: 'Claim successfully initiated',
  eligible: true,
  estimated_compensation: 25.5,
};

/**
 * _fixtureMetadata:
 *   source: eligibility-engine API contract
 *   sampledAt: 2026-01-17
 *   description: Not eligible claim response
 */
const notEligibleClaimResponse: ClaimTriggerApiResponse = {
  success: true,
  claim_reference_id: null,
  message: 'Journey does not meet eligibility criteria',
  eligible: false,
};

/**
 * _fixtureMetadata:
 *   source: eligibility-engine API contract
 *   sampledAt: 2026-01-17
 *   description: Successful eligibility check response
 */
const eligibleCheckResponse: EligibilityCheckResponse = {
  eligible: true,
  reason: 'Delay exceeds threshold for compensation',
};

/**
 * _fixtureMetadata:
 *   source: eligibility-engine API contract
 *   sampledAt: 2026-01-17
 *   description: Not eligible check response
 */
const notEligibleCheckResponse: EligibilityCheckResponse = {
  eligible: false,
  reason: 'Delay below minimum threshold',
};

// ============================================================================
// Test Parameters - Real UUIDs from journey_matcher.journeys
// ============================================================================

const testTriggerParams = {
  delayAlertId: 'alert-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  journeyId: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
  userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  delayMinutes: 25,
  delayReasons: { reason: 'Signal failure at Peterborough' },
};

const testCheckParams = {
  userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  journeyId: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
  delayMinutes: 25,
};

// ============================================================================
// MSW Server Setup
// ============================================================================

const TEST_BASE_URL = 'http://eligibility-engine.test:3000';

const handlers = [
  // Success handler for triggerClaim
  http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
    return HttpResponse.json(successfulClaimResponse);
  }),

  // Success handler for checkEligibility
  http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
    return HttpResponse.json(eligibleCheckResponse);
  }),
];

const server = setupServer(...handlers);

// ============================================================================
// Test Suite
// ============================================================================

describe('TD-DELAY-001: EligibilityEngineClient', () => {
  /**
   * TD CONTEXT: src/clients/eligibility-engine.ts has 0% test coverage (123 lines)
   * REQUIRED FIX: Add comprehensive unit tests for all HTTP client methods
   * IMPACT: HIGH - Untested claim triggers could fail silently, causing missed compensation
   */

  let client: EligibilityEngineClient;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    client = new EligibilityEngineClient({
      baseUrl: TEST_BASE_URL,
      timeout: 5000,
    });
  });

  // ==========================================================================
  // AC-2.1: triggerClaim() returns success response
  // ==========================================================================

  describe('AC-2.1: triggerClaim() returns success response', () => {
    it('should return successful claim response with reference ID', async () => {
      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(true);
      expect(result.claim_reference_id).toBe('claim-ref-001-abc123');
      expect(result.message).toBe('Claim successfully initiated');
      expect(result.eligible).toBe(true);
      expect(result.estimated_compensation).toBe(25.5);
    });

    it('should return not-eligible response when journey does not qualify', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return HttpResponse.json(notEligibleClaimResponse);
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(true);
      expect(result.claim_reference_id).toBeNull();
      expect(result.eligible).toBe(false);
    });

    it('should handle claim trigger without delay reasons', async () => {
      const paramsWithoutReasons = {
        ...testTriggerParams,
        delayReasons: undefined,
      };

      const result = await client.triggerClaim(paramsWithoutReasons);

      expect(result.success).toBe(true);
    });

    it('should send correct request body to API', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json(successfulClaimResponse);
        })
      );

      await client.triggerClaim(testTriggerParams);

      expect(capturedBody).toEqual({
        delay_alert_id: testTriggerParams.delayAlertId,
        journey_id: testTriggerParams.journeyId,
        user_id: testTriggerParams.userId,
        delay_minutes: testTriggerParams.delayMinutes,
        delay_reasons: testTriggerParams.delayReasons,
      });
    });
  });

  // ==========================================================================
  // AC-2.2: triggerClaim() returns error response on HTTP error
  // ==========================================================================

  describe('AC-2.2: triggerClaim() returns error response on HTTP error', () => {
    it('should return error response on 500 Internal Server Error', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return new HttpResponse('Internal Server Error', {
            status: 500,
            statusText: 'Internal Server Error',
          });
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error: 500 Internal Server Error');
      expect(result.message).toBe('Internal Server Error');
    });

    it('should return error response on 400 Bad Request', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return new HttpResponse('Invalid journey ID format', {
            status: 400,
            statusText: 'Bad Request',
          });
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error: 400 Bad Request');
      expect(result.message).toBe('Invalid journey ID format');
    });

    it('should return error response on 503 Service Unavailable', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return new HttpResponse('Service temporarily unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
          });
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('503');
    });

    it('should return error response on 401 Unauthorized', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return new HttpResponse('Unauthorized', {
            status: 401,
            statusText: 'Unauthorized',
          });
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should include response body in error message', async () => {
      const errorBody = 'Claim validation failed: missing required fields';

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return new HttpResponse(errorBody, {
            status: 422,
            statusText: 'Unprocessable Entity',
          });
        })
      );

      const result = await client.triggerClaim(testTriggerParams);

      expect(result.success).toBe(false);
      expect(result.message).toBe(errorBody);
    });
  });

  // ==========================================================================
  // AC-2.3: triggerClaim() throws on timeout
  // ==========================================================================

  describe('AC-2.3: triggerClaim() throws on timeout', () => {
    it('should throw timeout error when request exceeds timeout', async () => {
      const shortTimeoutClient = new EligibilityEngineClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms timeout
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(successfulClaimResponse);
        })
      );

      await expect(shortTimeoutClient.triggerClaim(testTriggerParams)).rejects.toThrow(
        'Eligibility API request timeout'
      );
    });

    it('should throw Error with timeout message', async () => {
      const shortTimeoutClient = new EligibilityEngineClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1,
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(successfulClaimResponse);
        })
      );

      try {
        await shortTimeoutClient.triggerClaim(testTriggerParams);
        expect.fail('Expected timeout error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('timeout');
      }
    });
  });

  // ==========================================================================
  // AC-2.4: checkEligibility() returns eligibility response
  // ==========================================================================

  describe('AC-2.4: checkEligibility() returns eligibility response', () => {
    it('should return eligible response when journey qualifies', async () => {
      const result = await client.checkEligibility(testCheckParams);

      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('Delay exceeds threshold for compensation');
    });

    it('should return not-eligible response when journey does not qualify', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
          return HttpResponse.json(notEligibleCheckResponse);
        })
      );

      const result = await client.checkEligibility(testCheckParams);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Delay below minimum threshold');
    });

    it('should send correct request body to API', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json(eligibleCheckResponse);
        })
      );

      await client.checkEligibility(testCheckParams);

      expect(capturedBody).toEqual({
        user_id: testCheckParams.userId,
        journey_id: testCheckParams.journeyId,
        delay_minutes: testCheckParams.delayMinutes,
      });
    });

    it('should handle various delay minute values', async () => {
      const paramsWithLargeDelay = {
        ...testCheckParams,
        delayMinutes: 120,
      };

      const result = await client.checkEligibility(paramsWithLargeDelay);

      expect(result.eligible).toBe(true);
    });
  });

  // ==========================================================================
  // AC-2.5: checkEligibility() returns eligible: false on HTTP error
  // ==========================================================================

  describe('AC-2.5: checkEligibility() returns eligible: false on HTTP error', () => {
    it('should return eligible: false on 500 Internal Server Error', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: 'Internal Server Error',
          });
        })
      );

      const result = await client.checkEligibility(testCheckParams);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('API error: 500');
    });

    it('should return eligible: false on 400 Bad Request', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
          return new HttpResponse(null, {
            status: 400,
            statusText: 'Bad Request',
          });
        })
      );

      const result = await client.checkEligibility(testCheckParams);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('API error: 400');
    });

    it('should return eligible: false on 503 Service Unavailable', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
          return new HttpResponse(null, {
            status: 503,
            statusText: 'Service Unavailable',
          });
        })
      );

      const result = await client.checkEligibility(testCheckParams);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('503');
    });

    it('should throw on timeout (not return eligible: false)', async () => {
      const shortTimeoutClient = new EligibilityEngineClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1,
      });

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json(eligibleCheckResponse);
        })
      );

      await expect(shortTimeoutClient.checkEligibility(testCheckParams)).rejects.toThrow(
        'Eligibility API request timeout'
      );
    });
  });

  // ==========================================================================
  // Additional Edge Cases for Coverage
  // ==========================================================================

  describe('Configuration and Edge Cases', () => {
    it('should use default timeout of 30000ms when not specified', () => {
      const defaultClient = new EligibilityEngineClient({
        baseUrl: TEST_BASE_URL,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((defaultClient as any).timeout).toBe(30000);
    });

    it('should remove trailing slash from baseUrl', () => {
      const clientWithSlash = new EligibilityEngineClient({
        baseUrl: `${TEST_BASE_URL}/`,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((clientWithSlash as any).baseUrl).toBe(TEST_BASE_URL);
    });

    it('should send correct Content-Type header for triggerClaim', async () => {
      let capturedContentType: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, ({ request }) => {
          capturedContentType = request.headers.get('Content-Type');
          return HttpResponse.json(successfulClaimResponse);
        })
      );

      await client.triggerClaim(testTriggerParams);

      expect(capturedContentType).toBe('application/json');
    });

    it('should send correct Content-Type header for checkEligibility', async () => {
      let capturedContentType: string | null = null;

      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, ({ request }) => {
          capturedContentType = request.headers.get('Content-Type');
          return HttpResponse.json(eligibleCheckResponse);
        })
      );

      await client.checkEligibility(testCheckParams);

      expect(capturedContentType).toBe('application/json');
    });

    it('should handle network errors for triggerClaim', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/claims/trigger`, () => {
          return HttpResponse.error();
        })
      );

      await expect(client.triggerClaim(testTriggerParams)).rejects.toThrow();
    });

    it('should handle network errors for checkEligibility', async () => {
      server.use(
        http.post(`${TEST_BASE_URL}/api/v1/eligibility/check`, () => {
          return HttpResponse.error();
        })
      );

      await expect(client.checkEligibility(testCheckParams)).rejects.toThrow();
    });
  });
});
