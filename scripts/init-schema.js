#!/usr/bin/env node
/**
 * Initialize delay_tracker schema before running migrations
 *
 * This script creates the delay_tracker schema if it doesn't exist.
 * Required because node-pg-migrate's --create-schema flag only works
 * for the target tables, not for the migrations tracking table.
 */

const { Pool } = require('pg');

async function initSchema() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    console.log('[init-schema] Creating delay_tracker schema if not exists...');
    await pool.query('CREATE SCHEMA IF NOT EXISTS delay_tracker');
    console.log('[init-schema] Schema ready');
  } catch (error) {
    console.error('[init-schema] Failed to create schema:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initSchema();
