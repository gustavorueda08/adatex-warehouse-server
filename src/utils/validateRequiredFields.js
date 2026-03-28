/**
 * @fileoverview Field-presence validation helpers.
 *
 * Lightweight utilities for checking that required keys exist and are
 * non-empty before performing database operations. These are intentionally
 * simple — use Zod schemas (src/validation/schemas/) for structural or
 * type-level validation of incoming HTTP requests.
 */

/**
 * Returns the names of fields that are missing or empty in `obj`.
 *
 * A field is considered missing when its value is `undefined`, `null`, or
 * an empty string `""`.
 *
 * @param {Object} obj - The object to inspect.
 * @param {string[]} requiredFields - Field names that must be present.
 * @returns {string[]} Names of fields that failed the check (empty if all pass).
 * @throws {Error} If `obj` is not a plain object.
 *
 * @example
 * validateRequiredFields({ name: 'ACME' }, ['name', 'email']);
 * // => ['email']
 */
function validateRequiredFields(obj, requiredFields) {
  if (!obj || typeof obj !== "object") {
    throw new Error("El primer parámetro debe ser un objeto válido");
  }

  return requiredFields.filter((field) => {
    const value = obj[field];
    return value === undefined || value === null || value === "";
  });
}

/**
 * Validates required fields and throws if any are missing.
 *
 * @param {Object} [obj={}] - The object to inspect.
 * @param {string[]} [requireFields=[]] - Field names that must be present.
 * @param {string|null} [message=null] - Custom prefix for the error message.
 *   Defaults to "Faltan datos obligatorios:".
 * @throws {Error} Lists all missing fields in the error message.
 *
 * @example
 * validateFields(data, ['customerId', 'total'], 'Orden inválida:');
 * // throws: Error: Orden inválida: customerId, total
 */
function validateFields(obj = {}, requireFields = [], message = null) {
  const missingFields = validateRequiredFields(obj, requireFields);
  if (missingFields.length > 0) {
    throw new Error(
      `${message ?? "Faltan datos obligatorios:"} ${missingFields.join(", ")}`
    );
  }
}

module.exports = { validateRequiredFields, validateFields };
