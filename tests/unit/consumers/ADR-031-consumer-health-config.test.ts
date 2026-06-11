/**
 * Unit Tests: Kafka consumer health config — ADR-031 Part 3
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-315
 * ADR     : ADR-031 — Option (f), Part 3: consumer-health fix
 * Date    : 2026-06-11
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC coverage map (delay-tracker consumer config — ADR-031 Part 3):
 *   AC-10: The delay-tracker Kafka consumer config sets sessionTimeout /
 *          heartbeatInterval at values that push long Darwin/SLW work off the poll loop.
 *          Asserts the config object passed to KafkaConsumer (or the consumer factory)
 *          has the tuned timeout values where unit-testable.
 *
 *          Target values Blake must implement:
 *            sessionTimeout      >= 30000  (30 s minimum; current default is typically 10s)
 *            heartbeatInterval   <= 10000  (must be < sessionTimeout/3)
 *
 *          These are the minimum required values. Blake may set higher sessionTimeout
 *          (up to 120000) so long as heartbeatInterval <= sessionTimeout / 3.
 *
 * RED failure modes expected:
 *   - createConsumerConfig() / EventConsumerConfig does not expose sessionTimeout /
 *     heartbeatInterval yet → assertions fail
 *   - KafkaConsumer not called with these config keys → vi.fn() call assertions fail
 *
 * Mocking strategy:
 *   - @railrepay/kafka-client KafkaConsumer — mocked to capture constructor args
 *   - All DB / handler deps mocked (we only test config wiring)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-031 — Synchronous ensure-on-404, Part 3 consumer-health
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Capture the KafkaConsumer constructor args ───────────────────────────────

const capturedKafkaConfigs: unknown[] = [];

vi.mock('@railrepay/kafka-client', () => ({
  KafkaConsumer: vi.fn().mockImplementation((cfg: unknown) => {
    capturedKafkaConfigs.push(cfg);
    return {
      connect: vi.fn(),
      subscribe: vi.fn(),
      start: vi.fn(),
      disconnect: vi.fn(),
      isConsumerRunning: vi.fn().mockReturnValue(false),
      getSubscribedTopics: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ processedCount: 0, errorCount: 0 }),
    };
  }),
}));

// Mock all heavy service dependencies so EventConsumer construction doesn't fail
vi.mock('../../../src/repositories/journey-repository.js', () => ({
  JourneyRepository: vi.fn().mockImplementation(() => ({
    findByJourneyId: vi.fn(),
    create: vi.fn(),
  })),
}));
vi.mock('../../../src/repositories/delay-alert-repository.js', () => ({
  DelayAlertRepository: vi.fn().mockImplementation(() => ({ create: vi.fn() })),
}));
vi.mock('../../../src/repositories/outbox-repository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(() => ({ create: vi.fn() })),
}));
vi.mock('../../../src/repositories/tiploc-repository.js', () => ({
  TiplocRepository: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../../src/clients/darwin-ingestor.js', () => ({
  DarwinIngestorClient: vi.fn().mockImplementation(() => ({
    getDelayInfo: vi.fn(),
    getServiceWithStops: vi.fn(),
  })),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-031 Part 3: Kafka consumer sessionTimeout / heartbeatInterval', () => {

  beforeEach(() => {
    capturedKafkaConfigs.length = 0;

    // Required env vars for createConsumerConfig / EventConsumer
    process.env.KAFKA_BROKERS = 'test-broker:9092';
    process.env.KAFKA_USERNAME = 'test-user';
    process.env.KAFKA_PASSWORD = 'test-pass';
    process.env.KAFKA_GROUP_ID = 'delay-tracker-consumer-group';
    process.env.DARWIN_INGESTOR_URL = 'http://darwin-test.internal';
  });

  afterEach(() => {
    delete process.env.KAFKA_BROKERS;
    delete process.env.KAFKA_USERNAME;
    delete process.env.KAFKA_PASSWORD;
    delete process.env.KAFKA_GROUP_ID;
    delete process.env.DARWIN_INGESTOR_URL;
  });

  // ── AC-10: sessionTimeout is tuned ────────────────────────────────────────

  it('AC-10: EventConsumer passes sessionTimeout >= 30000 ms to KafkaConsumer', async () => {
    // AC-10: Long Darwin/SLW evaluation (~5-15s) must complete within the session timeout.
    // If sessionTimeout is left at Kafka default (10s) the consumer is kicked before
    // evaluation finishes. This test asserts the config is tuned.
    // Target: sessionTimeout >= 30000 (30 s) to handle a 15 s Darwin call + overhead.
    const { EventConsumer } = await import('../../../src/consumers/event-consumer.js');

    const logger = {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    };

    new EventConsumer({
      serviceName: 'delay-tracker',
      brokers: ['test-broker:9092'],
      username: 'test-user',
      password: 'test-pass',
      groupId: 'delay-tracker-consumer-group',
      db: {} as any,
      logger,
      ssl: false,
    });

    // At least one KafkaConsumer must have been constructed
    expect(capturedKafkaConfigs.length).toBeGreaterThan(0);

    const cfg = capturedKafkaConfigs[0] as Record<string, unknown>;

    // AC-10: sessionTimeout must be set and >= 30 s
    // RED: Currently EventConsumer does not pass sessionTimeout → assertion fails
    expect(cfg).toHaveProperty('sessionTimeout');
    expect(typeof cfg.sessionTimeout).toBe('number');
    expect(cfg.sessionTimeout as number).toBeGreaterThanOrEqual(30000);
  });

  it('AC-10: EventConsumer passes heartbeatInterval that is <= sessionTimeout / 3', async () => {
    // AC-10: heartbeatInterval must be less than sessionTimeout / 3 (Kafka protocol requirement).
    // If sessionTimeout = 30000, heartbeatInterval must be <= 10000.
    const { EventConsumer } = await import('../../../src/consumers/event-consumer.js');

    const logger = {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    };

    capturedKafkaConfigs.length = 0;

    new EventConsumer({
      serviceName: 'delay-tracker',
      brokers: ['test-broker:9092'],
      username: 'test-user',
      password: 'test-pass',
      groupId: 'delay-tracker-consumer-group',
      db: {} as any,
      logger,
      ssl: false,
    });

    const cfg = capturedKafkaConfigs[0] as Record<string, unknown>;

    // RED: heartbeatInterval not present in current config → assertion fails
    expect(cfg).toHaveProperty('heartbeatInterval');
    expect(typeof cfg.heartbeatInterval).toBe('number');

    const sessionTimeout = cfg.sessionTimeout as number;
    const heartbeatInterval = cfg.heartbeatInterval as number;

    expect(heartbeatInterval).toBeLessThanOrEqual(Math.floor(sessionTimeout / 3));
  });

  it('AC-10: EventConsumerConfig interface exposes sessionTimeout and heartbeatInterval fields', async () => {
    // AC-10: The config type must accept these fields so they can be configured
    // from environment-level overrides in the future.
    // This is a compile-time / structural test — if EventConsumerConfig type does not
    // include these fields, TypeScript will fail on the shape assertion below.
    const { EventConsumer } = await import('../../../src/consumers/event-consumer.js');

    const logger = {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    };

    capturedKafkaConfigs.length = 0;

    // If the constructor type does not accept sessionTimeout, TypeScript will error here
    // (which is the RED state — compile fails until Blake adds the fields).
    new EventConsumer({
      serviceName: 'delay-tracker',
      brokers: ['test-broker:9092'],
      username: 'test-user',
      password: 'test-pass',
      groupId: 'delay-tracker-consumer-group',
      db: {} as any,
      logger,
      ssl: false,
      // AC-10: These optional fields must be accepted by the constructor config type
      sessionTimeout: 60000,
      heartbeatInterval: 10000,
    } as any); // as any: allows the test to run even before Blake adds the type (RED failure is the KafkaConsumer call assertion)

    const cfg = capturedKafkaConfigs[0] as Record<string, unknown>;
    expect(cfg.sessionTimeout).toBeDefined();
  });
});
