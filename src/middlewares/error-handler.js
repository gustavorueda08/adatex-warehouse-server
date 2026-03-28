// src/middlewares/error-handler.js

/**
 * Custom Strapi middleware that sanitizes error responses.
 *
 * Responsibilities:
 * - Strips circular references from Strapi error bodies before they reach the
 *   JSON serializer (which would throw otherwise).
 * - Maps Yup ValidationErrors to a standard 400 shape with per-field details.
 * - Maps known Strapi application errors (ApplicationError, NotFoundError,
 *   ForbiddenError) to their correct HTTP status codes.
 * - Re-throws anything else so Strapi's built-in error handler can deal with it.
 */
module.exports = (config, { strapi }) => {
  return async (ctx, next) => {
    try {
      await next();

      // Sanitize circular references that may appear in Strapi error bodies
      if (ctx.body?.error?.details) {
        try {
          JSON.stringify(ctx.body.error.details);
        } catch {
          // Circular reference detected — rebuild a clean, serializable error body
          const cleanedError = {
            status: ctx.body.error.status || ctx.status,
            name: ctx.body.error.name || "Error",
            message: ctx.body.error.message || "An error occurred",
          };

          if (ctx.body.error.details?.errors) {
            try {
              cleanedError.details = {
                errors: Array.isArray(ctx.body.error.details.errors)
                  ? ctx.body.error.details.errors.map((err) => ({
                      path: err.path,
                      message: err.message,
                      type: err.type,
                    }))
                  : [],
              };
            } catch {
              cleanedError.details = { message: "Validation error" };
            }
          }

          ctx.body = { data: null, error: cleanedError };
        }
      }
    } catch (err) {
      strapi.log.error("Unhandled request error", {
        name: err.name,
        message: err.message,
        status: err.status,
        path: ctx.path,
        method: ctx.method,
      });

      // Yup ValidationError — return field-level detail as 400
      if (err.name === "ValidationError") {
        ctx.status = 400;
        ctx.body = {
          data: null,
          error: {
            status: 400,
            name: "ValidationError",
            message: err.message,
            details: {
              errors: err.inner?.map((e) => ({
                path: e.path,
                message: e.message,
                type: e.type,
              })) ?? [],
            },
          },
        };
        ctx.app.emit("error", err, ctx);
        return;
      }

      // Known Strapi application errors — map to their HTTP status
      if (
        err.name === "ApplicationError" ||
        err.name === "NotFoundError" ||
        err.name === "ForbiddenError"
      ) {
        ctx.status = err.status || 400;
        ctx.body = {
          data: null,
          error: {
            status: ctx.status,
            name: err.name,
            message: err.message,
          },
        };
        return;
      }

      // Unknown error — let Strapi handle it
      throw err;
    }
  };
};
