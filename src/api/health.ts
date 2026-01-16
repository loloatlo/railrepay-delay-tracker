/**
 * Health Controller
 *
 * Provides health, liveness, and readiness endpoints
 * Per ADR-008: Health endpoint requirements
 */

import { DatabaseHealthChecker } from '../health/database-checker.js';
import {
  HealthStatus,
  HealthResponse,
  LivenessResponse,
  ReadinessResponse,
} from '../types.js';

interface HealthControllerConfig {
  databaseChecker: DatabaseHealthChecker;
  serviceName: string;
  version?: string;
}

// Re-export HealthStatus for test imports
export { HealthStatus };

export class HealthController {
  private databaseChecker: DatabaseHealthChecker;
  private serviceName: string;
  private version: string;
  private startTime: number;

  constructor(config: HealthControllerConfig) {
    this.databaseChecker = config.databaseChecker;
    this.serviceName = config.serviceName;
    this.version = config.version ?? process.env.npm_package_version ?? '1.0.0';
    this.startTime = Date.now();
  }

  /**
   * GET /health - Full health check
   */
  async getHealth(): Promise<HealthResponse> {
    let dbCheckResult;

    try {
      dbCheckResult = await this.databaseChecker.check();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      dbCheckResult = {
        healthy: false,
        error: errorMessage,
      };
    }

    // Determine overall status
    let overallStatus: HealthStatus = 'healthy';
    let httpStatus = 200;

    if (!dbCheckResult.healthy) {
      overallStatus = 'unhealthy';
      httpStatus = 503;
    } else if (dbCheckResult.degraded) {
      overallStatus = 'degraded';
      httpStatus = 200;
    }

    // Build database check status
    const databaseStatus: HealthStatus = dbCheckResult.healthy
      ? (dbCheckResult.degraded ? 'degraded' : 'healthy')
      : 'unhealthy';

    return {
      status: httpStatus,
      contentType: 'application/json',
      body: {
        status: overallStatus,
        service: this.serviceName,
        timestamp: new Date().toISOString(),
        version: this.version,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        checks: {
          database: {
            status: databaseStatus,
            latencyMs: dbCheckResult.latencyMs,
            error: dbCheckResult.error,
          },
        },
      },
    };
  }

  /**
   * GET /health/live - Liveness probe
   * Returns true as long as the process is running
   */
  async getLiveness(): Promise<LivenessResponse> {
    return {
      status: 200,
      body: {
        alive: true,
      },
    };
  }

  /**
   * GET /health/ready - Readiness probe
   * Returns true only when all dependencies are available
   */
  async getReadiness(): Promise<ReadinessResponse> {
    let dbCheckResult;

    try {
      dbCheckResult = await this.databaseChecker.check();
    } catch {
      dbCheckResult = { healthy: false };
    }

    const isReady = dbCheckResult.healthy;

    return {
      status: isReady ? 200 : 503,
      body: {
        ready: isReady,
      },
    };
  }
}
