"use strict";

const { INVENTORY_MOVEMENT_SERVICE } = require("../../../utils/services");
const {
  validateRequiredFields,
  validateFields,
} = require("../../../utils/validateRequiredFields");

/**
 * inventory-movement service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService(
  "api::inventory-movement.inventory-movement",
  ({ strapi }) => ({
    async create(data) {
      try {
        const requireFields = [
          "type",
          "quantity",
          "item",
          "order",
          "trx",
          "balanceBefore",
          "balanceAfter",
        ];
        const missingFields = validateRequiredFields(data, requireFields);
        if (missingFields.length > 0)
          throw new Error(
            `Faltan datos obligatorios para crear el inventory movement: ${missingFields.join(", ")}`
          );
        const { trx, ...movementData } = data;
        const inventoryMovement = await strapi.entityService.create(
          "api::inventory-movement.inventory-movement",
          {
            data: { ...movementData },
          },
          { transacting: trx }
        );
        return inventoryMovement;
      } catch (error) {
        throw error;
      }
    },
    async findMany(data) {
      try {
        const { filters = {}, populate = [], trx } = data;
        let transactingObj = {};
        if (trx) {
          transactingObj = { transacting: trx };
        }
        const inventoryMovements = await strapi.entityService.findMany(
          INVENTORY_MOVEMENT_SERVICE,
          {
            filters,
            populate,
            sort: [{ createdAt: "asc" }],
          },
          transactingObj
        );
        return inventoryMovements;
      } catch (error) {
        throw error;
      }
    },
  })
);
