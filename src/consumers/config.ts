/**
 * TD-DELAY-TRACKER-003: Kafka Consumer Configuration
 *
 * Configuration management for Kafka consumer, including environment
 * variable parsing and validation.
 *
 * Pattern reference: journey-matcher/src/consumers/config.ts
 */

/**
 * Consumer configuration interface
 */
export interface ConsumerConfig {
  serviceName: string;
  brokers: string[];
  username: string;
  password: string;
  groupId: string;
  ssl: boolean;
}

/**
 * Custom error for configuration validation failures
 */
export class ConsumerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerConfigError';
    Object.setPrototypeOf(this, ConsumerConfigError.prototype);
  }
}

/**
 * Required environment variables for Kafka consumer
 */
const REQUIRED_ENV_VARS = [
  'KAFKA_BROKERS',
  'KAFKA_USERNAME',
  'KAFKA_PASSWORD',
  'KAFKA_GROUP_ID',
] as const;

/**
 * Creates consumer configuration from environment variables.
 * Throws ConsumerConfigError if required variables are missing.
 *
 * @returns ConsumerConfig - validated configuration object
 * @throws ConsumerConfigError if required environment variables are missing
 */
export function createConsumerConfig(): ConsumerConfig {
  // Collect all missing variables
  const missingVars: string[] = [];

  for (const envVar of REQUIRED_ENV_VARS) {
    const value = process.env[envVar];
    if (!value || value.trim() === '') {
      missingVars.push(envVar);
    }
  }

  // If any required variables are missing, throw with all missing listed
  if (missingVars.length > 0) {
    if (missingVars.length === 1) {
      throw new ConsumerConfigError(
        `Missing required environment variable: ${missingVars[0]}`
      );
    }
    throw new ConsumerConfigError(
      `Missing required environment variables: ${missingVars.join(', ')}`
    );
  }

  // Parse KAFKA_BROKERS as comma-separated list
  const brokersStr = process.env.KAFKA_BROKERS!;
  const brokers = brokersStr.split(',').map((b) => b.trim()).filter((b) => b.length > 0);

  // Parse SSL setting (default to true)
  const sslEnabled = process.env.KAFKA_SSL_ENABLED;
  const ssl = sslEnabled !== 'false';

  // Get service name (default to delay-tracker)
  const serviceName = process.env.SERVICE_NAME || 'delay-tracker';

  return {
    serviceName,
    brokers,
    username: process.env.KAFKA_USERNAME!,
    password: process.env.KAFKA_PASSWORD!,
    groupId: process.env.KAFKA_GROUP_ID!,
    ssl,
  };
}
