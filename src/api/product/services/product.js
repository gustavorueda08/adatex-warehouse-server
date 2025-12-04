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
    const { page = 1, pageSize = 25, ...query } = params;

    // 1. Obtener products paginados con relaciones necesarias
    const products = await strapi.entityService.findMany(SERVICE_UID, {
      ...query,
      page,
      pageSize,
      populate: {
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
      },
    });

    // Si es paginación offset/limit, strapi devuelve array directo.
    // Si es page/pageSize, devuelve array también en findMany de entityService?
    // EntityService findMany devuelve array. Para paginación necesitamos count.
    
    const total = await strapi.entityService.count(SERVICE_UID, query);
    const pageCount = Math.ceil(total / pageSize);

    // 2. Calcular inventario para cada product
    const productsWithInventory = products.map((product) => {
      const stats = {
        stock: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
      };

      // Calcular stock físico por warehouse type
      if (product.items && product.items.length > 0) {
        product.items.forEach((item) => {
          // Solo sumar items disponibles
          if (item.state === "available" && item.warehouse) {
            const qty = Number(item.currentQuantity) || 0;
            switch (item.warehouse.type) {
              case "stock":
                stats.stock += qty;
                break;
              case "production":
                stats.production += qty;
                break;
              case "transit":
                stats.transit += qty;
                break;
              case "defective":
                stats.defective += qty;
                break;
            }
          }
        });
      }

      // Calcular reservas (OrderProducts pendientes)
      if (product.orderProducts && product.orderProducts.length > 0) {
        product.orderProducts.forEach((op) => {
          if (op.state === "pending") {
            const requested = Number(op.requestedQuantity) || 0;
            const confirmed = Number(op.confirmedQuantity) || 0;
            // Lo que falta por confirmar se considera reserva/demanda pendiente
            stats.reserved += Math.max(0, requested - confirmed);
          }
        });
      }

      // Calcular disponible real
      stats.available = Math.max(0, stats.stock - stats.reserved);

      // Limpiar relaciones pesadas para la respuesta
      const { items, orderProducts, ...productData } = product;

      return {
        ...productData,
        inventory: stats,
      };
    });

    return {
      data: productsWithInventory,
      meta: {
        pagination: {
          page: Number(page),
          pageSize: Number(pageSize),
          pageCount,
          total,
        },
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
