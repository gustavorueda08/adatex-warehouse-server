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
          filters,
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
          options,
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
    /**
     * Obtiene los items facturables (despachados pero no facturados) para un cliente
     * GET /api/customers/:customerId/invoiceable-items
     */
    async getInvoiceableItems(ctx) {
      try {
        const { customerId } = ctx.params;
        if (!customerId) {
          throw new Error("El id del cliente es requerido");
        }

        const customerService = strapi.service("api::customer.customer");
        const items = await customerService.getInvoiceableItems(customerId);

        return {
          data: items,
          meta: {
            count: items.length,
          },
        };
      } catch (error) {
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            message: error.message,
          },
        });
      }
    },
    /**
     * Retorna el balance de cuentas por cobrar y facturas pendientes para un cliente
     * GET /api/customers/:customerId/accounts-receivable?year=2026&month_start=1&month_end=3
     */
    async getAccountsReceivable(ctx) {
      try {
        const { customerId } = ctx.params;
        const { year, month_start, month_end } = ctx.query;

        const customer = await strapi.entityService.findOne(CUSTOMER_SERVICE, customerId, {
          fields: ["identification", "name", "lastName"],
        });

        if (!customer) return ctx.notFound("Cliente no encontrado");
        if (!customer.identification) {
          return ctx.badRequest("El cliente no tiene NIT/identificación registrado");
        }

        const arService = strapi.service("api::siigo.accounts-receivable");
        const options = {};
        if (year) options.year = parseInt(year);
        if (month_start) options.month_start = parseInt(month_start);
        if (month_end) options.month_end = parseInt(month_end);

        const data = await arService.getCustomerAccountsReceivable(customer.identification, options);

        return {
          data: {
            ...data,
            customerName: `${customer.name || ""} ${customer.lastName || ""}`.trim(),
          },
          meta: {},
        };
      } catch (error) {
        logger.error("Error al obtener cuentas por cobrar:", error);
        return ctx.internalServerError(error.message);
      }
    },

    /**
     * Descarga el reporte de cuentas por cobrar de un cliente (Excel o PDF)
     * GET /api/customers/:customerId/accounts-receivable/download?format=excel|pdf
     */
    async downloadCustomerAccountsReceivable(ctx) {
      try {
        const { customerId } = ctx.params;
        const { format = "excel", year, month_start, month_end } = ctx.query;

        const customer = await strapi.entityService.findOne(CUSTOMER_SERVICE, customerId, {
          fields: ["identification", "name", "lastName"],
        });

        if (!customer) return ctx.notFound("Cliente no encontrado");
        if (!customer.identification) return ctx.badRequest("El cliente no tiene identificación");

        const arService = strapi.service("api::siigo.accounts-receivable");
        const options = {};
        if (year) options.year = parseInt(year);
        if (month_start) options.month_start = parseInt(month_start);
        if (month_end) options.month_end = parseInt(month_end);

        const data = await arService.getCustomerAccountsReceivable(customer.identification, options);
        const customerName = `${customer.name || ""} ${customer.lastName || ""}`.trim();
        const reportData = { ...data, customerName };

        let buffer, contentType, filename;

        if (format === "pdf") {
          buffer = await arService.generateCustomerPdfReport(reportData);
          contentType = "application/pdf";
          filename = `Cartera-${customer.identification}-${new Date().toISOString().slice(0, 10)}.pdf`;
        } else {
          buffer = await arService.generateCustomerExcelReport(reportData);
          contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          filename = `Cartera-${customer.identification}-${new Date().toISOString().slice(0, 10)}.xlsx`;
        }

        ctx.set("Content-Type", contentType);
        ctx.set("Content-Disposition", `attachment; filename="${filename}"`);
        ctx.set("Content-Length", buffer.length);
        ctx.body = buffer;
      } catch (error) {
        logger.error("Error generando descarga de cartera:", error);
        return ctx.internalServerError(error.message);
      }
    },

    async triggerAnalytics(ctx) {
      try {
        logger.info("Analytics manual trigger requested");
        await strapi.service("api::customer.customer").calculateAnalytics();
        return { success: true };
      } catch (err) {
        console.error(err);
        return ctx.internalServerError(err.message);
      }
    }
  }),
);
