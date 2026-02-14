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

      if (!stateChangedToCompleted) {
        logger.info("Order updated, but not completed");
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

      if (freshOrder.type !== "sale") return;

      const shouldInvoice =
        freshOrder.emitInvoice === true &&
        freshOrder.customerForInvoice &&
        !freshOrder.siigoIdTypeA &&
        !freshOrder.siigoIdTypeB;

      if (shouldInvoice) {
        try {
          logger.info(
            `Order ${freshOrder.code} completada. Iniciando facturación automática...`,
          );

          const invoiceService = strapi.service("api::siigo.invoice");
          const invoiceResult = await invoiceService.createInvoiceForOrder(
            freshOrder.id,
          );

          if (invoiceResult.invoiceTypeB) {
            logger.info(
              `Facturas creadas para Order ${freshOrder.code}: Tipo A: ${invoiceResult.invoiceTypeA.siigoId}, Tipo B: ${invoiceResult.invoiceTypeB.siigoId}`,
            );
          } else {
            logger.info(
              `Factura tipo A creada para Order ${freshOrder.code}: ${invoiceResult.invoiceTypeA.siigoId}`,
            );
          }

          const updatedOrder = await strapi.entityService.findOne(
            "api::order.order",
            freshOrder.id,
            {
              populate: ORDER_POPULATE,
              // Intentar bypassear cache si es posible (depende de plugins de cache, pero no hace daño)
              _cache: false,
            },
          );

          strapi.io
            ?.to(`order:${freshOrder.id}`)
            .emit("order:invoice-created", {
              order: updatedOrder,
              invoiceTypeA: invoiceResult.invoiceTypeA,
              invoiceTypeB: invoiceResult.invoiceTypeB,
              invoice: invoiceResult.invoice,
            });
        } catch (invoiceError) {
          logger.error(
            `Error al facturar Order ${freshOrder.code}:`,
            invoiceError.message,
          );
          strapi.io?.to(`order:${freshOrder.id}`).emit("order:invoice-error", {
            orderId: freshOrder.id,
            orderCode: freshOrder.code,
            error: invoiceError.message,
          });
        }
      }

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
