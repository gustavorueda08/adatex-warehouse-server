'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::item.item', ({ strapi }) => ({
  /**
   * GET /api/items/aggregate
   *
   * Returns COUNT(*) and SUM(currentQuantity) for items matching the given
   * filters. Uses Strapi's DB query layer so relation filters (product,
   * warehouse) are handled by the ORM without requiring raw JOIN knowledge.
   *
   * Query params:
   *   productId    – filter by product id
   *   warehouseId  – filter by warehouse id
   *   state        – filter by item state (e.g. "available")
   *   isFixedQty   – "true" → skip the SUM query (each fixedQty item = 1 unit,
   *                  so count === totalQuantity)
   */
  async aggregate(ctx) {
    const { productId, warehouseId, state, isFixedQty } = ctx.query;

    const where = {
      currentQuantity: { $gt: 0 },
    };
    if (productId)   where.product   = { id: productId };
    if (warehouseId) where.warehouse = { id: warehouseId };
    if (state)       where.state     = state;

    // COUNT — always an efficient single SQL query
    const count = await strapi.db.query('api::item.item').count({ where });

    let totalQuantity;

    if (isFixedQty === 'true') {
      // fixedQuantityPerItem: every item has currentQuantity = 1
      totalQuantity = count;
    } else {
      // Fetch only the scalar field we need (no relation data)
      const rows = await strapi.db.query('api::item.item').findMany({
        where,
        select: ['currentQuantity'],
      });
      totalQuantity = Math.round(
        rows.reduce((sum, r) => sum + (Number(r.currentQuantity) || 0), 0) * 100,
      ) / 100;
    }

    ctx.body = { data: { count, totalQuantity } };
  },
}));
