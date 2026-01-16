/**
 * Unit Tests: Journey Monitor Service
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the journey monitoring logic that:
 * 1. Manages monitored journey lifecycle
 * 2. Handles T-48h scheduling for future journeys
 * 3. Updates monitoring status
 *
 * NOTE: These tests should FAIL until Blake implements the journey monitor.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyMonitor, MonitoringStatus } from '../../src/services/journey-monitor.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyRepository } from '../../src/repositories/journey-repository.js';

// Import fixtures
import {
  activeJourneyWithRid,
  pendingRidJourney,
  delayedJourney,
  completedJourney,
  journeyDueForCheck,
  multipleJourneysForUser,
} from '../fixtures/db/monitored-journeys.fixtures.js';

describe('JourneyMonitor', () => {
  let journeyMonitor: JourneyMonitor;
  let mockRepository: JourneyRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T08:30:00Z'));

    mockRepository = {
      findJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      findByUserId: vi.fn(),
      findByJourneyId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateLastChecked: vi.fn(),
      delete: vi.fn(),
    } as unknown as JourneyRepository;

    journeyMonitor = new JourneyMonitor({
      repository: mockRepository,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Get Journeys Due For Check', () => {
    it('should find journeys with next_check_at <= now', async () => {
      mockRepository.findJourneysDueForCheck = vi.fn().mockResolvedValue([journeyDueForCheck]);

      const journeys = await journeyMonitor.getJourneysDueForCheck();

      expect(mockRepository.findJourneysDueForCheck).toHaveBeenCalled();
      expect(journeys).toHaveLength(1);
    });

    it('should only return active and pending_rid status journeys', async () => {
      mockRepository.findJourneysDueForCheck = vi.fn().mockResolvedValue([
        activeJourneyWithRid,
        pendingRidJourney,
      ]);

      const journeys = await journeyMonitor.getJourneysDueForCheck();

      expect(journeys.every((j: any) =>
        ['active', 'pending_rid'].includes(j.monitoring_status)
      )).toBe(true);
    });

    it('should not return completed journeys', async () => {
      mockRepository.findJourneysDueForCheck = vi.fn().mockResolvedValue([]);

      const journeys = await journeyMonitor.getJourneysDueForCheck();

      expect(journeys.find((j: any) => j.monitoring_status === 'completed')).toBeUndefined();
    });

    it('should not return cancelled journeys', async () => {
      mockRepository.findJourneysDueForCheck = vi.fn().mockResolvedValue([]);

      const journeys = await journeyMonitor.getJourneysDueForCheck();

      expect(journeys.find((j: any) => j.monitoring_status === 'cancelled')).toBeUndefined();
    });
  });

  describe('Update Last Checked', () => {
    it('should update last_checked_at for journey IDs', async () => {
      await journeyMonitor.updateLastChecked(['journey-1', 'journey-2']);

      expect(mockRepository.updateLastChecked).toHaveBeenCalledWith(
        ['journey-1', 'journey-2'],
        expect.any(Date)
      );
    });

    it('should set next_check_at to 5 minutes from now', async () => {
      await journeyMonitor.updateLastChecked(['journey-1']);

      const expectedNextCheck = new Date('2026-01-15T08:35:00Z');
      expect(mockRepository.updateLastChecked).toHaveBeenCalledWith(
        ['journey-1'],
        expect.any(Date),
        expectedNextCheck
      );
    });

    it('should handle empty journey list', async () => {
      await journeyMonitor.updateLastChecked([]);

      expect(mockRepository.updateLastChecked).not.toHaveBeenCalled();
    });
  });

  describe('Register Journey for Monitoring', () => {
    it('should create monitored journey record', async () => {
      const journeyData = {
        user_id: 'user-001',
        journey_id: 'journey-001',
        service_date: '2026-01-16',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-16T08:00:00Z',
        scheduled_arrival: '2026-01-16T12:30:00Z',
      };

      mockRepository.create = vi.fn().mockResolvedValue({ id: 'new-id', ...journeyData });

      const result = await journeyMonitor.registerJourney(journeyData);

      expect(mockRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        user_id: 'user-001',
        journey_id: 'journey-001',
        monitoring_status: 'pending_rid',
      }));
      expect(result.id).toBe('new-id');
    });

    it('should set status to pending_rid for journeys >48h away', async () => {
      const futureJourney = {
        user_id: 'user-001',
        journey_id: 'journey-001',
        service_date: '2026-01-20', // 5 days away
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-20T08:00:00Z',
        scheduled_arrival: '2026-01-20T12:30:00Z',
      };

      await journeyMonitor.registerJourney(futureJourney);

      expect(mockRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        monitoring_status: 'pending_rid',
      }));
    });

    it('should calculate next_check_at as T-48h for future journeys', async () => {
      const futureJourney = {
        user_id: 'user-001',
        journey_id: 'journey-001',
        service_date: '2026-01-20',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-20T08:00:00Z',
        scheduled_arrival: '2026-01-20T12:30:00Z',
      };

      await journeyMonitor.registerJourney(futureJourney);

      // T-48h from 2026-01-20T08:00:00Z = 2026-01-18T08:00:00Z
      expect(mockRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        next_check_at: new Date('2026-01-18T08:00:00Z'),
      }));
    });

    it('should set next_check_at immediately for journeys within 48h', async () => {
      const soonJourney = {
        user_id: 'user-001',
        journey_id: 'journey-001',
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T12:00:00Z', // Same day
        scheduled_arrival: '2026-01-15T16:30:00Z',
      };

      await journeyMonitor.registerJourney(soonJourney);

      expect(mockRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        next_check_at: expect.any(Date),
      }));

      // Next check should be within minutes, not hours
      const createCall = mockRepository.create.mock.calls[0][0];
      const nextCheck = new Date(createCall.next_check_at);
      const now = new Date('2026-01-15T08:30:00Z');
      const diffMinutes = (nextCheck.getTime() - now.getTime()) / (1000 * 60);

      expect(diffMinutes).toBeLessThanOrEqual(5);
    });

    it('should reject duplicate journey registration', async () => {
      mockRepository.findByJourneyId = vi.fn().mockResolvedValue(activeJourneyWithRid);

      const journeyData = {
        user_id: 'user-001',
        journey_id: activeJourneyWithRid.journey_id,
        service_date: '2026-01-15',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        scheduled_departure: '2026-01-15T08:00:00Z',
        scheduled_arrival: '2026-01-15T12:30:00Z',
      };

      await expect(journeyMonitor.registerJourney(journeyData)).rejects.toThrow('already registered');
    });
  });

  describe('Update Monitoring Status', () => {
    it('should update status to active when RID is resolved', async () => {
      await journeyMonitor.updateStatus('journey-id', 'active', { rid: '202601150800123' });

      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        'journey-id',
        'active',
        expect.objectContaining({ rid: '202601150800123' })
      );
    });

    it('should update status to delayed when delay detected', async () => {
      await journeyMonitor.updateStatus('journey-id', 'delayed');

      expect(mockRepository.updateStatus).toHaveBeenCalledWith('journey-id', 'delayed', undefined);
    });

    it('should update status to completed after journey ends', async () => {
      await journeyMonitor.updateStatus('journey-id', 'completed');

      expect(mockRepository.updateStatus).toHaveBeenCalledWith('journey-id', 'completed', undefined);
    });

    it('should update status to cancelled for cancelled services', async () => {
      await journeyMonitor.updateStatus('journey-id', 'cancelled');

      expect(mockRepository.updateStatus).toHaveBeenCalledWith('journey-id', 'cancelled', undefined);
    });

    it('should validate status transitions', async () => {
      // Cannot go from completed to active
      mockRepository.findById = vi.fn().mockResolvedValue(completedJourney);

      await expect(
        journeyMonitor.updateStatus(completedJourney.id!, 'active')
      ).rejects.toThrow('Invalid status transition');
    });
  });

  describe('RID Resolution', () => {
    it('should update journey with resolved RID', async () => {
      const pendingJourney = { ...pendingRidJourney, id: 'pending-id' };
      mockRepository.findById = vi.fn().mockResolvedValue(pendingJourney);

      await journeyMonitor.resolveRid('pending-id', '202601200800123');

      expect(mockRepository.update).toHaveBeenCalledWith('pending-id', {
        rid: '202601200800123',
        monitoring_status: 'active',
      });
    });

    it('should set next_check_at to now after RID resolution', async () => {
      const pendingJourney = { ...pendingRidJourney, id: 'pending-id' };
      mockRepository.findById = vi.fn().mockResolvedValue(pendingJourney);

      await journeyMonitor.resolveRid('pending-id', '202601200800123');

      expect(mockRepository.update).toHaveBeenCalledWith('pending-id', expect.objectContaining({
        next_check_at: expect.any(Date),
      }));
    });
  });

  describe('Query Methods', () => {
    it('should find journey by ID', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(activeJourneyWithRid);

      const journey = await journeyMonitor.getJourneyById('journey-id');

      expect(mockRepository.findById).toHaveBeenCalledWith('journey-id');
      expect(journey).toEqual(activeJourneyWithRid);
    });

    it('should find journeys by user ID', async () => {
      mockRepository.findByUserId = vi.fn().mockResolvedValue(multipleJourneysForUser);

      const journeys = await journeyMonitor.getJourneysByUserId('user-multi-journey-001');

      expect(mockRepository.findByUserId).toHaveBeenCalledWith('user-multi-journey-001');
      expect(journeys).toHaveLength(2);
    });

    it('should return null for non-existent journey', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(null);

      const journey = await journeyMonitor.getJourneyById('non-existent');

      expect(journey).toBeNull();
    });
  });

  describe('Cancel Monitoring', () => {
    it('should cancel monitoring for a journey', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(activeJourneyWithRid);

      await journeyMonitor.cancelMonitoring('journey-id');

      expect(mockRepository.updateStatus).toHaveBeenCalledWith('journey-id', 'cancelled');
    });

    it('should clear next_check_at when cancelling', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(activeJourneyWithRid);

      await journeyMonitor.cancelMonitoring('journey-id');

      expect(mockRepository.update).toHaveBeenCalledWith('journey-id', expect.objectContaining({
        next_check_at: null,
      }));
    });
  });

  describe('Complete Journey', () => {
    it('should mark journey as completed', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(activeJourneyWithRid);

      await journeyMonitor.completeJourney('journey-id');

      expect(mockRepository.updateStatus).toHaveBeenCalledWith('journey-id', 'completed');
    });

    it('should clear next_check_at when completing', async () => {
      mockRepository.findById = vi.fn().mockResolvedValue(activeJourneyWithRid);

      await journeyMonitor.completeJourney('journey-id');

      expect(mockRepository.update).toHaveBeenCalledWith('journey-id', expect.objectContaining({
        next_check_at: null,
      }));
    });
  });
});
