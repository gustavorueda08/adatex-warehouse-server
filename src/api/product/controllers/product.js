"use strict";

/**
 * product controller
 */

const { createCoreController } = require("@strapi/strapi").factories;
const logger = require("../../../utils/logger");

module.exports = createCoreController("api::product.product", ({ strapi }) => ({
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
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Carga masiva de products. Si llega id se actualiza, si no se crea y sincroniza siigoId.
   * POST /api/products/bulk-upsert
   */
  /**
   * Obtiene products con inventario calculado
   * GET /api/products/inventory
   */
  async findWithInventory(ctx) {
    try {
      const productService = strapi.service("api::product.product");
      const result = await productService.findWithInventory(ctx.query);

      return result;
    } catch (error) {
      logger.error("Error al obtener inventario de products:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ProductInventoryError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Obtiene TODOS los products con inventario, opcionalmente filtrados por colección
   * GET /api/products/inventory/all
   */
  async findInventoryAll(ctx) {
    try {
      const { collection } = ctx.query;
      const productService = strapi.service("api::product.product");
      const result = await productService.findInventoryAll({ collection });

      return result;
    } catch (error) {
      logger.error("Error al obtener inventario total de products:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ProductInventoryAllError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  async bulkUpsert(ctx) {
    try {
      const { products } = ctx.request.body || {};

      if (!Array.isArray(products)) {
        return ctx.badRequest("El cuerpo debe incluir 'products' como array");
      }

      const productService = strapi.service("api::product.product");
      const result = await productService.bulkUpsert(products);

      return {
        success: result.success,
        data: result,
      };
    } catch (error) {
      logger.error("Error en carga masiva de products:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ProductBulkUpsertError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Obtiene los items de un producto con sus movimientos e historial
   * GET /api/products/:productId/items
   */
  async getItems(ctx) {
    try {
      const { productId } = ctx.params;
      if (!productId) throw new Error("Product ID is required");

      const productService = strapi.service("api::product.product");
      const result = await productService.getItemsWithHistory(productId);

      return {
        data: result,
      };
    } catch (error) {
      logger.error("Error fetching product items:", error);

      if (error.message === "Product not found") {
        return ctx.notFound("Producto no encontrado");
      }

      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ProductItemsError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },
}));
