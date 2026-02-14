"use strict";

/**
 * collection controller
 */

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController(
  "api::collection.collection",
  ({ strapi }) => ({
    async create(ctx) {
      try {
        const data = ctx.request.body;

        // Strapi wrapping convention check
        const payload = data.data || data;

        if (!payload) {
          throw new Error("Datos requeridos no encontrados en el payload");
        }

        const newCollection = await strapi
          .service("api::collection.collection")
          .create(payload);

        return {
          data: newCollection,
          meta: {},
        };
      } catch (error) {
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "CollectionCreateError",
            message: error.message,
          },
        });
      }
    },

    async update(ctx) {
      try {
        const { id } = ctx.params;
        const data = ctx.request.body;

        // Strapi wrapping convention check
        const payload = data.data || data;

        if (!id) {
          throw new Error("ID de colección requerido");
        }

        if (!payload) {
          throw new Error("Datos requeridos no encontrados en el payload");
        }

        const updatedCollection = await strapi
          .service("api::collection.collection")
          .update(id, payload);

        return {
          data: updatedCollection,
          meta: {},
        };
      } catch (error) {
        return ctx.internalServerError(error.message, {
          error: {
            status: 500,
            name: "CollectionUpdateError",
            message: error.message,
          },
        });
      }
    },
  }),
);
