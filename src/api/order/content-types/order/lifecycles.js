"use strict";

/**
 * Lifecycle callbacks para el content-type Order
 */

module.exports = {
  /**
   * Hook que se ejecuta después de actualizar una orden
   */
  async afterUpdate(event) {
    try {
      const { result, params } = event;

      // Verificar si la orden cambió a estado 'completed'
      if (result && result.state === "completed") {
        // Verificar si debe facturarse automáticamente
        // Lógica:
        // - Para 'partial-invoice': SIEMPRE facturar (es su propósito)
        // - Para 'sale': Solo si emitInvoice === true (venta con factura directa)
        // - Para otros tipos: NO facturar
        const autoInvoicing =
          process.env.SIIGO_AUTO_INVOICE_ON_COMPLETE === "true";

        const isPartialInvoice = result.type === "partial-invoice";
        const isSaleWithInvoice =
          result.type === "sale" && result.emitInvoice === true;

        const shouldInvoice =
          (isPartialInvoice || isSaleWithInvoice) &&
          result.customerForInvoice &&
          !result.siigoId;

        if (shouldInvoice) {
          console.log(
            `Order ${result.code} completada. Iniciando facturación automática...`
          );

          try {
            const invoiceService = strapi.service("api::siigo.invoice");
            const invoiceResult = await invoiceService.createInvoiceForOrder(
              result.id
            );

            console.log(
              `Factura creada automáticamente para Order ${result.code}. Siigo ID: ${invoiceResult.invoice.siigoId}`
            );

            // Obtener la orden actualizada con todos los datos
            const { ORDER_POPULATE } = require("../../utils/orderHelpers");
            const updatedOrder = await strapi.entityService.findOne(
              "api::order.order",
              result.id,
              { populate: ORDER_POPULATE }
            );

            // Emitir evento WebSocket con la orden actualizada
            strapi.io?.to(`order:${result.id}`).emit("order:invoice-created", {
              order: updatedOrder,
              invoice: invoiceResult.invoice,
            });

            console.log(
              `Evento WebSocket emitido para Order ${result.code} con factura creada`
            );
          } catch (error) {
            console.error(
              `Error al crear factura automática para Order ${result.code}:`,
              error.message
            );

            // Emitir evento de error por WebSocket
            strapi.io?.to(`order:${result.id}`).emit("order:invoice-error", {
              orderId: result.id,
              orderCode: result.code,
              error: error.message,
            });

            // No lanzamos el error para no afectar el flujo principal del update
          }
        }
      }
    } catch (error) {
      console.error("Error en lifecycle afterUpdate de Order:", error.message);
      // No lanzamos el error para no afectar el flujo principal
    }
  },
};
