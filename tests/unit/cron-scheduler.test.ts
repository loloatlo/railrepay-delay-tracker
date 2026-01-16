/**
 * Unit Tests: Cron Scheduler
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the cron job scheduler that:
 * 1. Runs every 5 minutes (per specification)
 * 2. Finds journeys due for checking
 * 3. Coordinates delay detection and claim triggering
 *
 * NOTE: These tests should FAIL until Blake implements the cron scheduler.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { CronScheduler } from '../../src/cron/scheduler.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DelayChecker } from '../../src/services/delay-checker.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { JourneyMonitor } from '../../src/services/journey-monitor.js';

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let mockDelayChecker: DelayChecker;
  let mockJourneyMonitor: JourneyMonitor;

  beforeEach(() => {
    vi.useFakeTimers();

    // Create mocks for dependencies
    mockDelayChecker = {
      checkDelays: vi.fn().mockResolvedValue([]),
    } as unknown as DelayChecker;

    mockJourneyMonitor = {
      getJourneysDueForCheck: vi.fn().mockResolvedValue([]),
      updateLastChecked: vi.fn().mockResolvedValue(undefined),
    } as unknown as JourneyMonitor;

    scheduler = new CronScheduler({
      delayChecker: mockDelayChecker,
      journeyMonitor: mockJourneyMonitor,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Configuration', () => {
    it('should be configured to run every 5 minutes', () => {
      expect(scheduler.getCronExpression()).toBe('*/5 * * * *');
    });

    it('should have a configurable cron expression', () => {
      const customScheduler = new CronScheduler({
        delayChecker: mockDelayChecker,
        journeyMonitor: mockJourneyMonitor,
        cronExpression: '*/10 * * * *',
      });

      expect(customScheduler.getCronExpression()).toBe('*/10 * * * *');
    });
  });

  describe('Lifecycle', () => {
    it('should start the cron job when start() is called', async () => {
      expect(scheduler.isRunning()).toBe(false);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
    });

    it('should stop the cron job when stop() is called', async () => {
      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      await scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
    });

    it('should not start twice if already running', async () => {
      await scheduler.start();
      await scheduler.start(); // Second start should be idempotent

      expect(scheduler.isRunning()).toBe(true);
    });

    it('should gracefully handle stop when not running', async () => {
      await expect(scheduler.stop()).resolves.not.toThrow();
    });
  });

  describe('Execution', () => {
    it('should fetch journeys due for check when executed', async () => {
      await scheduler.execute();

      expect(mockJourneyMonitor.getJourneysDueForCheck).toHaveBeenCalledTimes(1);
    });

    it('should check delays for each journey due', async () => {
      const mockJourneys = [
        { id: 'journey-1', rid: '202601150800123' },
        { id: 'journey-2', rid: '202601150900456' },
      ];

      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue(mockJourneys);

      await scheduler.execute();

      expect(mockDelayChecker.checkDelays).toHaveBeenCalledTimes(1);
      expect(mockDelayChecker.checkDelays).toHaveBeenCalledWith(mockJourneys);
    });

    it('should not call delay checker when no journeys are due', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([]);

      await scheduler.execute();

      expect(mockDelayChecker.checkDelays).not.toHaveBeenCalled();
    });

    it('should update last_checked_at for processed journeys', async () => {
      const mockJourneys = [
        { id: 'journey-1', rid: '202601150800123' },
      ];

      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue(mockJourneys);
      mockDelayChecker.checkDelays = vi.fn().mockResolvedValue([]);

      await scheduler.execute();

      expect(mockJourneyMonitor.updateLastChecked).toHaveBeenCalledWith(['journey-1']);
    });
  });

  describe('Error Handling', () => {
    it('should continue running after an execution error', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockRejectedValue(new Error('Database error'));

      await expect(scheduler.execute()).resolves.not.toThrow();

      // Scheduler should still be able to execute again
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([]);
      await expect(scheduler.execute()).resolves.not.toThrow();
    });

    it('should log errors without crashing the scheduler', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockDelayChecker.checkDelays = vi.fn().mockRejectedValue(new Error('Service unavailable'));
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([{ id: '1', rid: 'rid1' }]);

      await scheduler.execute();

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('Metrics', () => {
    it('should track execution duration', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([]);

      await scheduler.execute();

      const metrics = scheduler.getMetrics();
      expect(metrics.lastExecutionDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should track total executions count', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([]);

      await scheduler.execute();
      await scheduler.execute();
      await scheduler.execute();

      const metrics = scheduler.getMetrics();
      expect(metrics.totalExecutions).toBe(3);
    });

    it('should track journeys processed count', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockResolvedValue([
        { id: '1', rid: 'rid1' },
        { id: '2', rid: 'rid2' },
      ]);

      await scheduler.execute();

      const metrics = scheduler.getMetrics();
      expect(metrics.journeysProcessed).toBe(2);
    });

    it('should track error count', async () => {
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockRejectedValue(new Error('Fail'));

      await scheduler.execute();
      await scheduler.execute();

      const metrics = scheduler.getMetrics();
      expect(metrics.errorCount).toBe(2);
    });
  });

  describe('Concurrent Execution Prevention', () => {
    it('should not allow concurrent executions', async () => {
      // Simulate slow execution using a promise that resolves after advancing timers
      // With fake timers enabled, we need to advance time to resolve setTimeout
      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 1000))
      );

      const execution1 = scheduler.execute();
      const execution2 = scheduler.execute();

      // Advance timers to resolve the setTimeout in the mock
      await vi.advanceTimersByTimeAsync(1000);

      await Promise.all([execution1, execution2]);

      // Only one execution should have been processed
      expect(mockJourneyMonitor.getJourneysDueForCheck).toHaveBeenCalledTimes(1);
    });

    it('should set isExecuting flag during execution', async () => {
      let executingDuringCall = false;

      mockJourneyMonitor.getJourneysDueForCheck = vi.fn().mockImplementation(() => {
        executingDuringCall = scheduler.isExecuting();
        return Promise.resolve([]);
      });

      await scheduler.execute();

      expect(executingDuringCall).toBe(true);
      expect(scheduler.isExecuting()).toBe(false);
    });
  });
});
