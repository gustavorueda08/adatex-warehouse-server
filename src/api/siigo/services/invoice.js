"use strict";

const { ORDER_SERVICE } = require("../../../utils/services");
const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de creación y gestión de facturas en Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Crea una o dos facturas en Siigo para una orden específica
   * Genera factura tipo A (electrónica) y opcionalmente tipo B (normal) según invoicePercentage
   * @param {Number} orderId - ID de la orden
   * @param {Object} options - Opciones adicionales
   * @returns {Object} - Factura(s) creada(s)
   */
  async createInvoiceForOrder(orderId, options = {}) {
    try {
      // Obtener la orden con todos los datos necesarios
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: [
          "customerForInvoice",
          "customerForInvoice.taxes",
          "orderProducts",
          "orderProducts.product",
          "customer",
          "customer.seller",
        ],
      });

      if (!order) {
        throw new Error(`Orden con ID ${orderId} no encontrada`);
      }

      const authService = strapi.service("api::siigo.auth");
      const mapperService = strapi.service("api::siigo.mapper");

      const validation = await mapperService.validateOrderForInvoicing(order);
      if (!validation.valid) {
        throw new Error(
          `Orden no válida para facturación:\n- ${validation.errors.join("\n- ")}`
        );
      }

      // Dividir orderProducts en grupos para facturación dual
      const {
        splitOrderProductsForDualInvoices,
      } = require("../../order/utils/invoiceHelpers");
      const { needsSplit, typeAProducts, typeBProducts } =
        splitOrderProductsForDualInvoices(order);

      console.log(
        `Orden ${order.code} - Necesita split: ${needsSplit ? "SÍ" : "NO"}`
      );
      console.log(`  - Productos tipo A: ${typeAProducts.length}`);
      console.log(`  - Productos tipo B: ${typeBProducts.length}`);

      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
      let invoiceTypeA = null;
      let invoiceTypeB = null;

      // ========== CREAR FACTURA TIPO A (ELECTRÓNICA) ==========
      try {
        console.log("Creando factura tipo A (electrónica)...");
        const orderTypeA = { ...order, orderProducts: typeAProducts };
        const invoiceDataTypeA = await mapperService.mapOrderToInvoice(
          orderTypeA,
          28338
        );
        console.log(
          "Datos factura tipo A:",
          JSON.stringify(invoiceDataTypeA, null, 2)
        );
        invoiceTypeA = await this._sendInvoiceToSiigo(
          invoiceDataTypeA,
          apiUrl,
          authService
        );
        console.log(`✓ Factura tipo A creada: ${invoiceTypeA.id}`);
      } catch (error) {
        console.error("Error al crear factura tipo A:", error.message);
        throw new Error(
          `Error al crear factura tipo A (electrónica): ${error.message}`
        );
      }

      // ========== CREAR FACTURA TIPO B (NORMAL) SI ES NECESARIO ==========
      if (needsSplit) {
        try {
          console.log("Creando factura tipo B (normal)...");
          const orderTypeB = {
            ...order,
            customerForInvoice: { ...order.customerForInvoice, taxes: [] },
            orderProducts: typeBProducts,
          };
          const invoiceDataTypeB = await mapperService.mapOrderToInvoice(
            orderTypeB,
            12200,
            11534
          );

          console.log(
            "Datos factura tipo B:",
            JSON.stringify(invoiceDataTypeB, null, 2)
          );

          invoiceTypeB = await this._sendInvoiceToSiigo(
            invoiceDataTypeB,
            apiUrl,
            authService
          );
          console.log(`✓ Factura tipo B creada: ${invoiceTypeB.id}`);
        } catch (error) {
          console.error("Error al crear factura tipo B:", error.message);
          // IMPORTANTE: Si falla tipo B, no revertir tipo A
          // Solo loggear el error y continuar
          console.warn(
            "⚠ Factura tipo A fue creada exitosamente, pero tipo B falló. Continuar con precaución."
          );
        }
      }

      // ========== ACTUALIZAR ORDEN CON LOS SIIGO IDS ==========
      const updateData = {
        siigoIdTypeA: String(invoiceTypeA.id),
        invoiceNumberTypeA: invoiceTypeA.number || invoiceTypeA.id,
        // Mantener retrocompatibilidad con campos antiguos
        siigoId: String(invoiceTypeA.id),
        invoiceNumber: invoiceTypeA.number || invoiceTypeA.id,
      };

      if (invoiceTypeB) {
        updateData.siigoIdTypeB = String(invoiceTypeB.id);
        updateData.invoiceNumberTypeB = invoiceTypeB.number || invoiceTypeB.id;
      }

      await strapi.db.query(ORDER_SERVICE).update({
        where: { id: orderId },
        data: updateData,
      });

      // ========== MARCAR ITEMS COMO FACTURADOS ==========
      const orderWithItems = await strapi.entityService.findOne(
        ORDER_SERVICE,
        orderId,
        { populate: ["items"] }
      );

      const itemIds = orderWithItems.items?.map((i) => i.id) || [];
      if (itemIds.length > 0) {
        const {
          markItemsAsInvoiced,
        } = require("../../order/utils/invoiceHelpers");
        await markItemsAsInvoiced(itemIds);
        console.log(`${itemIds.length} items marcados como facturados`);
      }

      console.log(
        `✓ Order ${order.code} actualizada con facturas tipo A${invoiceTypeB ? " y tipo B" : ""}`
      );

      // ========== RETORNAR RESULTADO ==========
      return {
        success: true,
        testMode: false,
        order: {
          id: order.id,
          code: order.code,
        },
        invoiceTypeA: {
          siigoId: invoiceTypeA.id,
          number: invoiceTypeA.number,
          date: invoiceTypeA.date,
          total: invoiceTypeA.total,
        },
        invoiceTypeB: invoiceTypeB
          ? {
              siigoId: invoiceTypeB.id,
              number: invoiceTypeB.number,
              date: invoiceTypeB.date,
              total: invoiceTypeB.total,
            }
          : null,
        // Mantener retrocompatibilidad
        invoice: {
          siigoId: invoiceTypeA.id,
          number: invoiceTypeA.number,
          date: invoiceTypeA.date,
          total: invoiceTypeA.total,
        },
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
   * Helper interno: Envía una factura a Siigo y maneja reintentos de autenticación
   * @param {Object} invoiceData - Datos de la factura en formato Siigo
   * @param {String} apiUrl - URL base de la API de Siigo
   * @param {Object} authService - Servicio de autenticación
   * @returns {Object} - Respuesta de Siigo con la factura creada
   */
  async _sendInvoiceToSiigo(invoiceData, apiUrl, authService) {
    const headers = await authService.getAuthHeaders();

    let response = await siigoFetch(`${apiUrl}/v1/invoices`, {
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

        response = await siigoFetch(`${apiUrl}/v1/invoices`, {
          method: "POST",
          headers: newHeaders,
          body: JSON.stringify(invoiceData),
        });

        if (!response.ok) {
          const retryError = await response.text();
          throw new Error(
            `Error HTTP ${response.status} después de renovar token: ${retryError}`
          );
        }
      } else {
        throw new Error(`Error HTTP ${response.status}: ${errorData}`);
      }
    }

    const siigoInvoice = await response.json();

    if (!siigoInvoice || !siigoInvoice.id) {
      throw new Error("Respuesta inválida de Siigo al crear factura");
    }

    return siigoInvoice;
  },

  /**
   * Consulta una factura en Siigo
   * @param {String} siigoInvoiceId - ID de la factura en Siigo
   * @returns {Object} - Datos de la factura
   */
  async getInvoice(siigoInvoiceId) {
    try {
      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(
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
          console.error(
            `Error al facturar orden ${order.code}:`,
            error.message
          );
          results.push({
            orderId: order.id,
            orderCode: order.code,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }

      console.log(
        `Procesamiento completado. Exitosas: ${successful}, Fallidas: ${failed}`
      );

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
