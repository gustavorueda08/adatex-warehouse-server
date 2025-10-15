"use strict";

/**
 * Controlador de Siigo
 */

module.exports = {
  /**
   * Crea una factura en Siigo para una orden específica
   * POST /api/siigo/create-invoice/:orderId
   */
  async createInvoice(ctx) {
    try {
      const { orderId } = ctx.params;

      if (!orderId) {
        return ctx.badRequest("El ID de la orden es requerido");
      }

      const invoiceService = strapi.service("api::siigo.invoice");
      const result = await invoiceService.createInvoiceForOrder(
        parseInt(orderId)
      );

      ctx.send({
        success: true,
        message: "Factura creada exitosamente en Siigo",
        data: result,
      });
    } catch (error) {
      console.error("Error en createInvoice:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Consulta una factura en Siigo
   * GET /api/siigo/invoice/:siigoId
   */
  async getInvoice(ctx) {
    try {
      const { siigoId } = ctx.params;

      if (!siigoId) {
        return ctx.badRequest("El ID de Siigo es requerido");
      }

      const invoiceService = strapi.service("api::siigo.invoice");
      const invoice = await invoiceService.getInvoice(siigoId);

      ctx.send({
        success: true,
        data: invoice,
      });
    } catch (error) {
      console.error("Error en getInvoice:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Procesa todas las órdenes completadas pendientes de facturación
   * POST /api/siigo/process-completed-orders
   */
  async processCompletedOrders(ctx) {
    try {
      const invoiceService = strapi.service("api::siigo.invoice");
      const result = await invoiceService.processCompletedOrders();

      ctx.send({
        success: true,
        message: `Procesamiento completado. ${result.successful} exitosas, ${result.failed} fallidas`,
        data: result,
      });
    } catch (error) {
      console.error("Error en processCompletedOrders:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Valida si una orden puede facturarse
   * GET /api/siigo/validate-order/:orderId
   */
  async validateOrder(ctx) {
    try {
      const { orderId } = ctx.params;

      if (!orderId) {
        return ctx.badRequest("El ID de la orden es requerido");
      }

      const { ORDER_SERVICE } = require("../../../utils/services");
      const order = await strapi.entityService.findOne(
        ORDER_SERVICE,
        parseInt(orderId),
        {
          populate: [
            "customerForInvoice",
            "orderProducts",
            "orderProducts.product",
          ],
        }
      );

      if (!order) {
        return ctx.notFound("Orden no encontrada");
      }

      const mapperService = strapi.service("api::siigo.mapper");
      const validation = await mapperService.validateOrderForInvoicing(order);

      ctx.send({
        success: true,
        data: {
          orderId: order.id,
          orderCode: order.code,
          canInvoice: validation.valid,
          errors: validation.errors,
        },
      });
    } catch (error) {
      console.error("Error en validateOrder:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Obtiene el estado del token de autenticación
   * GET /api/siigo/auth-status
   */
  async getAuthStatus(ctx) {
    try {
      const authService = strapi.service("api::siigo.auth");

      // Intentar obtener token
      try {
        await authService.getAccessToken();
        ctx.send({
          success: true,
          authenticated: true,
          message: "Token de Siigo válido",
        });
      } catch (error) {
        ctx.send({
          success: false,
          authenticated: false,
          message: error.message,
        });
      }
    } catch (error) {
      console.error("Error en getAuthStatus:", error.message);
      ctx.throw(500, error.message);
    }
  },
};
