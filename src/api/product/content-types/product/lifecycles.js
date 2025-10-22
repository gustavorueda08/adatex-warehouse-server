"use strict";

/**
 * Lifecycle callbacks para el content-type Product
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  /**
   * Hook que se ejecuta después de crear un product
   */
  async afterCreate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        console.log(
          `[Product ${result.id}] Sincronización automática deshabilitada`
        );
        return;
      }

      // Si ya tiene siigoId, significa que viene de Siigo (sincronización desde Siigo)
      // No intentar sincronizar de vuelta para evitar loops
      if (result.siigoId) {
        console.log(
          `[Product ${result.id}] Ya tiene siigoId (${result.siigoId}), viene de Siigo. Se omite sincronización.`
        );
        return;
      }

      console.log(
        `[Product ${result.id}] Creado. Iniciando sincronización con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear (fire-and-forget)
      Promise.resolve().then(async () => {
        try {
          const productService = strapi.service("api::siigo.product");
          const syncResult = await productService.createInSiigo(result.id);

          console.log(
            `[Product ${result.id}] Sincronizado con Siigo. ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket para notificar al frontend
          if (strapi.io) {
            strapi.io.to(`product:${result.id}`).emit("product:siigo-synced", {
              productId: result.id,
              siigoId: syncResult.siigoId,
              operation: "create",
            });
          }
        } catch (error) {
          console.error(
            `[Product ${result.id}] Error al sincronizar con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`product:${result.id}`).emit("product:siigo-error", {
              productId: result.id,
              operation: "create",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterCreate:", error.message);
      // No lanzamos el error para no afectar la creación del product
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un product
   */
  async afterUpdate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el product ya tiene siigoId
      if (!result.siigoId) {
        console.log(
          `[Product ${result.id}] No tiene siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Product ${result.id}] Actualizado. Sincronizando cambios con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const productService = strapi.service("api::siigo.product");
          const syncResult = await productService.updateInSiigo(result.id);

          console.log(
            `[Product ${result.id}] Cambios sincronizados con Siigo ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket
          if (strapi.io) {
            strapi.io.to(`product:${result.id}`).emit("product:siigo-synced", {
              productId: result.id,
              siigoId: syncResult.siigoId,
              operation: "update",
            });
          }
        } catch (error) {
          console.error(
            `[Product ${result.id}] Error al sincronizar actualización con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`product:${result.id}`).emit("product:siigo-error", {
              productId: result.id,
              operation: "update",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterUpdate:", error.message);
      // No lanzamos el error para no afectar la actualización del product
    }
  },

  /**
   * Hook que se ejecuta después de eliminar un product
   */
  async afterDelete(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el product tenía siigoId
      if (!result.siigoId) {
        console.log(
          `[Product ${result.id}] No tenía siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Product ${result.id}] Eliminado. Marcando como inactivo en Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const productService = strapi.service("api::siigo.product");
          await productService.deleteInSiigo(result.id);

          console.log(
            `[Product ${result.id}] Marcado como inactivo en Siigo ID: ${result.siigoId}`
          );
        } catch (error) {
          console.error(
            `[Product ${result.id}] Error al marcar como inactivo en Siigo:`,
            error.message
          );
        }
      });
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterDelete:", error.message);
      // No lanzamos el error para no afectar la eliminación del product
    }
  },
};
