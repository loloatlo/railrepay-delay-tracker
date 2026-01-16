/**
 * Unit Tests: Health Endpoint
 *
 * Phase: 3.1 - Test Specification (Jessie)
 * Service: delay-tracker
 *
 * Tests for the health endpoint per ADR-008 requirements:
 * 1. GET /health returns service health status
 * 2. Checks database connectivity
 * 3. Returns appropriate HTTP status codes
 *
 * NOTE: These tests should FAIL until Blake implements the health endpoint.
 * DO NOT modify these tests to make them pass - implement the code instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// These imports will fail until Blake creates the modules
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { HealthController, HealthStatus } from '../../src/api/health.js';
// @ts-expect-error - Module does not exist yet (TDD RED phase)
import { DatabaseHealthChecker } from '../../src/health/database-checker.js';

describe('HealthController', () => {
  let healthController: HealthController;
  let mockDbChecker: DatabaseHealthChecker;

  beforeEach(() => {
    mockDbChecker = {
      check: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 5 }),
    } as unknown as DatabaseHealthChecker;

    healthController = new HealthController({
      databaseChecker: mockDbChecker,
      serviceName: 'delay-tracker',
    });
  });

  describe('GET /health', () => {
    it('should return 200 when service is healthy', async () => {
      const response = await healthController.getHealth();

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });

    it('should return 503 when database is unhealthy', async () => {
      mockDbChecker.check = vi.fn().mockResolvedValue({ healthy: false, error: 'Connection refused' });

      const response = await healthController.getHealth();

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('unhealthy');
    });

    it('should include service name in response', async () => {
      const response = await healthController.getHealth();

      expect(response.body.service).toBe('delay-tracker');
    });

    it('should include timestamp in response', async () => {
      const response = await healthController.getHealth();

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });

    it('should include version in response', async () => {
      const response = await healthController.getHealth();

      expect(response.body.version).toBeDefined();
      expect(typeof response.body.version).toBe('string');
    });

    it('should include uptime in response', async () => {
      const response = await healthController.getHealth();

      expect(response.body.uptime).toBeDefined();
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Database Health Check', () => {
    it('should check database connectivity', async () => {
      await healthController.getHealth();

      expect(mockDbChecker.check).toHaveBeenCalled();
    });

    it('should include database latency in response', async () => {
      mockDbChecker.check = vi.fn().mockResolvedValue({ healthy: true, latencyMs: 15 });

      const response = await healthController.getHealth();

      expect(response.body.checks.database.latencyMs).toBe(15);
    });

    it('should include database status in checks', async () => {
      const response = await healthController.getHealth();

      expect(response.body.checks.database).toBeDefined();
      expect(response.body.checks.database.status).toBe('healthy');
    });

    it('should report database error details when unhealthy', async () => {
      mockDbChecker.check = vi.fn().mockResolvedValue({
        healthy: false,
        error: 'Connection timeout after 5000ms',
      });

      const response = await healthController.getHealth();

      expect(response.body.checks.database.status).toBe('unhealthy');
      expect(response.body.checks.database.error).toBe('Connection timeout after 5000ms');
    });

    it('should handle database check timeout', async () => {
      mockDbChecker.check = vi.fn().mockRejectedValue(new Error('Check timeout'));

      const response = await healthController.getHealth();

      expect(response.status).toBe(503);
      expect(response.body.checks.database.status).toBe('unhealthy');
    });
  });

  describe('Response Format (ADR-008 Compliance)', () => {
    it('should return JSON content type', async () => {
      const response = await healthController.getHealth();

      expect(response.contentType).toBe('application/json');
    });

    it('should match ADR-008 response schema', async () => {
      const response = await healthController.getHealth();

      // Required fields per ADR-008
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('service');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('checks');
    });

    it('should use valid status enum values', async () => {
      const healthyResponse = await healthController.getHealth();
      expect(['healthy', 'unhealthy', 'degraded']).toContain(healthyResponse.body.status);

      mockDbChecker.check = vi.fn().mockResolvedValue({ healthy: false });
      const unhealthyResponse = await healthController.getHealth();
      expect(['healthy', 'unhealthy', 'degraded']).toContain(unhealthyResponse.body.status);
    });
  });

  describe('Degraded State', () => {
    it('should report degraded when database is slow', async () => {
      mockDbChecker.check = vi.fn().mockResolvedValue({
        healthy: true,
        latencyMs: 1500, // Slow but not failed
        degraded: true,
      });

      const response = await healthController.getHealth();

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('degraded');
    });
  });

  describe('Liveness vs Readiness', () => {
    it('should support liveness check endpoint', async () => {
      const response = await healthController.getLiveness();

      expect(response.status).toBe(200);
      expect(response.body.alive).toBe(true);
    });

    it('should support readiness check endpoint', async () => {
      const response = await healthController.getReadiness();

      expect(response.body).toHaveProperty('ready');
    });

    it('should return not ready when database is unavailable', async () => {
      mockDbChecker.check = vi.fn().mockResolvedValue({ healthy: false });

      const response = await healthController.getReadiness();

      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
    });
  });
});

describe('DatabaseHealthChecker', () => {
  // These tests verify the database health checker implementation

  it('should execute health check query', async () => {
    // This test will fail until implementation exists
    // @ts-expect-error - Module does not exist yet
    const { DatabaseHealthChecker } = await import('../../src/health/database-checker.js');

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
    };

    const checker = new DatabaseHealthChecker({ pool: mockPool });
    const result = await checker.check();

    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(result.healthy).toBe(true);
  });

  it('should measure query latency', async () => {
    // @ts-expect-error - Module does not exist yet
    const { DatabaseHealthChecker } = await import('../../src/health/database-checker.js');

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
    };

    const checker = new DatabaseHealthChecker({ pool: mockPool });
    const result = await checker.check();

    expect(result.latencyMs).toBeDefined();
    expect(typeof result.latencyMs).toBe('number');
  });

  it('should report unhealthy on query failure', async () => {
    // @ts-expect-error - Module does not exist yet
    const { DatabaseHealthChecker } = await import('../../src/health/database-checker.js');

    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const checker = new DatabaseHealthChecker({ pool: mockPool });
    const result = await checker.check();

    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });
});
