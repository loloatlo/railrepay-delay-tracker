/**
 * Darwin Ingestor Client
 *
 * HTTP client for communicating with the darwin-ingestor service
 * Fetches real-time delay information for monitored journeys
 */

import { DarwinDelayInfo } from '../types.js';
import { stripGtfsPrefix } from '../utils/strip-gtfs-prefix.js';

interface DarwinIngestorClientConfig {
  baseUrl: string;
  timeout?: number;
}

export class DarwinIngestorClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: DarwinIngestorClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Get delay information for multiple RIDs
   */
  async getDelaysByRids(rids: string[]): Promise<DarwinDelayInfo[]> {
    if (rids.length === 0) {
      return [];
    }

    // BL-179: Strip GTFS feed-index prefix (e.g. "1:202603117664795" → "202603117664795")
    // Darwin Ingestor stores bare RIDs; prefixed lookups return empty results.
    // Deduplicate after stripping in case prefix and bare form both appear in input.
    const bareRids = [...new Set(rids.map((rid) => stripGtfsPrefix(rid) as string))];

    const url = `${this.baseUrl}/api/v1/delays`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rids: bareRids }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Darwin API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { services?: DarwinDelayInfo[] };
      return data.services || [];
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Darwin API request timeout');
      }
      throw error;
    }
  }

  /**
   * Get delay information for a single journey
   * Used by journey.confirmed event handler
   */
  async getDelayInfo(params: {
    rid: string;
    service_date: string;
    origin_crs: string;
    destination_crs: string;
  }): Promise<DarwinDelayInfo> {
    // BL-179: Strip GTFS feed-index prefix before querying Darwin Ingestor
    const bareRid = stripGtfsPrefix(params.rid) as string;

    const url = `${this.baseUrl}/api/v1/delays`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rids: [bareRid] }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Darwin API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { services: DarwinDelayInfo[] };

      // If no services found, return zero-delay sentinel
      // BL-179: Use bareRid (stripped) for traceability - the prefix was not meaningful
      if (!data.services || data.services.length === 0) {
        return {
          rid: bareRid,
          delay_minutes: 0,
          is_cancelled: false,
          delay_reasons: null,
        };
      }

      // Return first service
      return data.services[0];
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }
}
