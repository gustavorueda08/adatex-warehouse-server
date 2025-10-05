// src/middlewares/error-handler.js
module.exports = (config, { strapi }) => {
  return async (ctx, next) => {
    console.log("==========================================");
    console.log("🔍 [ERROR-HANDLER] Middleware iniciado");
    console.log("📍 Path:", ctx.path);
    console.log("📍 Method:", ctx.method);
    console.log("==========================================");

    try {
      await next();

      console.log("✅ [ERROR-HANDLER] Next() completado");
      console.log("📊 Status:", ctx.status);
      console.log("📦 Body existe:", !!ctx.body);
      console.log("📦 Body type:", typeof ctx.body);

      // Verificar si hay error en el body
      if (ctx.body && ctx.body.error) {
        console.log("⚠️ [ERROR-HANDLER] Body contiene error");
        console.log("📝 Error name:", ctx.body.error.name);
        console.log("📝 Error message:", ctx.body.error.message);
        console.log("📝 Has details:", !!ctx.body.error.details);

        if (ctx.body.error.details) {
          console.log("🔎 Trying to stringify details...");
          try {
            JSON.stringify(ctx.body.error.details);
            console.log("✅ Details son serializables");
          } catch (stringifyError) {
            console.log("❌ REFERENCIAS CIRCULARES DETECTADAS en details");
            console.log("🔧 Limpiando referencias circulares...");

            // Limpiar el error
            const cleanedError = {
              status: ctx.body.error.status || ctx.status,
              name: ctx.body.error.name || "Error",
              message: ctx.body.error.message || "An error occurred",
            };

            // Intentar extraer errores de validación si existen
            if (ctx.body.error.details.errors) {
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
              } catch (e) {
                console.log("⚠️ No se pudieron extraer errors de details");
                cleanedError.details = { message: "Validation error" };
              }
            }

            ctx.body = {
              data: null,
              error: cleanedError,
            };

            console.log("✅ Error limpiado exitosamente");
          }
        }
      }

      console.log("==========================================");
    } catch (err) {
      console.log("");
      console.log("❌❌❌ [ERROR-HANDLER] Error capturado en catch ❌❌❌");
      console.log("📛 Error name:", err.name);
      console.log("📛 Error message:", err.message);
      console.log("📛 Error status:", err.status);
      console.log("📛 Has inner:", !!err.inner);
      console.log("📛 Has details:", !!err.details);
      console.log("");

      // Log completo del error para debugging
      strapi.log.error("Full error object:", {
        name: err.name,
        message: err.message,
        status: err.status,
      });

      // Manejar ValidationError de Yup
      if (err.name === "ValidationError") {
        console.log("🔧 Manejando ValidationError de Yup");

        ctx.status = 400;
        ctx.body = {
          data: null,
          error: {
            status: 400,
            name: "ValidationError",
            message: err.message,
            details: {
              errors:
                err.inner?.map((e) => {
                  console.log("  - Error path:", e.path, "message:", e.message);
                  return {
                    path: e.path,
                    message: e.message,
                    type: e.type,
                  };
                }) || [],
            },
          },
        };

        console.log("✅ ValidationError limpiado y asignado a ctx.body");
        console.log("==========================================");

        ctx.app.emit("error", err, ctx);
        return;
      }

      // Manejar otros errores de aplicación
      if (
        err.name === "ApplicationError" ||
        err.name === "NotFoundError" ||
        err.name === "ForbiddenError"
      ) {
        console.log("🔧 Manejando", err.name);

        ctx.status = err.status || 400;
        ctx.body = {
          data: null,
          error: {
            status: ctx.status,
            name: err.name,
            message: err.message,
          },
        };

        console.log("✅", err.name, "limpiado y asignado a ctx.body");
        console.log("==========================================");

        return;
      }

      console.log("⚠️ Re-lanzando error no manejado");
      console.log("==========================================");

      // Re-lanzar para que Strapi lo maneje
      throw err;
    }
  };
};
