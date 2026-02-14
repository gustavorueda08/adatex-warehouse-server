"use strict";

/**
 * collection service
 */

const { createCoreService } = require("@strapi/strapi").factories;
const compareRelationArrays = require("../../../utils/compareRelationArrays");

module.exports = createCoreService(
  "api::collection.collection",
  ({ strapi }) => ({
    async create(data) {
      return strapi.db.transaction(async (trx) => {
        const { products = [], line, ...rest } = data;

        const createData = {
          ...rest,
        };

        if (products.length > 0) {
          createData.products = { connect: products };
        }

        if (line) {
          createData.line = line;
        }

        const newCollection = await strapi.entityService.create(
          "api::collection.collection",
          {
            data: createData,
          },
          { transacting: trx },
        );

        return newCollection;
      });
    },

    async update(id, data) {
      const { products, line, ...rest } = data;
      return strapi.db.transaction(async (trx) => {
        const currentCollection = await strapi.entityService.findOne(
          "api::collection.collection",
          id,
          {
            populate: ["products"],
          },
          { transacting: trx },
        );
        if (!currentCollection) {
          throw new Error(`Colección con ID ${id} no encontrada`);
        }
        const updateData = {
          ...rest,
        };
        // Handle Products Relation (ManyToMany)
        if (typeof products !== "undefined") {
          const currentProductIds =
            currentCollection.products?.map((p) => p.id) || [];
          const { toAdd, toRemove } = compareRelationArrays(
            currentProductIds,
            products,
          );

          updateData.products = {
            connect: toAdd,
            disconnect: toRemove,
          };
        }

        // Handle Line Relation (ManyToOne)
        if (typeof line !== "undefined") {
          updateData.line = line;
        }

        const updatedCollection = await strapi.entityService.update(
          "api::collection.collection",
          id,
          {
            data: updateData,
          },
          { transacting: trx },
        );

        return strapi.entityService.findOne(
          "api::collection.collection",
          id,
          {
            populate: ["products", "line"],
          },
          { transacting: trx },
        );
      });
    },
  }),
);
