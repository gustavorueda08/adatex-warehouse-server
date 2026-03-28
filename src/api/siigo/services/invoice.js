"use strict";

const logger = require("../../../utils/logger");
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

      // ========== AUTO-SYNC PRODUCTOS CON SIIGO ==========
      if (order.orderProducts && order.orderProducts.length > 0) {
        const siigoProductService = strapi.service("api::siigo.product");
        for (const op of order.orderProducts) {
          // Ignorar productos que son regalos (sin precio o precio 0)
          let basePrice = parseFloat(op.price);
          if (isNaN(basePrice) || basePrice <= 0) {
            continue;
          }

          if (op.product && !op.product.siigoId) {
            logger.info(
              `Auto-sincronizando producto ${op.product.code || op.product.name} con Siigo antes de facturar...`,
            );
            try {
              let siigoProduct = null;
              if (op.product.code) {
                siigoProduct = await siigoProductService.searchInSiigoByCode(
                  op.product.code,
                );
              }

              if (siigoProduct) {
                await strapi.db.query("api::product.product").update({
                  where: { id: op.product.id },
                  data: { siigoId: String(siigoProduct.id) },
                });
                // Actualizar en el objeto de memoria para que pase la validación
                op.product.siigoId = String(siigoProduct.id);
                logger.info(
                  `✓ Producto enlazado con Siigo existente: ${siigoProduct.id}`,
                );
              } else {
                const syncResult = await siigoProductService.syncToSiigo(
                  op.product.id,
                );
                // Actualizar en el objeto de memoria para que pase la validación
                op.product.siigoId = syncResult.siigoId;
                logger.info(
                  `✓ Producto creado en Siigo: ${syncResult.siigoId}`,
                );
              }
            } catch (syncError) {
              console.error(
                `Error auto-sincronizando producto ${op.product.code}:`,
                syncError.message,
              );
              // Continuamos, la validación fallará y reportará el error adecuadamente
            }
          }
        }
      }

      const validation = await mapperService.validateOrderForInvoicing(order);
      if (!validation.valid) {
        throw new Error(
          `Orden no válida para facturación:\n- ${validation.errors.join("\n- ")}`,
        );
      }

      // Dividir orderProducts en grupos para facturación dual
      const {
        splitOrderProductsForDualInvoices,
      } = require("../../order/utils/invoiceHelpers");
      const { needsSplit, typeAProducts, typeBProducts } =
        splitOrderProductsForDualInvoices(order);

      logger.info(
        `Orden ${order.code} - Necesita split: ${needsSplit ? "SÍ" : "NO"}`,
      );
      logger.info(`  - Productos tipo A: ${typeAProducts.length}`);
      logger.info(`  - Productos tipo B: ${typeBProducts.length}`);

      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
      let invoiceTypeA = null;
      let invoiceTypeB = null;

      // ========== CREAR FACTURA TIPO A (ELECTRÓNICA) ==========
      if (typeAProducts.length > 0) {
        try {
          logger.info("Creando factura tipo A (electrónica)...");
          const orderTypeA = { ...order, orderProducts: typeAProducts };
          const invoiceDataTypeA = await mapperService.mapOrderToInvoice(
            orderTypeA,
            28338,
          );
          logger.debug(
            "Datos factura tipo A:",
            JSON.stringify(invoiceDataTypeA, null, 2),
          );
          invoiceTypeA = await this._sendInvoiceToSiigo(
            invoiceDataTypeA,
            apiUrl,
            authService,
          );
          logger.info(`✓ Factura tipo A creada: ${invoiceTypeA.id}`);
        } catch (error) {
          console.error("Error al crear factura tipo A:", error.message);
          throw new Error(
            `Error al crear factura tipo A (electrónica): ${error.message}`,
          );
        }
      } else {
        logger.info("No hay productos para factura Tipo A (todo va a Tipo B)");
      }

      // ========== CREAR FACTURA TIPO B (NORMAL) SI ES NECESARIO ==========
      if (needsSplit) {
        try {
          logger.info("Creando factura tipo B (normal)...");
          const orderTypeB = {
            ...order,
            customerForInvoice: { ...order.customerForInvoice, taxes: [] }, // Sin impuestos para Tipo B
            orderProducts: typeBProducts,
          };
          // Tipo B usa documentId 12200 y costCenter 11534
          const invoiceDataTypeB = await mapperService.mapOrderToInvoice(
            orderTypeB,
            12200,
            11534,
          );

          logger.debug(
            "Datos factura tipo B:",
            JSON.stringify(invoiceDataTypeB, null, 2),
          );

          invoiceTypeB = await this._sendInvoiceToSiigo(
            invoiceDataTypeB,
            apiUrl,
            authService,
          );
          logger.info(`✓ Factura tipo B creada: ${invoiceTypeB.id}`);
        } catch (error) {
          console.error("Error al crear factura tipo B:", error.message);
          // IMPORTANTE: Si falla tipo B, y se creó A, no revertir A
          // Solo loggear el error y continuar. Si A no se creó, lanzamos error.
          if (invoiceTypeA) {
            console.warn(
              "⚠ Factura tipo A fue creada exitosamente, pero tipo B falló. Continuar con precaución.",
            );
          } else {
            throw new Error(
              `Error al crear factura tipo B: ${error.message}. (No se creó Tipo A)`,
            );
          }
        }
      }

      // Si no se creó ninguna factura, lanzar error (orden vacía o error de lógica)
      if (!invoiceTypeA && !invoiceTypeB) {
        throw new Error(
          "No se creó ninguna factura (ni Tipo A ni Tipo B). Verifique los productos.",
        );
      }

      // ========== ACTUALIZAR ORDEN CON LOS SIIGO IDS Y ENTIDADES INVOICE ==========
      const invoiceIds = [];
      const updateData = {};

      // Sincronizar y asociar Factura A
      if (invoiceTypeA) {
        const localInvoiceA = await this.syncLocalInvoice(invoiceTypeA);
        invoiceIds.push(localInvoiceA.id);

        // Retrocompatibilidad
        updateData.siigoIdTypeA = String(invoiceTypeA.id);
        updateData.invoiceNumberTypeA = String(
          invoiceTypeA.number || invoiceTypeA.id,
        );
        updateData.siigoId = String(invoiceTypeA.id);
        updateData.invoiceNumber = String(
          invoiceTypeA.number || invoiceTypeA.id,
        );
      }

      // Sincronizar y asociar Factura B
      if (invoiceTypeB) {
        const localInvoiceB = await this.syncLocalInvoice(invoiceTypeB);
        invoiceIds.push(localInvoiceB.id);

        // Retrocompatibilidad
        updateData.siigoIdTypeB = String(invoiceTypeB.id);
        updateData.invoiceNumberTypeB = String(
          invoiceTypeB.number || invoiceTypeB.id,
        );

        // Si no hay factura A, usar B para los campos legacy
        if (!invoiceTypeA) {
          updateData.siigoId = String(invoiceTypeB.id);
          updateData.invoiceNumber = String(
            invoiceTypeB.number || invoiceTypeB.id,
          );
        }
      }

      // Actualizar la relación 'invoices' y desactivar el flag emitInvoice
      updateData.invoices = invoiceIds;
      updateData.emitInvoice = false;

      logger.debug(
        "Updating Order with data:",
        JSON.stringify(updateData, null, 2),
      );

      const updateResult = await strapi.entityService.update(
        ORDER_SERVICE,
        orderId,
        {
          data: updateData,
        },
      );

      logger.debug(
        "Order update result:",
        JSON.stringify(updateResult, null, 2),
      );

      // ========== MARCAR ITEMS COMO FACTURADOS ==========
      const orderWithItems = await strapi.entityService.findOne(
        ORDER_SERVICE,
        orderId,
        { populate: ["items"] },
      );

      const itemIds = orderWithItems.items?.map((i) => i.id) || [];
      if (itemIds.length > 0) {
        const {
          markItemsAsInvoiced,
        } = require("../../order/utils/invoiceHelpers");
        await markItemsAsInvoiced(itemIds);
        logger.info(`${itemIds.length} items marcados como facturados`);
      }

      logger.info(
        `✓ Order ${order.code} actualizada con facturas:${invoiceTypeA ? " Tipo A" : ""}${invoiceTypeB ? " Tipo B" : ""}`,
      );

      // ========== RETORNAR RESULTADO ==========
      // Construir respuesta robusta
      const result = {
        success: true,
        testMode: false,
        order: {
          id: order.id,
          code: order.code,
        },
        invoiceTypeA: invoiceTypeA
          ? {
              siigoId: invoiceTypeA.id,
              number: invoiceTypeA.number,
              date: invoiceTypeA.date,
              total: invoiceTypeA.total,
            }
          : null,
        invoiceTypeB: invoiceTypeB
          ? {
              siigoId: invoiceTypeB.id,
              number: invoiceTypeB.number,
              date: invoiceTypeB.date,
              total: invoiceTypeB.total,
            }
          : null,
      };

      // Mantener retrocompatibilidad en el campo 'invoice'
      // Si existe A, usa A. Si no, usa B.
      const mainInvoice = invoiceTypeA || invoiceTypeB;
      result.invoice = {
        siigoId: mainInvoice.id,
        number: mainInvoice.number,
        date: mainInvoice.date,
        total: mainInvoice.total,
      };

      return result;
    } catch (error) {
      console.error(
        `Error al crear factura para Order ID ${orderId}:`,
        error.message,
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
  async _sendInvoiceToSiigo(invoiceData, apiUrl, authService, retryCount = 0) {
    // 6.2 Recurse to handle token refresh if needed (though authenticatedFetch handles 401, we might keep this for other retries)
    // Actually, since we are moving to authenticatedFetch which handles 401, we can simplify this.
    // However, the original code had 401 handling inside _sendInvoiceToSiigo with recursion.
    // authenticatedFetch already does the token refresh.
    // But we need to handle the specific retry logic for 400 errors (rounding issues).

    let response = await authService.authenticatedFetch(
      `${apiUrl}/v1/invoices`,
      {
        method: "POST",
        body: JSON.stringify(invoiceData),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error("Error de Siigo:", errorData);

      if (response.status === 400 && retryCount < 3) {
        // Lógica de reintento para errores de totales (redondeo)
        logger.info(
          `Error 400 recibido (Intento ${retryCount + 1}). Intentando extraer valor correcto para reintento...`,
        );
        try {
          // Extraer todos los números del mensaje de error
          // Soporte para puntos y comas: "123.45" o "123,45"
          // Regex: digitos, seguido opcionalmente de punto/coma y más digitos
          const numbers = errorData.match(/[\d]+[.,]?[\d]*/g);

          if (numbers && numbers.length >= 2) {
            const currentTotal = invoiceData.payments[0].value;
            let newTotal = null;

            // Convertir strings a floats y buscar un valor plausible
            // Mejor lógica: Buscar el candidato que sea NUMÉRICO, DIFERENTE al actual y NO sea el código de error (400)
            let bestCandidate = null;
            let minDiff = Infinity;

            for (const numStr of numbers) {
              // Normalizar: cambiar coma por punto
              const normalizedStr = numStr.replace(",", ".");
              const val = parseFloat(normalizedStr);

              if (isNaN(val)) continue;

              // Ignorar el status code (400) o valores irreales (ej: 0)
              if (val === 400 || val === 0) continue;

              const diff = Math.abs(val - currentTotal);

              // Debe ser diferente al actual (si es igual, no arreglamos nada)
              // Usamos un epsilon pequeño para comparar floats
              if (diff < 0.0001) continue;

              logger.debug(`[Siigo Retry] Candidato: ${val} (Diff: ${diff})`);

              // Nos quedamos con el que tenga la menor diferencia (o simplemente el primero válido si confiamos en el mensaje)
              // En el mensaje de error de Siigo, el valor esperado suele ser el único otro número decimal grande.
              if (diff < minDiff) {
                minDiff = diff;
                bestCandidate = val;
              }
            }

            if (bestCandidate !== null) {
              newTotal = bestCandidate;
              // break; // No hacemos break para evaluar todos y encontrar el mejor
            }

            if (newTotal !== null) {
              logger.info(
                `[Siigo Retry] Ajustando total de pago: ${currentTotal} -> ${newTotal}`,
              );

              // Crear copia profunda para no mutar el original inesperadamente si hubiera más lógicas
              const newInvoiceData = JSON.parse(JSON.stringify(invoiceData));
              newInvoiceData.payments[0].value = newTotal;

              return await this._sendInvoiceToSiigo(
                newInvoiceData,
                apiUrl,
                authService,
                retryCount + 1,
              );
            }
          }
        } catch (retryError) {
          console.error("Fallo en lógica de reintento:", retryError);
          // Fallthrough al error original
        }

        throw new Error(`Error HTTP ${response.status}: ${errorData}`);
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
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await authService.authenticatedFetch(
        `${apiUrl}/v1/invoices/${siigoInvoiceId}`,
        {
          method: "GET",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return await response.json();
    } catch (error) {
      console.error(
        `Error al consultar factura ${siigoInvoiceId}:`,
        error.message,
      );
      throw new Error(`Error al consultar factura en Siigo: ${error.message}`);
    }
  },

  /**
   * Busca facturas por número en Siigo
   * @param {String|Number} number - Número de consecutivo
   * @returns {Array} - Lista de facturas encontradas
   */
  async getInvoicesByNumber(number) {
    try {
      const authService = strapi.service("api::siigo.auth");
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      // Intentamos filtrar por número si la API lo soporta.
      // Siigo API v1 suele tener ?number= o ?name=
      const response = await authService.authenticatedFetch(
        `${apiUrl}/v1/invoices?number=${number}&page=1&page_size=10`,
        {
          method: "GET",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      // La respuesta de Siigo para listas suele tener "results"
      return data.results || [];
    } catch (error) {
      console.error(
        `Error al buscar facturas por número ${number}:`,
        error.message,
      );
      // Retornar vacío en caso de error para no bloquear el flujo completo, o lanzar?
      // Mejor lanzar para que controller sepa que falló la búsqueda.
      throw new Error(`Error al buscar facturas en Siigo: ${error.message}`);
    }
  },

  /**
   * Descarga el PDF de una factura en Siigo
   * @param {String} siigoInvoiceId - ID de la factura en Siigo
   * @returns {Buffer} - Contenido del PDF
   */
  async downloadInvoicePdf(siigoInvoiceId) {
    try {
      const authService = strapi.service("api::siigo.auth");
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await authService.authenticatedFetch(
        `${apiUrl}/v1/invoices/${siigoInvoiceId}/pdf`,
        {
          method: "GET",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const payload = await response.json();
      const base64Content = payload?.base64 || payload?.Base64;

      if (!base64Content) {
        throw new Error("Respuesta de Siigo sin campo base64");
      }

      const sanitized = base64Content
        .replace(/^data:application\/pdf;base64,/, "")
        .replace(/\s+/g, "");

      return Buffer.from(sanitized, "base64");
    } catch (error) {
      console.error(
        `Error al descargar el PDF de la factura ${siigoInvoiceId}:`,
        error.message,
      );
      throw new Error(
        `Error al descargar PDF de factura en Siigo: ${error.message}`,
      );
    }
  },

  /**
   * Procesa órdenes completadas pendientes de facturación
   * @returns {Object} - Resumen del procesamiento
   */
  async processCompletedOrders() {
    try {
      logger.info("Buscando órdenes completadas pendientes de facturación...");

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
        logger.info("No hay órdenes pendientes de facturación");
        return {
          success: true,
          processed: 0,
          successful: 0,
          failed: 0,
          results: [],
        };
      }

      logger.info(`Encontradas ${orders.length} órdenes para facturar`);

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
            error.message,
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

      logger.info(
        `Procesamiento completado. Exitosas: ${successful}, Fallidas: ${failed}`,
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

  /**
   * Crea o actualiza una entidad Invoice local basada en datos de Siigo
   * @param {Object} siigoInvoiceData - Datos crudos de la factura de Siigo
   * @returns {Object} - Entidad Invoice de Strapi
   */
  async syncLocalInvoice(siigoInvoiceData) {
    const { id, number, date, total, document } = siigoInvoiceData;
    // Tratar de determinar el prefijo si viene en 'document'
    const prefix = document?.id || "";
    // Tipo (simplificado, se puede refinar)
    const type = "Electronic"; // Asumimos default por ahora

    // Buscar si ya existe
    const existing = await strapi.db.query("api::invoice.invoice").findOne({
      where: { siigoId: id },
    });

    if (existing) {
      return await strapi.entityService.update(
        "api::invoice.invoice",
        existing.id,
        {
          data: {
            number: Number(number),
            date,
            total,
            prefix: String(prefix),
          },
        },
      );
    } else {
      return await strapi.entityService.create("api::invoice.invoice", {
        data: {
          siigoId: id,
          number: Number(number),
          date,
          total,
          prefix: String(prefix),
          type,
        },
      });
    }
  },
});
