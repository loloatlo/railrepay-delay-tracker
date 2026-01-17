/**
 * Journey Matcher Client
 *
 * HTTP client for communicating with the journey-matcher service
 * Fetches journey details including segments with RIDs
 *
 * TD Item: TD-DELAY-001 - Architectural Correction
 * RIDs should be obtained from journey-matcher segments, not from darwin-ingestor.
 */

interface JourneyMatcherClientConfig {
  baseUrl: string;
  timeout?: number;
}

/**
 * Journey segment as returned by journey-matcher service
 */
export interface JourneySegment {
  id: string;
  journey_id: string;
  sequence: number;
  rid: string | null;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  toc_code: string;
}

/**
 * Journey with segments as returned by journey-matcher service
 */
export interface JourneyWithSegments {
  id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  travel_date: string;
  status: string;
  segments: JourneySegment[];
}

export class JourneyMatcherClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: JourneyMatcherClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Get journey with all segments including RIDs
   * Returns null if journey not found (404)
   */
  async getJourneyWithSegments(journeyId: string): Promise<JourneyWithSegments | null> {
    const url = `${this.baseUrl}/api/v1/journeys/${journeyId}/segments`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Journey Matcher API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as JourneyWithSegments;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Journey Matcher API request timeout');
      }
      throw error;
    }
  }

  /**
   * Extract all non-null RIDs from journey segments
   */
  extractRidsFromSegments(segments: JourneySegment[]): string[] {
    return segments
      .filter((segment) => segment.rid !== null)
      .map((segment) => segment.rid as string);
  }

  /**
   * Check if all segments have RIDs resolved
   */
  allSegmentsHaveRids(segments: JourneySegment[]): boolean {
    return segments.every((segment) => segment.rid !== null);
  }
}
