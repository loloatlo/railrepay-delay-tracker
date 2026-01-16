/**
 * Cron Scheduler
 *
 * Schedules periodic delay check execution
 * Default interval: every 5 minutes (star-slash-5 * * * *)
 */

import { CronMetrics } from '../types.js';
import { DelayChecker } from '../services/delay-checker.js';
import { JourneyMonitor } from '../services/journey-monitor.js';

interface CronSchedulerConfig {
  delayChecker: DelayChecker;
  journeyMonitor: JourneyMonitor;
  cronExpression?: string;
}

export class CronScheduler {
  private delayChecker: DelayChecker;
  private journeyMonitor: JourneyMonitor;
  private cronExpression: string;
  private running = false;
  private executing = false;
  private intervalId: NodeJS.Timeout | null = null;
  private metrics: CronMetrics = {
    lastExecutionDurationMs: 0,
    totalExecutions: 0,
    journeysProcessed: 0,
    errorCount: 0,
  };

  constructor(config: CronSchedulerConfig) {
    this.delayChecker = config.delayChecker;
    this.journeyMonitor = config.journeyMonitor;
    this.cronExpression = config.cronExpression ?? '*/5 * * * *';
  }

  /**
   * Get the configured cron expression
   */
  getCronExpression(): string {
    return this.cronExpression;
  }

  /**
   * Check if the scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if currently executing a job
   */
  isExecuting(): boolean {
    return this.executing;
  }

  /**
   * Get current metrics
   */
  getMetrics(): CronMetrics {
    return { ...this.metrics };
  }

  /**
   * Start the scheduler
   * For simplicity, uses setInterval - in production would use node-cron
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;

    // Parse cron expression to get interval
    // For */5 * * * *, interval is 5 minutes
    const intervalMs = this.parseCronToMs(this.cronExpression);

    this.intervalId = setInterval(() => {
      this.execute();
    }, intervalMs);

    // Also execute immediately on start
    await this.execute();
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Execute a single run of the delay check
   * Prevents concurrent execution
   */
  async execute(): Promise<void> {
    // Prevent concurrent execution
    if (this.executing) {
      return;
    }

    this.executing = true;
    const startTime = Date.now();

    try {
      // Get journeys due for checking
      const journeys = await this.journeyMonitor.getJourneysDueForCheck();

      if (journeys.length > 0) {
        // Check delays for journeys - filter to only those with valid RIDs
        const journeysWithRids = journeys
          .filter(j => j.rid != null)
          .map(j => ({ id: j.id!, rid: j.rid! }));

        if (journeysWithRids.length > 0) {
          await this.delayChecker.checkDelays(journeysWithRids);
        }

        // Update last checked for all processed journeys
        const journeyIds = journeys.map(j => j.id!);
        await this.journeyMonitor.updateLastChecked(journeyIds);
      }

      this.metrics.totalExecutions++;
      this.metrics.journeysProcessed += journeys.length;
      this.metrics.lastExecutionDurationMs = Date.now() - startTime;
    } catch (error) {
      this.metrics.errorCount++;
      this.metrics.lastExecutionDurationMs = Date.now() - startTime;
      // Log error but don't throw - let scheduler continue
      console.error('Cron execution error:', error);
    } finally {
      this.executing = false;
    }
  }

  /**
   * Parse a cron expression to milliseconds interval
   * Simplified parser for common patterns
   */
  private parseCronToMs(expression: string): number {
    const parts = expression.split(' ');
    const minutes = parts[0];

    // Handle */N pattern
    if (minutes.startsWith('*/')) {
      const interval = parseInt(minutes.substring(2), 10);
      return interval * 60 * 1000;
    }

    // Default to 5 minutes
    return 5 * 60 * 1000;
  }
}
