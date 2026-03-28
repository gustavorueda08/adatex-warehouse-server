"use strict";

/**
 * supplier controller
 */

const { createCoreController } = require("@strapi/strapi").factories;
const logger = require("../../../utils/logger");
const { SUPPLIER_SERVICE } = require("../../../utils/services");

module.exports = createCoreController(
  "api::supplier.supplier",
  ({ strapi }) => ({
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
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },

    async create(ctx) {
      try {
        const supplierService = strapi.service(SUPPLIER_SERVICE);
        const data = ctx.request.body;

        if (!data?.data) {
          throw new Error("Los datos del proveedor son requeridos");
        }

        const supplier = await supplierService.create({ data: data.data });

        if (!supplier) {
          throw new Error("Error al crear el proveedor");
        }

        return {
          data: supplier,
          meta: {},
        };
      } catch (error) {
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "SupplierCreateError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },

    async update(ctx) {
      try {
        const supplierService = strapi.service(SUPPLIER_SERVICE);
        const { id } = ctx.params;
        const data = ctx.request.body;

        if (!id) {
          throw new Error("El id del proveedor es requerido");
        }

        if (!data?.data) {
          throw new Error("Los datos del proveedor son requeridos");
        }

        const supplier = await supplierService.update(id, data.data);

        if (!supplier) {
          throw new Error("Error al actualizar el proveedor");
        }

        return {
          data: supplier,
          meta: {},
        };
      } catch (error) {
        logger.error("Error al actualizar el proveedor:", error);
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "SupplierUpdateError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },

    async delete(ctx) {
      try {
        const supplierService = strapi.service(SUPPLIER_SERVICE);
        const { id } = ctx.params;

        if (!id) {
          throw new Error("El id del proveedor es requerido");
        }

        const supplier = await supplierService.delete(id);

        if (!supplier) {
          throw new Error("Error al eliminar el proveedor");
        }

        return {
          data: supplier,
          meta: {},
        };
      } catch (error) {
        logger.error("Error al eliminar el proveedor:", error);
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "SupplierDeleteError",
            message: error.message,
            details: process.env.NODE_ENV !== "production" ? error : undefined,
          },
        });
      }
    },
  }),
);
