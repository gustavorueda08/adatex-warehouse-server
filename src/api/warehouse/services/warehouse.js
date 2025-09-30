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
    async find(id, trx) {
      try {
        if (!id || !trx) throw new Error("El id de la bodega es requerido");
        const warehouse = await strapi.entityService.findOne(
          "api::warehouse.warehouse",
          id,
          {},
          { transacting: trx }
        );
        if (!warehouse) throw new Error("La bodega buscada no existe");
        return warehouse;
      } catch (error) {
        throw error;
      }
    },
    async findMany({ filters = {}, populate = [], trx }) {
      try {
        if (!trx) throw new Error("Se requiere transaccion");
        const warehouses = await strapi.entityService.findMany(
          WAREHOUSE_SERVICE,
          {
            filters,
            populate,
          },
          {
            transacting: trx,
          }
        );
        return warehouses;
      } catch (error) {
        throw error;
      }
    },
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
