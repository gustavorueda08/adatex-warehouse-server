"use strict";

/**
 * product service
 */

const { createCoreService } = require("@strapi/strapi").factories;
const compareRelationArrays = require("../../../utils/compareRelationArrays");

const SERVICE_UID = "api::product.product";

module.exports = createCoreService(SERVICE_UID, ({ strapi }) => ({
  /**
   * Creates a new product and handles collections/hideFor associations
   * @param {Object} data
   * @returns {Object} Created product
   */
  async create(data) {
    const {
      collections = [],
      hideFor = [],
      transformationFactors = [],
      productsForCuts = [],
      parentProduct,
      ...rest
    } = data;

    return strapi.db.transaction(async (trx) => {
      const createData = {
        ...rest,
      };

      if (parentProduct) {
        createData.parentProduct =
          typeof parentProduct === "object" ? parentProduct.id : parentProduct;
      }

      if (collections.length > 0) {
        createData.collections = { connect: collections };
      }

      if (hideFor.length > 0) {
        createData.hideFor = { connect: hideFor };
      }

      // Handle on-the-fly TransformationFactors creation/association
      // Since it's Many-to-One from Product -> TransformationFactor, we assume Product links to the FIRST factor in the array logic, or the UI is just sending an array for UI convenience.
      // E.g. If frontend sends `[ { id: 1 }, { name: 'New Factor', factor: 5... } ]`
      // Wait, TransformationFactor is a Many-ToOne relation on Product (a Product has ONE TransformationFactor, a Factor has MANY Products).
      // However, if the user requested sending an array "transformationFactors", we'll process the array. If the schema is Many-to-One, we connect the last processed valid factor.
      let finalFactorId = null;
      if (
        Array.isArray(transformationFactors) &&
        transformationFactors.length > 0
      ) {
        for (const tf of transformationFactors) {
          if (tf.id) {
            // Validate it exists
            const existingTf = await strapi.entityService.findOne(
              "api::transformation-factor.transformation-factor",
              tf.id,
              { transacting: trx },
            );
            if (existingTf) finalFactorId = existingTf.id;
          } else if (
            tf.name &&
            tf.factor &&
            tf.sourceUnit &&
            tf.destinationUnit
          ) {
            // Create it on the fly
            const newTf = await strapi.entityService.create(
              "api::transformation-factor.transformation-factor",
              {
                data: {
                  name: tf.name,
                  sourceUnit: tf.sourceUnit,
                  destinationUnit: tf.destinationUnit,
                  factor: tf.factor,
                },
                transacting: trx,
              },
            );
            finalFactorId = newTf.id;
          }
        }
      }

      if (finalFactorId) {
        createData.transformationFactor = { connect: [finalFactorId] };
      }

      // Handle productsForCuts associations
      // According to schema, productsForCuts is a One-to-Many relation mapped by parentProduct.
      // So if creating THIS product assigns children, we need to connect them.
      if (Array.isArray(productsForCuts) && productsForCuts.length > 0) {
        createData.productsForCuts = {
          connect: productsForCuts
            .map((p) => (typeof p === "object" ? p.id : p))
            .filter(Boolean),
        };
      }

      const newProduct = await strapi.entityService.create(SERVICE_UID, {
        data: createData,
        transacting: trx,
      });

      return newProduct;
    });
  },

  /**
   * Updates a product and handles collections/hideFor associations
   * @param {string|number} id
   * @param {Object} data
   * @returns {Object} Updated product
   */
  async update(id, data) {
    const {
      collections = [],
      hideFor = [],
      transformationFactors = [],
      productsForCuts = [],
      parentProduct,
      ...rest
    } = data;

    return strapi.db.transaction(async (trx) => {
      const currentProduct = await strapi.entityService.findOne(
        SERVICE_UID,
        id,
        {
          populate: [
            "collections",
            "hideFor",
            "transformationFactor",
            "productsForCuts",
          ],
        },
        { transacting: trx },
      );

      if (!currentProduct) {
        throw new Error(`Product with ID ${id} not found`);
      }

      // Handle collections
      const currentCollections =
        currentProduct.collections?.map((c) => c.id) || [];
      const { toAdd: collectionsToAdd, toRemove: collectionsToRemove } =
        compareRelationArrays(currentCollections, collections);

      // Handle hideFor
      const currentHideFor = currentProduct.hideFor?.map((u) => u.id) || [];
      const { toAdd: hideForToAdd, toRemove: hideForToRemove } =
        compareRelationArrays(currentHideFor, hideFor);

      const updateData = {
        ...rest,
        collections: {
          connect: collectionsToAdd,
          disconnect: collectionsToRemove,
        },
        hideFor: {
          connect: hideForToAdd,
          disconnect: hideForToRemove,
        },
      };

      if (parentProduct !== undefined) {
        updateData.parentProduct = parentProduct
          ? typeof parentProduct === "object"
            ? parentProduct.id
            : parentProduct
          : null;
      }

      // Handle on-the-fly TransformationFactors creation/association
      let finalFactorId = null;
      if (
        Array.isArray(transformationFactors) &&
        transformationFactors.length > 0
      ) {
        for (const tf of transformationFactors) {
          if (tf.id) {
            const existingTf = await strapi.entityService.findOne(
              "api::transformation-factor.transformation-factor",
              tf.id,
              { transacting: trx },
            );
            if (existingTf) finalFactorId = existingTf.id;
          } else if (
            tf.name &&
            tf.factor &&
            tf.sourceUnit &&
            tf.destinationUnit
          ) {
            const newTf = await strapi.entityService.create(
              "api::transformation-factor.transformation-factor",
              {
                data: {
                  name: tf.name,
                  sourceUnit: tf.sourceUnit,
                  destinationUnit: tf.destinationUnit,
                  factor: tf.factor,
                },
                transacting: trx,
              },
            );
            finalFactorId = newTf.id;
          }
        }
      }

      if (finalFactorId) {
        // If the product already has one, the API will overwrite it.
        updateData.transformationFactor = { connect: [finalFactorId] };
      }

      const currentProductsForCuts =
        currentProduct.productsForCuts?.map((p) => p.id) || [];
      if (Array.isArray(productsForCuts) && productsForCuts.length > 0) {
        const incomingProductsForCuts = productsForCuts
          .map((p) => (typeof p === "object" ? p.id : p))
          .filter(Boolean);
        const { toAdd: pfcToAdd, toRemove: pfcToRemove } =
          compareRelationArrays(
            currentProductsForCuts,
            incomingProductsForCuts,
          );
        updateData.productsForCuts = {
          connect: pfcToAdd,
          disconnect: pfcToRemove,
        };
      }

      const updatedProduct = await strapi.entityService.update(
        SERVICE_UID,
        id,
        {
          data: updateData,
        },
        { transacting: trx },
      );

      return updatedProduct;
    });
  },

  /**
   * Deletes a product if it doesn't have any order associated
   * @param {string|number} id
   * @param {Object} params
   * @returns {Object} Deleted product
   */
  async delete(id, params) {
    const product = await strapi.entityService.findOne(SERVICE_UID, id, {
      populate: ["orderProducts"],
    });

    if (!product) {
      throw new Error(`Product with ID ${id} not found`);
    }

    if (product.orderProducts && product.orderProducts.length > 0) {
      const { errors } = require("@strapi/utils");
      throw new errors.ApplicationError(
        "No puedes eliminar un producto que tenga órdenes asociadas.",
      );
    }

    const deletedProduct = await strapi.entityService.delete(
      SERVICE_UID,
      id,
      params,
    );
    return deletedProduct;
  },

  /**
   * Deletes all products of type 'cutItem'
   * @returns {Object} Result counts
   */
  async deleteAllCutItems() {
    const products = await strapi.entityService.findMany(SERVICE_UID, {
      filters: { type: "cutItem" },
      populate: ["orderProducts"],
      limit: -1,
    });

    let deleted = 0;
    let failed = 0;

    for (const product of products) {
      try {
        if (product.orderProducts && product.orderProducts.length > 0) {
          failed++;
          continue;
        }
        await strapi.entityService.delete(SERVICE_UID, product.id);
        deleted++;
      } catch (error) {
        strapi.log.error(`Failed to delete cutItem product ${product.id}:`, error);
        failed++;
      }
    }

    return {
      deleted,
      failed,
      total: products.length,
    };
  },

  /**
   * Obtiene products con inventario calculado

   * @param {Object} params - Query params de Strapi
   * @returns {Object} - Resultados paginados con inventario
   */
  /**
   * Helper: builds a breakdown entry from an order + quantity
   */
  _buildBreakdownEntry(order, quantity) {
    const customer = order.customer;
    const supplier = order.supplier;
    return {
      order: order.id,
      orderCode: order.code || null,
      orderType: order.type || null,
      quantity,
      customer: customer
        ? [customer.name, customer.lastName].filter(Boolean).join(" ")
        : null,
      supplier: supplier
        ? [supplier.name, supplier.lastname].filter(Boolean).join(" ")
        : null,
      estimatedCompletedDate: order.estimatedCompletedDate || null,
    };
  },

  /**
   * ─── CURRENT INVENTORY ───
   * Calculates live inventory from items + draft orderProducts.
   * @param {Array} products - Products with populated items and orderProducts
   * @param {Object} options
   * @returns {Array} products with inventory stats
   */
  calculateInventoryForProducts(products, options = {}) {
    const { userPopulate = {} } = options;

    return products.map((product) => {
      const stats = {
        stock: 0,
        smartCut: 0,
        printlab: 0,
        freeTradeZone: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        available: 0,
        netAvailable: 0,
      };
      const breakdown = {
        production: [],
        transit: [],
        required: [],
        freeTradeZone: [],
        reserved: [],
      };

      // ── Items (physical) ──
      // Accumulate physical-item quantities grouped by (sourceOrder.id, wType) so
      // one purchase order does not produce dozens of breakdown rows.
      const sourceOrderGroups = {}; // key: `${sourceOrder.id}_${wType}`

      if (product.items?.length > 0) {
        product.items.forEach((item) => {
          const qty = Number(item.currentQuantity) || 0;
          const wType = item.warehouse?.type;
          if (!wType) return;

          const isStockLike = ["stock", "smartCut", "printlab"].includes(wType);

          if (isStockLike) {
            if (item.state === "available") {
              stats[wType] += qty;
            } else if (item.state === "reserved") {
              // Only consider an item 'reserved' (meaning deducted from available stock)
              // if it's tied to a 'sale' order. If it's for 'transfer' or 'out',
              // it should effectively remain 'available' until the order is completed.
              if (
                !item.order ||
                item.order.type === "sale" ||
                item.order.type === "return"
              ) {
                stats[wType] += qty;
                stats.reserved += qty;
              } else {
                // For transfer or out draft orders, it acts like available stock since it's still there
                stats[wType] += qty;
              }
            }
          } else if (wType === "freeTradeZone") {
            // Zona franca items are tracked separately — NOT included in operational stock
            stats.freeTradeZone += qty;
            // Accumulate for breakdown
            if (item.sourceOrder) {
              const key = `${item.sourceOrder.id}_freeTradeZone`;
              if (!sourceOrderGroups[key]) {
                sourceOrderGroups[key] = {
                  order: item.sourceOrder,
                  qty: 0,
                  wType: "freeTradeZone",
                };
              }
              sourceOrderGroups[key].qty += qty;
            }
          } else if (wType === "production") {
            stats.production += qty;
            if (item.sourceOrder) {
              const key = `${item.sourceOrder.id}_production`;
              if (!sourceOrderGroups[key]) {
                sourceOrderGroups[key] = {
                  order: item.sourceOrder,
                  qty: 0,
                  wType: "production",
                };
              }
              sourceOrderGroups[key].qty += qty;
            }
          } else if (wType === "transit") {
            stats.transit += qty;
            if (item.sourceOrder) {
              const key = `${item.sourceOrder.id}_transit`;
              if (!sourceOrderGroups[key]) {
                sourceOrderGroups[key] = {
                  order: item.sourceOrder,
                  qty: 0,
                  wType: "transit",
                };
              }
              sourceOrderGroups[key].qty += qty;
            }
          } else if (wType === "defective") {
            stats.defective += qty;
          }
        });
      }

      // Push aggregated physical-item entries into the breakdown arrays
      Object.values(sourceOrderGroups).forEach(({ order, qty, wType }) => {
        breakdown[wType].push(this._buildBreakdownEntry(order, qty));
      });

      // ── OrderProducts (draft orders — required/production/transit; confirmed/processing — reserved) ──
      if (product.orderProducts?.length > 0) {
        product.orderProducts.forEach((op) => {
          const requested = Number(op.requestedQuantity) || 0;
          const order = op.order;
          if (!order) return;

          // Confirmed / processing sale orders → reserved breakdown
          if (order.state === "confirmed" || order.state === "processing") {
            const isSourceStockLike = [
              "stock",
              "smartCut",
              "printlab",
            ].includes(order.sourceWarehouse?.type);
            if (order.type === "sale" && isSourceStockLike) {
              breakdown.reserved.push(this._buildBreakdownEntry(order, requested));
            }
            return;
          }

          if (order.state !== "draft") return;

          const entry = this._buildBreakdownEntry(order, requested);

          // Production: draft orders targeting production warehouse
          if (order.destinationWarehouse?.type === "production") {
            stats.production += requested;
            breakdown.production.push(entry);
          }

          // Transit: draft orders targeting transit warehouse
          if (order.destinationWarehouse?.type === "transit") {
            stats.transit += requested;
            breakdown.transit.push(entry);
          }

          // Required: draft sale orders from stock warehouse
          const isSourceStockLike = ["stock", "smartCut", "printlab"].includes(
            order.sourceWarehouse?.type,
          );
          if (order.type === "sale" && isSourceStockLike) {
            stats.required += requested;
            breakdown.required.push(entry);
          }
        });
      }

      // ── Derived metrics ──
      const totalStockLike = stats.stock + stats.smartCut + stats.printlab;
      stats.available = Math.max(0, totalStockLike - stats.reserved);
      stats.netAvailable =
        totalStockLike -
        stats.reserved -
        stats.required +
        stats.production +
        stats.transit;

      // ── Cleanup response ──
      const productData = { ...product };
      const userAskedForItems =
        userPopulate.items || userPopulate["*"] || userPopulate.includeItems;
      const userAskedForOrderProducts =
        userPopulate.orderProducts || userPopulate["*"];
      if (!userAskedForItems) delete productData.items;
      if (!userAskedForOrderProducts) delete productData.orderProducts;

      return { ...productData, inventory: { ...stats, breakdown } };
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

    // Ensure we capture the full day by setting time to end of day
    // This fixes the issue where movements on the same day were excluded if time was 00:00
    // We also account for timezone (approx UTC-5) by extending into the next UTC day
    let queryDate = date;
    const dateObj = new Date(date);
    if (!isNaN(dateObj.getTime())) {
      // Set to 23:59:59.999 + 5 hours buffer for UTC-5
      // This pushes it to approx 04:59:59 of the next day in UTC
      dateObj.setUTCHours(23 + 5, 59, 59, 999);
      queryDate = dateObj.toISOString();
    }

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
          createdAt: { $lte: queryDate },
        },
        populate: {
          item: { populate: { product: { fields: ["id"] } } },
          sourceWarehouse: { fields: ["id"] },
          destinationWarehouse: { fields: ["id"] },
          order: {
            fields: ["code", "type", "estimatedCompletedDate"],
            populate: {
              customer: { fields: ["name", "lastName"] },
            },
          },
        },
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
          orderType: null, // Keep track of the reserving order's type
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
          // We must clear the warehouseId so it doesn't count towards stock/defective/transit
          currentItemState.warehouseId = null;
          // Also reset state from 'reserved' if it was reserved, effectively making it 'gone'
          currentItemState.state = "available";
          break;

        case TRANSFER:
          if (mov.destinationWarehouse) {
            currentItemState.warehouseId = mov.destinationWarehouse.id;
          }
          break;

        case RESERVE:
          currentItemState.state = "reserved";
          if (mov.order) {
            currentItemState.orderType = mov.order.type;
            currentItemState.orderId = mov.order.id;
            currentItemState.orderCode = mov.order.code || null;
            currentItemState.orderCustomer = mov.order.customer || null;
            currentItemState.orderEstDate =
              mov.order.estimatedCompletedDate || null;
          }
          break;

        case UNRESERVE:
          currentItemState.state = "available";
          currentItemState.orderType = null;
          currentItemState.orderId = null;
          currentItemState.orderCode = null;
          currentItemState.orderCustomer = null;
          currentItemState.orderEstDate = null;
          break;

        // ADJUSTMENT doesn't change warehouse usually, just quantity
      }
    }

    // 5. Aggregate per Product - Physical Items (same formulas as Current mode)
    const productStats = {};

    productIds.forEach((pid) => {
      productStats[pid] = {
        stock: 0,
        smartCut: 0,
        printlab: 0,
        freeTradeZone: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        available: 0,
        netAvailable: 0,
      };
    });

    const productBreakdown = {};
    productIds.forEach((pid) => {
      productBreakdown[pid] = {
        production: [],
        transit: [],
        required: [],
        freeTradeZone: [],
        reserved: [],
      };
    });

    Object.values(itemStates).forEach((itemState) => {
      const stats = productStats[itemState.productId];
      if (!stats) return;

      const qty = itemState.quantity;
      if (qty <= 0) return;

      const wType =
        itemState.warehouseId && warehouseMap[itemState.warehouseId]
          ? warehouseMap[itemState.warehouseId].type
          : null;

      const isStockLike = ["stock", "smartCut", "printlab"].includes(wType);

      const bd = productBreakdown[itemState.productId];

      if (isStockLike) {
        if (itemState.state === "available") {
          stats[wType] += qty;
        } else if (itemState.state === "reserved") {
          if (
            !itemState.orderType ||
            itemState.orderType === "sale" ||
            itemState.orderType === "return"
          ) {
            stats[wType] += qty;
            stats.reserved += qty;
            // Build reserved breakdown: group by orderId to avoid one row per item
            if (bd && itemState.orderId) {
              const existing = bd.reserved.find(
                (e) => e.order === itemState.orderId,
              );
              if (existing) {
                existing.quantity += qty;
              } else {
                const customer = itemState.orderCustomer;
                bd.reserved.push({
                  order: itemState.orderId,
                  orderCode: itemState.orderCode,
                  orderType: itemState.orderType,
                  quantity: qty,
                  customer: customer
                    ? [customer.name, customer.lastName]
                        .filter(Boolean)
                        .join(" ")
                    : null,
                  supplier: null,
                  estimatedCompletedDate: itemState.orderEstDate,
                });
              }
            }
          } else {
            stats[wType] += qty;
          }
        }
      } else if (wType === "freeTradeZone") {
        stats.freeTradeZone += qty;
      } else if (wType === "production") {
        stats.production += qty;
      } else if (wType === "transit") {
        stats.transit += qty;
      } else if (wType === "defective") {
        stats.defective += qty;
      }
    });

    // 6. Fetch OrderProducts that were in DRAFT state at queryDate
    const orderProducts = await strapi.entityService.findMany(
      "api::order-product.order-product",
      {
        filters: {
          product: { id: { $in: productIds } },
          order: {
            createdAt: { $lte: queryDate },
            state: { $ne: "cancelled" },
          },
        },
        populate: {
          order: {
            fields: [
              "type",
              "state",
              "code",
              "createdAt",
              "confirmedDate",
              "completedDate",
              "estimatedCompletedDate",
            ],
            populate: {
              sourceWarehouse: { fields: ["type"] },
              destinationWarehouse: { fields: ["type"] },
              customer: { fields: ["name", "lastName"] },
              supplier: { fields: ["name", "lastname"] },
            },
          },
          product: { fields: ["id"] },
        },
        limit: -1,
      },
    );

    const qDate = new Date(queryDate);

    for (const op of orderProducts) {
      if (!op.order) continue;

      // Was this order still in Draft at queryDate?
      const confirmedDate = op.order.confirmedDate
        ? new Date(op.order.confirmedDate)
        : null;
      const completedDate = op.order.completedDate
        ? new Date(op.order.completedDate)
        : null;

      // If confirmed/completed BEFORE or ON queryDate → movements handle it
      if (confirmedDate && confirmedDate <= qDate) continue;
      if (completedDate && completedDate <= qDate) continue;

      const qty = Number(op.requestedQuantity) || 0;
      const productId = op.product?.id;
      const stats = productId ? productStats[productId] : null;
      const bd = productId ? productBreakdown[productId] : null;
      if (!stats) continue;

      const entry = this._buildBreakdownEntry(op.order, qty);

      // Same classification as Current mode:
      if (op.order.destinationWarehouse?.type === "production") {
        stats.production += qty;
        bd?.production.push(entry);
      }
      if (op.order.destinationWarehouse?.type === "transit") {
        stats.transit += qty;
        bd?.transit.push(entry);
      }
      const isSourceStockLike = ["stock", "smartCut", "printlab"].includes(
        op.order.sourceWarehouse?.type,
      );
      if (op.order.type === "sale" && isSourceStockLike) {
        stats.required += qty;
        bd?.required.push(entry);
      }
    }

    // 7. Derived metrics & Return (same formulas as Current mode)
    return products.map((product) => {
      const stats = productStats[product.id] || {
        stock: 0,
        smartCut: 0,
        printlab: 0,
        freeTradeZone: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        available: 0,
        netAvailable: 0,
      };

      const totalStockLike = stats.stock + stats.smartCut + stats.printlab;
      stats.available = Math.max(0, totalStockLike - stats.reserved);
      stats.netAvailable =
        totalStockLike -
        stats.reserved -
        stats.required +
        stats.production +
        stats.transit;

      const breakdown = productBreakdown[product.id] || {
        production: [],
        transit: [],
        required: [],
        freeTradeZone: [],
        reserved: [],
      };

      return { ...product, inventory: { ...stats, breakdown } };
    });
  },

  /**
   * ─── PROJECTED INVENTORY ───
   * Projects inventory into a future date range.
   * Uses current physical state + estimatedCompletedDate/estimatedTransitDate.
   *
   * @param {Array} products - Products with populated items and orderProducts
   * @param {string} fromDate - Range start (ISO string)
   * @param {string} toDate - Range end (ISO string)
   * @returns {Array} products with projected inventory stats
   */
  calculateProjectedInventory(products, fromDate, toDate) {
    const from = new Date(fromDate);
    const to = new Date(toDate);

    // Helper: is dateStr within [from, to]?
    const isWithinRange = (dateStr) => {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      return d >= from && d <= to;
    };

    // Helper: is dateStr after toDate?
    const isAfterRange = (dateStr) => {
      if (!dateStr) return false;
      return new Date(dateStr) > to;
    };

    return products.map((product) => {
      const stats = {
        stock: 0,
        smartCut: 0,
        printlab: 0,
        freeTradeZone: 0,
        production: 0,
        transit: 0,
        defective: 0,
        reserved: 0,
        required: 0,
        arriving: 0,
        available: 0,
        netAvailable: 0,
      };
      const breakdown = {
        production: [],
        transit: [],
        arriving: [],
        required: [],
        freeTradeZone: [],
        reserved: [],
      };

      // ── Items (physical) ──
      // Accumulate physical-item quantities grouped by (sourceOrder.id, bucket) to
      // avoid one breakdown row per item.
      const sourceOrderGroupsProj = {}; // key: `${sourceOrder.id}_${bucket}`

      if (product.items?.length > 0) {
        product.items.forEach((item) => {
          const qty = Number(item.currentQuantity) || 0;
          const wType = item.warehouse?.type;
          if (!wType) return;

          const sourceOrder = item.sourceOrder;
          const estCompleted = sourceOrder?.estimatedCompletedDate;
          const estTransit = sourceOrder?.estimatedTransitDate;

          const isStockLike = ["stock", "smartCut", "printlab"].includes(wType);

          if (isStockLike) {
            if (item.state === "available") {
              stats[wType] += qty;
            } else if (item.state === "reserved") {
              if (
                !item.order ||
                item.order.type === "sale" ||
                item.order.type === "return"
              ) {
                stats[wType] += qty;
                stats.reserved += qty;
              } else {
                stats[wType] += qty;
              }
            }
          } else if (wType === "freeTradeZone") {
            stats.freeTradeZone += qty;
            if (sourceOrder) {
              const key = `${sourceOrder.id}_freeTradeZone`;
              if (!sourceOrderGroupsProj[key]) {
                sourceOrderGroupsProj[key] = {
                  order: sourceOrder,
                  qty: 0,
                  bucket: "freeTradeZone",
                };
              }
              sourceOrderGroupsProj[key].qty += qty;
            }
          } else if (wType === "production") {
            if (isWithinRange(estCompleted)) {
              stats.arriving += qty;
              if (sourceOrder) {
                const key = `${sourceOrder.id}_arriving`;
                if (!sourceOrderGroupsProj[key]) {
                  sourceOrderGroupsProj[key] = {
                    order: sourceOrder,
                    qty: 0,
                    bucket: "arriving",
                  };
                }
                sourceOrderGroupsProj[key].qty += qty;
              }
            } else if (isWithinRange(estTransit)) {
              stats.transit += qty;
              if (sourceOrder) {
                const key = `${sourceOrder.id}_transit`;
                if (!sourceOrderGroupsProj[key]) {
                  sourceOrderGroupsProj[key] = {
                    order: sourceOrder,
                    qty: 0,
                    bucket: "transit",
                  };
                }
                sourceOrderGroupsProj[key].qty += qty;
              }
            } else if (isAfterRange(estCompleted)) {
              stats.production += qty;
              if (sourceOrder) {
                const key = `${sourceOrder.id}_production`;
                if (!sourceOrderGroupsProj[key]) {
                  sourceOrderGroupsProj[key] = {
                    order: sourceOrder,
                    qty: 0,
                    bucket: "production",
                  };
                }
                sourceOrderGroupsProj[key].qty += qty;
              }
            }
          } else if (wType === "transit") {
            if (isWithinRange(estCompleted)) {
              stats.arriving += qty;
              if (sourceOrder) {
                const key = `${sourceOrder.id}_arriving`;
                if (!sourceOrderGroupsProj[key]) {
                  sourceOrderGroupsProj[key] = {
                    order: sourceOrder,
                    qty: 0,
                    bucket: "arriving",
                  };
                }
                sourceOrderGroupsProj[key].qty += qty;
              }
            } else if (isAfterRange(estCompleted)) {
              stats.transit += qty;
              if (sourceOrder) {
                const key = `${sourceOrder.id}_transit`;
                if (!sourceOrderGroupsProj[key]) {
                  sourceOrderGroupsProj[key] = {
                    order: sourceOrder,
                    qty: 0,
                    bucket: "transit",
                  };
                }
                sourceOrderGroupsProj[key].qty += qty;
              }
            }
          } else if (wType === "defective") {
            stats.defective += qty;
          }
        });
      }

      // Push aggregated physical-item entries into the breakdown arrays
      Object.values(sourceOrderGroupsProj).forEach(({ order, qty, bucket }) => {
        breakdown[bucket].push(this._buildBreakdownEntry(order, qty));
      });

      // ── OrderProducts (draft + confirmed/processing for reserved) ──
      if (product.orderProducts?.length > 0) {
        product.orderProducts.forEach((op) => {
          const requested = Number(op.requestedQuantity) || 0;
          const order = op.order;
          if (!order) return;

          // Confirmed / processing sale orders → reserved breakdown
          if (order.state === "confirmed" || order.state === "processing") {
            const isSourceStockLike = [
              "stock",
              "smartCut",
              "printlab",
            ].includes(order.sourceWarehouse?.type);
            if (order.type === "sale" && isSourceStockLike) {
              breakdown.reserved.push(this._buildBreakdownEntry(order, requested));
            }
            return;
          }

          if (order.state !== "draft") return;

          const estCompleted = order.estimatedCompletedDate;
          const estTransit = order.estimatedTransitDate;
          const destType = order.destinationWarehouse?.type;
          const entry = this._buildBreakdownEntry(order, requested);

          // ── Purchase orders: mutually exclusive states ──
          if (
            order.type === "purchase" &&
            (destType === "production" || destType === "transit")
          ) {
            if (isWithinRange(estCompleted)) {
              stats.arriving += requested;
              breakdown.arriving.push(entry);
            } else if (isWithinRange(estTransit)) {
              stats.transit += requested;
              breakdown.transit.push(entry);
            } else if (isAfterRange(estCompleted)) {
              if (destType === "production") {
                stats.production += requested;
                breakdown.production.push(entry);
              } else if (destType === "transit") {
                stats.transit += requested;
                breakdown.transit.push(entry);
              }
            }
          }

          // ── Sale orders: required ──
          const isSourceStockLike = ["stock", "smartCut", "printlab"].includes(
            order.sourceWarehouse?.type,
          );
          if (
            order.type === "sale" &&
            isSourceStockLike &&
            isWithinRange(estCompleted)
          ) {
            stats.required += requested;
            breakdown.required.push(entry);
          }
        });
      }

      // ── Derived metrics ──
      const totalStockLike = stats.stock + stats.smartCut + stats.printlab;
      stats.available = Math.max(
        0,
        totalStockLike - stats.reserved + stats.arriving,
      );
      stats.netAvailable =
        totalStockLike +
        stats.arriving -
        stats.reserved -
        stats.required +
        stats.production +
        stats.transit;

      // ── Cleanup ──
      const productData = { ...product };
      delete productData.items;
      delete productData.orderProducts;

      return { ...productData, inventory: { ...stats, breakdown } };
    });
  },

  /**
   * Obtiene products con inventario calculado
   * Modes:
   *   - No date params → Current inventory
   *   - date → Historical inventory (reconstructed via movements)
   *   - fromDate + toDate → Projected inventory
   *
   * @param {Object} params - Query params de Strapi
   * @returns {Object} - Resultados paginados con inventario
   */
  async findWithInventory(params = {}) {
    // 1. Define required relations for inventory calculation.
    //    Items are intentionally excluded from inventoryPopulate here — they are loaded
    //    via raw SQL JOINs below to avoid SQLite's bind-variable limit when a
    //    fixedQuantityPerItem product has tens of thousands of items.
    //    (Strapi ORM batches relation loading as WHERE item_id IN (...all IDs...) which
    //    crashes SQLite when there are > ~999 items across all loaded products.)
    const inventoryPopulate = {
      orderProducts: {
        fields: ["requestedQuantity", "state"],
        populate: {
          order: {
            fields: [
              "type",
              "state",
              "code",
              "estimatedCompletedDate",
              "estimatedTransitDate",
            ],
            populate: {
              sourceWarehouse: {
                fields: ["type"],
              },
              destinationWarehouse: {
                fields: ["type"],
              },
              customer: {
                fields: ["name", "lastName"],
              },
              supplier: {
                fields: ["name", "lastname"],
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

    // 3. Extract pagination and special params
    const {
      pagination: paginationParams,
      collections,
      includeItems,
      hideZeroStock,
      date, // Historical mode
      fromDate, // Projection mode start
      toDate, // Projection mode end
      ...otherParams
    } = params;

    // Pass includeItems to calculation via userPopulate
    if (includeItems === "true" || includeItems === true) {
      userPopulate.includeItems = true;
      inventoryPopulate.items = {
        ...inventoryPopulate.items,
        populate: {
          ...inventoryPopulate.items.populate,
          warehouse: true,
        },
        fields: undefined,
      };
    }

    const page = parseInt(paginationParams?.page || params.page) || 1;
    const pageSize = parseInt(paginationParams?.pageSize || params.pageSize) || 25;

    const baseFilters = { ...(otherParams.filters || {}) };

    if (collections) {
      baseFilters.collections = {
        id: {
          $in: Array.isArray(collections) ? collections : [collections],
        },
      };
    }

    const mergedPopulate = {
      ...userPopulate,
      // items are intentionally excluded — loaded via raw SQL below
      orderProducts: {
        ...(userPopulate.orderProducts === true
          ? {}
          : userPopulate.orderProducts || {}),
        ...inventoryPopulate.orderProducts,
      },
    };

    // 4. Load ALL matching products with inventory relations (no items — loaded below).
    const allProducts = await strapi.entityService.findMany(SERVICE_UID, {
      ...otherParams,
      filters: baseFilters,
      sort: otherParams.sort || params.sort || "name:asc",
      populate: mergedPopulate,
    });

    // 4b. Attach items to each product via raw SQL JOINs, avoiding Strapi's
    //     "WHERE item_id IN (...all IDs...)" pattern that crashes SQLite when a
    //     fixedQuantityPerItem product has tens of thousands of items.
    if (allProducts.length > 0) {
      const knex = strapi.db.connection;

      // Separate fixed vs normal products
      const fixedIds = allProducts
        .filter((p) => p.type === "fixedQuantityPerItem")
        .map((p) => p.id);
      const normalIds = allProducts
        .filter((p) => p.type !== "fixedQuantityPerItem")
        .map((p) => p.id);

      // Build a map for quick access: productId → product object
      const productMap = new Map(allProducts.map((p) => [p.id, p]));
      // Initialise items array on every product
      allProducts.forEach((p) => { p.items = []; });

      // --- Fixed products: COUNT(*) aggregated by (product_id, state, warehouse_type) ---
      if (fixedIds.length > 0) {
        const fixedRows = await knex("items as i")
          .select(
            "ipl.product_id",
            "i.state",
            knex.raw("w.type as wtype"),
            knex.raw("COUNT(*) as cnt"),
          )
          .join("items_product_lnk as ipl", "ipl.item_id", "i.id")
          .leftJoin("items_warehouse_lnk as iwl", "iwl.item_id", "i.id")
          .leftJoin("warehouses as w", "w.id", "iwl.warehouse_id")
          .whereIn("ipl.product_id", fixedIds)
          .groupBy("ipl.product_id", "i.state", "w.type");

        fixedRows.forEach((row) => {
          const product = productMap.get(row.product_id);
          if (!product) return;
          const qty = Number(row.cnt) * (product.unitsPerPackage || 1);
          product.items.push({
            state: row.state,
            currentQuantity: qty,
            warehouse: row.wtype ? { type: row.wtype } : null,
            sourceOrder: null,
          });
        });
      }

      // --- Normal products: full item rows with warehouse + sourceOrder via JOINs ---
      if (normalIds.length > 0) {
        const normalRows = await knex("items as i")
          .select(
            "ipl.product_id",
            "i.state",
            knex.raw("i.current_quantity as current_quantity"),
            knex.raw("w.type as wtype"),
            knex.raw("so.id as so_id"),
            knex.raw("so.code as so_code"),
            knex.raw("so.type as so_type"),
            knex.raw("so.estimated_completed_date as so_ecd"),
            knex.raw("so.estimated_transit_date as so_etd"),
            knex.raw("dw.type as dest_wtype"),
            knex.raw("sup.name as sup_name"),
            knex.raw("sup.lastname as sup_lastname"),
          )
          .join("items_product_lnk as ipl", "ipl.item_id", "i.id")
          .leftJoin("items_warehouse_lnk as iwl", "iwl.item_id", "i.id")
          .leftJoin("warehouses as w", "w.id", "iwl.warehouse_id")
          .leftJoin("items_source_order_lnk as isol", "isol.item_id", "i.id")
          .leftJoin("orders as so", "so.id", "isol.order_id")
          .leftJoin(
            "orders_destination_warehouse_lnk as odwl",
            "odwl.order_id",
            "so.id",
          )
          .leftJoin("warehouses as dw", "dw.id", "odwl.warehouse_id")
          .leftJoin("orders_supplier_lnk as osl", "osl.order_id", "so.id")
          .leftJoin("suppliers as sup", "sup.id", "osl.supplier_id")
          .whereIn("ipl.product_id", normalIds);

        normalRows.forEach((row) => {
          const product = productMap.get(row.product_id);
          if (!product) return;
          product.items.push({
            state: row.state,
            currentQuantity: Number(row.current_quantity) || 0,
            warehouse: row.wtype ? { type: row.wtype } : null,
            sourceOrder: row.so_id
              ? {
                  id: row.so_id,
                  code: row.so_code,
                  type: row.so_type,
                  estimatedCompletedDate: row.so_ecd,
                  estimatedTransitDate: row.so_etd,
                  destinationWarehouse: row.dest_wtype
                    ? { type: row.dest_wtype }
                    : null,
                  supplier:
                    row.sup_name || row.sup_lastname
                      ? { name: row.sup_name, lastname: row.sup_lastname }
                      : null,
                }
              : null,
          });
        });
      }

    }

    // 5. Calculate inventory based on mode
    let allWithInventory;
    if (date) {
      allWithInventory = await this.calculateHistoricalInventory(
        allProducts,
        date,
      );
    } else if (fromDate && toDate) {
      allWithInventory = this.calculateProjectedInventory(
        allProducts,
        fromDate,
        toDate,
      );
    } else {
      allWithInventory = this.calculateInventoryForProducts(allProducts, {
        userPopulate,
      });
    }

    // 6. Optionally filter out products with all-zero inventory stats (default: on)
    const shouldHide = hideZeroStock !== "false" && hideZeroStock !== false;
    const filtered = shouldHide
      ? allWithInventory.filter((p) => {
          const inv = p.inventory;
          if (!inv) return false;
          return (
            (inv.stock || 0) > 0 ||
            (inv.smartCut || 0) > 0 ||
            (inv.printlab || 0) > 0 ||
            (inv.freeTradeZone || 0) > 0 ||
            (inv.production || 0) > 0 ||
            (inv.transit || 0) > 0 ||
            (inv.defective || 0) > 0 ||
            (inv.reserved || 0) > 0 ||
            (inv.required || 0) > 0 ||
            (inv.netAvailable || 0) !== 0 ||
            (inv.arriving || 0) > 0
          );
        })
      : allWithInventory;

    // 7. Paginate the filtered results
    const total = filtered.length;
    const pageCount = Math.ceil(total / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const paginatedProducts = filtered.slice(start, start + pageSize);

    return {
      data: paginatedProducts,
      meta: {
        pagination: { page, pageSize, pageCount, total },
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

    // 1. Build query (items loaded via raw SQL below — see findWithInventory for rationale)
    const query = {
      populate: {
        orderProducts: {
          fields: ["requestedQuantity", "state"],
          populate: {
            order: {
              fields: ["type"],
              populate: {
                destinationWarehouse: { fields: ["type"] },
              },
            },
          },
        },
      },
      sort: "name:asc",
    };

    if (collection) {
      query.filters = { collections: { id: collection } };
    }

    // 2. Fetch all products (without items)
    const results = await strapi.entityService.findMany(SERVICE_UID, query);

    // 3. Attach items via raw SQL JOINs to avoid SQLite variable limit
    if (results.length > 0) {
      const knex = strapi.db.connection;
      const productMap = new Map(results.map((p) => [p.id, p]));
      results.forEach((p) => { p.items = []; });

      const fixedIds = results.filter((p) => p.type === "fixedQuantityPerItem").map((p) => p.id);
      const normalIds = results.filter((p) => p.type !== "fixedQuantityPerItem").map((p) => p.id);

      if (fixedIds.length > 0) {
        const rows = await knex("items as i")
          .select("ipl.product_id", "i.state", knex.raw("w.type as wtype"), knex.raw("COUNT(*) as cnt"))
          .join("items_product_lnk as ipl", "ipl.item_id", "i.id")
          .leftJoin("items_warehouse_lnk as iwl", "iwl.item_id", "i.id")
          .leftJoin("warehouses as w", "w.id", "iwl.warehouse_id")
          .whereIn("ipl.product_id", fixedIds)
          .groupBy("ipl.product_id", "i.state", "w.type");

        rows.forEach((row) => {
          const product = productMap.get(row.product_id);
          if (!product) return;
          product.items.push({
            state: row.state,
            currentQuantity: Number(row.cnt) * (product.unitsPerPackage || 1),
            warehouse: row.wtype ? { type: row.wtype } : null,
            sourceOrder: null,
          });
        });
      }

      if (normalIds.length > 0) {
        const rows = await knex("items as i")
          .select(
            "ipl.product_id", "i.state",
            knex.raw("i.current_quantity as current_quantity"),
            knex.raw("w.type as wtype"),
          )
          .join("items_product_lnk as ipl", "ipl.item_id", "i.id")
          .leftJoin("items_warehouse_lnk as iwl", "iwl.item_id", "i.id")
          .leftJoin("warehouses as w", "w.id", "iwl.warehouse_id")
          .whereIn("ipl.product_id", normalIds);

        rows.forEach((row) => {
          const product = productMap.get(row.product_id);
          if (!product) return;
          product.items.push({
            state: row.state,
            currentQuantity: Number(row.current_quantity) || 0,
            warehouse: row.wtype ? { type: row.wtype } : null,
            sourceOrder: null,
          });
        });
      }
    }

    // 4. Calculate inventory
    const productsWithInventory = this.calculateInventoryForProducts(results, {});

    return productsWithInventory.filter((p) => {
      const inv = p.inventory;
      return (
        inv.stock > 0 ||
        inv.smartCut > 0 ||
        inv.printlab > 0 ||
        inv.freeTradeZone > 0 ||
        inv.production > 0 ||
        inv.transit > 0 ||
        inv.defective > 0 ||
        inv.reserved > 0 ||
        inv.required > 0 ||
        inv.available > 0 ||
        inv.netAvailable !== 0
      );
    });
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

        const {
          id,
          collections,
          hideFor,
          transformationFactors,
          productsForCuts,
          parentProduct,
          ...restData
        } = productInput;
        // Keep a mutable data object for injection
        let data = { ...restData };

        if (parentProduct !== undefined) {
          data.parentProduct = parentProduct
            ? typeof parentProduct === "object"
              ? parentProduct.id
              : parentProduct
            : null;
        }

        // ── Resolve collections by name ──
        if (Array.isArray(collections)) {
          const collectionIds = [];
          for (const name of collections) {
            if (typeof name === "number") {
              collectionIds.push(name);
              continue;
            }
            const found = await strapi.entityService.findMany(
              "api::collection.collection",
              {
                filters: { name: { $eqi: name } },
                fields: ["id"],
                limit: 1,
              },
            );
            if (found.length > 0) {
              collectionIds.push(found[0].id);
            }
          }
          if (collectionIds.length > 0) {
            data.collections = { set: collectionIds };
          }
        }

        // ── Resolve hideFor by username ──
        if (Array.isArray(hideFor)) {
          const userIds = [];
          for (const username of hideFor) {
            if (typeof username === "number") {
              userIds.push(username);
              continue;
            }
            const found = await strapi.entityService.findMany(
              "plugin::users-permissions.user",
              {
                filters: { username: { $eq: username } },
                fields: ["id"],
                limit: 1,
              },
            );
            if (found.length > 0) {
              userIds.push(found[0].id);
            }
          }
          if (userIds.length > 0) {
            data.hideFor = { set: userIds };
          }
        }

        // ── Resolve transformationFactors ──
        let finalFactorId = null;
        if (
          Array.isArray(transformationFactors) &&
          transformationFactors.length > 0
        ) {
          for (const tf of transformationFactors) {
            if (tf.id) {
              const existingTf = await strapi.entityService.findOne(
                "api::transformation-factor.transformation-factor",
                tf.id,
              );
              if (existingTf) finalFactorId = existingTf.id;
            } else if (
              tf.name &&
              tf.factor &&
              tf.sourceUnit &&
              tf.destinationUnit
            ) {
              const newTf = await strapi.entityService.create(
                "api::transformation-factor.transformation-factor",
                {
                  data: {
                    name: tf.name,
                    sourceUnit: tf.sourceUnit,
                    destinationUnit: tf.destinationUnit,
                    factor: tf.factor,
                  },
                },
              );
              finalFactorId = newTf.id;
            }
          }
        }
        if (finalFactorId) {
          data.transformationFactor = { set: [finalFactorId] }; // set overrides the existing relation in entityService create/update without trx disconnect blocks
        }

        // ── Resolve productsForCuts ──
        if (Array.isArray(productsForCuts)) {
          const incomingIds = productsForCuts
            .map((p) => (typeof p === "object" ? p.id : p))
            .filter(Boolean);
          if (incomingIds.length > 0) {
            data.productsForCuts = { set: incomingIds };
          }
        }

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
