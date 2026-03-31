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
      if (error.message?.startsWith("CREDIT_BLOCK:")) {
        const reason = error.message.slice("CREDIT_BLOCK:".length);
        return ctx.badRequest(reason, {
          error: { status: 400, name: "CreditBlockError", message: reason },
        });
      }
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

      const { products, ...rest } = data.data;
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
      if (error.message?.startsWith("CREDIT_BLOCK:")) {
        const reason = error.message.slice("CREDIT_BLOCK:".length);
        return ctx.badRequest(reason, {
          error: { status: 400, name: "CreditBlockError", message: reason },
        });
      }
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
          throw new Error("Cada producto debe tener una cantidad mayor a 0");
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

  /**
   * Descarga el PDF de la factura asociada a la orden
   * GET /api/orders/:orderId/invoices?type=A|B
   */
  async downloadInvoice(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { orderId } = ctx.params;
      const { type } = ctx.query;

      if (!orderId) {
        throw new Error("El id de la orden es requerido");
      }

      // Validar tipo (por defecto ALL si no se especifica)
      const invoiceType = (type || "ALL").toUpperCase();
      if (!["A", "B", "ALL"].includes(invoiceType)) {
        throw new Error("El tipo de factura debe ser 'A', 'B' o 'ALL'");
      }

      // El servicio ahora retorna { buffer, mimeType, filename, type }
      const downloadData = await orderService.downloadInvoice(
        orderId,
        invoiceType,
      );

      ctx.set("Content-Type", downloadData.mimeType);
      ctx.set(
        "Content-Disposition",
        `attachment; filename="${downloadData.filename}"`,
      );
      ctx.body = downloadData.buffer;
    } catch (error) {
      logger.error("Error al descargar factura:", error);

      // Si el error es "No existe factura...", retornar 404
      if (
        error.message.includes("No existe factura") ||
        error.message.includes("no encontrada")
      ) {
        return ctx.notFound(error.message);
      }

      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "InvoiceDownloadError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Devuelve los items disponibles para nacionalizar de una orden de compra en zona franca.
   * GET /api/orders/:purchaseOrderId/nationalizable-items
   */
  async getNationalizableItems(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { purchaseOrderId } = ctx.params;

      if (!purchaseOrderId) {
        throw new Error("El id de la orden de compra es requerido");
      }

      const items = await orderService.getNationalizableItems(purchaseOrderId);

      return {
        data: items,
        meta: { count: items.length, productCount: items.length },
      };
    } catch (error) {
      logger.error("Error al obtener items nacionalizables:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "NationalizableItemsError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Crea una orden de nacionalización a partir de una orden de compra en zona franca.
   * POST /api/orders/:purchaseOrderId/nationalize
   * Body: {
   *   destinationWarehouseId: number,
   *   products: [{ product: number, quantity: number }],
   *   notes?: string
   * }
   */
  async createNationalization(ctx) {
    try {
      const orderService = strapi.service(ORDER_SERVICE);
      const { purchaseOrderId } = ctx.params;
      const data = ctx.request.body;

      if (!purchaseOrderId) {
        throw new Error("El id de la orden de compra es requerido");
      }

      if (!data?.destinationWarehouseId) {
        throw new Error("La bodega destino (destinationWarehouseId) es requerida");
      }

      if (!data?.products || !Array.isArray(data.products) || data.products.length === 0) {
        throw new Error("Se requiere al menos un producto con cantidad para nacionalizar");
      }

      for (const p of data.products) {
        if (!p.product) throw new Error("Cada producto debe tener el campo 'product'");
        const hasQty = p.quantity && p.quantity > 0;
        const hasItems = Array.isArray(p.itemIds) && p.itemIds.length > 0;
        if (!hasQty && !hasItems) {
          throw new Error(
            "Cada producto debe tener una cantidad mayor a 0 o items seleccionados (itemIds)",
          );
        }
      }

      const order = await orderService.createNationalization({
        purchaseOrderId,
        destinationWarehouseId: data.destinationWarehouseId,
        products: data.products,
        notes: data.notes,
      });

      return {
        data: order,
        meta: {
          message: "Orden de nacionalización creada exitosamente",
        },
      };
    } catch (error) {
      logger.error("Error al crear orden de nacionalización:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "NationalizationCreationError",
          message: error.message,
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },

  /**
   * Aprueba o revoca la excepción de bloqueo de crédito para una orden de venta.
   * Solo administradores pueden llamar este endpoint.
   * POST /api/orders/:orderId/approve-credit
   * Body: { override: true|false }  (default: true)
   */
  async approveCreditOverride(ctx) {
    try {
      if (!ctx.state.user || ctx.state.user.type !== "admin") {
        return ctx.forbidden("Solo los administradores pueden aprobar excepciones de crédito");
      }

      const { orderId } = ctx.params;
      const override = ctx.request.body?.override !== false; // default true

      const order = await strapi.entityService.findOne("api::order.order", orderId, {
        fields: ["id", "type", "state", "code"],
      });

      if (!order) return ctx.notFound("Orden no encontrada");
      if (order.type !== "sale") {
        return ctx.badRequest("Solo las órdenes de venta pueden tener excepción de crédito");
      }

      await strapi.entityService.update("api::order.order", orderId, {
        data: { creditBlockOverridden: override },
      });

      logger.info(
        `Admin ${ctx.state.user.username || ctx.state.user.email || ctx.state.user.id} ${override ? "aprobó" : "revocó"} excepción de crédito para orden ${order.code}`,
      );

      return {
        data: { id: Number(orderId), creditBlockOverridden: override },
        meta: {
          message: override
            ? "Excepción de crédito aprobada. El equipo de bodega puede despachar esta orden."
            : "Excepción de crédito revocada.",
        },
      };
    } catch (error) {
      logger.error("Error al gestionar excepción de crédito:", error);
      return ctx.internalServerError(error.message);
    }
  },

  async testEmail(ctx) {
    try {
      // Only administrators may trigger test emails
      const userRole = ctx.state.user?.role?.type;
      if (!ctx.state.user || userRole !== "administrator") {
        return ctx.forbidden("Se requiere rol de administrador");
      }

      const { to } = ctx.request.body;
      if (!to) {
        return ctx.badRequest("Missing 'to' email address in body");
      }

      const order = await strapi.entityService.findOne("api::order.order", 1); // Mock order details

      if (!order) {
        return ctx.badRequest(
          "Cannot find any baseline order to attach against",
        );
      }

      const packingListNotifier = strapi.service(
        "api::order.packing-list-notifier",
      );

      await packingListNotifier.sendPackingListEmail({
        order,
        to,
        attachments: [],
      });

      return {
        success: true,
        message:
          "SendGrid attempt dispatched. If successful, you should see 202 status on SendGrid dashboard.",
      };
    } catch (error) {
      return ctx.internalServerError(
        `SendGrid Delivery Failed: ${error.message}`,
      );
    }
  },
}));
