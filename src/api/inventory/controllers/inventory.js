const moment = require("moment-timezone");
const { INVENTORY_SERVICE } = require("../../../utils/services");

module.exports = {
  async byWarehouse(ctx) {
    try {
      const inventoryService = strapi.service(INVENTORY_SERVICE);
      const { warehouses = [], isActive = true } = ctx.request.body;
      const inventory = await inventoryService.inventoryByWarehouse({
        warehouses,
        isActive,
      });
      ctx.body = inventory;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
  async byProduct(ctx) {
    try {
      const inventoryService = strapi.service(INVENTORY_SERVICE);
      const data = ctx.request.body;
      const inventory = await inventoryService.inventoryByProduct(data);
      ctx.body = inventory;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
  async getByWarehouse(ctx) {
    try {
      const { warehouseId, productId } = ctx.query;
      const filters = {
        warehouseId: warehouseId ? parseInt(warehouseId) : null,
        productId: productId ? parseInt(productId) : null,
      };
      const inventory = await strapi
        .service(INVENTORY_SERVICE)
        .getInventoryByWarehouse(filters);
      ctx.body = inventory;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
  async getMovements(ctx) {
    try {
      const date = moment.tz.setDefault("America/Bogota");
      const { startDate = null, endDate = null, byProduct = false } = ctx.query;
      let filters = {};
      if (startDate && endDate) {
        filters = {
          $and: [
            { createdAt: { $lte: endDate } },
            { createdAt: { $gte: startDate } },
          ],
        };
      }
      const movements = byProduct
        ? await strapi
            .service(INVENTORY_SERVICE)
            .getMovementsByProduct({ filters })
        : await strapi.service(INVENTORY_SERVICE).getMovements({ filters });
      ctx.status = 200;
      ctx.body = movements;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
  /**
   * GET /api/inventory/summary
   */
  async getSummary(ctx) {
    try {
      const summary = await strapi
        .service("api::inventory.inventory")
        .getInventorySummary();

      ctx.body = {
        data: summary,
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },

  /**
   * GET /api/inventory/reservations
   */
  async getReservations(ctx) {
    try {
      const { warehouseId, productId, customerId } = ctx.query;

      const filters = {
        warehouseId: warehouseId ? parseInt(warehouseId) : null,
        productId: productId ? parseInt(productId) : null,
        customerId: customerId ? parseInt(customerId) : null,
      };

      const reservations = await strapi
        .service("api::inventory.inventory")
        .getActiveReservations(filters);

      ctx.body = {
        data: reservations,
        meta: {
          timestamp: new Date().toISOString(),
          filters,
        },
      };
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },

  /**
   * GET /api/inventory/product/:id/availability
   */
  async getProductAvailability(ctx) {
    try {
      const { id } = ctx.params;
      const { warehouseId } = ctx.query;

      const availability = await strapi
        .service("api::inventory.inventory")
        .getProductAvailability(
          parseInt(id),
          warehouseId ? parseInt(warehouseId) : null
        );

      ctx.body = {
        data: availability,
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
};
