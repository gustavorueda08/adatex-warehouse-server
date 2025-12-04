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
        fields: ["requestedQuantity", "confirmedQuantity", "state"],
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
    const { pagination: paginationParams, ...otherParams } = params;
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

    // 4. Fetch data using entityService to handle pagination/filters
    const { results, pagination } = await strapi.entityService.findPage(
      SERVICE_UID,
      finalParams
    );

    // 5. Calculate inventory for each product
    const productsWithInventory = results.map((product) => {
      const stats = {
        stock: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
      };

      // Calculate physical stock
      if (product.items?.length > 0) {
        product.items.forEach((item) => {
          if (item.state === "available" && item.warehouse) {
            const qty = Number(item.currentQuantity) || 0;
            if (stats[item.warehouse.type] !== undefined) {
              stats[item.warehouse.type] += qty;
            }
          }
        });
      }

      // Calculate reserved stock (pending orders)
      if (product.orderProducts?.length > 0) {
        product.orderProducts.forEach((op) => {
          if (op.state === "pending") {
            const requested = Number(op.requestedQuantity) || 0;
            const confirmed = Number(op.confirmedQuantity) || 0;
            stats.reserved += Math.max(0, requested - confirmed);
          }
        });
      }

      stats.available = Math.max(0, stats.stock - stats.reserved);

      // 6. Cleanup: Remove inventory relations if not requested by user
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

    return {
      data: productsWithInventory,
      meta: {
        pagination,
      },
    };
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
