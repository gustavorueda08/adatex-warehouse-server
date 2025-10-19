"use strict";

const { ORDER_SERVICE } = require("../../../utils/services");

/**
 * Servicio de creación y gestión de facturas en Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Crea una factura en Siigo para una orden específica
   * @param {Number} orderId - ID de la orden
   * @param {Object} options - Opciones adicionales
   * @returns {Object} - Factura creada
   */
  async createInvoiceForOrder(orderId, options = {}) {
    try {
      const testMode = process.env.SIIGO_TEST_MODE === "true";
      console.log(
        `${testMode ? "[TEST MODE] " : ""}Iniciando creación de factura para Order ID: ${orderId}`
      );

      // Obtener la orden con todos los datos necesarios
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: [
          "customerForInvoice",
          "customerForInvoice.taxes",
          "orderProducts",
          "orderProducts.product",
        ],
      });

      if (!order) {
        throw new Error(`Orden con ID ${orderId} no encontrada`);
      }

      // Validar que la orden sea facturable
      const authService = strapi.service("api::siigo.auth");
      const mapperService = strapi.service("api::siigo.mapper");

      const validation = await mapperService.validateOrderForInvoicing(order);
      if (!validation.valid) {
        throw new Error(
          `Orden no válida para facturación:\n- ${validation.errors.join("\n- ")}`
        );
      }

      // Mapear orden a formato Siigo
      const invoiceData = await mapperService.mapOrderToInvoice(order);

      console.log(
        "Datos de factura mapeados:",
        JSON.stringify(invoiceData, null, 2)
      );

      // MODO TEST: Simular respuesta sin llamar a Siigo
      if (testMode) {
        console.log("[TEST MODE] Simulando creación de factura en Siigo...");
        const fakeInvoice = {
          id: "TEST-" + Date.now(),
          number: `FV-TEST-${order.id}`,
          date: new Date().toISOString().split("T")[0],
          total: order.totalAmount,
          status: "test",
        };

        // Actualizar orden con el siigoId falso
        await strapi.entityService.update(ORDER_SERVICE, orderId, {
          data: {
            siigoId: String(fakeInvoice.id),
            invoiceNumber: fakeInvoice.number,
          },
        });

        // Marcar items como facturados
        const orderWithItems = await strapi.entityService.findOne(
          ORDER_SERVICE,
          orderId,
          { populate: ["items"] }
        );

        const itemIds = orderWithItems.items?.map((i) => i.id) || [];
        if (itemIds.length > 0) {
          const { markItemsAsInvoiced } = require("../../order/utils/invoiceHelpers");
          await markItemsAsInvoiced(itemIds);
          console.log(
            `[TEST MODE] ${itemIds.length} items marcados como facturados`
          );
        }

        console.log(
          `[TEST MODE] Factura simulada creada. ID: ${fakeInvoice.id}`
        );

        return {
          success: true,
          testMode: true,
          order: {
            id: order.id,
            code: order.code,
          },
          invoice: {
            siigoId: fakeInvoice.id,
            number: fakeInvoice.number,
            date: fakeInvoice.date,
            total: fakeInvoice.total,
          },
          rawResponse: fakeInvoice,
        };
      }

      // MODO REAL: Llamar API de Siigo
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      let response;
      try {
        response = await fetch(`${apiUrl}/v1/invoices`, {
          method: "POST",
          headers,
          body: JSON.stringify(invoiceData),
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);

          // Si es error 401, renovar token e intentar de nuevo
          if (response.status === 401) {
            console.log("Token expirado, renovando...");
            authService.invalidateToken();
            const newHeaders = await authService.getAuthHeaders();

            response = await fetch(`${apiUrl}/v1/invoices`, {
              method: "POST",
              headers: newHeaders,
              body: JSON.stringify(invoiceData),
            });

            if (!response.ok) {
              throw new Error(
                `Error HTTP ${response.status}: ${response.statusText}`
              );
            }
          } else {
            throw new Error(
              `Error HTTP ${response.status}: ${response.statusText}`
            );
          }
        }
      } catch (fetchError) {
        console.error("Error al llamar API de Siigo:", fetchError.message);
        throw fetchError;
      }

      const siigoInvoice = await response.json();

      if (!siigoInvoice || !siigoInvoice.id) {
        throw new Error("Respuesta inválida de Siigo al crear factura");
      }

      console.log(
        `Factura creada exitosamente en Siigo. ID: ${siigoInvoice.id}`
      );

      // Actualizar orden con el siigoId de la factura
      await strapi.entityService.update(ORDER_SERVICE, orderId, {
        data: {
          siigoId: String(siigoInvoice.id),
          invoiceNumber: siigoInvoice.number || siigoInvoice.id,
        },
      });

      // Marcar items como facturados
      const orderWithItems = await strapi.entityService.findOne(
        ORDER_SERVICE,
        orderId,
        { populate: ["items"] }
      );

      const itemIds = orderWithItems.items?.map((i) => i.id) || [];
      if (itemIds.length > 0) {
        const { markItemsAsInvoiced } = require("../../order/utils/invoiceHelpers");
        await markItemsAsInvoiced(itemIds);
        console.log(`${itemIds.length} items marcados como facturados`);
      }

      console.log(
        `Order ${order.code} actualizada con siigoId: ${siigoInvoice.id}`
      );

      return {
        success: true,
        testMode: false,
        order: {
          id: order.id,
          code: order.code,
        },
        invoice: {
          siigoId: siigoInvoice.id,
          number: siigoInvoice.number,
          date: siigoInvoice.date,
          total: siigoInvoice.total || order.totalAmount,
        },
        rawResponse: siigoInvoice,
      };
    } catch (error) {
      console.error(
        `Error al crear factura para Order ID ${orderId}:`,
        error.message
      );
      throw new Error(`Error al crear factura en Siigo: ${error.message}`);
    }
  },

  /**
   * Consulta una factura en Siigo
   * @param {String} siigoInvoiceId - ID de la factura en Siigo
   * @returns {Object} - Datos de la factura
   */
  async getInvoice(siigoInvoiceId) {
    try {
      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando consulta de factura...");
        return {
          id: siigoInvoiceId,
          number: `FV-TEST-${siigoInvoiceId}`,
          date: new Date().toISOString().split("T")[0],
          total: 0,
          status: "test",
        };
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await fetch(
        `${apiUrl}/v1/invoices/${siigoInvoiceId}`,
        {
          method: "GET",
          headers,
        }
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error(
        `Error al consultar factura ${siigoInvoiceId}:`,
        error.message
      );
      throw new Error(`Error al consultar factura en Siigo: ${error.message}`);
    }
  },

  /**
   * Procesa órdenes completadas pendientes de facturación
   * @returns {Object} - Resumen del procesamiento
   */
  async processCompletedOrders() {
    try {
      console.log("Buscando órdenes completadas pendientes de facturación...");

      // Buscar órdenes de tipo sale, estado completed, sin siigoId
      const orders = await strapi.entityService.findMany(ORDER_SERVICE, {
        filters: {
          type: "sale",
          state: "completed",
          siigoId: { $null: true },
          customerForInvoice: { id: { $notNull: true } },
        },
        populate: [
          "customerForInvoice",
          "customerForInvoice.taxes",
          "orderProducts",
          "orderProducts.product",
        ],
        limit: 50, // Procesar máximo 50 a la vez
      });

      if (!orders || orders.length === 0) {
        console.log("No hay órdenes pendientes de facturación");
        return {
          success: true,
          processed: 0,
          successful: 0,
          failed: 0,
          results: [],
        };
      }

      console.log(`Encontradas ${orders.length} órdenes para facturar`);

      const results = [];
      let successful = 0;
      let failed = 0;

      for (const order of orders) {
        try {
          const result = await this.createInvoiceForOrder(order.id);
          results.push({
            orderId: order.id,
            orderCode: order.code,
            success: true,
            invoice: result.invoice,
          });
          successful++;
        } catch (error) {
          console.error(`Error al facturar orden ${order.code}:`, error.message);
          results.push({
            orderId: order.id,
            orderCode: order.code,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }

      console.log(`Procesamiento completado. Exitosas: ${successful}, Fallidas: ${failed}`);

      return {
        success: true,
        processed: orders.length,
        successful,
        failed,
        results,
      };
    } catch (error) {
      console.error("Error al procesar órdenes completadas:", error.message);
      throw error;
    }
  },

  /**
   * Crea una nota crédito en Siigo (para devoluciones)
   * @param {Number} orderId - ID de la orden de devolución
   * @returns {Object} - Nota crédito creada
   */
  async createCreditNote(orderId) {
    try {
      // TODO: Implementar creación de notas crédito
      // Similar a createInvoiceForOrder pero para tipo 'return'
      throw new Error("Creación de notas crédito aún no implementada");
    } catch (error) {
      console.error("Error al crear nota crédito:", error.message);
      throw error;
    }
  },
});
