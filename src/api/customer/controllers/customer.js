'use strict';

/**
 * customer controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const logger = require("../../../utils/logger");

module.exports = createCoreController('api::customer.customer', ({ strapi }) => ({
  /**
   * Obtiene el balance de inventario en remisión para un cliente
   * GET /api/customers/:customerId/consignment-balance?product=productId
   */
  async getConsignmentBalance(ctx) {
    try {
      const { customerId } = ctx.params;
      const { product } = ctx.query;

      if (!customerId) {
        throw new Error("El id del cliente es requerido");
      }

      const customerService = strapi.service("api::customer.customer");
      const filters = {};

      if (product) {
        filters.productId = parseInt(product);
      }

      const balance = await customerService.getConsignmentBalance(customerId, filters);

      return {
        data: balance,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al obtener balance de remisión:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ConsignmentBalanceError",
          message: error.message,
          details: process.env.NODE_ENV !== 'production' ? error : undefined,
        },
      });
    }
  },

  /**
   * Obtiene el histórico de despachos y facturaciones para un cliente
   * GET /api/customers/:customerId/consignment-history?startDate=...&endDate=...&product=...&limit=50
   */
  async getConsignmentHistory(ctx) {
    try {
      const { customerId } = ctx.params;
      const { startDate, endDate, product, limit } = ctx.query;

      if (!customerId) {
        throw new Error("El id del cliente es requerido");
      }

      const customerService = strapi.service("api::customer.customer");
      const options = {};

      if (startDate) options.startDate = new Date(startDate);
      if (endDate) options.endDate = new Date(endDate);
      if (product) options.productId = parseInt(product);
      if (limit) options.limit = parseInt(limit);

      const history = await customerService.getConsignmentHistory(customerId, options);

      return {
        data: history,
        meta: {
          count: history.length,
        },
      };
    } catch (error) {
      logger.error("Error al obtener historial de remisión:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ConsignmentHistoryError",
          message: error.message,
          details: process.env.NODE_ENV !== 'production' ? error : undefined,
        },
      });
    }
  },
}));
