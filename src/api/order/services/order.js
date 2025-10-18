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
  recalculateOrderProducts,
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
              `Orden partial-invoice inválida:\n- ${validation.errors.join("\n- ")}`
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
            state: ORDER_STATES.DRAFT,
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
                await runInBatches(items, (item) =>
                  strapi.service(ORDER_SERVICE).doItemMovement({
                    movementType: ITEM_MOVEMENT_TYPES.CREATE,
                    item,
                    order,
                    orderProduct,
                    product,
                    orderState: order.state,
                    trx,
                  })
                );
              }

              // Actualización del OrderProduct con cantidades finales
              await orderProductService.update({
                id: orderProduct.id,
                orderState: order.state,
                trx,
              });
            }
          );

          // Obtención del Order totalmente actualizado con todos los populates
          const updatedOrder = await strapi.entityService.findOne(
            ORDER_SERVICE,
            order.id,
            { populate: ORDER_POPULATE, transacting: trx }
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
        console.log("update", update);

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
          }
        );

        if (!currentOrder) {
          throw new Error("La orden a actualizar no existe");
        }

        // Validar que la orden pueda ser editada
        validateOrderIsEditable(currentOrder);

        // Obtener el nuevo estado del Order si llega, o tomar el estado actual
        const orderState = update?.state || currentOrder.state;

        // Si vienen productos para actualizar
        if (products.length > 0) {
          await updateOrderProducts(
            strapi,
            currentOrder,
            products,
            orderState,
            orderProductService,
            trx
          );
        }
        // Si no vienen productos pero hay productos existentes, actualizar sus estados
        else if (currentOrder.orderProducts.length > 0) {
          await updateExistingOrderProducts(
            strapi,
            currentOrder,
            orderState,
            trx
          );
        }

        // Actualizar OrderProducts con cantidades finales
        console.log("PRODUCTS", products);

        await recalculateOrderProducts(
          strapi,
          currentOrder.id,
          products,
          orderState,
          orderProductService,
          trx
        );

        // Actualizar y retornar la orden completa
        const updatedOrder = await strapi.entityService.update(
          ORDER_SERVICE,
          currentOrder.id,
          {
            data: update,
            populate: ORDER_POPULATE,
            transacting: trx,
          }
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
            populate: ["orderProducts", "orderProducts.items"],
            transacting: trx,
          }
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
          await runInBatches(items, (item) =>
            strapi.service(ORDER_SERVICE).doItemMovement({
              movementType: ITEM_MOVEMENT_TYPES.DELETE,
              item,
              order: currentOrder,
              orderProduct,
              trx,
            })
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
        itemService
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
          result = await strategy.delete({
            item,
            order,
            orderProduct,
            orderType,
            parentItem,
            movements,
            trx,
          });
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
          }
        );

        if (!currentOrder) {
          throw new Error("La orden no existe");
        }

        validateOrderIsEditable(currentOrder);

        // Obtención del OrderProduct actual para el Item
        let orderProductData = currentOrder.orderProducts.find(
          (op) => op.product.id === productId
        );

        let product;
        let orderProduct;

        if (!orderProductData) {
          // Obtener el producto
          product = await strapi.entityService.findOne(
            PRODUCT_SERVICE,
            productId,
            { transacting: trx }
          );

          if (!product) {
            throw new Error("El producto no existe");
          }

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
          product = orderProductData.product;
          orderProduct = orderProductData;
        }

        // Agregar el item
        const addedItem = await strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.CREATE,
          item,
          order: currentOrder,
          orderProduct,
          product,
          orderState: currentOrder.state,
          trx,
        });

        // Actualizar el OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });

        // Emitir evento WebSocket
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:item-added", { ...addedItem, product });

        logger.debug(`Item added to order`, {
          orderId: currentOrder.id,
          itemId: addedItem?.id,
        });

        return { ...addedItem, product: product.id };
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
          }
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
          (op) => op.product.id == item.product.id
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
}));
