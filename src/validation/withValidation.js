/**
 * @fileoverview Higher-order function that wraps a service method with Zod validation.
 *
 * Service methods in the order module are schema-validated at the entry point
 * so that downstream code can trust the shape of `data` without adding
 * per-field null-checks.
 *
 * If validation fails, a plain `Error` is thrown with a pipe-delimited list of
 * field paths and messages (e.g. `"products.0.product: Required | state: Invalid"`).
 * The error surfaces to the controller which maps it to a 500 response; if you
 * need a 400 instead, catch and re-throw as an `ApplicationError`.
 *
 * @example
 * ```js
 * const { withValidation } = require('../validation/withValidation');
 * const { CreateOrderSchema } = require('../validation/schemas');
 *
 * const create = withValidation(CreateOrderSchema, async (validatedData) => {
 *   // validatedData is the Zod-parsed, type-safe input
 * });
 * ```
 */

/**
 * Wraps an async handler with Zod schema validation.
 *
 * @template T, R
 * @param {import("zod").ZodSchema<T>} schema - Zod schema to validate against.
 * @param {function(T): Promise<R>} handler - The service function to call with validated data.
 * @returns {function(*): Promise<R>} A new function that validates input before calling the handler.
 * @throws {Error} If validation fails, with a human-readable message of all issues.
 */
const withValidation = (schema, handler) => async (input) => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(" | ");
    throw new Error(message);
  }

  return handler(parsed.data);
};

module.exports = { withValidation };
