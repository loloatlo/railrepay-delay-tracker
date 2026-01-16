/**
 * Delay Checker Service
 *
 * Coordinates delay checking for journeys
 * Used by the CronScheduler to check multiple journeys at once
 */

import { DelayDetector } from './delay-detector.js';
import { DarwinIngestorClient } from '../clients/darwin-ingestor.js';
import { DelayResult } from '../types.js';

interface DelayCheckerConfig {
  delayDetector: DelayDetector;
  darwinClient: DarwinIngestorClient;
}

interface JourneyToCheck {
  id: string;
  rid: string;
}

export class DelayChecker {
  private delayDetector: DelayDetector;
  private darwinClient: DarwinIngestorClient;

  constructor(config: DelayCheckerConfig) {
    this.delayDetector = config.delayDetector;
    this.darwinClient = config.darwinClient;
  }

  /**
   * Check delays for multiple journeys
   */
  async checkDelays(journeys: JourneyToCheck[]): Promise<DelayResult[]> {
    if (journeys.length === 0) {
      return [];
    }

    // Fetch delay data from Darwin
    const rids = journeys.map(j => j.rid);
    const darwinResponse = await this.darwinClient.getDelaysByRids(rids);

    // Map Darwin response to DelayData format expected by DelayDetector
    const delayDataArray = darwinResponse.map(d => ({
      rid: d.rid,
      total_delay_minutes: d.delay_minutes,
      cancelled: d.is_cancelled,
      delay_reasons: d.delay_reasons ?? null,
    }));

    return this.delayDetector.detectDelaysBatch(
      journeys.map(j => ({
        id: j.id,
        rid: j.rid,
      })),
      delayDataArray
    );
  }
}
