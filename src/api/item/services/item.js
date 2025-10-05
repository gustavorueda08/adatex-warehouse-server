"use strict";

const {
  generateItemBarcode,
  setItemBarcode,
} = require("../../../utils/generateCodes");
const {
  IN,
  ADJUSTMENT,
  TRANSFER,
  OUT,
  RESERVE,
  UNRESERVE,
} = require("../../../utils/inventoryMovementTypes");
const ITEM_STATES = require("../../../utils/itemStates");
const ORDER_STATES = require("../../../utils/orderStates");
const ORDER_TYPES = require("../../../utils/orderTypes");
const runInBatches = require("../../../utils/runInBatches");
const {
  INVENTORY_MOVEMENT_SERVICE,
  ITEM_SERVICE,
  BARCODE_MAPPING_SERVICE,
  WAREHOUSE_SERVICE,
} = require("../../../utils/services");
const {
  CreateItemSchema,
  DeleteItemSchema,
  UpdateItemSchema,
} = require("../../../validation/schemas");
const { withValidation } = require("../../../validation/withValidation");

/**
 * item service
 */
const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::item.item", ({ strapi }) => ({
  // Crea un Item nuevo asociado a un Order, a un Warehouse, a un Product y a un OrderProduct
  create: withValidation(CreateItemSchema, async (data) => {
    try {
      //Creación del Item

      const newItem = await strapi.entityService.create(
        ITEM_SERVICE,
        {
          data: {
            name: data.product.name,
            originalQuantity: data.quantity,
            currentQuantity: data.quantity,
            unit: data.product.unit,
            warehouse: data.warehouse,
            sourceOrder: data.sourceOrder,
            orderProducts: { connect: [data.orderProduct] },
            orders: { connect: [data.sourceOrder] },
            product: data.product.id,
            lotNumber: data.lot,
            barcode: generateItemBarcode(
              data.product,
              data.quantity,
              data.lot,
              data.itemNumber,
              data.containerCode
            ),
            itemNumber: data.itemNumber,
            state: ITEM_STATES.AVAILABLE,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );
      if (!newItem) throw newItem;
      // Creación del InventoryMovement
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: newItem.id,
            quantity: data.quantity,
            order: data.sourceOrder,
            orderProduct: data.orderProduct,
            type: IN,
            reason: `Creacion de Item ${data.product.name} con cantidad ${data.quantity}`,
            destinationWarehouse: data.warehouse,
            balanceBefore: 0,
            balanceAfter: data.quantity,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );
      // Retorno de Item creado
      return newItem;
    } catch (error) {
      throw error;
    }
  }),
  // Elimina un Item: Utilizar exclusivamente en ordenes de tipo Purchase y In que estén en Draft
  delete: withValidation(DeleteItemSchema, async (data) => {
    try {
      // Obtención del Item
      const item = await strapi.entityService.findOne(
        ITEM_SERVICE,
        data.id,
        data.trx ? { transacting: data.trx } : {}
      );
      // Creación del InventoryMovement antes de eliminar el Item
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: data.id,
            quantity: item.currentQuantity,
            order: data.order,
            orderProduct: data.orderProduct,
            type: ADJUSTMENT,
            reason: `Item eliminado por ajuste`,
            balanceBefore: item.currentQuantity,
            balanceAfter: 0,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );
      // Eliminación del Item
      await strapi.entityService.delete(
        ITEM_SERVICE,
        item.id,
        data.trx ? { transacting: data.trx } : {}
      );
      // Retorno con Deleted
      return {
        item: item.id,
        state: "Deleted",
      };
    } catch (error) {
      throw error;
    }
  }),
  // Actualiza el Item y lo asocia a un Order y/o a un OrderProduct si es necesario
  update: withValidation(UpdateItemSchema, async (data) => {
    try {
      // Obtención de asociaciones oneToMany, type y si es un update reversando
      const { type, reverse } = data;
      const { order, orderProduct, ...dataToUpdate } = data.update;
      if (order) {
        dataToUpdate.orders = reverse
          ? { disconnect: [order] }
          : { connect: [order] };
      }
      if (orderProduct) {
        dataToUpdate.orderProducts = reverse
          ? { disconnect: [orderProduct] }
          : { connect: [orderProduct] };
      }
      // Obtención del Item actual, tenemos tres maneras de buscarlo, por su id, por su barcode o por su cantidad (si llega el id del Product)
      let currentItem;

      // Obtención del Item por su ID
      if (data.id) {
        // Busqueda del Item por su id
        currentItem = await strapi.entityService.findOne(
          ITEM_SERVICE,
          data.id,
          {
            populate: [
              "warehouse",
              "movements",
              "orderProducts",
              "orderProducts.order",
            ],
          },
          data.trx ? { transacting: data.trx } : {}
        );
      } else if (data.barcode) {
        // Busqueda del Item por su barcode
        let items = await strapi.entityService.findMany(
          ITEM_SERVICE,
          {
            filters: {
              barcode: data.barcode,
              state: data.justAvailableItems
                ? ITEM_STATES.AVAILABLE
                : [Object.values(ITEM_STATES)],
            },
            populate: [
              "product",
              "warehouse",
              "movements",
              "orderProducts",
              "orderProducts.order",
            ],
          },
          data.trx ? { transacting: data.trx } : {}
        );
        if (items.length === 0) {
          // Buscar con Virtualbarcode
          const mappings = await strapi.entityService.findMany(
            BARCODE_MAPPING_SERVICE,
            {
              filters: {
                realBarcode: data.barcode,
                used: false,
              },
              populate: ["item", "item.movements"],
            },
            data.trx ? { transacting: data.trx } : {}
          );
          if (mappings.length === 0)
            throw new Error("No se ha encontrado ningun Item disponible");
          currentItem = mappings[0].item;
          // Actualizar VirtualBarcode a used
          await strapi.entityService.update(
            BARCODE_MAPPING_SERVICE,
            mappings[0].id,
            {
              used: true,
            },
            data.trx ? { transacting: data.trx } : {}
          );
        } else {
          currentItem = items[0];
          console.log("ITEM ENCONTRADO", currentItem);
        }
      } else if (data.quantity && data.product) {
        // Busqueda del Item por su cantidad (Scan manual)
        // Obtención del Warehouse en dónde buscar el Item
        let warehouse;
        if (!data.warehouse) {
          const warehouses = await strapi.entityService.findMany(
            WAREHOUSE_SERVICE,
            {
              filters: {
                isDefault: true,
              },
            },
            data.trx ? { transacting: data.trx } : {}
          );
          if (warehouses.length > 0) {
            warehouse = warehouses[0];
          }
        } else {
          warehouse = await strapi.entityService.findOne(
            WAREHOUSE_SERVICE,
            data.warehouse,
            {},
            data.trx ? { transacting: data.trx } : {}
          );
        }
        if (!warehouse)
          throw new Error(
            "No se ha encontrado una bodega de origen para buscar el Item"
          );
        // Busqueda de Items con cantidad y product especifico en el warehouse encontrado
        const items = await strapi.entityService.findMany(
          ITEM_SERVICE,
          {
            filters: {
              product: data.product,
              currentQuantity: Number(data.quantity),
              warehouse: warehouse.id,
              ...(data.justAvailableItems && { state: ITEM_STATES.AVAILABLE }),
            },
            populate: [
              "movements",
              "orderProducts",
              "orderProducts.order",
              "product",
              "warehouse",
            ],
          },
          data.trx ? { transacting: data.trx } : {}
        );
        // Obtención del Item y creación del VirtualBarcode
        if (items.length > 0) {
          currentItem = items[0];
          const vCode = setItemBarcode({
            productCode: currentItem.product.barcode,
            itemNumber: currentItem.itemNumber,
            lotNumber: currentItem.lotNumber,
            containerCode: null,
            isVirtual: true,
          });
          //Creación del VirtualBarcode asociado al Item encontrado
          const virtualbarcode = await strapi.entityService.create(
            BARCODE_MAPPING_SERVICE,
            {
              data: {
                itemId: String(currentItem.id),
                virtualBarcode: vCode,
                realBarcode: currentItem.barcode,
                type: "manual",
              },
            },
            data.trx ? { transacting: data.trx } : {}
          );
          console.log(virtualbarcode);
        }
        console.log("VIRTUAL BARCODE CREADO");
      } else {
        throw new Error("Se requieren los datos para identificar el Item");
      }
      if (!currentItem) throw new Error("No se encontró ningun Item");
      // Actualización del Item
      const updatedItem = await strapi.entityService.update(
        ITEM_SERVICE,
        currentItem.id,
        {
          data: {
            ...dataToUpdate,
          },
          populate: data.populate ? data.populate : ["warehouse"],
        },
        data.trx ? { transacting: data.trx } : {}
      );

      // Creación de los InventoryMovements de acuerdo con el orderType y los cambios presenciados
      const changes = [];
      // InventoryMovement de ajuste por cambios en el currentQuantity
      if (currentItem.currentQuantity !== updatedItem.currentQuantity) {
        changes.push({
          type: ADJUSTMENT,
          item: updatedItem.id,
          quantity: updatedItem.currentQuantity - currentItem.currentQuantity,
          order,
          orderProduct,
          balanceBefore: currentItem.currentQuantity,
          balanceAfter: updatedItem.currentQuantity,
          reason: "Cambio en la cantidad actual del item por ajuste",
        });
      }
      // InventoryMovement de transferencia por cambios en el warehouse
      if (currentItem.warehouse?.id != updatedItem.warehouse?.id) {
        console.log("INGRESO A CAMBIO DE WAREHOUSE");
        console.log(currentItem.warehouse?.id, updatedItem.warehouse?.id);

        changes.push({
          type: TRANSFER,
          item: updatedItem.id,
          quantity: updatedItem.currentQuantity,
          order,
          orderProduct,
          balanceBefore: updatedItem.currentQuantity,
          balanceAfter: updatedItem.currentQuantity,
          sourceWarehouse: currentItem.warehouse.id,
          destinationWarehouse: updatedItem.warehouse.id,
          reason: "Transferencia del item entre bodegas",
        });
      }
      // Identificación de cambios de estado de acuerdo al tipo de orden que hace un cambio de estado
      if (currentItem.state != updatedItem.state) {
        const stateMovement = {
          item: updatedItem.id,
          quantity: updatedItem.currentQuantity,
          order,
          orderProduct,
          balanceBefore: updatedItem.currentQuantity,
          balanceAfter: updatedItem.currentQuantity,
        };
        switch (type) {
          // Cambio de estado o reversa del estado en ordenes de tipo sale
          case ORDER_TYPES.SALE:
            reverse
              ? changes.push({
                  ...stateMovement,
                  type: UNRESERVE,
                  reason:
                    "Cambio de estado a disponible por cancelación de reserva",
                })
              : changes.push({
                  ...stateMovement,
                  type: updatedItem.state === ITEM_STATES.SOLD ? OUT : RESERVE,
                  reason:
                    updatedItem.state === ITEM_STATES.SOLD
                      ? "Item vendido y despachado"
                      : "Cambio de estado por orden de venta",
                });
            break;
          // Cambio de estado o reversa del estado en ordenes de tipo return
          case ORDER_TYPES.RETURN:
            reverse
              ? changes.push({
                  ...stateMovement,
                  type: OUT,
                  reason:
                    "Cambio de estado a vendido por cancelación de devolución",
                })
              : changes.push({
                  ...stateMovement,
                  type: IN,
                  reason:
                    "Cambio de estado a retornado por orden de devolución",
                });
            break;
          // Cambio de estado o reversa del estado en ordenes de tipo out
          case ORDER_TYPES.OUT:
            reverse
              ? changes.push({
                  ...stateMovement,
                  type: IN,
                  reason:
                    "Cambio de estado a disponible por cancelación de orden de salida",
                })
              : changes.push({
                  ...stateMovement,
                  type: OUT,
                  reason: "Cambio de estado a desechado por orden de salida",
                });
            break;
          default:
            break;
        }
      }
      // Creación de los InventoryMovements
      const movements = await runInBatches(changes, (change) =>
        strapi.entityService.create(
          INVENTORY_MOVEMENT_SERVICE,
          { data: change },
          data.trx ? { transacting: data.trx } : {}
        )
      );
      // Retorno del Item actualizado con sus movimientos
      return { ...updatedItem, movements };
    } catch (error) {
      throw error;
    }
  }),
}));
