/**
 * Unit Tests: journey.confirmed handler — parameterised consumer group id
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Story   : fix/dt-journey-confirmed-group-env — parameterise the hardcoded
 *           Kafka consumer group in JourneyConfirmedHandler so dev-environment
 *           instances can run without joining production consumer groups.
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC coverage:
 *   AC-1: When env var KAFKA_JOURNEY_CONFIRMED_GROUP_ID is set, the handler's
 *         groupId equals that value (dev instances get a dev-scoped group).
 *   AC-2: When the env var is absent, groupId defaults to the legacy literal
 *         'delay-tracker-consumer-group' — production (which does not set the
 *         var) keeps its exact consumer group and committed offsets.
 *   AC-3: An empty / whitespace-only value is treated as absent (mirrors the
 *         createConsumerConfig() validation pattern in src/consumers/config.ts,
 *         which rejects `!value || value.trim() === ''`).
 *
 * RED failure modes expected:
 *   - src/kafka/journey-confirmed-handler.ts:70 hardcodes
 *     `readonly groupId = 'delay-tracker-consumer-group'` and never reads the
 *     env var → AC-1 and AC-3-set-value assertions fail.
 *
 * Mocking strategy:
 *   - Handler dependencies (repositories, Darwin client) are inert vi.fn()
 *     mocks — these tests only exercise groupId resolution at construction.
 *   - Env var save/restore in beforeEach/afterEach (repo pattern, see
 *     tests/unit/consumers/ADR-031-consumer-health-config.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { JourneyConfirmedHandler } from '../../../src/kafka/journey-confirmed-handler.js';
import type { JourneyRepository } from '../../../src/repositories/journey-repository.js';
import type { DelayAlertRepository } from '../../../src/repositories/delay-alert-repository.js';
import type { OutboxRepository } from '../../../src/repositories/outbox-repository.js';
import type { DarwinIngestorClient } from '../../../src/clients/darwin-ingestor.js';

const ENV_KEY = 'KAFKA_JOURNEY_CONFIRMED_GROUP_ID';
const LEGACY_GROUP_ID = 'delay-tracker-consumer-group';

/** Build a handler with inert mocked deps. Construct AFTER env is arranged —
 *  groupId must be resolved from the environment at construction time. */
function buildHandler(): JourneyConfirmedHandler {
  return new JourneyConfirmedHandler({
    journeyRepository: {
      create: vi.fn(),
      findByJourneyId: vi.fn().mockResolvedValue(null),
    } as unknown as JourneyRepository,
    delayAlertRepository: { create: vi.fn() } as unknown as DelayAlertRepository,
    outboxRepository: { create: vi.fn() } as unknown as OutboxRepository,
    darwinClient: { getDelayInfo: vi.fn() } as unknown as DarwinIngestorClient,
  });
}

describe('JourneyConfirmedHandler groupId — KAFKA_JOURNEY_CONFIRMED_GROUP_ID parameterisation', () => {
  // Save/restore pattern: never leak env mutations into other suites
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedValue;
    }
  });

  describe('AC-1: env var set → handler uses it', () => {
    it('uses KAFKA_JOURNEY_CONFIRMED_GROUP_ID when set', () => {
      process.env[ENV_KEY] = 'dev-delay-tracker-journey-confirmed';

      const handler = buildHandler();

      expect(handler.groupId).toBe('dev-delay-tracker-journey-confirmed');
    });

    it('uses an arbitrary non-dev value verbatim (no prefixing/suffixing)', () => {
      process.env[ENV_KEY] = 'staging-dt-jc-group';

      const handler = buildHandler();

      expect(handler.groupId).toBe('staging-dt-jc-group');
    });
  });

  describe('AC-2: env var absent → legacy default (production behaviour preserved)', () => {
    it('defaults to the legacy literal when the env var is not set', () => {
      // beforeEach already deleted the var
      const handler = buildHandler();

      expect(handler.groupId).toBe(LEGACY_GROUP_ID);
    });

    it('topic subscription metadata is unchanged', () => {
      const handler = buildHandler();

      expect(handler.topic).toBe('journey.confirmed');
    });
  });

  describe('AC-3: empty/whitespace value treated as absent (config.ts validation pattern)', () => {
    it('falls back to the legacy literal when the env var is an empty string', () => {
      process.env[ENV_KEY] = '';

      const handler = buildHandler();

      expect(handler.groupId).toBe(LEGACY_GROUP_ID);
    });

    it('falls back to the legacy literal when the env var is whitespace-only', () => {
      process.env[ENV_KEY] = '   ';

      const handler = buildHandler();

      expect(handler.groupId).toBe(LEGACY_GROUP_ID);
    });
  });
});
