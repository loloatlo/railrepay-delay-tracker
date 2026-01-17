/**
 * Darwin Ingestor Client
 *
 * HTTP client for communicating with the darwin-ingestor service
 * Fetches real-time delay information for monitored journeys
 */

import { DarwinDelayInfo } from '../types.js';

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

    const url = `${this.baseUrl}/api/v1/delays`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rids }),
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
}
