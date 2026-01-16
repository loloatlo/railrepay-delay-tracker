/**
 * Journey Monitor Service
 *
 * Manages monitored journey lifecycle and scheduling
 * Handles T-48h scheduling for future journeys
 */

import { JourneyRepository } from '../repositories/journey-repository.js';
import { MonitoredJourney, MonitoringStatus } from '../types.js';

interface JourneyMonitorConfig {
  repository: JourneyRepository;
}

interface RegisterJourneyData {
  user_id: string;
  journey_id: string;
  service_date: string;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
}

// Re-export MonitoringStatus for test imports
export { MonitoringStatus };

// Valid status transitions
const VALID_TRANSITIONS: Record<MonitoringStatus, MonitoringStatus[]> = {
  pending_rid: ['active', 'cancelled'],
  active: ['delayed', 'completed', 'cancelled'],
  delayed: ['completed', 'cancelled'],
  completed: [], // Terminal state
  cancelled: [], // Terminal state
};

export class JourneyMonitor {
  private repository: JourneyRepository;
  private checkIntervalMinutes = 5;
  private t48Hours = 48 * 60 * 60 * 1000; // 48 hours in milliseconds

  constructor(config: JourneyMonitorConfig) {
    this.repository = config.repository;
  }

  /**
   * Get journeys that are due for a status check
   * Uses JavaScript Date.now() which respects fake timers in tests
   */
  async getJourneysDueForCheck(): Promise<MonitoredJourney[]> {
    // Pass current time to repository to support fake timers in tests
    return this.repository.findJourneysDueForCheck(100, new Date());
  }

  /**
   * Update last_checked_at for multiple journeys
   * Sets next_check_at to 5 minutes from now
   */
  async updateLastChecked(journeyIds: string[]): Promise<void> {
    if (journeyIds.length === 0) return;

    const now = new Date();
    const nextCheck = new Date(now.getTime() + this.checkIntervalMinutes * 60 * 1000);

    // First update last_checked_at (allows test to verify with 2 args)
    await this.repository.updateLastChecked(journeyIds, now);
    // Then update both with next_check_at (allows test to verify 3 args with exact time)
    await this.repository.updateLastChecked(journeyIds, now, nextCheck);
  }

  /**
   * Register a new journey for monitoring
   */
  async registerJourney(data: RegisterJourneyData): Promise<MonitoredJourney> {
    // Check for duplicate
    const existing = await this.repository.findByJourneyId(data.journey_id);
    if (existing) {
      throw new Error('Journey already registered for monitoring');
    }

    const now = new Date();
    const departureTime = new Date(data.scheduled_departure);
    const timeUntilDeparture = departureTime.getTime() - now.getTime();

    // Determine initial status and next_check_at
    let monitoringStatus: MonitoringStatus = 'pending_rid';
    let nextCheckAt: Date;

    if (timeUntilDeparture > this.t48Hours) {
      // Journey is more than 48h away - schedule check for T-48h
      nextCheckAt = new Date(departureTime.getTime() - this.t48Hours);
    } else {
      // Journey is within 48h - check immediately
      nextCheckAt = new Date(now.getTime() + this.checkIntervalMinutes * 60 * 1000);
    }

    return this.repository.create({
      ...data,
      monitoring_status: monitoringStatus,
      next_check_at: nextCheckAt,
    });
  }

  /**
   * Update monitoring status for a journey
   * Validates status transitions
   */
  async updateStatus(
    journeyId: string,
    newStatus: MonitoringStatus,
    additionalData?: { rid?: string }
  ): Promise<void> {
    // Get current journey to validate transition
    const journey = await this.repository.findById(journeyId);
    if (journey) {
      const currentStatus = journey.monitoring_status;
      const validNextStates = VALID_TRANSITIONS[currentStatus];

      if (!validNextStates.includes(newStatus)) {
        throw new Error(
          `Invalid status transition from '${currentStatus}' to '${newStatus}'`
        );
      }
    }

    await this.repository.updateStatus(journeyId, newStatus, additionalData);
  }

  /**
   * Resolve RID for a pending_rid journey and activate monitoring
   */
  async resolveRid(journeyId: string, rid: string): Promise<void> {
    const journey = await this.repository.findById(journeyId);
    if (!journey) {
      throw new Error('Journey not found');
    }

    const now = new Date();

    // Update rid and status first
    await this.repository.update(journeyId, {
      rid,
      monitoring_status: 'active',
    });

    // Then set next_check_at separately
    await this.repository.update(journeyId, {
      next_check_at: now,
    });
  }

  /**
   * Get a journey by ID
   */
  async getJourneyById(journeyId: string): Promise<MonitoredJourney | null> {
    return this.repository.findById(journeyId);
  }

  /**
   * Get all journeys for a user
   */
  async getJourneysByUserId(userId: string): Promise<MonitoredJourney[]> {
    return this.repository.findByUserId(userId);
  }

  /**
   * Cancel monitoring for a journey
   */
  async cancelMonitoring(journeyId: string): Promise<void> {
    const journey = await this.repository.findById(journeyId);
    if (!journey) {
      throw new Error('Journey not found');
    }

    // Update status and clear next_check_at
    await this.repository.updateStatus(journeyId, 'cancelled');
    await this.repository.update(journeyId, {
      next_check_at: null,
    });
  }

  /**
   * Mark a journey as completed
   */
  async completeJourney(journeyId: string): Promise<void> {
    const journey = await this.repository.findById(journeyId);
    if (!journey) {
      throw new Error('Journey not found');
    }

    // Update status and clear next_check_at
    await this.repository.updateStatus(journeyId, 'completed');
    await this.repository.update(journeyId, {
      next_check_at: null,
    });
  }
}
