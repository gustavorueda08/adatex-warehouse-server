/**
 * @fileoverview Custom application error class.
 *
 * Extends the native Error with an HTTP `status` code and a stable `name`
 * property so that error-handling middleware can inspect it without relying
 * on string matching against the message.
 *
 * Usage:
 *   throw new ApiError(404, 'Order not found');
 *   throw new ApiError(422, 'Insufficient stock');
 */

class ApiError extends Error {
  /**
   * @param {number} [status=500] - HTTP status code to return to the client.
   * @param {string} [message='Error'] - Human-readable error description.
   */
  constructor(status = 500, message = "Error") {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

module.exports = ApiError;
