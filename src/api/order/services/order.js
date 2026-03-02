"use strict";
const moment = require("moment-timezone");
const ORDER_TYPES = require("../../../utils/orderTypes");
const runInBatches = require("../../../utils/runInBatches");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");
const logger = require("../../../utils/logger");

const {
  ORDER_PRODUCT_SERVICE,
  ITEM_SERVICE,
  PRODUCT_SERVICE,
  ORDER_SERVICE,
} = require("../../../utils/services");

const { withValidation } = require("../../../validation/withValidation");
const {
  CreateOrderSchema,
  UpdateOrderSchema,
  DeleteOrderSchema,
  DoItemMovementSchema,
  AddItemToOrderSchema,
  RemoveItemFromOrderSchema,
} = require("../../../validation/schemas");

const {
  validateOrderIsEditable,
  generateOrderNumber,
  updateOrderProducts,
  updateExistingOrderProducts,
  syncOrderProducts,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
} = require("../utils/orderHelpers");

const {
  ItemMovementStrategyFactory,
} = require("../strategies/itemMovementStrategies");

/**
 * Order service - Versión optimizada y refactorizada
 */
const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::order.order", ({ strapi }) => ({
  /**
   * Crea un Order, OrderProducts y asocia o crea Items al OrderProduct y al Order
   */
  create: withValidation(CreateOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        moment.tz.setDefault("America/Bogota");

        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const code = await generateOrderNumber(strapi, data.type, trx);
        const { products = [], ...orderData } = data;

        // Validaciones especiales para partial-invoice
        if (data.type === ORDER_TYPES.PARTIAL_INVOICE) {
          const {
            validatePartialInvoiceOrder,
          } = require("../utils/invoiceHelpers");
          const validation = await validatePartialInvoiceOrder(data, { trx });

          if (!validation.valid) {
            throw new Error(
              `Orden partial-invoice inválida:\n- ${validation.errors.join("\n- ")}`,
            );
          }

          // Usar el customer de la orden padre si no se especifica
          if (!orderData.customer && validation.parentOrder?.customer) {
            orderData.customer = validation.parentOrder.customer.id;
          }

          // Usar customerForInvoice de la orden padre si no se especifica
          if (
            !orderData.customerForInvoice &&
            validation.parentOrder?.customerForInvoice
          ) {
            orderData.customerForInvoice =
              validation.parentOrder.customerForInvoice.id;
          }
        }

        // Creación del Order
        let order = await strapi.entityService.create(ORDER_SERVICE, {
          data: {
            ...orderData,
            code,
            state: orderData.state || ORDER_STATES.DRAFT,
            createdDate: moment().toDate(),
          },
          populate: ORDER_POPULATE_BASIC,
          transacting: trx,
        });

        // Si hay products, crear OrderProducts e Items
        if (products.length > 0) {
          await runInBatches(
            products,
            async ({ items = [], ...productData }) => {
              // Creación del OrderProduct
              const orderProduct = await orderProductService.create({
                ...productData,
                order: order.id,
                trx,
              });

              const { product } = orderProduct;

              // Procesar Items
              if (items.length > 0) {
                await runInBatches(
                  items,
                  (item) =>
                    strapi.service(ORDER_SERVICE).doItemMovement({
                      movementType: ITEM_MOVEMENT_TYPES.CREATE,
                      item,
                      order,
                      orderProduct,
                      product,
                      orderState: order.state,
                      trx,
                    }),
                  1,
                );
              }

              // Actualización del OrderProduct con cantidades finales
              await orderProductService.update({
                id: orderProduct.id,
                orderState: order.state,
                trx,
              });
            },
          );

          // Obtención del Order totalmente actualizado con todos los populates
          const updatedOrder = await strapi.entityService.findOne(
            ORDER_SERVICE,
            order.id,
            { populate: ORDER_POPULATE, transacting: trx },
          );

          // Emitir evento WebSocket
          strapi.io
            ?.to(`order:${updatedOrder.id}`)
            .emit("order:created", updatedOrder);

          logger.info(`Order created successfully`, {
            orderId: updatedOrder.id,
            code,
          });

          return updatedOrder;
        }

        return order;
      } catch (error) {
        logger.error("Error creating order", error);
        throw error;
      }
    });
  }),

  /**
   * Actualiza un Order y crea, modifica o asocia OrderProducts y Items
   */
  update: withValidation(UpdateOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const { id, products = [], update = {} } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);

        // Obtención de la orden actual con todos los datos necesarios
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.items",
              "orderProducts.items.product",
              "orderProducts.items.warehouse",
              "orderProducts.product",
              "destinationWarehouse",
              "sourceWarehouse",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden a actualizar no existe");
        }

        // Validar que la orden pueda ser editada
        validateOrderIsEditable(currentOrder);

        // Obtener el nuevo estado del Order si llega, o tomar el estado actual
        const orderState = update?.state || currentOrder.state;

        // Si vienen productos para actualizar (incluso array vacío)
        if (data.products) {
          await updateOrderProducts(
            strapi,
            currentOrder,
            products,
            orderState,
            orderProductService,
            trx,
            update.destinationWarehouse,
          );
        }

        // Sincronizar OrderProducts (actualizar y eliminar huérfanos)
        if (data.products) {
          await syncOrderProducts(
            strapi,
            currentOrder.id,
            products,
            orderState,
            orderProductService,
            trx,
          );
        }

        // Si el estado de la orden cambió, pero no se enviaron productos
        // Asegurar que los items existentes se actualicen (ej. para recibir destinationWarehouse)
        if (!data.products && currentOrder.state !== orderState) {
          await updateExistingOrderProducts(
            strapi,
            currentOrder,
            orderState,
            trx,
            update.destinationWarehouse,
          );
        }

        // Lógica para asociar facturas manuales (universal para sale y partial-invoice)
        // Se espera: manualInvoiceNumbers: ["123", "195"]
        if (
          update.manualInvoiceNumbers &&
          Array.isArray(update.manualInvoiceNumbers)
        ) {
          const siigoService = strapi.service("api::siigo.invoice");
          const foundInvoicesIds = [];

          for (const numStr of update.manualInvoiceNumbers) {
            const num = parseInt(numStr, 10);
            if (isNaN(num)) continue;

            try {
              const results = await siigoService.getInvoicesByNumber(num);
              // Results puede ser un array con coincidencias.
              // Siigo puede retornar varias si hay distintos prefijos con mismo número?
              // Por ahora tomamos el primero que coincida o todos.

              if (results && results.length > 0) {
                for (const invData of results) {
                  // Solo si coincide el número exactamente (por si la búsqueda fue laxa)
                  if (invData.number === num) {
                    const localInvoice =
                      await siigoService.syncLocalInvoice(invData);
                    foundInvoicesIds.push(localInvoice.id);
                  }
                }
              } else {
                logger.warn(
                  `No se encontró factura con número ${num} en Siigo`,
                );
              }
            } catch (err) {
              logger.warn(
                `Error buscando factura manual ${num}: ${err.message}`,
              );
            }
          }

          if (foundInvoicesIds.length > 0) {
            // Asociar a la orden vía 'invoices' relation
            // OJO: Queremos AGREGAR, no reemplazar? O reemplazar?
            // Usualmente si mando una lista, espero que esa sea LA lista.
            // Pero cuidado con no borrar historial si se edita.
            // Asumiremos que el frontend manda la lista acumulada o se reemplaza.
            // Para seguridad, hacemos merge con los que ya tenga?
            // Mejor reemplazar para permitir correcciones (quitar una factura erronea).

            update.invoices = foundInvoicesIds;

            // Si la orden NO tiene siigoId antiguo, le ponemos el de la primera factura para retrocompatibilidad visual
            // (aunque ya no deberíamos depender de eso, pero el frontend puede usarlo)
            const firstInv = await strapi.entityService.findOne(
              "api::invoice.invoice",
              foundInvoicesIds[0],
            );
            if (firstInv) {
              if (!update.invoiceNumber) update.invoiceNumber = firstInv.number;
              if (!update.siigoId) update.siigoId = firstInv.siigoId; // Deprecated field
            }
          }
        }

        // Lógica antigua de siigoId single para retrocompatibilidad (si frontend manda siigoId en vez de manualInvoiceNumbers)
        if (
          !update.manualInvoiceNumbers &&
          currentOrder.type === ORDER_TYPES.PARTIAL_INVOICE &&
          (update.siigoId || update.siigoIdTypeA)
        ) {
          const siigoId = update.siigoIdTypeA || update.siigoId;
          // ... (lógica existente que busca por ID y actualiza campos antiguos) ...
          // Podríamos aprovechar para crear el Invoice entity también aquí
          try {
            const siigoService = strapi.service("api::siigo.invoice");
            const invoiceData = await siigoService.getInvoice(siigoId);
            if (invoiceData) {
              const localInvoice =
                await siigoService.syncLocalInvoice(invoiceData);
              update.invoices = [localInvoice.id]; // Asociar nueva entidad

              // Retrocompatibilidad campos planos
              update.invoiceNumber = invoiceData.number;
              update.invoiceNumberTypeA = invoiceData.number;
              if (!update.actualDepositPaymentDate) {
                update.actualDepositPaymentDate = invoiceData.date;
              }
            }
          } catch (e) {
            /* ignore */
          }
        }

        // Actualizar y retornar la orden completa
        const updatedOrder = await strapi.entityService.update(
          ORDER_SERVICE,
          currentOrder.id,
          {
            data: update,
            populate: ORDER_POPULATE,
            transacting: trx,
          },
        );

        // Emitir evento WebSocket
        strapi.io
          ?.to(`order:${updatedOrder.id}`)
          .emit("order:updated", updatedOrder);

        logger.info(`Order updated successfully`, { orderId: updatedOrder.id });

        return updatedOrder;
      } catch (error) {
        logger.error("Error updating order", error);
        throw error;
      }
    });
  }),

  /**
   * Elimina un Order y sus OrderProducts, sólo en caso de que su estado sea borrador o confirmado
   */
  delete: withValidation(DeleteOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const { id } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);

        // Obtención del Order existente
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.product",
              "orderProducts.items",
              "sourceWarehouse",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden a eliminar no existe");
        }

        // Validar que la orden pueda ser eliminada
        validateOrderIsEditable(currentOrder);

        // Eliminación de OrderProducts y sus Items
        await runInBatches(currentOrder.orderProducts, async (orderProduct) => {
          const items = orderProduct.items;

          // Eliminar o revertir items
          await runInBatches(
            items,
            (item) =>
              strapi.service(ORDER_SERVICE).doItemMovement({
                movementType: ITEM_MOVEMENT_TYPES.DELETE,
                item,
                order: currentOrder,
                orderProduct,
                product: orderProduct.product,
                trx,
              }),
            1,
          );

          // Eliminar OrderProduct
          await orderProductService.delete({ id: orderProduct.id, trx });
        });

        // Eliminación del Order
        await strapi.entityService.delete(ORDER_SERVICE, currentOrder.id, {
          transacting: trx,
        });

        // Emitir evento WebSocket
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:deleted", currentOrder.id);

        logger.info(`Order deleted successfully`, { orderId: currentOrder.id });

        return {
          order: currentOrder.id,
          state: "Deleted",
        };
      } catch (error) {
        logger.error("Error deleting order", error);
        throw error;
      }
    });
  }),

  /**
   * Realiza el movimiento del Item usando patrón Strategy
   */
  doItemMovement: withValidation(DoItemMovementSchema, async (data) => {
    try {
      const {
        movementType,
        item: itemData,
        order,
        orderProduct,
        product,
        trx,
        orderState,
      } = data;

      const itemService = strapi.service(ITEM_SERVICE);
      const { type: orderType } = order;
      const { parentItem, movements, ...item } = itemData;

      // Obtener la estrategia correcta según el tipo de orden
      const strategy = ItemMovementStrategyFactory.getStrategy(
        orderType,
        itemService,
      );

      // Ejecutar la operación correspondiente
      let result;

      switch (movementType) {
        case ITEM_MOVEMENT_TYPES.CREATE:
          result = await strategy.create({
            item,
            order,
            orderProduct,
            product,
            orderType,
            parentItem,
            trx,
          });
          break;

        case ITEM_MOVEMENT_TYPES.UPDATE:
          result = await strategy.update({
            item,
            order,
            orderProduct,
            product,
            orderState,
            orderType,
            trx,
          });
          break;

        case ITEM_MOVEMENT_TYPES.DELETE:
          if (product?.type === "cutItem") {
            const transformStrategy = ItemMovementStrategyFactory.getStrategy(
              require("../../../utils/orderTypes").TRANSFORM,
              itemService,
            );
            result = await transformStrategy.delete({
              item,
              order,
              orderProduct,
              orderType: require("../../../utils/orderTypes").TRANSFORM,
              parentItem,
              movements,
              trx,
            });
          } else {
            result = await strategy.delete({
              item,
              order,
              orderProduct,
              orderType,
              parentItem,
              movements,
              trx,
            });
          }
          break;

        default:
          throw new Error(`Invalid movement type: ${movementType}`);
      }

      return result;
    } catch (error) {
      logger.error("Error in doItemMovement", error);
      throw error;
    }
  }),

  /**
   * Agrega un Item al Order
   */
  addItem: withValidation(AddItemToOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item, product: productId } = data;

        // Obtención del Order actual
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.product",
              "sourceWarehouse",
              "destinationWarehouse",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden no existe");
        }

        validateOrderIsEditable(currentOrder);

        // Auto-transition DRAFT to CONFIRMED for sale and out orders
        if (
          currentOrder.state === ORDER_STATES.DRAFT &&
          (currentOrder.type === ORDER_TYPES.SALE ||
            currentOrder.type === ORDER_TYPES.OUT)
        ) {
          currentOrder.state = ORDER_STATES.CONFIRMED;
          await strapi.entityService.update(ORDER_SERVICE, currentOrder.id, {
            data: { state: currentOrder.state },
            transacting: trx,
          });
        }

        let orderProductData = currentOrder.orderProducts.find(
          (op) => op.product.id === productId,
        );

        // Siempre obtener el producto completo para tener las relaciones necesarias (parentProduct, transformationFactor)
        const product = await strapi.entityService.findOne(
          require("../../../utils/services").PRODUCT_SERVICE,
          productId,
          {
            populate: ["parentProduct", "transformationFactor"],
            transacting: trx,
          },
        );

        if (!product) {
          throw new Error("El producto no existe");
        }

        let orderProduct;
        if (!orderProductData) {
          // Crear OrderProduct
          orderProduct = await orderProductService.create({
            product: product.id,
            order: currentOrder.id,
            requestedQuantity: 0,
            requestedPackages: 0,
            notes: "Producto agregado dinámicamente",
            trx,
          });
        } else {
          orderProduct = orderProductData;
        }

        let addedItemsList = [];

        if (
          product.type === "fixedQuantityPerItem" &&
          item.count !== undefined
        ) {
          const resolveWarehouse = () => {
            return item.warehouse || currentOrder.sourceWarehouse?.id || null;
          };

          let filters = {
            product: product.id,
            state: require("../../../utils/itemStates").AVAILABLE,
          };
          const whId = resolveWarehouse();
          if (whId) filters.warehouse = whId;

          const availableItems = await strapi.entityService.findMany(
            require("../../../utils/services").ITEM_SERVICE,
            {
              filters,
              limit: item.count,
              transacting: trx,
            },
          );

          if (availableItems.length < item.count) {
            throw new Error(
              `No hay suficientes items disponibles para ${product.name}. Solicitados: ${item.count}, Disponibles: ${availableItems.length}`,
            );
          }

          for (const aItem of availableItems) {
            const addedItem = await strapi
              .service(ORDER_SERVICE)
              .doItemMovement({
                movementType: ITEM_MOVEMENT_TYPES.CREATE,
                item: aItem,
                order: currentOrder,
                orderProduct,
                product,
                orderState: currentOrder.state,
                trx,
              });
            addedItemsList.push(addedItem);
          }
        } else if (
          product.type === "cutItem" &&
          (item.quantity !== undefined || item.quantities !== undefined)
        ) {
          const quantities = Array.isArray(item.quantities)
            ? item.quantities
            : [item.quantity];

          if (!product.parentProduct) {
            throw new Error(
              `El producto ${product.name} es type cutItem pero no tiene parentProduct configurado.`,
            );
          }

          let factor = 1;
          let multiplySource = false;
          if (product.transformationFactor) {
            factor = parseFloat(product.transformationFactor.factor) || 1;
            // If the transformation rule is defined as: Child Unit -> Parent Unit
            // Example: 1 meter (cut) = 0.5 kg (parent). Factor = 0.5
            // Target is 10 meters. Consumed = 10 * 0.5 = 5kg.
            if (
              product.transformationFactor.sourceUnit === product.unit &&
              product.transformationFactor.destinationUnit ===
                product.parentProduct.unit
            ) {
              multiplySource = true;
            }
            // Otherwise, assume rule is Parent Unit -> Child Unit
            // Example: 1 kg (parent) = 2 meters (cut). Factor = 2
            // Target is 10 meters. Consumed = 10 / 2 = 5kg.
            else {
              multiplySource = false;
            }
          }

          const smartCutWarehouses = await strapi.entityService.findMany(
            require("../../../utils/services").WAREHOUSE_SERVICE,
            {
              filters: {
                type: { $in: ["smartCut", "printLab"] },
                isActive: true,
              },
              transacting: trx,
            },
          );

          if (smartCutWarehouses.length === 0) {
            throw new Error(
              "No hay bodegas configuradas como smartCut o printLab",
            );
          }
          const smartCutWhIds = smartCutWarehouses.map((w) => w.id);

          for (const targetQty of quantities) {
            let sourceQuantityConsumed = parseFloat(targetQty);
            if (factor !== 1) {
              sourceQuantityConsumed = multiplySource
                ? sourceQuantityConsumed * factor
                : sourceQuantityConsumed / factor;
            }

            // Fetch enough available parent items to potentially fulfill the request
            const availableParentItems = await strapi.entityService.findMany(
              require("../../../utils/services").ITEM_SERVICE,
              {
                filters: {
                  product: product.parentProduct.id,
                  state: require("../../../utils/itemStates").AVAILABLE,
                  warehouse: { $in: smartCutWhIds },
                },
                sort: { currentQuantity: "desc" },
                limit: 50, // Fetch up to 50 parent rolls to ensure we have enough
                populate: ["warehouse", "product"],
                transacting: trx,
              },
            );

            if (availableParentItems.length === 0) {
              throw new Error(
                `No hay items de ${product.parentProduct.name} disponibles en bodegas smartCut o printLab para cortar.`,
              );
            }

            let remainingSourceQty = sourceQuantityConsumed;
            let parentItemIndex = 0;
            const sourceItemsConsumedMap = [];

            while (remainingSourceQty > 0) {
              const sourceItem = availableParentItems[parentItemIndex];

              if (!sourceItem) {
                // We ran out of available items. Apply negative stock to the last known item if confirmed
                const lastSourceItem =
                  availableParentItems[availableParentItems.length - 1];
                if (!item.confirmNegativeStock && !item.forceNegativeStock) {
                  throw new Error(
                    JSON.stringify({
                      code: "NEGATIVE_STOCK",
                      message: `No hay suficiente stock en los rollos disponibles. Faltan ${remainingSourceQty} ${lastSourceItem.unit}. ¿Desea forzar el corte negativo en el último rollo disponible?`,
                    }),
                  );
                }

                // If confirmed, just dump the rest of the negative debt onto the last item
                sourceItemsConsumedMap.push({
                  id: lastSourceItem.id,
                  quantity: remainingSourceQty,
                });

                // Force break the loop as we handled the remainder
                remainingSourceQty = 0;
                break;
              }

              const consumedFromThisItem = Math.min(
                sourceItem.currentQuantity,
                remainingSourceQty,
              );

              // If this item is empty (e.g., 0 quantity), skip it
              if (consumedFromThisItem <= 0) {
                parentItemIndex++;
                continue;
              }

              sourceItemsConsumedMap.push({
                id: sourceItem.id,
                quantity: consumedFromThisItem,
              });

              remainingSourceQty -= consumedFromThisItem;

              // Proceed to next parent item if we still need more
              parentItemIndex++;
            }

            // Create ONE cutItem for the entire requested targetQty, mapping the multiple consumed sources
            const transformStrategy =
              require("../strategies/itemMovementStrategies").ItemMovementStrategyFactory.getStrategy(
                require("../../../utils/orderTypes").TRANSFORM,
                strapi.service(require("../../../utils/services").ITEM_SERVICE),
              );

            const newCutItem = await transformStrategy.create({
              item: {
                sourceItemsConsumed: sourceItemsConsumedMap,
                sourceQuantityConsumed: sourceQuantityConsumed,
                targetQuantity: targetQty,
                warehouse: item.warehouse || currentOrder.sourceWarehouse?.id,
                confirmNegativeStock: item.confirmNegativeStock,
                forceNegativeStock: item.forceNegativeStock,
              },
              order: currentOrder,
              orderProduct: orderProduct,
              trx,
              orderType: require("../../../utils/orderTypes").TRANSFORM,
              product: product,
              parentItem: null,
            });

            const addedItem = await strapi
              .service(ORDER_SERVICE)
              .doItemMovement({
                movementType: ITEM_MOVEMENT_TYPES.CREATE,
                item: newCutItem,
                order: currentOrder,
                orderProduct,
                product,
                orderState: currentOrder.state,
                trx,
              });

            addedItemsList.push(addedItem);
          }
        } else {
          const addedItem = await strapi.service(ORDER_SERVICE).doItemMovement({
            movementType: ITEM_MOVEMENT_TYPES.CREATE,
            item,
            order: currentOrder,
            orderProduct,
            product,
            orderState: currentOrder.state,
            trx,
          });
          addedItemsList.push(addedItem);
        }

        // Actualizar el OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });

        // Emitir evento WebSocket
        for (const addedItem of addedItemsList) {
          strapi.io
            ?.to(`order:${currentOrder.id}`)
            .emit("order:item-added", { ...addedItem, product });

          logger.debug(`Item added to order`, {
            orderId: currentOrder.id,
            itemId: addedItem?.id,
          });
        }

        return addedItemsList.length === 1
          ? { ...addedItemsList[0], product: product.id }
          : addedItemsList.map((i) => ({ ...i, product: product.id }));
      } catch (error) {
        logger.error("Error adding item to order", error);
        throw error;
      }
    });
  }),

  /**
   * Remueve un Item del Order
   */
  removeItem: withValidation(RemoveItemFromOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item: itemId } = data;

        // Obtención del Order actual
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.product",
              "orderProducts.items",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden no existe");
        }

        validateOrderIsEditable(currentOrder);

        // Obtención del Item
        const item = await strapi.entityService.findOne(ITEM_SERVICE, itemId, {
          populate: ["product", "orders"],
          transacting: trx,
        });

        if (!item) {
          throw new Error("El Item no pudo ser encontrado");
        }

        if (!item.orders?.find((o) => o.id === currentOrder.id)) {
          throw new Error("El Item no hace parte de esta orden");
        }

        // Obtención del OrderProduct que contiene el Item
        const orderProduct = currentOrder.orderProducts.find(
          (op) => op.product.id == item.product.id,
        );

        if (!orderProduct) {
          throw new Error("El OrderProduct no pudo ser encontrado");
        }

        // Remover el item
        const removedItem = await strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.DELETE,
          item,
          order: currentOrder,
          orderProduct,
          product: orderProduct.product,
          orderState: currentOrder.state,
          trx,
        });

        // Count remaining items across all orderProducts
        let totalItemsLeft = 0;
        for (const op of currentOrder.orderProducts) {
          const itemsLeft = op.items
            ? op.items.filter((i) => i.id !== removedItem.id).length
            : 0;
          totalItemsLeft += itemsLeft;
        }

        // Auto-transition CONFIRMED to DRAFT if order is now empty
        if (
          totalItemsLeft === 0 &&
          currentOrder.state === ORDER_STATES.CONFIRMED &&
          (currentOrder.type === ORDER_TYPES.SALE ||
            currentOrder.type === ORDER_TYPES.OUT)
        ) {
          currentOrder.state = ORDER_STATES.DRAFT;
          await strapi.entityService.update(ORDER_SERVICE, currentOrder.id, {
            data: { state: ORDER_STATES.DRAFT },
            transacting: trx,
          });
        }

        // Actualizar OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });

        // Emitir evento WebSocket
        strapi.io?.to(`order:${currentOrder.id}`).emit("order:item-removed", {
          ...removedItem,
          product: orderProduct.product,
        });

        logger.debug(`Item removed from order`, {
          orderId: currentOrder.id,
          itemId: removedItem?.id,
        });

        return { ...removedItem, product: orderProduct.product.id };
      } catch (error) {
        logger.error("Error removing item from order", error);
        throw error;
      }
    });
  }),

  /**
   * Descarga la factura asociada a la orden
   * @param {Number} orderId - ID de la orden
   * @param {String} type - Tipo de factura ('A', 'B' o 'ALL')
   * @returns {Object} - { buffer, mimeType, filename, type }
   */
  async downloadInvoice(orderId, type = "ALL") {
    try {
      // 1. Obtener la orden con customer
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: ["customer"],
      });

      if (!order) {
        throw new Error("Orden no encontrada");
      }

      const siigoInvoiceService = strapi.service("api::siigo.invoice");
      const archiver = require("archiver");
      const { Writable } = require("stream");
      const moment = require("moment");

      // Helper para nombre de cliente
      const getCustomerName = (customer) => {
        if (!customer) return "Unknown";
        const name = customer.name || "";
        const lastName = customer.lastName || "";
        return `${name} ${lastName}`.trim();
      };

      // Helper para fecha
      const getFormattedDate = (date) => {
        if (!date) return moment().format("DD-MM-YYYY");
        return moment(date).format("DD-MM-YYYY");
      };

      const customerName = getCustomerName(order.customer);
      const dateStr = getFormattedDate(order.actualDispatchDate);

      // Helper para generar nombres de archivo
      const getFilename = (invoiceType) => {
        if (invoiceType === "A") {
          const number = order.invoiceNumberTypeA || "SIN-NUMERO";
          return `ADTX-${number} - ${customerName} (${dateStr}).pdf`;
        }
        if (invoiceType === "B") {
          const number = order.invoiceNumberTypeB || "SIN-NUMERO";
          return `AD-${number} - ${customerName} (${dateStr}).pdf`;
        }
        return `invoice_${invoiceType}_${order.code || orderId}.pdf`;
      };

      // 2. Determinar IDs disponibles
      const idA = order.siigoIdTypeA || order.siigoId;
      const idB = order.siigoIdTypeB;

      // 3. Lógica para "ALL" (automático)
      if (type === "ALL") {
        // Caso 1: Ambas existen -> ZIP
        if (idA && idB) {
          const [pdfA, pdfB] = await Promise.all([
            siigoInvoiceService.downloadInvoicePdf(idA),
            siigoInvoiceService.downloadInvoicePdf(idB),
          ]);

          // Crear ZIP en memoria
          const chunks = [];
          const output = new Writable({
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          });

          return new Promise((resolve, reject) => {
            const archive = archiver("zip", { zlib: { level: 9 } });

            archive.on("error", (err) => reject(err));
            output.on("finish", () => {
              const buffer = Buffer.concat(chunks);
              const zipFilename = `Facturas - ${customerName} (${dateStr}).zip`;
              resolve({
                buffer,
                mimeType: "application/zip",
                filename: zipFilename,
                type: "zip",
              });
            });

            archive.pipe(output);
            archive.append(pdfA, { name: getFilename("A") });
            archive.append(pdfB, { name: getFilename("B") });
            archive.finalize();
          });
        }

        // Caso 2: Solo una existe -> PDF directo
        // Si hay A, devolvemos A. Si no hay A pero hay B (raro), devolvemos B.
        if (idA) {
          const pdfBuffer = await siigoInvoiceService.downloadInvoicePdf(idA);
          return {
            buffer: pdfBuffer,
            mimeType: "application/pdf",
            filename: getFilename("A"),
            type: "pdf",
          };
        }

        if (idB) {
          const pdfBuffer = await siigoInvoiceService.downloadInvoicePdf(idB);
          return {
            buffer: pdfBuffer,
            mimeType: "application/pdf",
            filename: getFilename("B"),
            type: "pdf",
          };
        }

        throw new Error("La orden no tiene facturas asociadas");
      }

      // 4. Lógica para tipos específicos ('A' o 'B')
      let siigoInvoiceId;
      let suffix; // Ya no se usa para el filename final, pero lo dejo por estructura

      if (type === "A") {
        siigoInvoiceId = idA;
        suffix = "A";
        if (!siigoInvoiceId) {
          throw new Error("La orden no tiene una factura Tipo A asociada");
        }
      } else if (type === "B") {
        siigoInvoiceId = idB;
        suffix = "B";
        if (!siigoInvoiceId) {
          throw new Error("La orden no tiene una factura Tipo B asociada");
        }
      } else {
        throw new Error("Tipo de factura inválido");
      }

      const pdfBuffer =
        await siigoInvoiceService.downloadInvoicePdf(siigoInvoiceId);

      return {
        buffer: pdfBuffer,
        mimeType: "application/pdf",
        filename: getFilename(type),
        type: "pdf",
      };
    } catch (error) {
      // Propagar error para que el controller lo maneje
      throw error;
    }
  },
}));
