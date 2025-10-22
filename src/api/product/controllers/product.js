'use strict';

/**
 * product controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const logger = require("../../../utils/logger");

module.exports = createCoreController('api::product.product', ({ strapi }) => ({
  /**
   * Sincroniza todos los products desde Siigo a la base de datos local
   * POST /api/products/sync-from-siigo
   */
  async syncFromSiigo(ctx) {
    try {
      logger.info("Iniciando sincronización de products desde Siigo...");

      const siigoProductService = strapi.service("api::siigo.product");
      const result = await siigoProductService.syncAllFromSiigo();

      logger.info("Sincronización de products completada:", result);

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
      logger.error("Error al sincronizar products desde Siigo:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ProductSyncError",
          message: error.message,
          details: process.env.NODE_ENV !== 'production' ? error : undefined,
        },
      });
    }
  },
}));
