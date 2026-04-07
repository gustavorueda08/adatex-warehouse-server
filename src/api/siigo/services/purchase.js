"use strict";

const logger = require("../../../utils/logger");
const { ORDER_SERVICE } = require("../../../utils/services");

/**
 * Servicio de creación y actualización de soporte contable (Factura de Compra)
 * en Siigo para órdenes de type "purchase".
 */
module.exports = ({ strapi }) => ({
  /**
   * Crea una factura de compra en Siigo para una orden de compra.
   * Auto-sincroniza productos sin siigoId antes de enviar.
   *
   * @param {number|string} orderId - ID de la orden de compra.
   * @returns {Promise<{ purchaseSiigoId: string, purchaseInvoiceNumber: string }>}
   */
  async createPurchaseInvoice(orderId) {
    try {
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: {
          supplier: { populate: { taxes: true } },
          orderProducts: { populate: { product: true } },
          destinationWarehouse: true,
        },
      });

      if (!order) throw new Error(`Orden con ID ${orderId} no encontrada`);
      if (order.type !== "purchase") {
        throw new Error("Solo órdenes de tipo 'purchase' pueden generar soporte contable");
      }
      if (order.purchaseSiigoId) {
        throw new Error("Esta orden ya tiene un soporte contable en Siigo");
      }
      if (!order.supplier?.identification) {
        throw new Error("El proveedor no tiene NIT/identificación configurado");
      }

      // Auto-sync productos sin siigoId
      const siigoProductService = strapi.service("api::siigo.product");
      for (const op of order.orderProducts || []) {
        const basePrice = parseFloat(op.price);
        if (isNaN(basePrice) || basePrice <= 0) continue;
        if (op.product && !op.product.siigoId) {
          logger.info(
            `Auto-sincronizando producto ${op.product.code || op.product.name} con Siigo antes del soporte contable...`
          );
          try {
            let siigoProduct = null;
            if (op.product.code) {
              siigoProduct = await siigoProductService.searchInSiigoByCode(op.product.code);
            }
            if (siigoProduct) {
              await strapi.db.query("api::product.product").update({
                where: { id: op.product.id },
                data: { siigoId: String(siigoProduct.id) },
              });
              op.product.siigoId = String(siigoProduct.id);
              logger.info(`✓ Producto enlazado con Siigo existente: ${siigoProduct.id}`);
            } else {
              const syncResult = await siigoProductService.syncToSiigo(op.product.id);
              op.product.siigoId = syncResult.siigoId;
              logger.info(`✓ Producto creado en Siigo: ${syncResult.siigoId}`);
            }
          } catch (syncError) {
            logger.error(
              `Error auto-sincronizando producto ${op.product.code}:`,
              syncError.message
            );
          }
        }
      }

      const documentTypeId = await this._getDocumentTypeId();
      const costCenterId = await this._resolveCostCenter(order);

      const authService = strapi.service("api::siigo.auth");
      const mapperService = strapi.service("api::siigo.mapper");

      const purchaseData = mapperService.mapOrderToPurchaseInvoice(
        order, documentTypeId, "create", costCenterId
      );
      logger.debug("Datos soporte contable (crear):", JSON.stringify(purchaseData, null, 2));

      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
      const response = await authService.authenticatedFetch(`${apiUrl}/v1/purchases`, {
        method: "POST",
        body: JSON.stringify(purchaseData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Error de Siigo al crear soporte contable:", errorText);
        throw new Error(`Error de Siigo (${response.status}): ${errorText}`);
      }

      const siigoResult = await response.json();
      logger.info(`✓ Soporte contable creado en Siigo: ${siigoResult.id}`);

      await strapi.entityService.update(ORDER_SERVICE, orderId, {
        data: {
          purchaseSiigoId: String(siigoResult.id),
          purchaseInvoiceNumber: String(siigoResult.number || siigoResult.id),
        },
      });

      strapi.io?.to(`order:${orderId}`).emit("order:purchase-invoice-created", {
        orderId,
        purchaseSiigoId: String(siigoResult.id),
        purchaseInvoiceNumber: String(siigoResult.number || siigoResult.id),
      });

      return {
        purchaseSiigoId: String(siigoResult.id),
        purchaseInvoiceNumber: String(siigoResult.number || siigoResult.id),
      };
    } catch (error) {
      logger.error(
        `Error al crear soporte contable para Order ${orderId}:`,
        error.message
      );
      throw error;
    }
  },

  /**
   * Actualiza la factura de compra existente en Siigo con cantidades confirmadas.
   *
   * @param {number|string} orderId - ID de la orden de compra.
   * @returns {Promise<{ purchaseSiigoId: string, purchaseInvoiceNumber: string }>}
   */
  async updatePurchaseInvoice(orderId) {
    try {
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: {
          supplier: { populate: { taxes: true } },
          orderProducts: { populate: { product: true } },
          destinationWarehouse: true,
        },
      });

      if (!order) throw new Error(`Orden con ID ${orderId} no encontrada`);
      if (!order.purchaseSiigoId) {
        throw new Error(
          "Esta orden no tiene soporte contable en Siigo. Use 'Crear Soporte Contable' primero."
        );
      }

      const documentTypeId = await this._getDocumentTypeId();
      const costCenterId = await this._resolveCostCenter(order);

      const authService = strapi.service("api::siigo.auth");
      const mapperService = strapi.service("api::siigo.mapper");

      const purchaseData = mapperService.mapOrderToPurchaseInvoice(
        order, documentTypeId, "update", costCenterId
      );
      logger.debug("Datos soporte contable (actualizar):", JSON.stringify(purchaseData, null, 2));

      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
      const response = await authService.authenticatedFetch(
        `${apiUrl}/v1/purchases/${order.purchaseSiigoId}`,
        {
          method: "PUT",
          body: JSON.stringify(purchaseData),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Error de Siigo al actualizar soporte contable:", errorText);
        throw new Error(`Error de Siigo (${response.status}): ${errorText}`);
      }

      const siigoResult = await response.json();
      logger.info(`✓ Soporte contable actualizado en Siigo: ${siigoResult.id}`);

      strapi.io?.to(`order:${orderId}`).emit("order:purchase-invoice-updated", {
        orderId,
        purchaseSiigoId: String(siigoResult.id),
        purchaseInvoiceNumber: String(siigoResult.number || siigoResult.id),
      });

      return {
        purchaseSiigoId: String(siigoResult.id),
        purchaseInvoiceNumber: String(siigoResult.number || siigoResult.id),
      };
    } catch (error) {
      logger.error(
        `Error al actualizar soporte contable para Order ${orderId}:`,
        error.message
      );
      throw error;
    }
  },

  /**
   * Deriva el ID de centro de costos a usar en la factura.
   * Prioridad:
   *   1. order.siigoCostCenterId — seleccionado manualmente en el frontend
   *   2. Derivado automáticamente del containerCode: "ADX23-2025-1" → "ADX23-2025"
   *   3. null — sin centro de costos
   *
   * @param {Object} order - Orden con `siigoCostCenterId` y `containerCode`.
   * @returns {Promise<number|null>}
   */
  async _resolveCostCenter(order) {
    // 1. ID ya resuelto previamente
    if (order.siigoCostCenterId) {
      return parseInt(order.siigoCostCenterId);
    }

    // 2. Usar el nombre guardado en el formulario, o derivar del containerCode
    const costCenterName =
      order.siigoCostCenterName ||
      (order.containerCode ? order.containerCode.replace(/-\d+$/, "") : null);

    if (!costCenterName) return null;

    const costCenterService = strapi.service("api::siigo.cost-center");
    const resolvedId = await costCenterService.getOrCreate(costCenterName);

    // Guardar el ID resuelto en la orden para evitar lookups futuros
    if (resolvedId) {
      try {
        await strapi.entityService.update(ORDER_SERVICE, order.id, {
          data: { siigoCostCenterId: String(resolvedId) },
        });
      } catch (err) {
        logger.warn(`No se pudo guardar siigoCostCenterId en Order ${order.id}:`, err.message);
      }
    }
    return resolvedId;
  },

  /**
   * Obtiene el ID del tipo de documento FC en Siigo.
   * Primero busca en la variable de entorno SIIGO_PURCHASE_DOCUMENT_ID;
   * si no está, hace GET /v1/document-types?type=FC.
   *
   * @returns {Promise<number>}
   */
  async _getDocumentTypeId() {
    if (process.env.SIIGO_PURCHASE_DOCUMENT_ID) {
      return parseInt(process.env.SIIGO_PURCHASE_DOCUMENT_ID);
    }

    const authService = strapi.service("api::siigo.auth");
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
    const response = await authService.authenticatedFetch(
      `${apiUrl}/v1/document-types?type=FC`,
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error("No se pudo obtener el tipo de documento FC de Siigo");
    }

    const data = await response.json();
    const docType = Array.isArray(data) ? data[0] : data?.results?.[0];
    if (!docType?.id) {
      throw new Error("No se encontró ningún tipo de documento FC en Siigo");
    }
    return docType.id;
  },
});
