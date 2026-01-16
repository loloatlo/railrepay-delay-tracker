/**
 * Database Health Checker
 *
 * Performs health checks against PostgreSQL database
 * Per ADR-008: Health endpoint requirements
 */

import { Pool } from 'pg';
import { HealthCheckResult } from '../types.js';

interface DatabaseHealthCheckerConfig {
  pool: Pool;
  slowThresholdMs?: number;
}

export class DatabaseHealthChecker {
  private pool: Pool;
  private slowThresholdMs: number;

  constructor(config: DatabaseHealthCheckerConfig) {
    this.pool = config.pool;
    this.slowThresholdMs = config.slowThresholdMs ?? 1000; // Default 1 second
  }

  /**
   * Execute health check query and measure latency
   */
  async check(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      await this.pool.query('SELECT 1');
      const latencyMs = Date.now() - startTime;

      // Check if response is degraded (slow but not failed)
      const degraded = latencyMs > this.slowThresholdMs;

      return {
        healthy: true,
        latencyMs,
        degraded,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        healthy: false,
        latencyMs,
        error: errorMessage,
      };
    }
  }
}
