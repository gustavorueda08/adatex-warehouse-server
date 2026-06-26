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
     * GET /inventory-movements/kardex?year=YYYY[&productId=ID]
     *
     * Returns the Kardex (quantity-only, per product, all warehouses) as JSON,
     * for on-screen preview / verification before downloading the Excel.
     */
    async kardex(ctx) {
      try {
        const { year, productId } = ctx.query;
        const service = strapi.service(INVENTORY_MOVEMENT_SERVICE);
        const data = await service.buildKardex({ year, productId });
        return data;
      } catch (error) {
        return ctx.badRequest(error.message);
      }
    },

    /**
     * GET /inventory-movements/kardex/download?year=YYYY[&productId=ID]
     *
     * Streams the Kardex as a styled .xlsx file for the DIAN audit.
     */
    async downloadKardex(ctx) {
      try {
        const { year, productId } = ctx.query;
        const service = strapi.service(INVENTORY_MOVEMENT_SERVICE);
        const data = await service.buildKardex({ year, productId });
        const buffer = await service.generateKardexExcel(data);

        const suffix = productId ? `-producto-${productId}` : "";
        const filename = `Kardex-Adatex-${data.meta.year}${suffix}.xlsx`;

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
