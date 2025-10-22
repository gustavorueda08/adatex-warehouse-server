"use strict";

/**
 * Lifecycle callbacks para el content-type Customer
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  /**
   * Hook que se ejecuta después de crear un customer
   */
  async afterCreate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        console.log(
          `[Customer ${result.id}] Sincronización automática deshabilitada`
        );
        return;
      }

      // Si ya tiene siigoId, significa que viene de Siigo (sincronización desde Siigo)
      // No intentar sincronizar de vuelta para evitar loops
      if (result.siigoId) {
        console.log(
          `[Customer ${result.id}] Ya tiene siigoId (${result.siigoId}), viene de Siigo. Se omite sincronización.`
        );
        return;
      }

      console.log(
        `[Customer ${result.id}] Creado. Iniciando sincronización con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear (fire-and-forget)
      Promise.resolve().then(async () => {
        try {
          const customerService = strapi.service("api::siigo.customer");
          const syncResult = await customerService.createInSiigo(result.id);

          console.log(
            `[Customer ${result.id}] Sincronizado con Siigo. ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket para notificar al frontend
          if (strapi.io) {
            strapi.io
              .to(`customer:${result.id}`)
              .emit("customer:siigo-synced", {
                customerId: result.id,
                siigoId: syncResult.siigoId,
                operation: "create",
              });
          }
        } catch (error) {
          console.error(
            `[Customer ${result.id}] Error al sincronizar con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`customer:${result.id}`).emit("customer:siigo-error", {
              customerId: result.id,
              operation: "create",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterCreate:",
        error.message
      );
      // No lanzamos el error para no afectar la creación del customer
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un customer
   */
  async afterUpdate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el customer ya tiene siigoId
      if (!result.siigoId) {
        console.log(
          `[Customer ${result.id}] No tiene siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Customer ${result.id}] Actualizado. Sincronizando cambios con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const customerService = strapi.service("api::siigo.customer");
          const syncResult = await customerService.updateInSiigo(result.id);

          console.log(
            `[Customer ${result.id}] Cambios sincronizados con Siigo ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket
          if (strapi.io) {
            strapi.io
              .to(`customer:${result.id}`)
              .emit("customer:siigo-synced", {
                customerId: result.id,
                siigoId: syncResult.siigoId,
                operation: "update",
              });
          }
        } catch (error) {
          console.error(
            `[Customer ${result.id}] Error al sincronizar actualización con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`customer:${result.id}`).emit("customer:siigo-error", {
              customerId: result.id,
              operation: "update",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterUpdate:",
        error.message
      );
      // No lanzamos el error para no afectar la actualización del customer
    }
  },

  /**
   * Hook que se ejecuta después de eliminar un customer
   */
  async afterDelete(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el customer tenía siigoId
      if (!result.siigoId) {
        console.log(
          `[Customer ${result.id}] No tenía siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Customer ${result.id}] Eliminado. Marcando como inactivo en Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const customerService = strapi.service("api::siigo.customer");
          await customerService.deleteInSiigo(result.id);

          console.log(
            `[Customer ${result.id}] Marcado como inactivo en Siigo ID: ${result.siigoId}`
          );
        } catch (error) {
          console.error(
            `[Customer ${result.id}] Error al marcar como inactivo en Siigo:`,
            error.message
          );
        }
      });
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterDelete:",
        error.message
      );
      // No lanzamos el error para no afectar la eliminación del customer
    }
  },
};
