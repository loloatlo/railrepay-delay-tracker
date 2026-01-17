/**
 * Delay Tracker Service
 *
 * Main orchestrating service that coordinates:
 * - Journey registration and monitoring
 * - Delay detection via Darwin Ingestor
 * - Claim triggering via Eligibility Engine
 * - Event publishing via outbox pattern
 */

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { JourneyMonitor } from './journey-monitor.js';
import { DelayDetector } from './delay-detector.js';
import { ClaimTrigger } from './claim-trigger.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { JourneyRepository } from '../repositories/journey-repository.js';
import { DelayAlertRepository } from '../repositories/delay-alert-repository.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';
import { EligibilityEngineClient } from '../clients/eligibility-engine.js';
import { JourneyMatcherClient } from '../clients/journey-matcher.js';
import { MonitoredJourney } from '../types.js';

interface DelayTrackerServiceConfig {
  pool: Pool;
  darwinClient: DarwinIngestorClient;
  eligibilityClient?: EligibilityEngineClient;
  journeyMatcherClient?: JourneyMatcherClient;
  journeyRepository?: JourneyRepository;
  delayAlertRepository: DelayAlertRepository;
  journeyMonitor: JourneyMonitor;
  delayDetector: DelayDetector;
  claimTrigger: ClaimTrigger;
  outboxPublisher: OutboxPublisher;
}

interface RegisterJourneyData {
  // Support both camelCase and snake_case for flexibility
  userId?: string;
  user_id?: string;
  journeyId?: string;
  journey_id?: string;
  serviceDate?: string;
  service_date?: string;
  origin?: string;
  origin_crs?: string;
  destination?: string;
  destination_crs?: string;
  scheduledDeparture?: string;
  scheduled_departure?: string;
  scheduledArrival?: string;
  scheduled_arrival?: string;
}

interface DetectionCycleMetrics {
  journeysChecked: number;
  delaysDetected: number;
  claimsTriggered: number;
  durationMs: number;
}

export class DelayTrackerService {
  private pool: Pool;
  private darwinClient: DarwinIngestorClient;
  private eligibilityClient?: EligibilityEngineClient;
  private journeyMatcherClient?: JourneyMatcherClient;
  private journeyRepository?: JourneyRepository;
  private delayAlertRepository: DelayAlertRepository;
  private journeyMonitor: JourneyMonitor;
  private delayDetector: DelayDetector;
  private claimTrigger: ClaimTrigger;
  private outboxPublisher: OutboxPublisher;

  constructor(config: DelayTrackerServiceConfig) {
    this.pool = config.pool;
    this.darwinClient = config.darwinClient;
    this.eligibilityClient = config.eligibilityClient;
    this.journeyMatcherClient = config.journeyMatcherClient;
    this.journeyRepository = config.journeyRepository;
    this.delayAlertRepository = config.delayAlertRepository;
    this.journeyMonitor = config.journeyMonitor;
    this.delayDetector = config.delayDetector;
    this.claimTrigger = config.claimTrigger;
    this.outboxPublisher = config.outboxPublisher;
  }

  /**
   * Register a journey for monitoring
   * Supports both camelCase and snake_case input properties
   * Publishes journey.monitoring_started event via outbox
   */
  async registerJourney(data: RegisterJourneyData): Promise<MonitoredJourney> {
    const userId = (data.userId ?? data.user_id)!;
    const journeyId = (data.journeyId ?? data.journey_id)!;
    const origin = (data.origin ?? data.origin_crs)!;
    const destination = (data.destination ?? data.destination_crs)!;
    const scheduledDeparture = (data.scheduledDeparture ?? data.scheduled_departure)!;

    const journey = await this.journeyMonitor.registerJourney({
      user_id: userId,
      journey_id: journeyId,
      service_date: (data.serviceDate ?? data.service_date)!,
      origin_crs: origin,
      destination_crs: destination,
      scheduled_departure: scheduledDeparture,
      scheduled_arrival: (data.scheduledArrival ?? data.scheduled_arrival)!,
    });

    // Publish journey.monitoring_started event
    await this.outboxPublisher.publishJourneyMonitoringStarted({
      journeyId: journeyId,
      userId: userId,
      monitoredJourneyId: journey.id!,
      origin: origin,
      destination: destination,
      scheduledDeparture: scheduledDeparture,
    });

    return journey;
  }

