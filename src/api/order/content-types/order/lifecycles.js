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
        const isPartialInvoice = result.type === "partial-invoice";
        const isSaleWithInvoice =
          result.type === "sale" && result.emitInvoice === true;

        const shouldInvoice =
          (isPartialInvoice || isSaleWithInvoice) &&
          result.customerForInvoice &&
          !result.siigoIdTypeA && // Usar siigoIdTypeA en lugar de siigoId
          !result.siigoId; // Mantener compatibilidad con órdenes antiguas

        if (shouldInvoice) {
          console.log(
            `Order ${result.code} completada. Iniciando facturación automática...`
          );

          try {
            const invoiceService = strapi.service("api::siigo.invoice");
            const invoiceResult = await invoiceService.createInvoiceForOrder(
              result.id
            );

            // Log de facturas creadas
            if (invoiceResult.invoiceTypeB) {
              console.log(
                `Facturas creadas automáticamente para Order ${result.code}:`
              );
              console.log(`  - Tipo A: ${invoiceResult.invoiceTypeA.siigoId}`);
              console.log(`  - Tipo B: ${invoiceResult.invoiceTypeB.siigoId}`);
            } else {
              console.log(
                `Factura tipo A creada automáticamente para Order ${result.code}. Siigo ID: ${invoiceResult.invoiceTypeA.siigoId}`
              );
            }

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
              invoiceTypeA: invoiceResult.invoiceTypeA,
              invoiceTypeB: invoiceResult.invoiceTypeB,
              // Mantener retrocompatibilidad
              invoice: invoiceResult.invoice,
            });

            console.log(
              `Evento WebSocket emitido para Order ${result.code} con factura(s) creada(s)`
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
