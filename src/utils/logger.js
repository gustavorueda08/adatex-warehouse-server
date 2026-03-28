/**
 * @fileoverview Thin logging wrapper used throughout the application.
 *
 * Provides levelled logging methods that mirror those of Strapi's built-in
 * logger so that the two can be swapped without changing call sites.
 * Debug output is suppressed in production.
 *
 * Usage:
 *   const logger = require('../utils/logger');
 *   logger.info('Order created', { orderId: 42 });
 *   logger.error('Failed to sync', err);
 */

const IS_PROD = process.env.NODE_ENV === "production";

const logger = {
  /**
   * Log an informational message.
   * @param {string} message - Human-readable description.
   * @param {Object} [data={}] - Structured context to attach.
   */
  info(message, data = {}) {
    console.log(`[INFO] ${message}`, data);
  },

  /**
   * Log an error. Always emits regardless of environment.
   * @param {string} message - Human-readable description.
   * @param {Error|Object} [error={}] - The error or extra context.
   */
  error(message, error = {}) {
    console.error(`[ERROR] ${message}`, error);
  },

  /**
   * Log a debug message. Suppressed in production.
   * @param {string} message - Human-readable description.
   * @param {Object} [data={}] - Structured context to attach.
   */
  debug(message, data = {}) {
    if (!IS_PROD) {
      console.log(`[DEBUG] ${message}`, data);
    }
  },

  /**
   * Log a warning.
   * @param {string} message - Human-readable description.
   * @param {Object} [data={}] - Structured context to attach.
   */
  warn(message, data = {}) {
    console.warn(`[WARN] ${message}`, data);
  },
};

module.exports = logger;
