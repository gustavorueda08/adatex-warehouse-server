"use strict";

/**
 * supplier service
 */

const { createCoreService } = require("@strapi/strapi").factories;

const detectPriceOperations = require("../../../utils/detectPriceOperations");
const { SUPPLIER_SERVICE } = require("../../../utils/services");

module.exports = createCoreService("api::supplier.supplier", ({ strapi }) => ({
  /**
   * Actualiza un supplier y sus precios
   */
  async update(id, data) {
    const compareRelationArrays = require("../../../utils/compareRelationArrays");
    const { prices = [], taxes = [], ...rest } = data;

    return strapi.db.transaction(async (trx) => {
      // 1. Obtener supplier actual con precios y taxes
      const currentSupplier = await strapi.entityService.findOne(
        SUPPLIER_SERVICE,
        id,
        {
          populate: ["prices", "taxes"],
          transacting: trx,
        },
      );

      if (!currentSupplier) {
        throw new Error(`Supplier con ID ${id} no encontrado`);
      }

      // 2. Procesar Taxes (many-to-many)
      const currentTaxes = currentSupplier.taxes?.map((tax) => tax.id) || [];
      const { toAdd: taxesToAdd, toRemove: taxesToRemove } =
        compareRelationArrays(currentTaxes, taxes);

      // 3. Procesar Prices
      // currentSupplier.prices es un array de objetos
      const currentPrices = currentSupplier.prices || [];
      const { toCreate, toUpdate, toDelete } = detectPriceOperations(
        currentPrices,
        prices,
      );

      // Eliminar prices
      for (const price of toDelete) {
        await strapi.entityService.delete("api::price.price", price.id, {
          transacting: trx,
        });
      }

      // Actualizar prices
      for (const price of toUpdate) {
        const { id: priceId, ...priceData } = price;
        await strapi.entityService.update(
          "api::price.price",
          priceId,
          {
            data: priceData,
          },
          { transacting: trx },
        );
      }

      // Crear prices
      for (const price of toCreate) {
        const { id: _, ...priceData } = price; // Ignorar ID si viene
        await strapi.entityService.create(
          "api::price.price",
          {
            data: {
              ...priceData,
              supplier: id,
            },
          },
          { transacting: trx },
        );
      }

      // 4. Actualizar Supplier con el resto de datos y taxes
      await strapi.entityService.update(
        SUPPLIER_SERVICE,
        id,
        {
          data: {
            ...rest,
            taxes: {
              connect: taxesToAdd,
              disconnect: taxesToRemove,
            },
          },
        },
        { transacting: trx },
      );

      // 5. Retornar Supplier actualizado con precios y taxes
      return await strapi.entityService.findOne(SUPPLIER_SERVICE, id, {
        populate: ["prices", "prices.product", "taxes"],
        transacting: trx,
      });
    });
  },
}));
