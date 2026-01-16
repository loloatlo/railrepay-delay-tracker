/**
 * Delay Detector Service
 *
 * Detects train delays based on Darwin data
 * Threshold: >=15 minutes for claim eligibility (per specification)
 */

import { DelayResult, DelayThreshold } from '../types.js';

interface DelayDetectorConfig {
  thresholdMinutes?: number;
}

interface JourneyData {
  id?: string;
  rid?: string;
}

interface DelayData {
  rid: string;
  total_delay_minutes: number;
  cancelled: boolean;
  delay_reasons: Record<string, unknown> | null;
}

// Re-export types for test imports
export { DelayResult, DelayThreshold };

export class DelayDetector {
  private thresholdMinutes: number;

  constructor(config: DelayDetectorConfig = {}) {
    const threshold = config.thresholdMinutes ?? 15;

    // Validate threshold
    if (threshold <= 0) {
      throw new Error('Threshold must be a positive number');
    }

    this.thresholdMinutes = threshold;
  }

  /**
   * Get the configured delay threshold in minutes
   */
  getThreshold(): number {
    return this.thresholdMinutes;
  }

  /**
   * Check if delay meets the threshold for compensation
   */
  meetsThreshold(delayMinutes: number): boolean {
    return delayMinutes >= this.thresholdMinutes;
  }

  /**
   * Detect delay for a single journey using pre-fetched delay data
   */
  detectDelay(journey: JourneyData, delayData: DelayData): DelayResult {
    const delayMinutes = delayData.total_delay_minutes;
    const isCancelled = delayData.cancelled;
    const isDelayed = delayMinutes > 0 || isCancelled;
    const exceedsThreshold = this.meetsThreshold(delayMinutes);
    const claimEligible = exceedsThreshold || isCancelled;

    return {
      journeyId: journey.id ?? '',
      rid: delayData.rid,
      isDelayed,
      isCancelled,
      delayMinutes,
      exceedsThreshold,
      claimEligible,
      delayReasons: delayData.delay_reasons,
      detectedAt: new Date(),
    };
  }

  /**
   * Detect delays for multiple journeys in batch using pre-fetched delay data
   */
  detectDelaysBatch(journeys: JourneyData[], delayDataArray: DelayData[]): DelayResult[] {
    if (journeys.length === 0) {
      return [];
    }

    const results: DelayResult[] = [];

    for (const journey of journeys) {
      const delayData = this.findDelayByRid(journey.rid ?? '', delayDataArray);

      if (delayData) {
        results.push(this.detectDelay(journey, delayData));
      } else {
        // No delay data found for this journey
        results.push({
          journeyId: journey.id ?? '',
          rid: journey.rid ?? '',
          isDelayed: false,
          isCancelled: false,
          delayMinutes: 0,
          exceedsThreshold: false,
          claimEligible: false,
          delayReasons: null,
          detectedAt: new Date(),
          dataNotFound: true,
        });
      }
    }

    return results;
  }

  /**
   * Find delay data for a specific RID
   */
  findDelayByRid(rid: string, delayDataArray: DelayData[]): DelayData | undefined {
    if (!rid) {
      return undefined;
    }

    return delayDataArray.find(d => d.rid === rid);
  }
}
