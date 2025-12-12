"use strict";

const logger = require("../../../../utils/logger");

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
      logger.info("Order updated", { result, params });

      const stateChangedToCompleted =
        result?.state === "completed" &&
        (params?.data?.state === "completed" || params?.data?.completedDate);
      const { ORDER_POPULATE } = require("../../utils/orderHelpers");

      // Verificar si la orden cambió a estado 'completed'
      if (stateChangedToCompleted) {
        // Obtener la orden actualizada con todos los datos necesarios (incluyendo relaciones)
        logger.info("Iniciando camibios");
        const freshOrder = await strapi.entityService.findOne(
          "api::order.order",
          result.id,
          { populate: ORDER_POPULATE }
        );

        if (!freshOrder) {
          logger.warn(`Order ${result.id} not found in afterUpdate lifecycle`);
          return;
        }

        // Verificar si debe facturarse automáticamente
        // Lógica:
        // - Para 'partial-invoice': SIEMPRE facturar (es su propósito)
        // - Para 'sale': Solo si emitInvoice === true (venta con factura directa)
        // - Para otros tipos: NO facturar
        const isPartialInvoice = freshOrder.type === "partial-invoice";
        const isSaleWithInvoice =
          freshOrder.type === "sale" && freshOrder.emitInvoice === true;

        const shouldInvoice =
          (isPartialInvoice || isSaleWithInvoice) &&
          freshOrder.customerForInvoice &&
          !freshOrder.siigoIdTypeA && // Usar siigoIdTypeA en lugar de siigoId
          !freshOrder.siigoId; // Mantener compatibilidad con órdenes antiguas

        if (shouldInvoice) {
          console.log(
            `Order ${freshOrder.code} completada. Iniciando facturación automática...`
          );

          try {
            const invoiceService = strapi.service("api::siigo.invoice");
            const invoiceResult = await invoiceService.createInvoiceForOrder(
              freshOrder.id
            );

            // Log de facturas creadas
            if (invoiceResult.invoiceTypeB) {
              console.log(
                `Facturas creadas automáticamente para Order ${freshOrder.code}:`
              );
              console.log(`  - Tipo A: ${invoiceResult.invoiceTypeA.siigoId}`);
              console.log(`  - Tipo B: ${invoiceResult.invoiceTypeB.siigoId}`);
            } else {
              console.log(
                `Factura tipo A creada automáticamente para Order ${freshOrder.code}. Siigo ID: ${invoiceResult.invoiceTypeA.siigoId}`
              );
            }

            // Emitir evento WebSocket con la orden actualizada (usamos freshOrder ya populada)
            // Nota: Si el servicio de invoice modifica la orden (ej. guarda IDs),
            // sería ideal volver a cargarla o actualizar freshOrder,
            // pero por eficiencia podemos reenviar freshOrder asumiendo que el cliente
            // recibirá los datos de factura en el payload del evento aparte.
            // SIN EMBARGO, el código original volvía a hacer fetch.
            // Si createInvoiceForOrder actualiza la orden en DB, necesitamos refetch
            // para enviar los datos más frescos (ej. siigoIdTypeA).

            const updatedOrder = await strapi.entityService.findOne(
              "api::order.order",
              freshOrder.id,
              { populate: ORDER_POPULATE }
            );

            strapi.io
              ?.to(`order:${freshOrder.id}`)
              .emit("order:invoice-created", {
                order: updatedOrder,
                invoiceTypeA: invoiceResult.invoiceTypeA,
                invoiceTypeB: invoiceResult.invoiceTypeB,
                // Mantener retrocompatibilidad
                invoice: invoiceResult.invoice,
              });

            console.log(
              `Evento WebSocket emitido para Order ${freshOrder.code} con factura(s) creada(s)`
            );
          } catch (error) {
            console.error(
              `Error al crear factura automática para Order ${freshOrder.code}:`,
              error.message
            );

            // Emitir evento de error por WebSocket
            strapi.io
              ?.to(`order:${freshOrder.id}`)
              .emit("order:invoice-error", {
                orderId: freshOrder.id,
                orderCode: freshOrder.code,
                error: error.message,
              });

            // No lanzamos el error para no afectar el flujo principal del update
          }
        }

        // La notificación de packing list ahora se maneja vía Cron Task (config/cron-tasks.js)
        // para evitar errores de "Transaction query already complete" y asegurar que se envíe
        // incluso si la transacción original falla o tarda mucho.
      } else {
        logger.info("Order updated, but not completed");
      }
    } catch (error) {
      console.error("Error en lifecycle afterUpdate de Order:", error.message);
      // No lanzamos el error para no afectar el flujo principal
    }
  },
};