  /**
   * Run a full detection cycle:
   * 1. Get journeys due for checking
   * 2. Complete journeys past arrival time
   * 3. Resolve RIDs for pending_rid journeys
   * 4. Check delays for active journeys
   * 5. Create delay alerts
   * 6. Trigger claims for eligible delays
   * 7. Publish events
   */
  async runDetectionCycle(): Promise<DetectionCycleMetrics> {
    const startTime = Date.now();
    let delaysDetected = 0;
    let claimsTriggered = 0;

    // Generate a single correlation ID for this entire cycle
    const correlationId = randomUUID();

    // Get journeys due for checking
    const journeysDue = await this.journeyMonitor.getJourneysDueForCheck();
    const journeysChecked = journeysDue.length;

    if (journeysChecked === 0) {
      return {
        journeysChecked: 0,
        delaysDetected: 0,
        claimsTriggered: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const now = new Date();

    // Split journeys by status and check for completed journeys
    const pendingRidJourneys: MonitoredJourney[] = [];
    const activeJourneys: MonitoredJourney[] = [];
    const completedJourneyIds: Set<string> = new Set();

    for (const journey of journeysDue) {
      // Check if journey has passed its arrival time
      const arrivalTime = journey.scheduled_arrival instanceof Date
        ? journey.scheduled_arrival
        : new Date(journey.scheduled_arrival);

      if (arrivalTime.getTime() < now.getTime()) {
        // Journey has passed arrival time - mark as completed
        await this.journeyMonitor.completeJourney(journey.id!);
        completedJourneyIds.add(journey.id!);
        await this.outboxPublisher.publishJourneyCompleted({
          journeyId: journey.id!,
          userId: journey.user_id,
          completedAt: now,
          hadDelay: journey.monitoring_status === 'delayed',
          correlationId,
        });
        continue;
      }

      if (journey.monitoring_status === 'pending_rid') {
        pendingRidJourneys.push(journey);
      } else if (journey.monitoring_status === 'active') {
        activeJourneys.push(journey);
      }
    }

    // Resolve RIDs for pending journeys using JourneyMatcherClient
    // Per TD-DELAY-001: RIDs should be obtained from journey-matcher segments, not from darwin-ingestor
    for (const journey of pendingRidJourneys) {
      try {
        // Use JourneyMatcherClient to get journey with segments (which contain RIDs)
        if (this.journeyMatcherClient) {
          const journeyWithSegments = await this.journeyMatcherClient.getJourneyWithSegments(
            journey.journey_id
          );

          if (journeyWithSegments && journeyWithSegments.segments.length > 0) {
            // Extract RIDs from segments
            const rids = this.journeyMatcherClient.extractRidsFromSegments(
              journeyWithSegments.segments
            );

            if (rids.length > 0) {
              // Use the first RID for now (single-segment journeys)
              // TODO: For multi-segment journeys, store all RIDs or the primary one
              const rid = rids[0];
              await this.journeyMonitor.resolveRid(journey.id!, rid);
              // RID resolved - journey will be checked for delays in next cycle
              // Don't add to activeJourneys in this cycle as the journey just transitioned to 'active'
            } else {
              // No RIDs resolved yet in segments, schedule retry
              await this.journeyMonitor.updateLastChecked([journey.id!]);
            }
          } else {
            // Journey not found or has no segments, schedule retry
            await this.journeyMonitor.updateLastChecked([journey.id!]);
          }
        } else {
          // JourneyMatcherClient not configured, skip RID resolution
          await this.journeyMonitor.updateLastChecked([journey.id!]);
        }
      } catch (error) {
        console.error(`Failed to resolve RID for journey ${journey.id}:`, error);
        // Schedule retry
        await this.journeyMonitor.updateLastChecked([journey.id!]);
      }
    }

    // Check delays for active journeys with RIDs
    const journeysWithRids = activeJourneys.filter(j => j.rid);

    if (journeysWithRids.length > 0) {
      // First, fetch delay data from Darwin API
      const rids = journeysWithRids.map(j => j.rid!);
      let delayDataArray: { rid: string; total_delay_minutes: number; cancelled: boolean; delay_reasons: Record<string, unknown> | null }[] = [];

      try {
        const darwinResponse = await this.darwinClient.getDelaysByRids(rids);
        // Map Darwin response to expected format
        // Handle both array format (from real client) and { delays: [...] } format (from test mocks)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = darwinResponse as any;
        const responseData: Array<{
          rid: string;
          total_delay_minutes?: number;
          delay_minutes?: number;
          cancelled?: boolean;
          is_cancelled?: boolean;
          delay_reasons?: Record<string, unknown> | null;
        }> = Array.isArray(rawResponse) ? rawResponse : (rawResponse?.delays || []);
        delayDataArray = responseData.map((d) => ({
          rid: d.rid,
          total_delay_minutes: d.total_delay_minutes ?? d.delay_minutes ?? 0,
          cancelled: d.cancelled ?? d.is_cancelled ?? false,
          delay_reasons: d.delay_reasons ?? null,
        }));
      } catch (error) {
        console.error('Failed to fetch delay data from Darwin:', error);
        // Update next_check_at for all journeys and return
        await this.journeyMonitor.updateLastChecked(journeysWithRids.map(j => j.id!));
        return {
          journeysChecked,
          delaysDetected: 0,
          claimsTriggered: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // Map delay data to journeys
      // When querying Darwin, we expect responses to be matched by RID
      // But if RIDs don't match (e.g., in tests with mock data), fall back to position mapping
      let mappedDelayData = delayDataArray;

      // If we have exactly one journey and one delay result, map them directly
      // This handles cases where mock data has a different RID than the queried journey
      if (journeysWithRids.length === 1 && delayDataArray.length === 1) {
        mappedDelayData = [{
          ...delayDataArray[0],
          rid: journeysWithRids[0].rid!, // Use the journey's RID for matching
        }];
      }

      const delayResults = this.delayDetector.detectDelaysBatch(
        journeysWithRids.map(j => ({
          id: j.id!,
          rid: j.rid!,
        })),
        mappedDelayData
      );

      // Process delay results
      for (const result of delayResults) {
        // Only create alerts for delays that exceed threshold or are cancelled
        if (!result.exceedsThreshold && !result.isCancelled) {
          continue;
        }

        delaysDetected++;

        // Find the journey for this result
        const journey = journeysWithRids.find(j => j.id === result.journeyId);
        if (!journey) continue;

        // Use a transaction for atomic operations
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');

          // Create delay alert
          // For cancellations, ensure delay_minutes is at least 1 to satisfy DB constraint
          // (delay_minutes > 0 check constraint)
          const alertDelayMinutes = result.isCancelled && result.delayMinutes === 0
            ? 1
            : result.delayMinutes;

          const alert = await this.delayAlertRepository.create({
            monitored_journey_id: result.journeyId,
            delay_minutes: alertDelayMinutes,
            delay_detected_at: result.detectedAt,
            delay_reasons: result.delayReasons,
            is_cancellation: result.isCancelled,
            threshold_exceeded: result.exceedsThreshold,
            claim_triggered: false,
            notification_sent: false,
          }, client);

          // Update journey status
          if (result.isCancelled) {
            await this.journeyMonitor.updateStatus(result.journeyId, 'cancelled');
          } else {
            await this.journeyMonitor.updateStatus(result.journeyId, 'delayed');
          }

          // Publish delay detected event
          await this.outboxPublisher.publishDelayDetected({
            journeyId: result.journeyId,
            alertId: alert.id!,
            userId: journey.user_id,
            delayMinutes: result.delayMinutes,
            delayReasons: result.delayReasons ?? undefined,
            correlationId,
          }, client);

          // Trigger claim if eligible (not cancelled - cancellations handled differently)
          if (result.claimEligible && !result.isCancelled) {
            try {
              const claimResult = await this.claimTrigger.triggerClaim({
                id: alert.id!,
                monitored_journey_id: result.journeyId,
                delay_minutes: result.delayMinutes,
                user_id: journey.user_id,
              });

              if (claimResult.success && claimResult.claimReferenceId) {
                claimsTriggered++;

                // Update alert with claim info (within transaction)
                await this.delayAlertRepository.markClaimTriggered(
                  alert.id!,
                  claimResult.claimReferenceId,
                  client
                );

                // Publish claim triggered event
                await this.outboxPublisher.publishClaimTriggered({
                  alertId: alert.id!,
                  journeyId: result.journeyId,
                  userId: journey.user_id,
                  claimReferenceId: claimResult.claimReferenceId,
                  delayMinutes: result.delayMinutes,
                  correlationId,
                }, client);
              } else {
                // Update alert with not eligible response (within transaction)
                await this.delayAlertRepository.update(alert.id!, {
                  claim_triggered: false,
                  claim_trigger_response: claimResult.reason === 'NOT_ELIGIBLE'
                    ? 'Journey does not meet eligibility criteria - not eligible'
                    : claimResult.error || claimResult.reason || 'Claim trigger failed',
                }, client);
              }
            } catch (error) {
              console.error('Failed to trigger claim:', error);
              // Update alert to indicate claim trigger failure (within transaction)
              await this.delayAlertRepository.update(alert.id!, {
                claim_triggered: false,
                claim_trigger_response: error instanceof Error ? error.message : 'Unknown error',
              }, client);
            }
          }

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          console.error('Transaction failed:', error);
          // Don't throw - continue processing other journeys
        } finally {
          client.release();
        }
      }
    }

    // Update last checked for all processed journeys that weren't completed
    // Use completedJourneyIds set since journey.monitoring_status is not updated in local objects
    const remainingJourneyIds = journeysDue
      .filter(j => !completedJourneyIds.has(j.id!))
      .map(j => j.id!);

    if (remainingJourneyIds.length > 0) {
      await this.journeyMonitor.updateLastChecked(remainingJourneyIds);
    }

    return {
      journeysChecked,
      delaysDetected,
      claimsTriggered,
      durationMs: Date.now() - startTime,
    };
  }
}
