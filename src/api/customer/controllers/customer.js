"use strict";

/**
 * customer controller
 */

const { createCoreController } = require("@strapi/strapi").factories;
const logger = require("../../../utils/logger");
const { CUSTOMER_SERVICE } = require("../../../utils/services");

module.exports = createCoreController(
  "api::customer.customer",
  ({ strapi }) => ({
    /**
     * Obtiene el balance de inventario en remisión para un cliente
     * GET /api/customers/:customerId/consignment-balance?product=productId
     */
    async getConsignmentBalance(ctx) {
      try {
        const { customerId } = ctx.params;
        const { product } = ctx.query;
        console.log(customerId, "IDDIDIDI");

        if (!customerId) {
          throw new Error("El id del cliente es requerido");
        }

        const customerService = strapi.service("api::customer.customer");
        const filters = {};

        if (product) {
          filters.productId = parseInt(product);
        }

        const balance = await customerService.getConsignmentBalance(
          customerId,
          filters
        );

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
            details: process.env.NODE_ENV !== "production" ? error : undefined,
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

        const history = await customerService.getConsignmentHistory(
          customerId,
          options
        );

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
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },

    /**
     * Sincroniza todos los customers desde Siigo a la base de datos local
     * POST /api/customers/sync-from-siigo
     */
    async syncFromSiigo(ctx) {
      try {
        logger.info("Iniciando sincronización de customers desde Siigo...");

        const siigoCustomerService = strapi.service("api::siigo.customer");

        const result = await siigoCustomerService.syncAllFromSiigo();

        logger.info("Sincronización de customers completada:", result);

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
        logger.error("Error al sincronizar customers desde Siigo:", error);
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "CustomerSyncError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },
    async create(ctx) {
      try {
        const customerService = strapi.service(CUSTOMER_SERVICE);
        const data = ctx.request.body;
        if (!data?.data) {
          throw new Error("Los datos del cliente son requeridos");
        }
        const customer = await customerService.create(data.data);
        if (!customer) {
          throw new Error("Error al crear el cliente");
        }
        return {
          data: customer,
          meta: {},
        };
      } catch (error) {
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "CustomerCreateError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },
    async update(ctx) {
      try {
        const customerService = strapi.service(CUSTOMER_SERVICE);
        const { customerId } = ctx.params;
        const data = ctx.request.body;
        console.log("DATOS", data);
        if (!customerId) {
          throw new Error("El id del cliente es requerido");
        }
        if (!data?.data) {
          throw new Error("Los datos del cliente son requeridos");
        }
        const customer = await customerService.update(customerId, data.data);
        if (!customer) {
          throw new Error("Error al actualizar el cliente");
        }
        return {
          data: customer,
          meta: {},
        };
      } catch (error) {
        logger.error("Error al actualizar el cliente:", error);
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "CustomerUpdateError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },
  })
);
