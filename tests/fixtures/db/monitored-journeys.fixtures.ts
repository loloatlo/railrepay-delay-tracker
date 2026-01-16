/**
 * Test Fixtures: Monitored Journeys
 *
 * Source: RFC-003 Delay Tracker Schema Design
 * Pattern: Based on darwin_ingestor.delay_services data structure
 * Purpose: Provide realistic test data for delay-tracker service tests
 *
 * NOTE: These fixtures use realistic data patterns from the RailRepay domain.
 * CRS codes and RID formats are based on actual UK rail data conventions.
 */

export interface MonitoredJourneyFixture {
  id?: string;
  user_id: string;
  journey_id: string;
  rid: string | null;
  service_date: string;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  monitoring_status: 'pending_rid' | 'active' | 'delayed' | 'completed' | 'cancelled';
  last_checked_at: string | null;
  next_check_at: string | null;
}

/**
 * Active journey with RID resolved - ready for delay monitoring
 */
export const activeJourneyWithRid: MonitoredJourneyFixture = {
  user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  journey_id: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
  rid: '202601150800123',
  service_date: '2026-01-15',
  origin_crs: 'KGX', // London King's Cross
  destination_crs: 'EDB', // Edinburgh
  scheduled_departure: '2026-01-15T08:00:00Z',
  scheduled_arrival: '2026-01-15T12:30:00Z',
  monitoring_status: 'active',
  last_checked_at: '2026-01-15T08:05:00Z',
  next_check_at: '2026-01-15T08:10:00Z',
};

/**
 * Journey pending RID resolution - scheduled for T-48h
 */
export const pendingRidJourney: MonitoredJourneyFixture = {
  user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  journey_id: 'c3d4e5f6-a7b8-9012-cdef-34567890abcd',
  rid: null,
  service_date: '2026-01-20',
  origin_crs: 'PAD', // London Paddington
  destination_crs: 'BRI', // Bristol Temple Meads
  scheduled_departure: '2026-01-20T10:00:00Z',
  scheduled_arrival: '2026-01-20T11:45:00Z',
  monitoring_status: 'pending_rid',
  last_checked_at: null,
  next_check_at: '2026-01-18T10:00:00Z', // T-48h trigger
};

/**
 * Journey that has been detected as delayed
 */
export const delayedJourney: MonitoredJourneyFixture = {
  user_id: 'd4e5f6a7-b8c9-0123-def0-456789abcdef',
  journey_id: 'd4e5f6a7-b8c9-0123-def0-456789abcdef',
  rid: '202601140900456',
  service_date: '2026-01-14',
  origin_crs: 'MAN', // Manchester Piccadilly
  destination_crs: 'LDS', // Leeds
  scheduled_departure: '2026-01-14T09:00:00Z',
  scheduled_arrival: '2026-01-14T10:00:00Z',
  monitoring_status: 'delayed',
  last_checked_at: '2026-01-14T10:30:00Z',
  next_check_at: null,
};

/**
 * Completed journey - monitoring finished
 */
export const completedJourney: MonitoredJourneyFixture = {
  user_id: 'e5f6a7b8-c9d0-1234-ef01-567890abcdef',
  journey_id: 'e5f6a7b8-c9d0-1234-ef01-567890abcdef',
  rid: '202601130700789',
  service_date: '2026-01-13',
  origin_crs: 'BHM', // Birmingham New Street
  destination_crs: 'EUS', // London Euston
  scheduled_departure: '2026-01-13T07:00:00Z',
  scheduled_arrival: '2026-01-13T08:30:00Z',
  monitoring_status: 'completed',
  last_checked_at: '2026-01-13T09:00:00Z',
  next_check_at: null,
};

/**
 * Cancelled journey
 */
export const cancelledJourney: MonitoredJourneyFixture = {
  user_id: 'f6a7b8c9-d0e1-2345-f012-678901abcdef',
  journey_id: 'f6a7b8c9-d0e1-2345-f012-678901abcdef',
  rid: '202601121600234',
  service_date: '2026-01-12',
  origin_crs: 'GLC', // Glasgow Central
  destination_crs: 'LIV', // Liverpool Lime Street
  scheduled_departure: '2026-01-12T16:00:00Z',
  scheduled_arrival: '2026-01-12T20:30:00Z',
  monitoring_status: 'cancelled',
  last_checked_at: '2026-01-12T15:55:00Z',
  next_check_at: null,
};

/**
 * Multiple journeys for the same user (testing user lookup)
 * Note: user_id must be shared to test findByUserId functionality
 */
export const MULTI_JOURNEY_USER_ID = '11111111-1111-4111-8111-111111111111';

export const multipleJourneysForUser: MonitoredJourneyFixture[] = [
  {
    user_id: MULTI_JOURNEY_USER_ID,
    journey_id: '22222222-2222-4222-8222-222222222201',
    rid: '202601151000111',
    service_date: '2026-01-15',
    origin_crs: 'LDS',
    destination_crs: 'YRK', // York
    scheduled_departure: '2026-01-15T10:00:00Z',
    scheduled_arrival: '2026-01-15T10:25:00Z',
    monitoring_status: 'active',
    last_checked_at: '2026-01-15T10:05:00Z',
    next_check_at: '2026-01-15T10:10:00Z',
  },
  {
    user_id: MULTI_JOURNEY_USER_ID,
    journey_id: '22222222-2222-4222-8222-222222222202',
    rid: '202601151200222',
    service_date: '2026-01-15',
    origin_crs: 'YRK',
    destination_crs: 'NCL', // Newcastle
    scheduled_departure: '2026-01-15T12:00:00Z',
    scheduled_arrival: '2026-01-15T13:00:00Z',
    monitoring_status: 'pending_rid',
    last_checked_at: null,
    next_check_at: '2026-01-15T11:00:00Z',
  },
];

/**
 * Journey due for immediate check (next_check_at in the past)
 */
export const journeyDueForCheck: MonitoredJourneyFixture = {
  user_id: '33333333-3333-4333-8333-333333333333',
  journey_id: '44444444-4444-4444-8444-444444444444',
  rid: '202601150900333',
  service_date: '2026-01-15',
  origin_crs: 'STP', // London St Pancras
  destination_crs: 'NOT', // Nottingham
  scheduled_departure: '2026-01-15T09:00:00Z',
  scheduled_arrival: '2026-01-15T11:00:00Z',
  monitoring_status: 'active',
  last_checked_at: '2026-01-15T08:55:00Z',
  next_check_at: '2026-01-15T09:00:00Z', // Due now
};

/**
 * All fixtures combined for batch tests
 */
export const allMonitoredJourneyFixtures: MonitoredJourneyFixture[] = [
  activeJourneyWithRid,
  pendingRidJourney,
  delayedJourney,
  completedJourney,
  cancelledJourney,
  ...multipleJourneysForUser,
  journeyDueForCheck,
];

export default {
  activeJourneyWithRid,
  pendingRidJourney,
  delayedJourney,
  completedJourney,
  cancelledJourney,
  multipleJourneysForUser,
  MULTI_JOURNEY_USER_ID,
  journeyDueForCheck,
  allMonitoredJourneyFixtures,
};
