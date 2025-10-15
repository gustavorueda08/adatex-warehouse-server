const moment = require("moment-timezone");
const { INVENTORY_SERVICE } = require("../../../utils/services");
const logger = require("../../../utils/logger");

module.exports = {
  /**
   * GET /api/inventory?type=<operation>
   *
   * Available operations:
   * - by-warehouse: Get inventory by warehouse (params: warehouseId, productId, warehouses[], isActive)
   * - by-product: Get inventory by product (params: productId, warehouseId)
   * - summary: Get inventory summary
   * - reservations: Get active reservations (params: warehouseId, productId, customerId)
   * - availability: Get product availability (params: productId, warehouseId)
   * - movements: Get inventory movements (params: startDate, endDate, byProduct)
   */
  async get(ctx) {
    try {
      // Safely extract type from query params
      console.log(ctx.query);

      const type = ctx.query?.filters?.type?.["$eq"] || ctx.query?.filters.type;
      console.log(type);

      const inventoryService = strapi.service(INVENTORY_SERVICE);

      if (!type) {
        return ctx.badRequest("Parameter 'type' is required", {
          error: {
            status: 400,
            name: "ValidationError",
            message: "Parameter 'type' is required",
          },
        });
      }

      switch (type) {
        case "by-warehouse":
          return await this.handleByWarehouse(ctx, inventoryService);

        case "by-product":
          return await this.handleByProduct(ctx, inventoryService);

        case "summary":
          return await this.handleSummary(ctx, inventoryService);

        case "reservations":
          return await this.handleReservations(ctx, inventoryService);

        case "availability":
          return await this.handleAvailability(ctx, inventoryService);

        case "movements":
          return await this.handleMovements(ctx, inventoryService);

        default:
          return ctx.badRequest(`Invalid type: ${type}`, {
            error: {
              status: 400,
              name: "ValidationError",
              message: `Invalid type: ${type}. Valid types are: by-warehouse, by-product, summary, reservations, availability, movements`,
            },
          });
      }
    } catch (error) {
      logger.error("Error in inventory controller:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "InventoryError",
          message:
            error.message ||
            "An error occurred while processing inventory request",
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  async handleByWarehouse(ctx, inventoryService) {
    const { warehouseId, productId, warehouses, isActive = "true" } = ctx.query;

    let inventory;

    // Si se proporciona warehouses (array), usar el método original
    if (warehouses) {
      const warehouseArray = Array.isArray(warehouses)
        ? warehouses
        : [warehouses];
      inventory = await inventoryService.inventoryByWarehouse({
        warehouses: warehouseArray,
        isActive: isActive === "true",
      });
    } else {
      // Si se proporcionan IDs específicos, usar el método getInventoryByWarehouse
      const filters = {
        warehouseId: warehouseId ? parseInt(warehouseId) : null,
        productId: productId ? parseInt(productId) : null,
      };
      inventory = await inventoryService.getInventoryByWarehouse(filters);
    }

    return {
      data: inventory,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  },

  async handleByProduct(ctx, inventoryService) {
    const { productId, warehouseId } = ctx.query.filters;
    const data = {
      productId: productId ? parseInt(productId) : null,
      warehouseId: warehouseId ? parseInt(warehouseId) : null,
    };
    const inventory = await inventoryService.inventoryByProduct(data);

    return {
      data: inventory,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  },

  async handleSummary(ctx, inventoryService) {
    const summary = await inventoryService.getInventorySummary();

    return {
      data: summary,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  },

  async handleReservations(ctx, inventoryService) {
    const { warehouseId, productId, customerId } = ctx.query;
    const filters = {
      warehouseId: warehouseId ? parseInt(warehouseId) : null,
      productId: productId ? parseInt(productId) : null,
      customerId: customerId ? parseInt(customerId) : null,
    };
    const reservations = await inventoryService.getActiveReservations(filters);

    return {
      data: reservations,
      meta: {
        timestamp: new Date().toISOString(),
        filters,
      },
    };
  },

  async handleAvailability(ctx, inventoryService) {
    const { productId, warehouseId } = ctx.query;

    if (!productId) {
      return ctx.badRequest(
        "Parameter 'productId' is required for availability type",
        {
          error: {
            status: 400,
            name: "ValidationError",
            message: "Parameter 'productId' is required for availability type",
          },
        }
      );
    }

    const availability = await inventoryService.getProductAvailability(
      parseInt(productId),
      warehouseId ? parseInt(warehouseId) : null
    );

    return {
      data: availability,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  },

  async handleMovements(ctx, inventoryService) {
    moment.tz.setDefault("America/Bogota");
    const { startDate = null, endDate = null, byProduct = "false" } = ctx.query;

    let filters = {};
    if (startDate && endDate) {
      filters = {
        $and: [
          { createdAt: { $lte: endDate } },
          { createdAt: { $gte: startDate } },
        ],
      };
    }

    const movements =
      byProduct === "true"
        ? await inventoryService.getMovementsByProduct({ filters })
        : await inventoryService.getMovements({ filters });

    return {
      data: movements,
      meta: {
        timestamp: new Date().toISOString(),
        filters: {
          startDate,
          endDate,
          byProduct: byProduct === "true",
        },
      },
    };
  },
};
