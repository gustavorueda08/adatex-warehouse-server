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
        // Obtener la orden anterior para comparar
        const previousOrder = await strapi.entityService.findOne(
          "api::order.order",
          result.id,
          {
            populate: ["customerForInvoice"],
          }
        );

        // Solo proceder si:
        // 1. Es una orden de tipo 'sale' o 'partial-invoice'
        // 2. Tiene customerForInvoice
        // 3. No tiene ya un siigoId (no está facturada)
        // 4. La variable de entorno permite auto-facturación
        const autoInvoicing =
          process.env.SIIGO_AUTO_INVOICE_ON_COMPLETE === "true";

        if (
          (result.type === "sale" || result.type === "partial-invoice") &&
          result.customerForInvoice &&
          !result.siigoId &&
          autoInvoicing
        ) {
          console.log(
            `Order ${result.code} completada. Iniciando facturación automática...`
          );

          // Ejecutar creación de factura de forma asíncrona
          // No bloqueamos el update de la orden
          setImmediate(async () => {
            try {
              const invoiceService = strapi.service("api::siigo.invoice");
              const invoiceResult = await invoiceService.createInvoiceForOrder(
                result.id
              );

              console.log(
                `Factura creada automáticamente para Order ${result.code}. Siigo ID: ${invoiceResult.invoice.siigoId}`
              );
            } catch (error) {
              console.error(
                `Error al crear factura automática para Order ${result.code}:`,
                error.message
              );

              // Aquí podrías:
              // 1. Enviar notificación a administradores
              // 2. Crear un registro de error
              // 3. Agregar la orden a una cola de reintentos
            }
          });
        }
      }
    } catch (error) {
      console.error("Error en lifecycle afterUpdate de Order:", error.message);
      // No lanzamos el error para no afectar el flujo principal
    }
  },
};
