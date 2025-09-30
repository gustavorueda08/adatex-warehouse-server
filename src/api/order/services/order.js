"use strict";
const moment = require("moment-timezone");
const ORDER_TYPES = require("../../../utils/orderTypes");
const runInBatches = require("../../../utils/runInBatches");
const ORDER_STATES = require("../../../utils/orderStates");
const {
  ORDER_PRODUCT_SERVICE,
  ITEM_SERVICE,
  PRODUCT_SERVICE,
  ORDER_SERVICE,
  WAREHOUSE_SERVICE,
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
const ITEM_STATES = require("../../../utils/itemStates");
const { reverse } = require("../../../../config/middlewares");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");

/**
 * order service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::order.order", ({ strapi }) => ({
  // Crea un Order, OrderProducts y asocia o crea Items al OrderProduct y al Order
  create: withValidation(CreateOrderSchema, async (data) => {
    try {
      // Declaración de función interna para crear el número del Order
      const generateOrderNumber = async (data) => {
        try {
          const { type, trx } = data;
          if (!type)
            throw new Error("Order type is required to generate order number.");

          let prefix = "";
          switch (type) {
            case "purchase":
              prefix = "PO";
              break;
            case "sale":
              prefix = "SO";
              break;
            case "transfer":
              prefix = "TR";
              break;
            case "return":
              prefix = "RT";
            case "cutting":
              prefix = "CT";
              break;
            case "disposal":
              prefix = "DS";
              break;
            default:
              prefix = "UN"; // Unknown
              break;
          }

          if (prefix === "UN") throw new Error("Invalid order type.");

          const date = new Date();
          const year = date.getFullYear().toString().slice(-2);
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          const dateString = `${year}${month}${day}`;
          const orderQuery = await strapi.entityService.findMany(
            "api::order.order",
            {
              filters: { type },
              sort: { createdAt: "desc" },
              limit: 1,
            },
            { transcting: trx }
          );
          if (orderQuery.length === 0) {
            return `${prefix}-${dateString}-1`;
          }
          return `${prefix}-${dateString}-${Number(orderQuery[0].id) + 1}`;
        } catch (error) {
          throw error;
        }
      };
      return await strapi.db.transaction(async (trx) => {
        // Obtención de variables
        moment.tz.setDefault("America/Bogota");
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const code = await generateOrderNumber({ type: data.type, trx });
        const { products, ...orderData } = data;
        // Creación del Order
        let order = await strapi.entityService.create(
          ORDER_SERVICE,
          {
            data: {
              ...orderData,
              code,
              state: "draft",
              createdDate: moment().toDate(),
            },
            populate: [
              "destinationWarehouse",
              "sourceWarehouse",
              "customer",
              "supplier",
              "generatedBy",
              "orderProducts",
            ],
          },
          { transacting: trx }
        );
        // Si hay products entonces debemos crear el OrderProduct y, si hay Items, entonces debemos crear o actualizar los Items
        if (products.length > 0) {
          // Recorer los Products para obtener la información del Product y los Items
          await runInBatches(products, async ({ items, ...productData }) => {
            // Creación del OrderProduct
            const orderProduct = await orderProductService.create({
              ...productData,
              order: order.id,
              trx,
            });
            const { product } = orderProduct;
            // Recorrer los Items
            // Agregación del Item al Order de acuerdo con el type del Order
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
            // Actualización del OrderProduct
            await orderProductService.update({
              id: orderProduct.id,
              orderState: order.state,
              trx,
            });
          });
          // Obtención y retorno del Order totalmente actualizado
          const updatedOrder = await strapi.entityService.findOne(
            ORDER_SERVICE,
            order.id,
            {
              populate: [
                "orderProducts",
                "orderProducts.items",
                "sourceWarehouse",
                "destinationWarehouse",
                "customer",
                "supplier",
                "movements",
                "generatedBy",
              ],
            },
            {
              transacting: trx,
            }
          );
          strapi.io
            ?.to(`order:${updatedOrder.id}`)
            .emit("order:created", updatedOrder);
          return updatedOrder;
        }
      });
    } catch (error) {
      throw error;
    }
  }),
  // Actualiza un Order y crea, modifica o asocia OrderProducts y Items
  update: withValidation(UpdateOrderSchema, async (data) => {
    try {
      return await strapi.db.transaction(async (trx) => {
        // Obtención de Variables
        const { id, products = [], update = {} } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        // Obtención de la orden actual
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
          },
          { transacting: trx }
        );
        if (!currentOrder) throw new Error("La orden a actualizar no existe");
        // Validación del estado de la orden para sólo modificar ordenes que esten en estado draft o confirmed
        if (!["draft", "confirmed"].includes(currentOrder.state)) {
          throw new Error(
            "Sólo las ordenes en borrador o confirmadas pueden ser modificadas"
          );
        }
        // Obtener el nuevo estado del Order si llega o tomar el estado del Order actual
        const orderState = update?.state || currentOrder.state;
        console.log("ESTADO NUEVO", orderState);

        // Validamos si viene una lista de productos para comparar con los productos actuales del Order y proceder con la modificación del Order
        if (products.length > 0) {
          // Obtención de todos los Items actuales de la orden en un Array
          const currentItems = currentOrder.orderProducts
            .map((orderProduct) => orderProduct.items)
            .flat();
          // Obtención de todos los Items requeridos, incluyendo en cada Item el ID del Product
          const itemsFromRequest = products
            .map(({ product, items }) =>
              items.map((item) => ({ ...item, product }))
            )
            .flat();
          // Función que saca la clave de cada item, utilizando ID o barcode
          const getKey = (item) => item?.id ?? item?.barcode;
          // Sets con las claves de cada Array, tanto el de los Items actuales, como el de los Items requeridos
          const currentKeys = new Set(currentItems.map(getKey));
          const requestKeys = new Set(itemsFromRequest.map(getKey));
          // Clasificación de los Items
          // Items a remover del Order
          const itemsToRemove = currentItems.filter(
            (i) => !requestKeys.has(getKey(i))
          );
          // Items que se mantienen en el Order
          const itemsToKeep = currentItems.filter((i) =>
            requestKeys.has(getKey(i))
          );
          // Items para agregar al Order
          const itemsToAdd = itemsFromRequest.filter(
            (i) => !currentKeys.has(getKey(i))
          );
          // Mostrar cuantos Items se eliminarán, cuantos se actualizarán y cuantos de agregarán
          console.log(`Items to remove: ${itemsToRemove.length}`);
          console.log(`Items to keep: ${itemsToKeep.length}`);
          console.log(`Items to add: ${itemsToAdd.length}`);
          // Remover del Order los Items que se encuentren en la lista itemsToRemove
          await runInBatches(itemsToRemove, async (item) => {
            // Obtención del OrderProduct que contiene el Item en el Order
            const orderProduct = currentOrder.orderProducts.find(
              (orderProduct) => orderProduct.product.id == item.product.id
            );
            // Remoción del Item
            await strapi.service(ORDER_SERVICE).doItemMovement({
              movementType: ITEM_MOVEMENT_TYPES.DELETE,
              item,
              order: currentOrder,
              orderProduct,
              product: orderProduct.product,
              orderState,
              trx,
            });
          });
          // Agregar Items que se encuentren en la lista itemsToAdd al Order
          await runInBatches(itemsToAdd, async (itemData) => {
            const {
              product: productId,
              id,
              sourceWarehouse,
              parentItem,
              ...item
            } = itemData;
            console.log(itemData, "ITEMDATA");

            // Creación de variable para guardar el Product completo
            let product;
            // Obtención del OrderProduct que concuerde con el ID del Product
            let orderProduct = currentOrder.orderProducts.find(
              ({ product }) => product.id == productId
            );
            // Si no hay OrderProduct significa que debemos crearlo
            if (!orderProduct) {
              product = await strapi.entityService.findOne(
                PRODUCT_SERVICE,
                productId,
                {},
                { transacting: trx }
              );
              if (!product) throw new Error("El producto no existe");

              // Creación del OrderProduct
              orderProduct = await orderProductService.create({
                product: product.id,
                order: currentOrder.id,
                requestedQuantity: 0,
                requestedPackages: 0,
                notes: "Producto agregado en actualización de lista de empaque",
                trx,
              });
            } else {
              product = orderProduct.product;
            }

            // Agregación del Item al Order de acuerdo con el type del Order
            await strapi.service(ORDER_SERVICE).doItemMovement({
              movementType: ITEM_MOVEMENT_TYPES.CREATE,
              item,
              update: { orderProduct, order: currentOrder },
              order: currentOrder,
              orderProduct: orderProduct,
              product: product,
              orderState,
              trx,
            });
          });
          // Actualizar Items que se mantienen en el Order
          await runInBatches(itemsToKeep, async (item) => {
            // Obtención de datos del Request
            const newItemData = itemsFromRequest.find((i) => i?.id == item.id);
            if (!newItemData)
              throw new Error("Error al actualizar item existente");
            // Obtención del OrderProduct desde los Items actuales del Order
            const orderProduct = currentOrder.orderProducts.find(
              (orderProduct) => orderProduct.items.find((i) => i.id === item.id)
            );
            // Si no hay OrderProduct no se prosigue
            if (!orderProduct)
              throw new Error(
                "El OrderProduct del Item a mantener no ha sido encontrado"
              );
            // Obtención del Product desde el Item y el resto del Data
            const { product, ...itemData } = item;
            // Obtención del destinationWarehouse, por si se necesita hacer una transferencia
            let destintationWarehouse = null;
            if (newItemData.warehouse) {
              destintationWarehouse = await strapi.entityService.findOne(
                WAREHOUSE_SERVICE,
                newItemData.warehouse,
                {},
                { transacting: trx }
              );
              if (!destintationWarehouse)
                throw new Error("La bodega de destino no existe");
            }
            // Elección del estado del Item de acuerdo con el estado y tipo de la orden
            await strapi.service(ORDER_SERVICE).doItemMovement({
              movementType: ITEM_MOVEMENT_TYPES.UPDATE,
              item: {
                ...itemData,
                warehouse: destintationWarehouse
                  ? destintationWarehouse
                  : itemData.warehouse,
                cuerrentQuantity:
                  newItemData.quantity || newItemData.currentQuantity
                    ? newItemData.quantity || newItemData.currentQuantity
                    : itemData.currentQuantity || itemData.quantity,
              },
              order: currentOrder,
              orderState,
              product,
              orderProduct,
              trx,
            });
          });
        }
        // Si no llegan Products entonces se actualizan los Items ya existentes de acuerdo con el estado del Order
        else if (currentOrder.orderProducts.length > 0) {
          // Obtención de los OrderProducts del Order actual
          const { orderProducts } = currentOrder;
          // Recorrer los OrderProducts
          for (const orderProduct of orderProducts) {
            // Si existen Items asociados al OrderProduct entonces se actualizan
            if (orderProduct.items.length > 0) {
              // Obtención de Datos
              const { items, product, ...orderProductData } = orderProduct;
              // Actualización de los Items de acuerdo con el tipo de Order y estado del Order
              await runInBatches(items, (item) =>
                strapi.service(ORDER_SERVICE).doItemMovement({
                  movementType: ITEM_MOVEMENT_TYPES.UPDATE,
                  item,
                  order: currentOrder,
                  orderState,
                  product,
                  orderProduct: orderProductData,
                  trx,
                })
              );
            }
          }
        }
        // Obtención de OrderProducts
        const orderProducts = await strapi.entityService.findMany(
          ORDER_PRODUCT_SERVICE,
          {
            filters: {
              order: currentOrder.id,
            },
            populate: ["product"],
          },
          { transacting: trx }
        );
        if (!orderProducts)
          throw new Error("La orden no tiene productos asociados");
        // Actualizar OrderProducts
        await runInBatches(orderProducts, async (orderProduct) => {
          // Obtención del Product asociado al OrderProduct
          const { product } = orderProduct;
          // Obtención de los datos del Request si es que llegan
          const dataFromRequest = products.find(
            (p) => p.product === product.id
          );
          // Objeto para el update del OrderProduct
          const update = {};
          // Si llega requestedQuantity, llenamos el update con este dato para actualizar el OrderItem
          if (dataFromRequest && dataFromRequest?.requestedQuantity) {
            const { requestedQuantity } = dataFromRequest;
            update.requestedQuantity = requestedQuantity;
            update.requestedPackages = Math.round(
              requestedQuantity / product.unitsPerPackage
            );
          }
          // Actualización del OrderItem
          await orderProductService.update({
            id: orderProduct.id,
            update,
            orderState,
            trx,
          });
        });
        // Actualizar y retornar la orden completa
        const updatedOrder = await strapi.entityService.update(
          ORDER_SERVICE,
          currentOrder.id,
          {
            data: update,
            populate: [
              "orderProducts",
              "orderProducts.items",
              "orderProducts.items.warehouse",
              "orderProducts.product",
              "sourceWarehouse",
              "destinationWarehouse",
            ],
          },
          { transacting: trx }
        );
        strapi.io
          ?.to(`order:${updatedOrder.id}`)
          .emit("order:updated", updatedOrder);
        return updatedOrder;
      });
    } catch (error) {
      throw error;
    }
  }),
  // Elimina un Order y sus OrderProducts, sólo en caso de que su estado sea borrador
  delete: withValidation(DeleteOrderSchema, async (data) => {
    try {
      return await strapi.db.transaction(async (trx) => {
        // Obtención de variables
        const { id } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const itemService = strapi.service(ITEM_SERVICE);
        // Obtención del Order existente
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: ["orderProducts", "orderProducts.items"],
          },
          { transacting: trx }
        );
        if (!currentOrder) throw new Error("La orden a eliminar no existe");
        // Verificar que el Order esté en borrador
        if (!["draft", "confirmed"].includes(currentOrder.state)) {
          throw new Error(
            "Sólo las ordenes en borrador o confirmadas pueden ser eliminadas"
          );
        }
        // Obtención de los Items del Order
        const items = currentOrder.orderProducts.map((op) => op.items).flat();

        // Eliminación de OrderProducts y eliminación o desanclado de los Items
        await runInBatches(currentOrder.orderProducts, async (orderProduct) => {
          await runInBatches(items, async (item) => {
            switch (currentOrder.type) {
              case ORDER_TYPES.SALE:
              case ORDER_TYPES.OUT:
                await itemService.update({
                  id: item.id,
                  reverse: true,
                  update: { state: ITEM_STATES.AVAILABLE },
                  trx,
                });
                break;
              case ORDER_TYPES.PURCHASE:
              case ORDER_TYPES.IN:
                await itemService.delete({
                  id: item.id,
                  order: currentOrder.id,
                  orderProduct: orderProduct.id,
                  trx,
                });
                break;
              case ORDER_TYPES.RETURN:
                await itemService.update({
                  id: item.id,
                  reverse: true,
                  update: { state: ITEM_STATES.SOLD, warehouse: null },
                  trx,
                });
                break;
              case ORDER_TYPES.TRANSFER:
                await itemService.update({
                  id: item.id,
                  reverse: true,
                  udpade: { warehouse: currentOrder.sourceWarehouse.id },
                  trx,
                });
                break;
              case ORDER_TYPES.ADJUSTMENT:
                break;
              case ORDER_TYPES.CUT:
              default:
                break;
            }
          });
          // Eliminación del OrderProduct
          await orderProductService.delete({ id: orderProduct.id, trx });
        });
        // Eliminación del Order
        await strapi.entityService.delete(ORDER_SERVICE, currentOrder.id, {
          transacting: trx,
        });
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:deleted", currentOrder.id);
        return {
          order: currentOrder.id,
          state: "Deleted",
        };
      });
    } catch (error) {
      throw error;
    }
  }),
  // Realiza el movimiento del Item de acuerdo con el tipo del Order y el state del Order, además de tener en cuenta el movementType
  doItemMovement: withValidation(DoItemMovementSchema, async (data) => {
    try {
      // Obtenemos variables
      const {
        movementType,
        item: itemData,
        order,
        orderProduct,
        product,
        trx,
        orderState, // Estado de la orden que tendrá después de todas las actualizaciones, si las hay, o estado inicial del Order
      } = data;

      const itemService = strapi.service(ITEM_SERVICE);
      const { type: orderType, destinationWarehouse, sourceWarehouse } = order;
      const { parentItem, movements, ...item } = itemData;
      // TODO: Agregar el emit del IO a cada item si viene en el data una variable en true
      // Movimiento del Item para agregación al Order
      if (movementType === ITEM_MOVEMENT_TYPES.CREATE) {
        // De acuerdo con el type del Order
        switch (orderType) {
          // Para caso Purchase e IN se crea un Item nuevo
          case ORDER_TYPES.PURCHASE:
          case ORDER_TYPES.IN:
            await itemService.create({
              ...item,
              state: ITEM_STATES.AVAILABLE,
              sourceOrder: order.id,
              orderProduct: orderProduct.id,
              product: {
                id: product.id,
                unit: product.unit,
                name: product.name,
                code: product.code,
                barcode: product.barcode,
              },
              warehouse: destinationWarehouse.id,
              trx,
            });
            break;
          // Para caso Return se actualiza el Item existente a disponible
          case ORDER_TYPES.RETURN:
            await itemService.update({
              ...item,
              state: ITEM_STATES.AVAILABLE,
              order: order.id,
              orderProduct: orderProduct.id,
              trx,
            });
            break;
          // Para caso Sale se actualiza el Item existente a reservado
          case ORDER_TYPES.SALE:
            await itemService.update({
              ...item,
              update: {
                state: ITEM_STATES.RESERVED,
                order: order.id,
                orderProduct: orderProduct.id,
              },
              type: orderType,
              trx,
            });
            break;
          // Para caso Out se actualiza el Item existente a desechado, quitandolo del warehouse donde esté
          case ORDER_TYPES.OUT:
            await itemService.update({
              ...item,
              state: ITEM_STATES.DROPPED,
              order: order.id,
              orderProduct: orderProduct.id,
              update: { warehouse: null },
              trx,
            });
            break;
          // Para caso Transfer, se actualiza el Item existente cambiandolo de bodega al destinationWarehouse del Order
          case ORDER_TYPES.TRANSFER:
            await itemService.update({
              ...item,
              warehouse: destinationWarehouse.id,
              order: order.id,
              orderProduct: orderProduct.id,
              trx,
            });
            break;
          // Para caso Adjustment (normalmente cantidades), se actualiza el Item existente cambiando lo que venga en Item
          case ORDER_TYPES.ADJUSTMENT:
            await itemService.update({
              ...item,
              order: order.id,
              orderProduct: orderProduct.id,
              trx,
            });
            break;
          // Para caso Cut, se crea un nuevo Item que toma como padre el Item inicial y se actualiza la cantidad actual del Item padre
          case ORDER_TYPES.CUT:
            await itemService.create({
              ...item,
              order: order.id,
              orderProduct: orderProduct.id,
              isPartition: true,
              parentItem: parentItem.id,
              trx,
            });
            await itemService.update({
              id: item.parentItem,
              currentQuantity: Math.max(
                parentItem.currentQuantity - item.quantity,
                0
              ),
              trx,
            });
            break;
          default:
            break;
        }
      }
      // Movimiento del Item para quitarlo del Order
      if (movementType === ITEM_MOVEMENT_TYPES.DELETE) {
        // De acuerdo con el type del Order
        switch (orderType) {
          // Para caso Purchase e IN, se elimina el Item de la base de datos
          case ORDER_TYPES.PURCHASE:
          case ORDER_TYPES.IN:
            await itemService.delete({
              id: item.id,
              order: order.id,
              orderProduct: orderProduct.id,
              trx,
            });
            break;
          // Para caso Sale y Out, se actualiza el Item a disponible
          case ORDER_TYPES.SALE:
          case ORDER_TYPES.OUT:
            await itemService.update({
              id: item.id,
              reverse: true,
              update: {
                state: ITEM_STATES.AVAILABLE,
                order: order.id,
                orderProduct: orderProduct.id,
              },
              type: order.type,
              trx,
            });
            break;
          // Para el caso de Return, se actualiza el Item a vendido, ya que si es una devolución, su ultimo estado debió ser este, además de eliminarlo de la bodega
          case ORDER_TYPES.RETURN:
            await itemService.update({
              id: item.id,
              reverse: true,
              update: { state: ITEM_STATES.SOLD, warehouse: null },
              trx,
            });
            break;
          // Para el caso de Transfer, se actualiza el Item cambiandolo a la bodega de origen del Order, ya que su estado anterior debió ser la bodega destino del Order
          case ORDER_TYPES.TRANSFER:
            await itemService.update({
              id: item.id,
              reverse: true,
              udpade: { warehouse: sourceWarehouse.id },
              trx,
            });
            break;
          // Para el caso de Adjustment, se actualiza el Item cambiando el currentQuantity al estado anterior que tenía, tomándolo del último movimiento que tuvo
          case ORDER_TYPES.ADJUSTMENT:
            const lastMovement = movements.at(-1);
            if (!lastMovement)
              throw new Error("No hay movimientos de este Item");
            await itemService.update({
              id: item.id,
              reverse: true,
              currentQuantity: lastMovement.balanceBefore,
              trx,
            });
            break;
          // Para el caso de Cut, se elimina el Item y se actualiza el Item padre aumentando su cantidad con la cantidad del Item parcial
          case ORDER_TYPES.CUT:
            await itemService.delete({
              id: item.id,
              order: order.id,
              orderProduct: orderProduct.id,
              trx,
            });
            await itemService.update({
              id: parentItem.id,
              reverse: true,
              currentQuantity:
                parentItem.currentQuantity +
                (item.currentQuantity || item.quantity),
              trx,
            });
            break;
          default:
            break;
        }
      }
      // Movimiento del Item para actualizarlo en el Order
      if (movementType === ITEM_MOVEMENT_TYPES.UPDATE) {
        // De acuerdo con el type del Order y el orderState del Order
        switch (orderType) {
          // Para caso Purchase o In podriamos estar trasladando los productos a otra bodega en el mismo order
          case ORDER_TYPES.PURCHASE:
          case ORDER_TYPES.IN:
            const pruchaseUpdate = {
              orderProduct: orderProduct.id,
              order: order.id,
            };
            if (item.warehouse) {
              pruchaseUpdate.warehouse = item.warehouse.id;
            }
            await itemService.update({
              id: item.id,
              update: pruchaseUpdate,
              type: orderType,
              trx,
            });
            break;
          // Para caso Sale, si el Order está completado entonces el estado pasa a vendido, si está cancelado entonces cambia a disponible, y para cualquier otro pasa a reservado
          case ORDER_TYPES.SALE:
            let itemState = ITEM_STATES.RESERVED;
            if (orderState === ORDER_STATES.COMPLETED) {
              itemState = ITEM_STATES.SOLD;
            } else if (orderState === ORDER_STATES.CANCELLED) {
              itemState = ITEM_STATES.AVAILABLE;
            }
            const warehouse = item.warehouse;
            const update = {
              state: itemState,
              order: order.id,
              orderProduct: orderProduct.id,
            };
            if (warehouse) {
              update.warehouse = warehouse.id;
            }
            await itemService.update({
              id: item.id,
              update,
              type: orderType,
              trx,
            });
            break;
          default:
            break;
        }
      }
    } catch (error) {
      throw error;
    }
  }),
  // Agrega un Item al Order
  addItem: withValidation(AddItemToOrderSchema, async (data) => {
    try {
      return await strapi.db.transaction(async (trx) => {
        // Obtención de variables
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item, product: productId } = data;
        // Obtención del Order actual
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: ["orderProducts", "orderProducts.product"],
          },
          { transacting: trx }
        );
        if (!currentOrder) throw new Error("La orden no existe");
        if (!["draft", "confirmed"].includes(currentOrder.state)) {
          throw new Error(
            "Sólo las ordenes en borrador o confirmadas pueden ser modificadas"
          );
        }
        // Obtención del OrderProduct actual para el Item
        let { product, ...orderProduct } = currentOrder.orderProducts.find(
          (orderProduct) => orderProduct.product.id === productId
        );
        if (!product) throw new Error("El producto es requerido");
        // Si no existe, debe crearse
        if (!orderProduct) {
          orderProduct = await orderProductService.create({
            product: product.id,
            order: currentOrder.id,
            requestedQuantity: 0,
            requestedPackages: 0,
            notes: "Producto agregado en actualización de lista de empaque",
            trx,
          });
          if (!orderProduct) throw new Error("Error al crear el OrderProduct");
        }
        // Realizar movimiento de agregación Item de acuerdo al tipo del Order
        await strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.CREATE,
          item,
          order: currentOrder,
          orderProduct,
          product,
          orderState: currentOrder.state,
          trx,
        });
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:item-added", item);
        // Actualizar el OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });
        // Emisión de agregación del Item
        // Retornar el Order con los cambios
        return await strapi.entityService.findOne(
          ORDER_SERVICE,
          currentOrder.id,
          {
            populate: [
              "orderProducts",
              "orderProducts.items",
              "orderProducts.items.warehouse",
              "orderProducts.product",
              "sourceWarehouse",
              "destinationWarehouse",
            ],
          },
          { transacting: trx }
        );
      });
    } catch (error) {
      throw error;
    }
  }),
  // Remueve un Item del Order
  removeItem: withValidation(RemoveItemFromOrderSchema, async (data) => {
    try {
      return await strapi.db.transaction(async (trx) => {
        // Obtención de variables
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item: itemId } = data;
        // Obtención del Order actual
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: ["orderProducts", "orderProducts.product"],
          },
          { transacting: trx }
        );
        if (!currentOrder) throw new Error("La orden no existe");
        if (!["draft", "confirmed"].includes(currentOrder.state)) {
          throw new Error(
            "Sólo las ordenes en borrador o confirmadas pueden ser modificadas"
          );
        }
        // Obtención del Item
        const item = await strapi.entityService.findOne(
          ITEM_SERVICE,
          itemId,
          {
            populate: ["product", "orders"],
          },
          { transacting: trx }
        );
        if (!item) throw new Error("El Item no pudo ser encontrado");
        if (!item.orders.find((o) => o.id === currentOrder.id))
          throw new Error("El Item no hace parte de esta orden");
        // Obtención del OrderProduct que contiene el Item en el Order
        const orderProduct = currentOrder.orderProducts.find(
          (orderProduct) => orderProduct.product.id == item.product.id
        );
        if (!orderProduct)
          throw new Error("El OrderProduct no pudo ser encontrado");
        // Remoción del Item
        await strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.DELETE,
          item,
          order: currentOrder,
          orderProduct,
          product: orderProduct.product,
          orderState: currentOrder.state,
          trx,
        });
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:item-removed", item);
        // Actualizar OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });
        // Emisión de agregación del Item
        // Retornar el Order con los cambios
        const updatedOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          currentOrder.id,
          {
            populate: [
              "orderProducts",
              "orderProducts.items",
              "orderProducts.items.warehouse",
              "orderProducts.product",
              "sourceWarehouse",
              "destinationWarehouse",
            ],
          },
          { transacting: trx }
        );
        if (!updatedOrder) throw new Error("No se pudo actualizar la orden");
        return updatedOrder;
      });
    } catch (error) {
      throw error;
    }
  }),
}));
