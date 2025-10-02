"use strict";

const runInBatches = require("../../../utils/runInBatches");
const { ORDER_SERVICE } = require("../../../utils/services");

/**
 * order controller
 */

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
  // Crea una orden, sus orderProducts y items de acuerdo con el tipo de orden
  async create(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const data = ctx.request.body;
      const order = await orderService.create(data.data);
      if (!order) throw new Error("Error al crear la orden");
      console.log(data);

      return {
        data: order,
        meta: {},
      };
    } catch (error) {
      console.error("Error al crear orden:", error);
      return ctx.badRequest(error.message, {
        error: {
          status: 500,
          name: "OrderCreationError",
          message: error.message,
          details: error,
        },
      });
    }
  },
  // Actualiza una orden, sus orderProducts y items de acuerdo con el tipo de orden
  async update(ctx) {
    try {
      const orderService = strapi.service("api::order.order");
      const { orderId } = ctx.params;
      if (!orderId) throw new Error("El id de la orden es requerido");
      const data = ctx.request.body;
      const { products = [], ...rest } = data.data;
      console.log(products[0].items);

      const order = await orderService.update({
        products,
        update: { ...rest },
        id: orderId,
      });
      if (!order) throw new Error("Error al actualizar la orden");
      return {
        data: order,
        meta: {},
      };
    } catch (error) {
      console.error("Error al actualizar la orden:", error);
      return ctx.badRequest(error.message, {
        error: {
          status: 500,
          name: "OrderCreationError",
          message: error.message,
          details: error,
        },
      });
    }
  },
  // Elimina una orden, sus orderProducts e Items de acuerdo con el tipo de Order
  async delete(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      if (!orderId) throw new Error("El id de la orden es requerido");
      const deletedOrder = await orderService.delete({ id: orderId });
      console.log(orderId, "ID");

      return {
        data: deletedOrder,
        meta: {},
      };
    } catch (error) {
      console.error("Error al crear orden:", error);
      return ctx.badRequest(error.message, {
        error: {
          status: 500,
          name: "OrderCreationError",
          message: error.message,
          details: error,
        },
      });
    }
  },
  // Agrega un producto al Order
  async add(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const data = ctx.request.body;
      console.log({ ...data, id: orderId });

      if (!orderId) throw new Error("El id de la orden es requerido");
      const updatedOrder = await orderService.addItem({ ...data, id: orderId });
      ctx.body = updatedOrder;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
  // Remuebe un producto del Order
  async remove(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const data = ctx.request.body;
      if (!orderId) throw new Error("El id de la orden es requerido");
      const updatedOrder = await orderService.removeItem({
        ...data,
        id: orderId,
      });
      ctx.body = updatedOrder;
    } catch (error) {
      ctx.badRequest(error.message);
    }
  },
}));
