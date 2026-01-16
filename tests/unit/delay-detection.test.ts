/**
 * Unit Tests: Delay Detection Logic
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the delay detection logic that:
 * 1. Checks journey delays against >15 minute threshold
 * 2. Handles various delay scenarios (on-time, minor, major, cancelled)
 * 3. Processes delay reasons from Darwin data
 *
 * NOTE: These tests should FAIL until Blake implements the delay detection module.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayDetector, DelayResult, DelayThreshold } from '../../src/services/delay-detector.js';

// Import fixtures for test data
import {
  singleDelayedService,
  noDelays,
  minorDelay,
  delayAtThreshold,
  cancelledService,
  multipleServicesResponse,
  largeDelayService,
  emptyResponse,
  delayWithNullReasons,
} from '../fixtures/api/darwin-ingestor-responses.fixtures.js';

import {
  activeJourneyWithRid,
  delayedJourney,
} from '../fixtures/db/monitored-journeys.fixtures.js';

describe('DelayDetector', () => {
  let detector: DelayDetector;

  beforeEach(() => {
    detector = new DelayDetector({
      thresholdMinutes: 15,
    });
  });

  describe('Threshold Configuration', () => {
    it('should have default threshold of 15 minutes', () => {
      const defaultDetector = new DelayDetector();
      expect(defaultDetector.getThreshold()).toBe(15);
    });

    it('should allow custom threshold configuration', () => {
      const customDetector = new DelayDetector({ thresholdMinutes: 30 });
      expect(customDetector.getThreshold()).toBe(30);
    });

    it('should reject invalid threshold values', () => {
      expect(() => new DelayDetector({ thresholdMinutes: 0 })).toThrow();
      expect(() => new DelayDetector({ thresholdMinutes: -5 })).toThrow();
    });
  });

  describe('Single Journey Detection', () => {
    it('should detect delay above threshold', () => {
      const delayData = singleDelayedService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isDelayed).toBe(true);
      expect(result.delayMinutes).toBe(25);
      expect(result.exceedsThreshold).toBe(true);
      expect(result.claimEligible).toBe(true);
    });

    it('should not detect delay when service is on time', () => {
      const delayData = noDelays.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isDelayed).toBe(false);
      expect(result.delayMinutes).toBe(0);
      expect(result.exceedsThreshold).toBe(false);
      expect(result.claimEligible).toBe(false);
    });

    it('should detect minor delay but not mark as claim eligible', () => {
      const delayData = minorDelay.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isDelayed).toBe(true);
      expect(result.delayMinutes).toBe(10);
      expect(result.exceedsThreshold).toBe(false);
      expect(result.claimEligible).toBe(false);
    });

    it('should mark delay exactly at threshold as claim eligible', () => {
      const delayData = delayAtThreshold.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isDelayed).toBe(true);
      expect(result.delayMinutes).toBe(15);
      expect(result.exceedsThreshold).toBe(true);
      expect(result.claimEligible).toBe(true);
    });

    it('should handle cancelled services', () => {
      const delayData = cancelledService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isCancelled).toBe(true);
      expect(result.claimEligible).toBe(true); // Cancellations are claim eligible
    });

    it('should detect large delays correctly', () => {
      const delayData = largeDelayService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.isDelayed).toBe(true);
      expect(result.delayMinutes).toBe(90);
      expect(result.exceedsThreshold).toBe(true);
      expect(result.claimEligible).toBe(true);
    });
  });

  describe('Delay Reasons Handling', () => {
    it('should extract delay reasons from response', () => {
      const delayData = singleDelayedService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.delayReasons).toEqual({ reason: 'Signal failure at Peterborough' });
    });

    it('should handle null delay reasons', () => {
      const delayData = delayWithNullReasons.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.delayReasons).toBeNull();
      expect(result.isDelayed).toBe(true);
      expect(result.delayMinutes).toBe(20);
    });

    it('should handle complex delay reasons with multiple fields', () => {
      const delayData = largeDelayService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.delayReasons).toEqual({
        reason: 'Infrastructure failure',
        secondary_reason: 'Emergency speed restrictions',
      });
    });
  });

  describe('Batch Detection', () => {
    it('should process multiple journeys in batch', () => {
      const journeys = [
        { ...activeJourneyWithRid, rid: '202601150800123' },
        { ...activeJourneyWithRid, id: 'journey-2', rid: '202601151000456' },
        { ...activeJourneyWithRid, id: 'journey-3', rid: '202601151200789' },
      ];

      const delayData = multipleServicesResponse.delays;

      const results = detector.detectDelaysBatch(journeys, delayData);

      expect(results).toHaveLength(3);
      expect(results[0].exceedsThreshold).toBe(true); // 25 min delay
      expect(results[1].exceedsThreshold).toBe(false); // 5 min delay
      expect(results[2].exceedsThreshold).toBe(true); // 45 min delay
    });

    it('should handle empty journey list', () => {
      const results = detector.detectDelaysBatch([], []);

      expect(results).toEqual([]);
    });

    it('should handle missing delay data for a journey', () => {
      const journeys = [
        { ...activeJourneyWithRid, rid: '202601150800123' },
        { ...activeJourneyWithRid, id: 'journey-no-data', rid: 'nonexistent-rid' },
      ];

      const delayData = singleDelayedService.delays;

      const results = detector.detectDelaysBatch(journeys, delayData);

      expect(results).toHaveLength(2);
      expect(results[0].exceedsThreshold).toBe(true);
      expect(results[1].dataNotFound).toBe(true);
    });
  });

  describe('RID Matching', () => {
    it('should match journey to delay data by RID', () => {
      const journey = { ...activeJourneyWithRid, rid: '202601150800123' };
      const delayData = singleDelayedService.delays;

      const matchedDelay = detector.findDelayByRid(journey.rid, delayData);

      expect(matchedDelay).toBeDefined();
      expect(matchedDelay!.rid).toBe(journey.rid);
    });

    it('should return undefined for non-matching RID', () => {
      const matchedDelay = detector.findDelayByRid('nonexistent-rid', singleDelayedService.delays);

      expect(matchedDelay).toBeUndefined();
    });

    it('should handle null RID gracefully', () => {
      const matchedDelay = detector.findDelayByRid(null as unknown as string, singleDelayedService.delays);

      expect(matchedDelay).toBeUndefined();
    });
  });

  describe('Threshold Comparison', () => {
    it('should correctly compare delay to threshold', () => {
      expect(detector.meetsThreshold(16)).toBe(true);
      expect(detector.meetsThreshold(15)).toBe(true);
      expect(detector.meetsThreshold(14)).toBe(false);
      expect(detector.meetsThreshold(0)).toBe(false);
    });

    it('should handle edge case of exactly threshold', () => {
      expect(detector.meetsThreshold(15)).toBe(true);
    });

    it('should handle negative delay values (data anomaly)', () => {
      expect(detector.meetsThreshold(-5)).toBe(false);
    });
  });

  describe('Detection Result Structure', () => {
    it('should return complete result structure', () => {
      const delayData = singleDelayedService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result).toHaveProperty('journeyId');
      expect(result).toHaveProperty('rid');
      expect(result).toHaveProperty('isDelayed');
      expect(result).toHaveProperty('isCancelled');
      expect(result).toHaveProperty('delayMinutes');
      expect(result).toHaveProperty('exceedsThreshold');
      expect(result).toHaveProperty('claimEligible');
      expect(result).toHaveProperty('delayReasons');
      expect(result).toHaveProperty('detectedAt');
    });

    it('should include journey ID in result', () => {
      const delayData = singleDelayedService.delays[0];
      const journey = { ...activeJourneyWithRid, id: 'test-journey-id', rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.journeyId).toBe('test-journey-id');
    });

    it('should include detection timestamp', () => {
      const delayData = singleDelayedService.delays[0];
      const journey = { ...activeJourneyWithRid, rid: delayData.rid };

      const result = detector.detectDelay(journey, delayData);

      expect(result.detectedAt).toBeInstanceOf(Date);
      expect(result.detectedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
