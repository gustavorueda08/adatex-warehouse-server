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
  calculateInventoryForProducts(products, options = {}) {
    const {
      userPopulate = {},
      fromDate: fromDateParam,
      toDate: toDateParam,
    } = options;

    // Normalizar fechas (ignorando hora para comparaciones de inclusión)
    // Si no se envían, se asume rango abierto o lógica por defecto "hoy en adelante" para proyecciones
    // Pero si el usuario no envía nada, ¿qué mostramos? Lo actual + proyecciones futuras?
    // Asumiremos que si no hay fechas, es "current state" (sin proyecciones de required/production/arriving a futuro lejano, o TODO?)
    // Para simplificar: Si no hay rango, mostramos CURRENT actual (reservas actuales, stock actual).
    // Required/Production futuros dependen de fechas. Si no hay rango, ¿mostramos 0 o todo?
    // Mostremos TODO lo pendiente si no hay filtro de fecha.

    const fromDate = fromDateParam ? new Date(fromDateParam) : null;
    const toDate = toDateParam ? new Date(toDateParam) : null;

    // Helper para verificar rango
    const isWithinRange = (dateStr) => {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    };

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
        arriving: 0, // New Metric
      };

      // Calculate physical stock (stock, transit, defective, reserved from items)
      // Esto siempre es "CURRENT" snapshot de los items físicos en DB.
      if (product.items?.length > 0) {
        product.items.forEach((item) => {
          const qty = Number(item.currentQuantity) || 0;

          // Reserved: items with state 'reserved' (Existing physical reservations)
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

      // Calculate future/projected metrics from orderProducts
      if (product.orderProducts?.length > 0) {
        product.orderProducts.forEach((op) => {
          const requested = Number(op.requestedQuantity) || 0;
          const order = op.order;

          if (!order) return;

          // 1. ARRIVING: Purchase orders completed within range
          // items que llegarán (Purchase -> Completed date en rango)
          // OJO: Si la orden ya está completed, sus items YA deberían estar en stock/físico.
          // Arriving suele ser "Incoming".
          // Si la orden es 'purchase' y está en 'confirmed' o 'processing', es lo que esperamos.
          // Si está 'completed', ya son items.
          // Usaremos estimatedCompletedDate para filtrar.

          if (
            order.type === "purchase" &&
            ["confirmed", "processing"].includes(order.state)
          ) {
            // ARRIVING logic
            if (isWithinRange(order.estimatedCompletedDate)) {
              stats.arriving += requested;
            }

            // PRODUCTION logic (Purchase orders in production phase?)
            // Si definimos production como lo que está por llegar/producirse.
            // En tu lógica anterior: op.order?.destinationWarehouse?.type === "production"
            // Mantengamos esa lógica si aplica, o la basada en fechas.
            // Asumiremos:
            // - Arriving: Llega al final (CompletedDate)
            // - Transit: En transito (TransitDate)
            // - Production: En producción?

            // Re-usemos tu lógica anterior combinada con fechas:

            // PRODUCTION
            // Si el destino es producción o fecha encaja
            // (La definición exacta de "production" vs "arriving" puede solaparse si no se define estricto)
            // Usaré la lógica solicitada:
            // "production ... considered if estimatedTransitDate OR estimatedCompletedDate falls within range"
            if (
              isWithinRange(order.estimatedTransitDate) ||
              isWithinRange(order.estimatedCompletedDate)
            ) {
              // Evitar doble conteo si ya está en Arriving?
              // Usualmente metrics son vistas distintas.
              // stats.production += requested;
              // Pero cuidado con sumar al netAvailable duplicado.
              // NetAvailable = stock + arriving - reserved - required. (Production/Transit son informativos o parte de Arriving?)
              // En tu fórmula anterior: Net = stock + production + transit - reserved - required
              // Ahora agregamos Arriving.
              // Vamos a separar roles:
              // Arriving: Lo que entra neto al stock disponible final.
              // Production/Transit: Estados intermedios.
              // Voy a sumar 'Arriving' al NetAvailable.
              // 'Production' y 'Transit' serán informativos filtrados por fecha.

              stats.production += requested;
            }

            // TRANSIT
            if (isWithinRange(order.estimatedTransitDate)) {
              stats.transit += requested;
            }
          }

          // 2. REQUIRED: Sale orders (Demand)
          // Sales with no items assigned yet (pure demand)
          if (order.type === "sale" && (!op.items || op.items.length === 0)) {
            if (isWithinRange(order.estimatedCompletedDate)) {
              stats.required += requested;
            }
          }
        });
      }

      // Available: stock - reserved (Current physical availability)
      stats.available = Math.max(0, stats.stock - stats.reserved);

      // NetAvailable: Projected availability
      // stock (actual) + arriving (futuro entrada) - reserved (físico actual) - required (futuro salida)
      // * Nota: 'transit' y 'production' suelen ser subsets de 'arriving' o etapas previas.
      // Si sumamos todo se duplica. Usaré 'arriving' como la fuente de verdad de entradas futuras en el rango.
      // O si el usuario prefiere la fórmula vieja + arriving?
      // "NetAvailable logic: Updated to stock + arriving - reserved - required for range projections." -> SEGÚN TU PREVIOUS SUMMARY.

      stats.netAvailable =
        stats.stock + stats.arriving - stats.reserved - stats.required;

      // Cleanup
      const userAskedForItems =
        userPopulate.items || userPopulate["*"] || userPopulate.includeItems;
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
   * Helper to calculate inventory for a list of products at a specific date
   * @param {Array} products
   * @param {string} date - ISO date string
   * @returns {Promise<Array>} products with historical inventory
   */
  async calculateHistoricalInventory(products, date) {
    const {
      INVENTORY_MOVEMENT_SERVICE,
      WAREHOUSE_SERVICE,
    } = require("../../../utils/services");
    const {
      IN,
      OUT,
      TRANSFER,
      ADJUSTMENT,
      RESERVE,
      UNRESERVE,
      TRANSFORM,
    } = require("../../../utils/inventoryMovementTypes");

    // 1. Get all product IDs
    const productIds = products.map((p) => p.id);

    if (productIds.length === 0) return products;

    // 2. Fetch all movements for these products up to the date
    // We need to fetch movements for items belonging to these products
    const movements = await strapi.entityService.findMany(
      INVENTORY_MOVEMENT_SERVICE,
      {
        filters: {
          item: {
            product: {
              id: { $in: productIds },
            },
          },
          createdAt: { $lte: date },
        },
        populate: [
          "item",
          "item.product",
          "sourceWarehouse",
          "destinationWarehouse",
          "order",
        ],
        sort: { createdAt: "asc" }, // Process in chronological order
        limit: -1, // Fetch all
      },
    );

    // 3. Fetch all warehouses to know their types
    const warehouses = await strapi.entityService.findMany(
      WAREHOUSE_SERVICE,
      {},
    );
    const warehouseMap = warehouses.reduce((acc, w) => {
      acc[w.id] = w;
      return acc;
    }, {});

    // 4. Reconstruct Item States
    const itemStates = {}; // itemId -> { quantity, warehouseId, state }

    for (const mov of movements) {
      if (!itemStates[mov.item.id]) {
        itemStates[mov.item.id] = {
          quantity: 0,
          warehouseId: null,
          state: "available", // Default start state
          productId: mov.item.product.id,
        };
      }

      const currentItemState = itemStates[mov.item.id];

      // Update Quantity (balanceAfter is reliable for the quantity at that moment)
      // If balanceAfter is null (should not happen for verified movements, but... Use logic if needed)
      // Assuming balanceAfter is populated correctly.
      if (mov.balanceAfter !== null && mov.balanceAfter !== undefined) {
        currentItemState.quantity = Number(mov.balanceAfter);
      } else {
        // Fallback logic if balanceAfter is missing (e.g. legacy data)
        currentItemState.quantity += Number(mov.quantity);
      }

      // Update Warehouse and State
      switch (mov.type) {
        case IN:
        case TRANSFORM: // Transform IN creates new item in dest warehouse
          if (mov.destinationWarehouse) {
            currentItemState.warehouseId = mov.destinationWarehouse.id;
          }
          if (mov.type === IN || (mov.type === TRANSFORM && mov.quantity > 0)) {
            currentItemState.state = "available";
          }
          break;

        case OUT:
          // Item leaves warehouse
          // If pure OUT, warehouse might become null or it effectively disappears from stock
          // But we keep tracking it.
          // currentItemState.warehouseId = null; // Maybe?
          if (mov.balanceAfter <= 0) {
            // Effectively gone/consumed
          }
          // Mapping state based on order type?
          // Usually OUT is final.
          break;

        case TRANSFER:
          if (mov.destinationWarehouse) {
            currentItemState.warehouseId = mov.destinationWarehouse.id;
          }
          break;

        case RESERVE:
          currentItemState.state = "reserved";
          break;

        case UNRESERVE:
          currentItemState.state = "available";
          break;

        // ADJUSTMENT doesn't change warehouse usually, just quantity
      }
    }

    // 5. Aggregate per Product
    const productStats = {}; // productId -> stats object

    productIds.forEach((pid) => {
      productStats[pid] = {
        stock: 0,
        production: 0, // Hard to reconstruct without order history, maybe skip or assume 0
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0, // Hard to reconstruct
        available: 0,
        netAvailable: 0,
      };
    });

    Object.values(itemStates).forEach((itemState) => {
      const stats = productStats[itemState.productId];
      if (!stats) return;

      const qty = itemState.quantity;
      if (qty <= 0) return; // Skip zero/negative quantity items

      // Reserved
      if (itemState.state === "reserved") {
        stats.reserved += qty;
      }

      // Warehouse type stats
      if (itemState.warehouseId && warehouseMap[itemState.warehouseId]) {
        const wType = warehouseMap[itemState.warehouseId].type;
        if (wType === "stock") {
          stats.stock += qty;
        } else if (wType === "transit") {
          stats.transit += qty;
        } else if (wType === "defective") {
          stats.defective += qty;
        }
      }
    });

    // 6. Final Calculation & Return
    return products.map((product) => {
      const stats = productStats[product.id] || {
        stock: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        available: 0,
        netAvailable: 0,
      };

      // Recalculate derived fields
      stats.available = Math.max(0, stats.stock - stats.reserved);
      stats.netAvailable = stats.stock + stats.transit - stats.reserved; // Ignoring production/required for history as they are future/pending

      return {
        ...product,
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
    const {
      pagination: paginationParams,
      collections,
      includeItems,
      date, // Extract date parameter (Historical)
      fromDate, // New: Range start
      toDate, // New: Range end
      ...otherParams
    } = params;

    // Pass includeItems to calculateInventoryForProducts via userPopulate
    if (includeItems === "true" || includeItems === true) {
      userPopulate.includeItems = true;
      inventoryPopulate.items = {
        ...inventoryPopulate.items,
        populate: {
          ...inventoryPopulate.items.populate,
          warehouse: true, // Fetch full warehouse info
        },
        fields: undefined,
      };
    }

    const finalParams = {
      ...otherParams,
      page: paginationParams?.page || params.page,
      pageSize: paginationParams?.pageSize || params.pageSize,
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
      finalParams,
    );

    // 5. Calculate inventory
    let productsWithInventory;
    if (date) {
      // Use historical calculation
      productsWithInventory = await this.calculateHistoricalInventory(
        results,
        date,
      );
    } else {
      // Use current/live calculation with range projection options
      productsWithInventory = this.calculateInventoryForProducts(results, {
        userPopulate,
        fromDate,
        toDate,
      });
    }

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
      {},
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

  /**
   * Obtiene un producto con sus items (que tengan warehouse) y su historial completo de movimientos.
   * @param {Number} productId
   * @returns {Object} Producto con items y movimientos
   */
  async getItemsWithHistory(productId) {
    const serviceUid = "api::product.product";
    const itemServiceUid = "api::item.item";

    // 1. Obtener producto básico
    const product = await strapi.entityService.findOne(serviceUid, productId);
    if (!product) {
      throw new Error("Product not found");
    }

    // 2. Obtener items con warehouse
    // (Usuario solicitó remover historial de movimientos)
    const items = await strapi.entityService.findMany(itemServiceUid, {
      filters: {
        product: productId,
        warehouse: { $not: null }, // Solo items en algún warehouse
      },
      populate: {
        warehouse: {
          fields: ["id", "name", "type"],
        },
      },
    });

    return {
      product,
      items,
    };
  },
}));
