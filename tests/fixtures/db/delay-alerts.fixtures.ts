/**
 * Test Fixtures: Delay Alerts
 *
 * Source: RFC-003 Delay Tracker Schema Design
 * Purpose: Provide realistic test data for delay alert tests
 *
 * NOTE: delay_minutes values aligned with >15 minute threshold for claim eligibility
 */

export interface DelayAlertFixture {
  id?: string;
  monitored_journey_id: string;
  delay_minutes: number;
  delay_detected_at: string;
  delay_reasons: object | null;
  claim_triggered: boolean;
  claim_triggered_at: string | null;
  claim_reference_id: string | null;
  notification_sent: boolean;
  notification_sent_at: string | null;
}

/**
 * Delay detected and claim triggered successfully
 */
export const delayWithClaimTriggered: DelayAlertFixture = {
  monitored_journey_id: 'd4e5f6a7-b8c9-0123-def0-456789abcdef', // Links to delayedJourney
  delay_minutes: 25,
  delay_detected_at: '2026-01-14T10:25:00Z',
  delay_reasons: { reason: 'Signal failure at Leeds' },
  claim_triggered: true,
  claim_triggered_at: '2026-01-14T10:26:00Z',
  claim_reference_id: 'e5f6a7b8-c9d0-1234-ef01-567890abcdef',
  notification_sent: true,
  notification_sent_at: '2026-01-14T10:26:30Z',
};

/**
 * Delay detected but claim not yet triggered (pending)
 */
export const delayPendingClaimTrigger: DelayAlertFixture = {
  monitored_journey_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  delay_minutes: 18,
  delay_detected_at: '2026-01-15T08:30:00Z',
  delay_reasons: null,
  claim_triggered: false,
  claim_triggered_at: null,
  claim_reference_id: null,
  notification_sent: false,
  notification_sent_at: null,
};

/**
 * Delay exactly at threshold (15 minutes)
 */
export const delayAtThreshold: DelayAlertFixture = {
  monitored_journey_id: 'threshold-journey-001',
  delay_minutes: 15,
  delay_detected_at: '2026-01-15T09:15:00Z',
  delay_reasons: { reason: 'Late departure from origin' },
  claim_triggered: false,
  claim_triggered_at: null,
  claim_reference_id: null,
  notification_sent: false,
  notification_sent_at: null,
};

/**
 * Delay just below threshold (14 minutes - should NOT trigger claim)
 */
export const delayBelowThreshold: DelayAlertFixture = {
  monitored_journey_id: 'below-threshold-journey-001',
  delay_minutes: 14,
  delay_detected_at: '2026-01-15T09:14:00Z',
  delay_reasons: { reason: 'Minor delay at intermediate stop' },
  claim_triggered: false,
  claim_triggered_at: null,
  claim_reference_id: null,
  notification_sent: false,
  notification_sent_at: null,
};

/**
 * Large delay (>60 minutes)
 */
export const largeDelay: DelayAlertFixture = {
  monitored_journey_id: 'large-delay-journey-001',
  delay_minutes: 75,
  delay_detected_at: '2026-01-15T10:15:00Z',
  delay_reasons: {
    reason: 'Engineering works overran',
    secondary_reason: 'Knock-on delays from earlier incident',
  },
  claim_triggered: true,
  claim_triggered_at: '2026-01-15T10:16:00Z',
  claim_reference_id: 'large-delay-claim-001',
  notification_sent: true,
  notification_sent_at: '2026-01-15T10:16:30Z',
};

/**
 * Delay with notification sent but claim failed
 */
export const delayClaimFailed: DelayAlertFixture = {
  monitored_journey_id: 'claim-failed-journey-001',
  delay_minutes: 22,
  delay_detected_at: '2026-01-14T11:00:00Z',
  delay_reasons: { reason: 'Track circuit failure' },
  claim_triggered: false, // Failed to trigger
  claim_triggered_at: null,
  claim_reference_id: null,
  notification_sent: true, // But user was notified
  notification_sent_at: '2026-01-14T11:01:00Z',
};

/**
 * Multiple delays for same journey (escalating delays)
 */
export const escalatingDelays: DelayAlertFixture[] = [
  {
    monitored_journey_id: 'escalating-journey-001',
    delay_minutes: 10,
    delay_detected_at: '2026-01-15T08:10:00Z',
    delay_reasons: { reason: 'Initial delay' },
    claim_triggered: false,
    claim_triggered_at: null,
    claim_reference_id: null,
    notification_sent: false,
    notification_sent_at: null,
  },
  {
    monitored_journey_id: 'escalating-journey-001',
    delay_minutes: 20,
    delay_detected_at: '2026-01-15T08:20:00Z',
    delay_reasons: { reason: 'Delay increased' },
    claim_triggered: true,
    claim_triggered_at: '2026-01-15T08:21:00Z',
    claim_reference_id: 'escalating-claim-001',
    notification_sent: true,
    notification_sent_at: '2026-01-15T08:21:30Z',
  },
];

/**
 * All fixtures combined for batch tests
 */
export const allDelayAlertFixtures: DelayAlertFixture[] = [
  delayWithClaimTriggered,
  delayPendingClaimTrigger,
  delayAtThreshold,
  delayBelowThreshold,
  largeDelay,
  delayClaimFailed,
  ...escalatingDelays,
];

export default {
  delayWithClaimTriggered,
  delayPendingClaimTrigger,
  delayAtThreshold,
  delayBelowThreshold,
  largeDelay,
  delayClaimFailed,
  escalatingDelays,
  allDelayAlertFixtures,
};
