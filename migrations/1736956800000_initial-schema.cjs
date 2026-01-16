/**
 * Initial schema migration for delay-tracker service
 * Creates delay_tracker schema with monitored_journeys, delay_alerts, and outbox tables
 *
 * Per ADR-001: Schema-per-service - delay_tracker owns its own schema
 * Per ADR-003: node-pg-migrate for all migrations
 * Per ADR-007: Transactional outbox pattern
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Step 1: Create schema (REQUIRED per ADR-001)
  pgm.createSchema('delay_tracker', { ifNotExists: true });

  // Table 1: monitored_journeys
  // Stores journeys registered for delay monitoring
  pgm.createTable(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      user_id: {
        type: 'uuid',
        notNull: true,
      },
      journey_id: {
        type: 'uuid',
        notNull: true,
      },
      rid: {
        type: 'varchar(20)',
      },
      service_date: {
        type: 'date',
        notNull: true,
      },
      origin_crs: {
        type: 'varchar(3)',
        notNull: true,
      },
      destination_crs: {
        type: 'varchar(3)',
        notNull: true,
      },
      scheduled_departure: {
        type: 'timestamptz',
        notNull: true,
      },
      scheduled_arrival: {
        type: 'timestamptz',
        notNull: true,
      },
      monitoring_status: {
        type: 'varchar(20)',
        notNull: true,
        default: "'pending_rid'",
        check: "monitoring_status IN ('pending_rid', 'active', 'delayed', 'completed', 'cancelled')",
      },
      last_checked_at: {
        type: 'timestamptz',
      },
      next_check_at: {
        type: 'timestamptz',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    }
  );

  // Add unique constraint on journey_id
  pgm.addConstraint(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'uk_monitored_journeys_journey_id',
    { unique: ['journey_id'] }
  );

  // Create indexes on monitored_journeys
  // Index for cron job: find journeys needing check
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    ['next_check_at'],
    {
      name: 'idx_monitored_journeys_next_check',
      where: "monitoring_status IN ('pending_rid', 'active')",
    }
  );

  // Index for looking up by RID when checking delays
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    ['rid', 'service_date'],
    {
      name: 'idx_monitored_journeys_rid_service_date',
      where: 'rid IS NOT NULL',
    }
  );

  // Index for user's journeys lookup
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    ['user_id'],
    { name: 'idx_monitored_journeys_user_id' }
  );

  // Table 2: delay_alerts
  // Records detected delays and tracks claim trigger status
  pgm.createTable(
    { schema: 'delay_tracker', name: 'delay_alerts' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      monitored_journey_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'delay_tracker', name: 'monitored_journeys' },
        onDelete: 'CASCADE',
      },
      delay_minutes: {
        type: 'integer',
        notNull: true,
        check: 'delay_minutes > 0',
      },
      delay_detected_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      delay_reasons: {
        type: 'jsonb',
      },
      is_cancellation: {
        type: 'boolean',
        notNull: true,
        default: false,
      },
      threshold_exceeded: {
        type: 'boolean',
        notNull: true,
        default: false,
      },
      claim_triggered: {
        type: 'boolean',
        notNull: true,
        default: false,
      },
      claim_triggered_at: {
        type: 'timestamptz',
      },
      claim_reference_id: {
        type: 'varchar(255)',
      },
      claim_trigger_response: {
        type: 'jsonb',
      },
      notification_sent: {
        type: 'boolean',
        notNull: true,
        default: false,
      },
      notification_sent_at: {
        type: 'timestamptz',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    }
  );

  // Create indexes on delay_alerts
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'delay_alerts' },
    ['monitored_journey_id'],
    { name: 'idx_delay_alerts_monitored_journey_id' }
  );

  // Partial index for finding untriggered claims
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'delay_alerts' },
    ['delay_detected_at'],
    {
      name: 'idx_delay_alerts_claim_not_triggered',
      where: 'claim_triggered = false AND delay_minutes >= 15',
    }
  );

  // Table 3: outbox (transactional outbox pattern per ADR-007)
  pgm.createTable(
    { schema: 'delay_tracker', name: 'outbox' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      aggregate_id: {
        type: 'varchar(255)',
        notNull: true,
      },
      aggregate_type: {
        type: 'varchar(100)',
        notNull: true,
      },
      event_type: {
        type: 'varchar(100)',
        notNull: true,
      },
      payload: {
        type: 'jsonb',
        notNull: true,
      },
      correlation_id: {
        type: 'uuid',
      },
      status: {
        type: 'varchar(20)',
        notNull: true,
        default: "'pending'",
        check: "status IN ('pending', 'processing', 'processed', 'published', 'failed')",
      },
      retry_count: {
        type: 'integer',
        notNull: true,
        default: 0,
      },
      error_message: {
        type: 'text',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      processed_at: {
        type: 'timestamptz',
      },
      published_at: {
        type: 'timestamptz',
      },
    }
  );

  // Partial index for pending events (outbox-relay pattern)
  pgm.createIndex(
    { schema: 'delay_tracker', name: 'outbox' },
    ['created_at'],
    {
      name: 'idx_delay_tracker_outbox_pending',
      where: "status = 'pending'",
    }
  );

  // Create trigger function for updated_at
  pgm.createFunction(
    { schema: 'delay_tracker', name: 'update_updated_at_column' },
    [],
    {
      returns: 'TRIGGER',
      language: 'plpgsql',
      replace: true,
    },
    `
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    `
  );

  // Add trigger for monitored_journeys
  pgm.createTrigger(
    { schema: 'delay_tracker', name: 'monitored_journeys' },
    'update_monitored_journeys_updated_at',
    {
      when: 'BEFORE',
      operation: 'UPDATE',
      function: { schema: 'delay_tracker', name: 'update_updated_at_column' },
      level: 'ROW',
    }
  );

  // Add trigger for delay_alerts
  pgm.createTrigger(
    { schema: 'delay_tracker', name: 'delay_alerts' },
    'update_delay_alerts_updated_at',
    {
      when: 'BEFORE',
      operation: 'UPDATE',
      function: { schema: 'delay_tracker', name: 'update_updated_at_column' },
      level: 'ROW',
    }
  );
};

exports.down = async (pgm) => {
  // Drop tables in reverse order (respecting FK dependencies)
  pgm.dropTable({ schema: 'delay_tracker', name: 'outbox' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'delay_tracker', name: 'delay_alerts' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'delay_tracker', name: 'monitored_journeys' }, { ifExists: true, cascade: true });

  // Drop function
  pgm.dropFunction(
    { schema: 'delay_tracker', name: 'update_updated_at_column' },
    [],
    { ifExists: true, cascade: true }
  );

  // Drop schema
  pgm.dropSchema('delay_tracker', { ifExists: true, cascade: true });
};
