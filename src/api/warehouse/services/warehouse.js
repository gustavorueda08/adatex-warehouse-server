"use strict";

const { WAREHOUSE_SERVICE } = require("../../../utils/services");
const { validateFields } = require("../../../utils/validateRequiredFields");

/**
 * warehouse service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService(
  "api::warehouse.warehouse",
  ({ strapi }) => ({
    async getDefaultWarehouse(trx) {
      try {
        if (!trx) throw new Error("Se requiere transaccion");
        const warehouses = await strapi.entityService.findMany(
          "api::warehouse.warehouse",
          {
            filters: {
              isDefault: true,
            },
          },
          {
            transacting: trx,
          }
        );
        if (warehouses.length === 0)
          throw new Error("No se ha encontrado una bodega por defecto");
        return warehouses[0];
      } catch (error) {
        throw error;
      }
    },
  })
);
