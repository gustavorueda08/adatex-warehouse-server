"use strict";

/**
 * Lifecycle callbacks para el content-type Supplier
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  /**
   * Hook que se ejecuta después de crear un supplier
   */
  async afterCreate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        console.log(
          `[Supplier ${result.id}] Sincronización automática deshabilitada`
        );
        return;
      }

      // Si ya tiene siigoId, significa que viene de Siigo (sincronización desde Siigo)
      // No intentar sincronizar de vuelta para evitar loops
      if (result.siigoId) {
        console.log(
          `[Supplier ${result.id}] Ya tiene siigoId (${result.siigoId}), viene de Siigo. Se omite sincronización.`
        );
        return;
      }

      console.log(
        `[Supplier ${result.id}] Creado. Iniciando sincronización con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear (fire-and-forget)
      Promise.resolve().then(async () => {
        try {
          const supplierService = strapi.service("api::siigo.supplier");
          const syncResult = await supplierService.createInSiigo(result.id);

          console.log(
            `[Supplier ${result.id}] Sincronizado con Siigo. ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket para notificar al frontend
          if (strapi.io) {
            strapi.io
              .to(`supplier:${result.id}`)
              .emit("supplier:siigo-synced", {
                supplierId: result.id,
                siigoId: syncResult.siigoId,
                operation: "create",
              });
          }
        } catch (error) {
          console.error(
            `[Supplier ${result.id}] Error al sincronizar con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`supplier:${result.id}`).emit("supplier:siigo-error", {
              supplierId: result.id,
              operation: "create",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error(
        "[Supplier Lifecycle] Error en afterCreate:",
        error.message
      );
      // No lanzamos el error para no afectar la creación del supplier
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un supplier
   */
  async afterUpdate(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el supplier ya tiene siigoId
      if (!result.siigoId) {
        console.log(
          `[Supplier ${result.id}] No tiene siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Supplier ${result.id}] Actualizado. Sincronizando cambios con Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const supplierService = strapi.service("api::siigo.supplier");
          const syncResult = await supplierService.updateInSiigo(result.id);

          console.log(
            `[Supplier ${result.id}] Cambios sincronizados con Siigo ID: ${syncResult.siigoId}`
          );

          // Opcional: Emitir evento WebSocket
          if (strapi.io) {
            strapi.io
              .to(`supplier:${result.id}`)
              .emit("supplier:siigo-synced", {
                supplierId: result.id,
                siigoId: syncResult.siigoId,
                operation: "update",
              });
          }
        } catch (error) {
          console.error(
            `[Supplier ${result.id}] Error al sincronizar actualización con Siigo:`,
            error.message
          );

          // Opcional: Emitir evento de error por WebSocket
          if (strapi.io) {
            strapi.io.to(`supplier:${result.id}`).emit("supplier:siigo-error", {
              supplierId: result.id,
              operation: "update",
              error: error.message,
            });
          }
        }
      });
    } catch (error) {
      console.error(
        "[Supplier Lifecycle] Error en afterUpdate:",
        error.message
      );
      // No lanzamos el error para no afectar la actualización del supplier
    }
  },

  /**
   * Hook que se ejecuta después de eliminar un supplier
   */
  async afterDelete(event) {
    try {
      const { result } = event;

      // Verificar si la sincronización automática está habilitada
      const autoSyncEnabled = process.env.SIIGO_AUTO_SYNC_ENABLED !== "false";

      if (!autoSyncEnabled) {
        return;
      }

      // Solo sincronizar si el supplier tenía siigoId
      if (!result.siigoId) {
        console.log(
          `[Supplier ${result.id}] No tenía siigoId, se omite sincronización`
        );
        return;
      }

      console.log(
        `[Supplier ${result.id}] Eliminado. Marcando como inactivo en Siigo...`
      );

      // Sincronizar de forma asíncrona sin bloquear
      Promise.resolve().then(async () => {
        try {
          const supplierService = strapi.service("api::siigo.supplier");
          await supplierService.deleteInSiigo(result.id);

          console.log(
            `[Supplier ${result.id}] Marcado como inactivo en Siigo ID: ${result.siigoId}`
          );
        } catch (error) {
          console.error(
            `[Supplier ${result.id}] Error al marcar como inactivo en Siigo:`,
            error.message
          );
        }
      });
    } catch (error) {
      console.error(
        "[Supplier Lifecycle] Error en afterDelete:",
        error.message
      );
      // No lanzamos el error para no afectar la eliminación del supplier
    }
  },
};
