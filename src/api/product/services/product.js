"use strict";

/**
 * product service
 */

const { createCoreService } = require("@strapi/strapi").factories;

const SERVICE_UID = "api::product.product";

module.exports = createCoreService(SERVICE_UID, ({ strapi }) => ({
  /**
   * Carga masiva de products. Si un item trae id, se actualiza; si no, se crea
   * y se sincroniza con Siigo para obtener siigoId.
   * @param {Array<Object>} products
   * @returns {Object} resumen de la operación
   */
  /**
   * Obtiene products con inventario calculado
   * @param {Object} params - Query params de Strapi
   * @returns {Object} - Resultados paginados con inventario
   */
  /**
   * Helper to calculate inventory for a list of products
   * @param {Array} products
   * @returns {Array} products with inventory
   */
  calculateInventoryForProducts(products, userPopulate = {}) {
    return products.map((product) => {
      const stats = {
        stock: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        available: 0,
        netAvailable: 0,
      };

      // Calculate physical stock (stock, transit, defective, reserved from items)
      if (product.items?.length > 0) {
        product.items.forEach((item) => {
          const qty = Number(item.currentQuantity) || 0;

          // Reserved: items with state 'reserved'
          if (item.state === "reserved") {
            stats.reserved += qty;
          }

          // Warehouse based stats
          if (item.warehouse?.type) {
            if (item.warehouse.type === "stock") {
              stats.stock += qty;
            } else if (item.warehouse.type === "transit") {
              stats.transit += qty;
            } else if (item.warehouse.type === "defective") {
              stats.defective += qty;
            }
          }
        });
      }

      // Calculate production and required from orderProducts
      if (product.orderProducts?.length > 0) {
        product.orderProducts.forEach((op) => {
          const requested = Number(op.requestedQuantity) || 0;

          // Production: items in warehouses of type 'production' (via order destination)
          // "los production son todos los items que estén en warehause de tipo production, PERO, en este caso usamos los orderProducts con su requestedQuantity"
          if (op.order?.destinationWarehouse?.type === "production") {
            stats.production += requested;
          }

          // Required: sale orders with no assigned items
          // "required, lo cual sería todos los orderProducts que sean de ordenes de venta que aún no tengan items asignados"
          if (
            op.order?.type === "sale" &&
            (!op.items || op.items.length === 0)
          ) {
            stats.required += requested;
          }
        });
      }

      // Available: stock - reserved
      stats.available = Math.max(0, stats.stock - stats.reserved);

      // NetAvailable: stock + production + transit - reserved - required
      stats.netAvailable =
        stats.stock +
        stats.production +
        stats.transit -
        stats.reserved -
        stats.required;

      // Cleanup: Remove inventory relations if not requested by user
      const userAskedForItems = userPopulate.items || userPopulate["*"];
      const userAskedForOrderProducts =
        userPopulate.orderProducts || userPopulate["*"];

      const productData = { ...product };

      if (!userAskedForItems) delete productData.items;
      if (!userAskedForOrderProducts) delete productData.orderProducts;

      return {
        ...productData,
        inventory: stats,
      };
    });
  },

  /**
   * Obtiene products con inventario calculado
   * @param {Object} params - Query params de Strapi
   * @returns {Object} - Resultados paginados con inventario
   */
  async findWithInventory(params = {}) {
    // 1. Define required relations for inventory calculation
    const inventoryPopulate = {
      items: {
        fields: ["currentQuantity", "state"],
        populate: {
          warehouse: {
            fields: ["type"],
          },
        },
      },
      orderProducts: {
        fields: ["requestedQuantity", "state"],
        populate: {
          items: {
            fields: ["id"],
          },
          order: {
            fields: ["type"],
            populate: {
              destinationWarehouse: {
                fields: ["type"],
              },
            },
          },
        },
      },
    };

    // 2. Normalize user populate params to object format
    let userPopulate = {};
    const paramPopulate = params.populate;

    if (paramPopulate) {
      if (typeof paramPopulate === "string") {
        if (paramPopulate === "*") {
          userPopulate = { [paramPopulate]: true };
        } else {
          paramPopulate.split(",").forEach((p) => {
            userPopulate[p.trim()] = true;
          });
        }
      } else if (Array.isArray(paramPopulate)) {
        paramPopulate.forEach((p) => {
          if (typeof p === "string") {
            userPopulate[p] = true;
          }
        });
      } else if (typeof paramPopulate === "object") {
        userPopulate = paramPopulate;
      }
    }

    // 3. Merge user params with inventory requirements
    // Extract pagination params if they exist in the nested format (Strapi v4 standard)
    // Also extract 'collections' if present to handle custom filtering
    const {
      pagination: paginationParams,
      collections,
      ...otherParams
    } = params;
    const { page, pageSize } = paginationParams || {};

    const finalParams = {
      ...otherParams,
      // entityService.findPage expects page and pageSize at the root level
      page: page || params.page,
      pageSize: pageSize || params.pageSize,
      // Default sort by name:asc if not provided
      sort: params.sort || "name:asc",
      populate: {
        ...userPopulate,
        ...inventoryPopulate,
        items: {
          ...(userPopulate.items === true ? {} : userPopulate.items || {}),
          ...inventoryPopulate.items,
        },
        orderProducts: {
          ...(userPopulate.orderProducts === true
            ? {}
            : userPopulate.orderProducts || {}),
          ...inventoryPopulate.orderProducts,
        },
      },
    };

    // Handle custom 'collections' filter
    if (collections) {
      finalParams.filters = {
        ...(finalParams.filters || {}),
        collections: {
          id: {
            $in: Array.isArray(collections) ? collections : [collections],
          },
        },
      };
    }

    // 4. Fetch data using entityService to handle pagination/filters
    const { results, pagination } = await strapi.entityService.findPage(
      SERVICE_UID,
      finalParams
    );

    // 5. Calculate inventory using helper
    const productsWithInventory = this.calculateInventoryForProducts(
      results,
      userPopulate
    );

    return {
      data: productsWithInventory,
      meta: {
        pagination,
      },
    };
  },

  /**
   * Obtiene TODOS los productos con inventario, opcionalmente filtrados por colección
   * @param {Object} params - { collection: id }
   * @returns {Array} - Array de productos con inventario
   */
  async findInventoryAll(params = {}) {
    const { collection } = params;

    // 1. Define required relations for inventory calculation
    const inventoryPopulate = {
      items: {
        fields: ["currentQuantity", "state"],
        populate: {
          warehouse: {
            fields: ["type"],
          },
        },
      },
      orderProducts: {
        fields: ["requestedQuantity", "state"],
        populate: {
          items: {
            fields: ["id"],
          },
          order: {
            fields: ["type"],
            populate: {
              destinationWarehouse: {
                fields: ["type"],
              },
            },
          },
        },
      },
    };

    // 2. Build query
    const query = {
      populate: inventoryPopulate,
      sort: "name:asc", // Default sort
    };

    if (collection) {
      query.filters = {
        collections: {
          id: collection,
        },
      };
    }

    // 3. Fetch all data
    const results = await strapi.entityService.findMany(SERVICE_UID, query);

    // 4. Calculate inventory
    // We pass empty userPopulate because for this specific endpoint we only care about inventory
    // and we don't support dynamic populate from client for simplicity/performance in this "all" endpoint
    // unless requested, but requirements said "just return array of products with inventory".
    // So we will strip items/orderProducts by default to keep response clean.
    const productsWithInventory = this.calculateInventoryForProducts(
      results,
      {}
    );

    return productsWithInventory;
  },

  async bulkUpsert(products = []) {
    if (!Array.isArray(products)) {
      throw new Error("products debe ser un array");
    }

    const summary = {
      created: 0,
      updated: 0,
      synced: 0,
      failed: 0,
      items: [],
      total: products.length,
    };

    const siigoProductService = strapi.service("api::siigo.product");

    for (const productInput of products) {
      const itemSummary = {
        inputId: productInput?.id,
      };

      try {
        if (!productInput || typeof productInput !== "object") {
          throw new Error("Cada producto debe ser un objeto");
        }

        const { id, ...data } = productInput;
        let product;

        if (id) {
          product = await strapi.entityService.update(SERVICE_UID, id, {
            data,
          });
          itemSummary.action = "updated";
          summary.updated++;
        } else {
          product = await strapi.entityService.create(SERVICE_UID, { data });
          itemSummary.action = "created";

          const syncResult = await siigoProductService.syncToSiigo(product.id);
          itemSummary.siigoSync = "ok";
          itemSummary.siigoId = syncResult?.siigoId;
          summary.created++;
          summary.synced++;
        }

        itemSummary.id = product.id;
        itemSummary.siigoId = itemSummary.siigoId || product.siigoId;

        summary.items.push(itemSummary);
      } catch (error) {
        summary.failed++;
        summary.items.push({
          ...itemSummary,
          action: itemSummary.action || "failed",
          error: error.message,
        });
      }
    }

    summary.success = summary.failed === 0;

    return summary;
  },
}));
