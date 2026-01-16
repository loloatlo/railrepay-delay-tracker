/**
 * Test Fixtures: Darwin Ingestor API Responses
 *
 * Source: RFC-003 Data Contract specification
 * Purpose: Mock responses from darwin-ingestor service for delay data
 *
 * These fixtures represent the expected response format from darwin-ingestor's
 * delay lookup API: GET /api/v1/delays?rids=RID1,RID2&service_date=YYYY-MM-DD
 */

export interface DelayServiceResponse {
  rid: string;
  service_date: string;
  toc_code: string;
  total_delay_minutes: number;
  cancelled: boolean;
  delay_reasons: object | null;
}

export interface DarwinDelaysApiResponse {
  delays: DelayServiceResponse[];
}

/**
 * Response with single delayed service (above threshold)
 */
export const singleDelayedService: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601150800123',
      service_date: '2026-01-15',
      toc_code: 'GR', // LNER (Great Railway)
      total_delay_minutes: 25,
      cancelled: false,
      delay_reasons: { reason: 'Signal failure at Peterborough' },
    },
  ],
};

/**
 * Response with no delays (service on time)
 */
export const noDelays: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601150800123',
      service_date: '2026-01-15',
      toc_code: 'GR',
      total_delay_minutes: 0,
      cancelled: false,
      delay_reasons: null,
    },
  ],
};

/**
 * Response with minor delay (below threshold)
 */
export const minorDelay: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601151000456',
      service_date: '2026-01-15',
      toc_code: 'GW', // Great Western Railway
      total_delay_minutes: 10,
      cancelled: false,
      delay_reasons: { reason: 'Crew changeover delayed' },
    },
  ],
};

/**
 * Response with delay exactly at threshold (15 minutes)
 */
export const delayAtThreshold: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601151100789',
      service_date: '2026-01-15',
      toc_code: 'AW', // Avanti West Coast
      total_delay_minutes: 15,
      cancelled: false,
      delay_reasons: { reason: 'Waiting for late connecting service' },
    },
  ],
};

/**
 * Response with cancelled service
 */
export const cancelledService: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601121600234',
      service_date: '2026-01-12',
      toc_code: 'TP', // TransPennine Express
      total_delay_minutes: 0,
      cancelled: true,
      delay_reasons: { reason: 'Driver shortage' },
    },
  ],
};

/**
 * Response with multiple services (mixed delays)
 */
export const multipleServicesResponse: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601150800123',
      service_date: '2026-01-15',
      toc_code: 'GR',
      total_delay_minutes: 25,
      cancelled: false,
      delay_reasons: { reason: 'Signal failure' },
    },
    {
      rid: '202601151000456',
      service_date: '2026-01-15',
      toc_code: 'GW',
      total_delay_minutes: 5,
      cancelled: false,
      delay_reasons: null,
    },
    {
      rid: '202601151200789',
      service_date: '2026-01-15',
      toc_code: 'AW',
      total_delay_minutes: 45,
      cancelled: false,
      delay_reasons: { reason: 'Earlier trespass incident' },
    },
  ],
};

/**
 * Response with large delay (>60 minutes)
 */
export const largeDelayService: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601150700111',
      service_date: '2026-01-15',
      toc_code: 'XC', // CrossCountry
      total_delay_minutes: 90,
      cancelled: false,
      delay_reasons: {
        reason: 'Infrastructure failure',
        secondary_reason: 'Emergency speed restrictions',
      },
    },
  ],
};

/**
 * Empty response (no matching services found)
 */
export const emptyResponse: DarwinDelaysApiResponse = {
  delays: [],
};

/**
 * Response with null delay_reasons
 */
export const delayWithNullReasons: DarwinDelaysApiResponse = {
  delays: [
    {
      rid: '202601151400222',
      service_date: '2026-01-15',
      toc_code: 'SE', // Southeastern
      total_delay_minutes: 20,
      cancelled: false,
      delay_reasons: null,
    },
  ],
};

export default {
  singleDelayedService,
  noDelays,
  minorDelay,
  delayAtThreshold,
  cancelledService,
  multipleServicesResponse,
  largeDelayService,
  emptyResponse,
  delayWithNullReasons,
};
