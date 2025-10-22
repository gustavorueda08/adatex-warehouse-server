'use strict';

/**
 * supplier controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const logger = require("../../../utils/logger");

module.exports = createCoreController('api::supplier.supplier', ({ strapi }) => ({
  /**
   * Sincroniza todos los suppliers desde Siigo a la base de datos local
   * POST /api/suppliers/sync-from-siigo
   */
  async syncFromSiigo(ctx) {
    try {
      logger.info("Iniciando sincronización de suppliers desde Siigo...");

      const siigoSupplierService = strapi.service("api::siigo.supplier");
      const result = await siigoSupplierService.syncAllFromSiigo();

      logger.info("Sincronización de suppliers completada:", result);

      return {
        success: true,
        data: result,
        meta: {
          created: result.created,
          updated: result.updated,
          failed: result.failed,
          total: result.total,
        },
      };
    } catch (error) {
      logger.error("Error al sincronizar suppliers desde Siigo:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "SupplierSyncError",
          message: error.message,
          details: process.env.NODE_ENV !== 'production' ? error : undefined,
        },
      });
    }
  },
}));
