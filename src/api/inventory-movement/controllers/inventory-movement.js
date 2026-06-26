"use strict";

/**
 * inventory-movement controller
 */

const { createCoreController } = require("@strapi/strapi").factories;
const { INVENTORY_MOVEMENT_SERVICE } = require("../../../utils/services");

module.exports = createCoreController(
  "api::inventory-movement.inventory-movement",
  ({ strapi }) => ({
    /**
     * GET /inventory-movements/kardex?years=2024,2025,2026[&productId=ID]
     * (also accepts ?year=YYYY for a single year)
     *
     * Returns the multi-year Kardex (quantity-only, per product, all
     * warehouses) as JSON, for on-screen preview / verification.
     */
    async kardex(ctx) {
      try {
        const { years, year, productId } = ctx.query;
        const service = strapi.service(INVENTORY_MOVEMENT_SERVICE);
        const data = await service.buildKardex({ years, year, productId });
        return data;
      } catch (error) {
        return ctx.badRequest(error.message);
      }
    },

    /**
     * GET /inventory-movements/kardex/download?years=2024,2025,2026[&productId=ID]
     *
     * Streams the Kardex as a styled .xlsx file (one sheet per year).
     */
    async downloadKardex(ctx) {
      try {
        const { years, year, productId } = ctx.query;
        const service = strapi.service(INVENTORY_MOVEMENT_SERVICE);
        const data = await service.buildKardex({ years, year, productId });
        const buffer = await service.generateKardexExcel(data);

        const yearLabel = data.meta.years.join("-");
        const suffix = productId ? `-producto-${productId}` : "";
        const filename = `Kardex-Adatex-${yearLabel}${suffix}.xlsx`;

        ctx.set(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        ctx.set("Content-Disposition", `attachment; filename="${filename}"`);
        ctx.set("Content-Length", buffer.length);
        ctx.body = buffer;
      } catch (error) {
        console.error("Error generando Kardex:", error.message);
        ctx.throw(500, error.message);
      }
    },
  })
);
