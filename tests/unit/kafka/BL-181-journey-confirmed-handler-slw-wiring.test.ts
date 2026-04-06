/**
 * Unit Tests: BL-181 Wiring — JourneyConfirmedHandler SequentialLegWalk Integration
 *
 * Phase: TD-1 — Test Specification (Jessie)
 * Workflow ID: TD-BL181-WIRING-001
 * BL Item: BL-181 (TD-DELAY-CALC-001)
 * Governing ADR: ADR-021 — Passenger Journey Delay Calculation
 * Service: delay-tracker
 *
 * PROBLEM (live E2E evidence — RID 202604058023515, SIT→GLM):
 *   handleHistoricJourney() calls darwinClient.getDelayInfo() and uses
 *   delayInfo.delay_minutes (returns 58 — max-stop at Ebbsfleet).
 *   It never calls SequentialLegWalk.calculate(), which would return
 *   51 minutes (Gillingham/GLNGHMK stop).
 *
 *   Result: customer sees 58 min delay instead of correct 51 min.
 *
 * WIRING GAPS:
 *   Gap 1: JourneyConfirmedHandlerDeps has no SequentialLegWalk dependencies
 *   Gap 2: handleHistoricJourney() does not call SequentialLegWalk.calculate()
 *   Gap 3: delay.detected event payload has no resolution_method field
 *
 * ACCEPTANCE CRITERIA:
 *   AC-W6: JourneyConfirmedHandlerDeps MUST include SequentialLegWalk dependencies
 *          (tiplocRepository, darwinClientWithStops, otpClient)
 *   AC-W7: handleHistoricJourney() MUST call SequentialLegWalk.calculate()
 *          for historic journeys (not just darwinClient.getDelayInfo())
 *   AC-W8: delay.detected event payload MUST include resolution_method field
 *          (value: 'sequential_leg_walk' when SLW is used)
 *   AC-W9: For SIT→GLM test case with GLNGHMK at 51 min, handler MUST publish
 *          delay_minutes: 51 (not 58 — the Ebbsfleet max-stop value)
 *   AC-W10: Existing journey.confirmed handler tests continue to pass
 *           (no regressions to prior behaviour)
 *
 * FAIL REASON:
 *   None of these behaviours exist yet. Tests will FAIL until Blake wires in
 *   SequentialLegWalk.calculate() inside handleHistoricJourney().
 *
 * Test Lock Rule: Blake MUST NOT modify these tests.
 * Per ADR-014 (TDD) and ADR-004 (Vitest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JourneyConfirmedHandler,
  type JourneyConfirmedPayload,
} from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import type { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';
import type { OutboxRepository } from '../../../src/repositories/outbox-repository.js';
import type { DarwinServiceWithStops } from '../../../src/services/sequential-leg-walk.js';

// ============================================================================
// Fixtures
// Live E2E evidence: RID 202604058023515, SIT → GLM, 2026-04-05
// Darwin stops (TIPLOC codes stored in crs_code column):
//   STNGBRN(53m), RAINHMK(52m), GLNGHMK(51m), CHATHAM(52m),
//   RCHT(52m), STROOD(52m), GRVSEND(56m), EBSFLTI(58m)
// Expected delay at GLM (GLNGHMK): 51 minutes
// Current (wrong) delay from delay_minutes field: 58 minutes (max-stop at Ebbsfleet)
// ============================================================================

const LIVE_RID = '202604058023515';
const LIVE_SERVICE_DATE = '2026-04-05';
const LIVE_DEPARTURE_ISO = `${LIVE_SERVICE_DATE}T09:00:00.000Z`; // departure < now (historic)
const LIVE_ARRIVAL_ISO = `${LIVE_SERVICE_DATE}T10:20:00.000Z`;  // scheduled arrival at GLM

// Live SIT→GLM service stop data as returned by darwin-ingestor after BL-181 Sub-task 2
const SIT_GLM_SERVICE_WITH_STOPS: DarwinServiceWithStops = {
  rid: LIVE_RID,
  delay_minutes: 58, // max-stop value — NOT what SequentialLegWalk should return
  is_cancelled: false,
  delay_reasons: null,
  status: 'delayed',
  stops: [
    { tiploc_code: 'STNGBRN', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:00:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T10:53:00Z`, delay_minutes: 53 },
    { tiploc_code: 'RAINHMK', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:10:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:02:00Z`, delay_minutes: 52 },
    { tiploc_code: 'GLNGHMK', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:20:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:11:00Z`, delay_minutes: 51 },
    { tiploc_code: 'CHATHAM', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:30:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:22:00Z`, delay_minutes: 52 },
    { tiploc_code: 'RCHT',    scheduled_arrival: `${LIVE_SERVICE_DATE}T10:35:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:27:00Z`, delay_minutes: 52 },
    { tiploc_code: 'STROOD',  scheduled_arrival: `${LIVE_SERVICE_DATE}T10:42:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:34:00Z`, delay_minutes: 52 },
    { tiploc_code: 'GRVSEND', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:48:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:44:00Z`, delay_minutes: 56 },
    { tiploc_code: 'EBSFLTI', scheduled_arrival: `${LIVE_SERVICE_DATE}T10:58:00Z`, actual_arrival: `${LIVE_SERVICE_DATE}T11:56:00Z`, delay_minutes: 58 },
  ],
};

// ============================================================================
// Base journey.confirmed payload for SIT→GLM historic journey
// ============================================================================

const SIT_GLM_PAYLOAD: JourneyConfirmedPayload = {
  journey_id: 'sit-glm-journey-001',
  user_id: 'user-001',
  origin_crs: 'SIT',         // Sittingbourne CRS
  destination_crs: 'GLM',    // Gillingham (Kent) CRS
  departure_datetime: LIVE_DEPARTURE_ISO,
  arrival_datetime: LIVE_ARRIVAL_ISO,
  journey_type: 'single',
  toc_code: 'SE',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'SIT',
      destination_crs: 'GLM',
      scheduled_departure: LIVE_DEPARTURE_ISO,
      scheduled_arrival: LIVE_ARRIVAL_ISO,
      rid: LIVE_RID,
      toc_code: 'SE',
    },
  ],
  correlation_id: 'corr-bl181-wiring-001',
  ticket_fare_pence: 1850,
  ticket_class: 'standard',
  ticket_type: 'single',
};

// ============================================================================
// Helper: build shared mocks
//
// The new handler deps (AC-W6) require SequentialLegWalk dependencies in addition
// to the existing journeyRepository, delayAlertRepository, outboxRepository,
// and darwinClient deps.
//
// Per Jessie Guideline #11: shared mock logger instance created OUTSIDE factory.
// ============================================================================

const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

function buildMocks() {
  const mockJourneyRepo = {
    findByJourneyId: vi.fn().mockResolvedValue(null), // not duplicate
    create: vi.fn().mockResolvedValue({ id: 'monitored-journey-uuid-001' }),
    update: vi.fn(),
  } as unknown as JourneyRepository;

  const mockDelayAlertRepo = {
    create: vi.fn().mockResolvedValue({ id: 'delay-alert-uuid-001' }),
  } as unknown as DelayAlertRepository;

  const mockOutboxRepo = {
    create: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboxRepository;

  // Legacy darwin client (getDelayInfo) — should still be present for non-SLW paths
  const mockDarwinClient = {
    getDelayInfo: vi.fn().mockResolvedValue({
      rid: LIVE_RID,
      delay_minutes: 58, // old method returns max-stop value
      is_cancelled: false,
      delay_reasons: null,
      status: 'delayed',
      stops: SIT_GLM_SERVICE_WITH_STOPS.stops,
    }),
    // AC-W5: getServiceWithStops must also be present
    getServiceWithStops: vi.fn().mockResolvedValue(SIT_GLM_SERVICE_WITH_STOPS),
  };

  // SequentialLegWalk mock — calculate() returns destination-specific delay
  const mockSequentialLegWalk = {
    calculate: vi.fn().mockResolvedValue({
      delay_minutes: 51, // correct GLM arrival delay (GLNGHMK stop)
      actual_final_arrival: `${LIVE_SERVICE_DATE}T11:11:00Z`,
      scheduled_final_arrival: LIVE_ARRIVAL_ISO,
      status: 'completed',
    }),
  };

  // TiplocRepository mock (required by SequentialLegWalk wiring)
  const mockTiplocRepo = {
    getCrsByTiploc: vi.fn().mockResolvedValue('GLM'),
    getTiplocsByCrs: vi.fn().mockImplementation(async (crs: string) => {
      if (crs === 'GLM') return ['GLNGHMK'];
      if (crs === 'SIT') return ['SITTNGBN'];
      return [];
    }),
  };

  // OTP client mock (required by SequentialLegWalk wiring, not invoked for this journey)
  const mockOtpClient = {
    findReplacementRoute: vi.fn().mockResolvedValue(null),
  };

  return {
    mockJourneyRepo,
    mockDelayAlertRepo,
    mockOutboxRepo,
    mockDarwinClient,
    mockSequentialLegWalk,
    mockTiplocRepo,
    mockOtpClient,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('BL-181 Wiring: JourneyConfirmedHandler SequentialLegWalk integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.info.mockClear();
    sharedLogger.error.mockClear();
    sharedLogger.warn.mockClear();
    sharedLogger.debug.mockClear();
  });

  // ==========================================================================
  // AC-W6: JourneyConfirmedHandlerDeps MUST include SequentialLegWalk deps
  // ==========================================================================

  describe('AC-W6: JourneyConfirmedHandlerDeps includes SequentialLegWalk dependencies', () => {
    it('should construct without error when SequentialLegWalk dependencies are provided', () => {
      // FAILS CURRENTLY: JourneyConfirmedHandlerDeps has no tiplocRepository,
      // otpClient, or sequentialLegWalk fields. Constructor will throw or ignore them.
      const mocks = buildMocks();

      expect(() => {
        new JourneyConfirmedHandler({
          journeyRepository: mocks.mockJourneyRepo,
          delayAlertRepository: mocks.mockDelayAlertRepo,
          outboxRepository: mocks.mockOutboxRepo,
          darwinClient: mocks.mockDarwinClient,
          // AC-W6: these new deps must be accepted by the constructor
          tiplocRepository: mocks.mockTiplocRepo,
          otpClient: mocks.mockOtpClient,
        });
      }).not.toThrow();
    });

    it('should NOT throw when given a pre-built SequentialLegWalk instance', () => {
      // Alternative wiring: handler accepts a pre-built SequentialLegWalk instance
      // This is valid if Blake chooses to accept the whole SLW object vs individual deps.
      const mocks = buildMocks();

      expect(() => {
        new JourneyConfirmedHandler({
          journeyRepository: mocks.mockJourneyRepo,
          delayAlertRepository: mocks.mockDelayAlertRepo,
          outboxRepository: mocks.mockOutboxRepo,
          darwinClient: mocks.mockDarwinClient,
          sequentialLegWalk: mocks.mockSequentialLegWalk,
        });
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // AC-W7: handleHistoricJourney() MUST call SequentialLegWalk.calculate()
  // ==========================================================================

  describe('AC-W7: handleHistoricJourney() calls SequentialLegWalk.calculate()', () => {
    it('should call sequentialLegWalk.calculate() when processing a historic journey', async () => {
      // FAILS CURRENTLY: handleHistoricJourney() uses darwinClient.getDelayInfo()
      // and never calls SequentialLegWalk.calculate().
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // SequentialLegWalk.calculate() MUST have been called
      expect(mocks.mockSequentialLegWalk.calculate).toHaveBeenCalledTimes(1);
    });

    it('should call SequentialLegWalk.calculate() with legs derived from payload segments', async () => {
      // FAILS CURRENTLY: SequentialLegWalk.calculate() is never called
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // The calculate() call should include the journey leg from SIT→GLM
      const calculateCall = mocks.mockSequentialLegWalk.calculate.mock.calls[0][0];
      expect(calculateCall).toHaveProperty('legs');
      expect(calculateCall.legs).toHaveLength(1);
      expect(calculateCall.legs[0].rid).toBe(LIVE_RID);
      expect(calculateCall.legs[0].originCrs).toBe('SIT');
      expect(calculateCall.legs[0].destinationCrs).toBe('GLM');
    });

    it('should use the final destination CRS from the payload for calculate() params', async () => {
      // FAILS CURRENTLY: SequentialLegWalk.calculate() is never called
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const calculateCall = mocks.mockSequentialLegWalk.calculate.mock.calls[0][0];
      expect(calculateCall.finalDestinationCrs).toBe('GLM');
      expect(calculateCall.scheduledFinalArrival).toBe(LIVE_ARRIVAL_ISO);
    });

    it('should NOT fall back to delayInfo.delay_minutes when SequentialLegWalk succeeds', async () => {
      // FAILS CURRENTLY: handler always uses delayInfo.delay_minutes (58 for SIT→GLM)
      // After fix: handler uses SLW result (51) when status='completed'
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // delay_alert must be created with SLW result (51), not Darwin max-stop (58)
      const delayAlertCall = mocks.mockDelayAlertRepo.create.mock.calls[0][0];
      expect(delayAlertCall.delay_minutes).toBe(51);
      expect(delayAlertCall.delay_minutes).not.toBe(58);
    });
  });

  // ==========================================================================
  // AC-W8: delay.detected payload MUST include resolution_method field
  // ==========================================================================

  describe('AC-W8: delay.detected event includes resolution_method field', () => {
    it('should include resolution_method: "sequential_leg_walk" in delay.detected payload', async () => {
      // FAILS CURRENTLY: outbox payload does not include resolution_method
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // Find the delay.detected outbox event
      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const delayDetectedCall = outboxCalls.find(
        (call) => call[0].event_type === 'delay.detected'
      );

      expect(delayDetectedCall).toBeDefined();
      const payload = delayDetectedCall![0].payload;

      // AC-W8: payload must include resolution_method
      expect(payload).toHaveProperty('resolution_method');
      expect(payload.resolution_method).toBe('sequential_leg_walk');
    });

    it('should include resolution_method in the delay.detected payload alongside existing fields', async () => {
      // FAILS CURRENTLY: resolution_method not in payload
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const delayDetectedCall = outboxCalls.find(
        (call) => call[0].event_type === 'delay.detected'
      );
      const payload = delayDetectedCall![0].payload;

      // Verify pre-existing required fields are still present (AC-W10 regression guard)
      expect(payload).toHaveProperty('journey_id', SIT_GLM_PAYLOAD.journey_id);
      expect(payload).toHaveProperty('user_id', SIT_GLM_PAYLOAD.user_id);
      expect(payload).toHaveProperty('delay_minutes');
      expect(payload).toHaveProperty('is_cancellation');
      expect(payload).toHaveProperty('toc_code');

      // New field
      expect(payload).toHaveProperty('resolution_method', 'sequential_leg_walk');
    });
  });

  // ==========================================================================
  // AC-W9: SIT→GLM must return 51 minutes (not 58)
  // ==========================================================================

  describe('AC-W9: SIT→GLM historic journey publishes 51 min (not 58)', () => {
    it('should publish delay_minutes: 51 for SIT→GLM journey using SequentialLegWalk result', async () => {
      // THE CORE BUG FIX.
      // FAILS CURRENTLY: handler publishes delay_minutes: 58 (max-stop at Ebbsfleet).
      // AFTER FIX: handler calls SLW.calculate() → returns 51 (Gillingham/GLNGHMK stop).
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // Find delay.detected event
      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const delayDetectedCall = outboxCalls.find(
        (call) => call[0].event_type === 'delay.detected'
      );

      expect(delayDetectedCall).toBeDefined();

      const publishedDelayMinutes = delayDetectedCall![0].payload.delay_minutes;

      // MUST be 51 (GLM arrival delay per SequentialLegWalk)
      // MUST NOT be 58 (Ebbsfleet max-stop that the current handler wrongly uses)
      expect(publishedDelayMinutes).toBe(51);
      expect(publishedDelayMinutes).not.toBe(58);
    });

    it('should create delay_alert with 51 minutes for SIT→GLM journey', async () => {
      // FAILS CURRENTLY: delay_alert is created with delay_minutes: 58
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const alertCreate = mocks.mockDelayAlertRepo.create.mock.calls[0][0];
      expect(alertCreate.delay_minutes).toBe(51);
      expect(alertCreate.delay_minutes).not.toBe(58);
    });

    it('should still exceed the 15-minute threshold with 51 min delay and publish delay.detected', async () => {
      // 51 minutes > 15-minute threshold → should still trigger delay.detected
      // FAILS CURRENTLY: wrong delay minutes used
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const eventTypes = outboxCalls.map((call) => call[0].event_type);
      expect(eventTypes).toContain('delay.detected');
      expect(eventTypes).not.toContain('delay.not-detected');
    });
  });

  // ==========================================================================
  // SLW assessment_pending fallback: when SLW cannot determine delay
  // ==========================================================================

  describe('SLW assessment_pending fallback', () => {
    it('should fall back to darwin delay_minutes when SequentialLegWalk returns assessment_pending', async () => {
      // When SLW returns status: 'assessment_pending' (no Darwin data),
      // the handler should fall back to the legacy Darwin delay_minutes.
      // This ensures no regression for services where SLW cannot calculate.
      const mocks = buildMocks();

      mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
        delay_minutes: null,
        actual_final_arrival: null,
        scheduled_final_arrival: LIVE_ARRIVAL_ISO,
        status: 'assessment_pending',
      });

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      // With a 58-min fallback delay (>= 15 min threshold), handler should still
      // publish delay.detected (using the fallback value).
      await handler.handle(SIT_GLM_PAYLOAD);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const eventTypes = outboxCalls.map((call) => call[0].event_type);

      // Should still detect delay (falls back to darwin delay_minutes=58)
      // OR publish delay.not-detected if implementation chooses conservative fallback.
      // Either is acceptable; what is NOT acceptable is throwing an uncaught error.
      expect(eventTypes.length).toBeGreaterThan(0);
      expect(['delay.detected', 'delay.not-detected']).toContain(eventTypes[0]);
    });

    it('should include resolution_method: "fallback" in delay.detected when SLW is assessment_pending', async () => {
      // If Blake chooses to publish delay.detected on fallback, the resolution_method
      // should indicate it was NOT SequentialLegWalk that produced the result.
      const mocks = buildMocks();

      mocks.mockSequentialLegWalk.calculate.mockResolvedValue({
        delay_minutes: null,
        actual_final_arrival: null,
        scheduled_final_arrival: LIVE_ARRIVAL_ISO,
        status: 'assessment_pending',
      });

      // Ensure fallback darwin delay_minutes is above threshold
      mocks.mockDarwinClient.getDelayInfo.mockResolvedValue({
        rid: LIVE_RID,
        delay_minutes: 58,
        is_cancelled: false,
        delay_reasons: null,
        status: 'delayed',
        stops: null,
      });

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const delayDetectedCall = outboxCalls.find(
        (call) => call[0].event_type === 'delay.detected'
      );

      if (delayDetectedCall) {
        const payload = delayDetectedCall[0].payload;
        // If published, resolution_method must NOT be 'sequential_leg_walk'
        expect(payload.resolution_method).not.toBe('sequential_leg_walk');
      }
    });
  });

  // ==========================================================================
  // Darwin unavailability: existing AC-7 regression guard (AC-W10)
  // ==========================================================================

  describe('AC-W10: Darwin unavailability still publishes delay.not-detected (regression)', () => {
    it('should publish delay.not-detected with darwin_unavailable when darwin throws', async () => {
      // Regression guard: AC-7 from original journey.confirmed handler spec.
      // Darwin throwing must still result in delay.not-detected, not an unhandled error.
      // The handler must handle this case even with SLW wiring.
      const mocks = buildMocks();

      mocks.mockDarwinClient.getDelayInfo.mockRejectedValue(new Error('Darwin connection refused'));
      mocks.mockDarwinClient.getServiceWithStops.mockRejectedValue(new Error('Darwin connection refused'));

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      // Should not throw
      await expect(handler.handle(SIT_GLM_PAYLOAD)).resolves.not.toThrow();

      // Should publish delay.not-detected
      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const eventTypes = outboxCalls.map((call) => call[0].event_type);
      expect(eventTypes).toContain('delay.not-detected');
    });

    it('should include reason: darwin_unavailable in delay.not-detected when darwin throws', async () => {
      const mocks = buildMocks();

      mocks.mockDarwinClient.getDelayInfo.mockRejectedValue(new Error('timeout'));
      mocks.mockDarwinClient.getServiceWithStops.mockRejectedValue(new Error('timeout'));

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const notDetectedCall = outboxCalls.find(
        (call) => call[0].event_type === 'delay.not-detected'
      );

      expect(notDetectedCall).toBeDefined();
      expect(notDetectedCall![0].payload.reason).toBe('darwin_unavailable');
    });
  });

  // ==========================================================================
  // Future journey path unchanged (AC-W10 regression guard)
  // ==========================================================================

  describe('AC-W10: Future journey path unchanged (no SequentialLegWalk for future journeys)', () => {
    it('should NOT call SequentialLegWalk.calculate() for a future (upcoming) journey', async () => {
      // Future journeys should use monitoring registration, not SLW.
      // SequentialLegWalk is ONLY for historic journeys (departure < now).
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      // Future payload: departure 2 hours from "now"
      const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const futureArrival = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

      const futurePayload: JourneyConfirmedPayload = {
        ...SIT_GLM_PAYLOAD,
        journey_id: 'future-journey-001',
        departure_datetime: futureDate,
        arrival_datetime: futureArrival,
        segments: [
          {
            ...SIT_GLM_PAYLOAD.segments[0],
            scheduled_departure: futureDate,
            scheduled_arrival: futureArrival,
          },
        ],
      };

      await handler.handle(futurePayload);

      // SLW MUST NOT be called for future journeys
      expect(mocks.mockSequentialLegWalk.calculate).not.toHaveBeenCalled();
    });

    it('should publish journey.monitoring-registered for a future journey (regression)', async () => {
      const mocks = buildMocks();

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const futureArrival = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

      const futurePayload: JourneyConfirmedPayload = {
        ...SIT_GLM_PAYLOAD,
        journey_id: 'future-journey-002',
        departure_datetime: futureDate,
        arrival_datetime: futureArrival,
        segments: [
          {
            ...SIT_GLM_PAYLOAD.segments[0],
            scheduled_departure: futureDate,
            scheduled_arrival: futureArrival,
          },
        ],
      };

      await handler.handle(futurePayload);

      const outboxCalls = mocks.mockOutboxRepo.create.mock.calls;
      const eventTypes = outboxCalls.map((call) => call[0].event_type);
      expect(eventTypes).toContain('journey.monitoring-registered');
    });
  });

  // ==========================================================================
  // Idempotency (AC-W10: no regression to existing AC-10)
  // ==========================================================================

  describe('AC-W10: Idempotency unchanged (no regression to AC-10)', () => {
    it('should skip processing when journey_id is already registered (duplicate)', async () => {
      const mocks = buildMocks();

      // Simulate existing journey
      (mocks.mockJourneyRepo.findByJourneyId as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'existing-journey-uuid',
        journey_id: SIT_GLM_PAYLOAD.journey_id,
      });

      const handler = new JourneyConfirmedHandler({
        journeyRepository: mocks.mockJourneyRepo,
        delayAlertRepository: mocks.mockDelayAlertRepo,
        outboxRepository: mocks.mockOutboxRepo,
        darwinClient: mocks.mockDarwinClient,
        sequentialLegWalk: mocks.mockSequentialLegWalk,
      });

      await handler.handle(SIT_GLM_PAYLOAD);

      // No SLW calculation for duplicate
      expect(mocks.mockSequentialLegWalk.calculate).not.toHaveBeenCalled();
      // No outbox events for duplicate
      expect(mocks.mockOutboxRepo.create).not.toHaveBeenCalled();
    });
  });
});
