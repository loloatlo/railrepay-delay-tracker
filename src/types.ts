/**
 * Core types and interfaces for delay-tracker service
 *
 * Per ADR-001: Schema-per-service isolation
 * Per ADR-007: Transactional outbox pattern
 */

// Monitoring status for journeys
// NOTE: 'darwin_unavailable' added by migration 1770714617404_add-darwin-unavailable-status.cjs
export type MonitoringStatus = 'pending_rid' | 'active' | 'delayed' | 'completed' | 'cancelled' | 'darwin_unavailable';

// Outbox event status
export type OutboxStatus = 'pending' | 'processed' | 'failed';

// Health check status
export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded';

// Monitored Journey entity
export interface MonitoredJourney {
  id?: string;
  user_id: string;
  journey_id: string;
  rid?: string | null;
  service_date: string;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string | Date;
  scheduled_arrival: string | Date;
  monitoring_status: MonitoringStatus;
  last_checked_at?: Date | null;
  next_check_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

// Delay Alert entity
export interface DelayAlert {
  id?: string;
  monitored_journey_id: string;
  delay_minutes: number;
  delay_detected_at?: Date;
  delay_reasons?: Record<string, unknown> | null;
  is_cancellation?: boolean;
  threshold_exceeded?: boolean;
  claim_triggered: boolean;
  claim_triggered_at?: Date | null;
  claim_reference_id?: string | null;
  claim_trigger_response?: string | null;
  notification_sent: boolean;
  notification_sent_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

// Outbox Event entity
export interface OutboxEvent {
  id?: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  correlation_id?: string;
  status?: OutboxStatus;
  retry_count?: number;
  error_message?: string | null;
  created_at?: Date;
  processed_at?: Date | null;
}

// Health check response types
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  degraded?: boolean;
}

export interface HealthResponse {
  status: number;
  contentType: string;
  body: {
    status: HealthStatus;
    service: string;
    timestamp: string;
    version: string;
    uptime: number;
    checks: {
      database: {
        status: HealthStatus;
        latencyMs?: number;
        error?: string;
      };
    };
  };
}

export interface LivenessResponse {
  status: number;
  body: {
    alive: boolean;
  };
}

export interface ReadinessResponse {
  status: number;
  body: {
    ready: boolean;
  };
}

// Delay detection types
export interface DelayResult {
  journeyId: string;
  rid: string;
  isDelayed: boolean;
  isCancelled: boolean;
  delayMinutes: number;
  exceedsThreshold: boolean;
  claimEligible: boolean;
  delayReasons?: Record<string, unknown> | null;
  detectedAt: Date;
  dataNotFound?: boolean;
}

export interface DelayThreshold {
  minutes: number;
}

// Claim trigger types
export interface ClaimTriggerResult {
  success: boolean;
  claimReferenceId?: string | null;
  reason?: ClaimTriggerReason;
  estimatedCompensation?: number;
  existingClaimReferenceId?: string;
  error?: string;
  retryable?: boolean;
  triggeredAt?: Date;
  delayAlertId?: string;
}

export type ClaimTriggerReason =
  | 'BELOW_THRESHOLD'
  | 'NOT_ELIGIBLE'
  | 'SERVICE_ERROR'
  | 'DUPLICATE_CLAIM'
  | 'NETWORK_ERROR'
  | 'ALREADY_TRIGGERED';

// Cron scheduler metrics
export interface CronMetrics {
  lastExecutionDurationMs: number;
  totalExecutions: number;
  journeysProcessed: number;
  errorCount: number;
}

// Darwin Ingestor API types

// BL-181 AC-W4: stop-level arrival data returned by darwin-ingestor after stops join fix
export interface DarwinStopInfo {
  tiploc_code: string;
  scheduled_arrival: string | null;
  actual_arrival: string | null;
  delay_minutes: number;
}

// BL-181 AC-W4: extended with status and stops fields required by SequentialLegWalk
export interface DarwinDelayInfo {
  rid: string;
  delay_minutes: number | null;
  is_cancelled: boolean;
  delay_reasons?: Record<string, unknown> | null;
  // AC-W4: disambiguates on_time (0) vs no_data (null) vs delayed (>0) vs cancelled
  status?: 'on_time' | 'delayed' | 'cancelled' | 'no_data';
  // AC-W4: stop-level arrival data for SequentialLegWalk algorithm
  stops?: DarwinStopInfo[] | null;
}

export interface DarwinDelaysApiResponse {
  services: DarwinDelayInfo[];
}

// Eligibility Engine API types
export interface EligibilityCheckResponse {
  eligible: boolean;
  reason?: string;
}

export interface ClaimTriggerApiResponse {
  success: boolean;
  claim_reference_id?: string | null;
  message?: string;
  eligible?: boolean;
  estimated_compensation?: number;
  error?: string;
}

// Message broker interface (for outbox publisher)
export interface MessageBroker {
  publish(event: OutboxEvent): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// DT-001: synchronous delay-query endpoint types
// ---------------------------------------------------------------------------

/** Outcome kind for GET /delays/:journeyId metrics and logging */
export type OutcomeKind =
  | 'hit'
  | 'on_time'
  | 'pending'
  | 'unknown'
  | 'forbidden'
  | 'bad_request'
  | 'error';

/** Response shape when a delay row exists or journey is on_time */
export interface GetDelayHitResponse {
  journey_id: string;
  delay_minutes: number;
  cancelled: boolean;
  last_observed_at: string;
  status: 'delayed' | 'cancelled' | 'on_time';
}

/** Response shape when journey is still pending (no delay data yet) */
export interface GetDelayPendingResponse {
  journey_id: string;
  status: 'pending';
  message: string;
}

export type GetDelayResponse = GetDelayHitResponse | GetDelayPendingResponse;
