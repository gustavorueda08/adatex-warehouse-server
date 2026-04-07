"use strict";

const logger = require("../../../../utils/logger");

module.exports = {
  async afterUpdate(event) {
    try {
      // ========== 1. Facturación automática ==========
      const { result, params } = event;
      logger.info("Order updated", { result, params });
      const stateChangedToCompleted =
        result?.state === "completed" &&
        (params?.data?.state === "completed" || params?.data?.completedDate);

      const stateChangedToConfirmed =
        result?.state === "confirmed" && params?.data?.state === "confirmed";

      if (!stateChangedToCompleted && !stateChangedToConfirmed) {
        logger.info("Order updated, but not completed or confirmed");
        return;
      }

      const { ORDER_POPULATE } = require("../../utils/orderHelpers");

      const freshOrder = await strapi.entityService.findOne(
        "api::order.order",
        result.id,
        { populate: ORDER_POPULATE },
      );

      if (!freshOrder) {
        logger.warn(`Order ${result.id} not found in afterUpdate lifecycle`);
        return;
      }

      // ========== Soporte contable de compra (al confirmar) ==========
      if (stateChangedToConfirmed && freshOrder.type === "purchase") {
        const canAutoCreate =
          !freshOrder.purchaseSiigoId &&
          freshOrder.supplier?.identification &&
          freshOrder.supplierInvoiceNumber;

        if (canAutoCreate) {
          try {
            logger.info(
              `Order ${freshOrder.code} confirmada. Creando soporte contable en Siigo...`
            );
            const purchaseService = strapi.service("api::siigo.purchase");
            await purchaseService.createPurchaseInvoice(freshOrder.id);
          } catch (err) {
            logger.error(
              `Error al crear soporte contable para Order ${freshOrder.code}:`,
              err.message
            );
            strapi.io?.to(`order:${freshOrder.id}`).emit("order:purchase-invoice-error", {
              orderId: freshOrder.id,
              error: err.message,
            });
          }
        }
        return;
      }

      if (freshOrder.type !== "sale") return;

      // La facturación de órdenes de venta ya no se dispara desde el lifecycle.
      // Se usa el endpoint dedicado POST /api/orders/:orderId/sale-invoice
      // (manejado por order.createSaleInvoice en el controlador).

      // ========== 2. Sincronizar precios del customer ==========
      if (freshOrder.customer) {
        try {
          const customerId = freshOrder.customer.id;

          for (const op of freshOrder.orderProducts || []) {
            const productId = op.product?.id;
            const price = parseFloat(op.price) || 0;

            if (!productId || price <= 0) continue;

            const existingPrices = await strapi.entityService.findMany(
              "api::price.price",
              {
                filters: { customer: customerId, product: productId },
                limit: 1,
              },
            );

            const priceData = {
              unitPrice: price,
              ivaIncluded: op.ivaIncluded ?? true,
              invoicePercentage: parseFloat(op.invoicePercentage) || 0,
            };

            if (existingPrices.length > 0) {
              await strapi.entityService.update(
                "api::price.price",
                existingPrices[0].id,
                { data: priceData },
              );
              logger.debug(
                `Price actualizado: customer ${customerId}, product ${productId}: ${price}`,
              );
            } else {
              await strapi.entityService.create("api::price.price", {
                data: {
                  ...priceData,
                  customer: customerId,
                  product: productId,
                },
              });
              logger.debug(
                `Price creado: customer ${customerId}, product ${productId}: ${price}`,
              );
            }
          }

          logger.info(
            `Precios sincronizados para customer ${customerId} desde Order ${freshOrder.code}`,
          );
        } catch (priceError) {
          logger.error(
            `Error al sincronizar precios desde Order ${freshOrder.code}:`,
            priceError.message,
          );
        }
      }

      // ========== 3. Sincronizar precios del supplier (orden de compra) ==========
      if (freshOrder.type === "purchase" && freshOrder.supplier) {
        try {
          const supplierId = freshOrder.supplier.id;

          for (const op of freshOrder.orderProducts || []) {
            const productId = op.product?.id;
            const price = parseFloat(op.price) || 0;

            if (!productId || price <= 0) continue;

            const existingPrices = await strapi.entityService.findMany(
              "api::price.price",
              {
                filters: { supplier: supplierId, product: productId },
                limit: 1,
              },
            );

            const priceData = {
              unitPrice: price,
              ivaIncluded: op.ivaIncluded ?? true, // Aunque en suppliers es menos común, mantengamos consistencia
            };

            if (existingPrices.length > 0) {
              await strapi.entityService.update(
                "api::price.price",
                existingPrices[0].id,
                { data: priceData },
              );
              logger.debug(
                `Price actualizado: supplier ${supplierId}, product ${productId}: ${price}`,
              );
            } else {
              await strapi.entityService.create("api::price.price", {
                data: {
                  ...priceData,
                  supplier: supplierId,
                  product: productId,
                },
              });
              logger.debug(
                `Price creado: supplier ${supplierId}, product ${productId}: ${price}`,
              );
            }
          }

          logger.info(
            `Precios sincronizados para supplier ${supplierId} desde Order ${freshOrder.code}`,
          );
        } catch (priceError) {
          logger.error(
            `Error al sincronizar precios de proveedor desde Order ${freshOrder.code}:`,
            priceError.message,
          );
        }
      }
    } catch (error) {
      console.error("Error en lifecycle afterUpdate de Order:", error.message);
    }
  },
};
