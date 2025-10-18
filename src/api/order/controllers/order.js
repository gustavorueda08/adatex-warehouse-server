"use strict";

const logger = require("../../../utils/logger");
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

      if (!data?.data) {
        throw new Error("Los datos de la orden son requeridos");
      }

      const order = await orderService.create(data.data);

      if (!order) {
        throw new Error("Error al crear la orden");
      }

      return {
        data: order,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al crear orden:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "OrderCreationError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  // Actualiza una orden, sus orderProducts y items de acuerdo con el tipo de orden
  async update(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const data = ctx.request.body;

      if (!orderId) {
        throw new Error("El id de la orden es requerido");
      }

      if (!data?.data) {
        throw new Error("Los datos de la orden son requeridos");
      }

      const { products = [], ...rest } = data.data;

      const order = await orderService.update({
        products,
        update: { ...rest },
        id: orderId,
      });

      if (!order) {
        throw new Error("Error al actualizar la orden");
      }

      return {
        data: order,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al actualizar la orden:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "OrderUpdateError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  // Elimina una orden, sus orderProducts e Items de acuerdo con el tipo de Order
  async delete(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;

      if (!orderId) {
        throw new Error("El id de la orden es requerido");
      }

      const deletedOrder = await orderService.delete({ id: orderId });

      return {
        data: deletedOrder,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al eliminar orden:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "OrderDeletionError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  // Agrega un producto al Order
  async add(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const data = ctx.request.body.data;

      if (!orderId) {
        throw new Error("El id de la orden es requerido");
      }

      if (!data) {
        throw new Error("Los datos del producto son requeridos");
      }

      const updatedOrder = await orderService.addItem({ ...data, id: orderId });

      return {
        data: updatedOrder,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al agregar producto a la orden:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ItemAddError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  // Remueve un producto del Order
  async remove(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const data = ctx.request.body.data;

      if (!orderId) {
        throw new Error("El id de la orden es requerido");
      }

      if (!data) {
        throw new Error("Los datos del producto son requeridos");
      }

      const updatedOrder = await orderService.removeItem({
        ...data,
        id: orderId,
      });

      return {
        data: updatedOrder,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al remover producto de la orden:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "ItemRemoveError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Obtiene los items facturables de una orden (despachados pero no facturados)
   * GET /api/orders/:parentOrderId/invoiceable-items
   */
  async getInvoiceableItems(ctx) {
    try {
      const { parentOrderId } = ctx.params;

      if (!parentOrderId) {
        throw new Error("El id de la orden padre es requerido");
      }

      const {
        getInvoiceableItemsFromOrder,
      } = require("../utils/invoiceHelpers");
      const result = await getInvoiceableItemsFromOrder(parentOrderId);

      return {
        data: result,
        meta: {},
      };
    } catch (error) {
      logger.error("Error al obtener items facturables:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "InvoiceableItemsError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Crea una orden de facturación parcial a partir de una orden de venta
   * POST /api/orders/create-partial-invoice
   * Body: {
   *   parentOrder: orderId,
   *   customer: customerId,
   *   customerForInvoice: customerId,
   *   products: [{ product: productId, quantity: X }],
   *   notes?: string
   * }
   */
  async createPartialInvoice(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const data = ctx.request.body;

      if (!data?.parentOrder) {
        throw new Error("El parentOrder es requerido");
      }

      if (!data?.products || !Array.isArray(data.products)) {
        throw new Error("Se requiere un array de productos con cantidades");
      }

      // Validar que los productos tengan la estructura correcta
      for (const p of data.products) {
        if (!p.product) {
          throw new Error("Cada producto debe tener el campo 'product'");
        }
        if (!p.quantity || p.quantity <= 0) {
          throw new Error(
            "Cada producto debe tener una cantidad mayor a 0"
          );
        }
      }

      // Construir la orden de tipo partial-invoice
      const orderData = {
        type: "partial-invoice",
        parentOrder: data.parentOrder,
        customer: data.customer,
        customerForInvoice: data.customerForInvoice,
        notes: data.notes || "Facturación parcial automática (FIFO)",
        products: data.products.map((p) => ({
          product: p.product,
          requestedQuantity: p.quantity || 0,
          items: [
            {
              quantity: p.quantity,
              // La estrategia buscará automáticamente los items usando FIFO
            },
          ],
        })),
      };

      const order = await orderService.create(orderData);

      return {
        data: order,
        meta: {
          message: "Orden de facturación parcial creada exitosamente",
          type: "fifo-automatic",
        },
      };
    } catch (error) {
      logger.error("Error al crear orden de facturación parcial:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "PartialInvoiceCreationError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },
}));
