"use strict";

const {
  generateItemBarcode,
  setItemBarcode,
  generateAlternativeItemBarcode,
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

const { createCoreService } = require("@strapi/strapi").factories;

/**
 * Item Service
 *
 * Servicio para la gestión de items en el inventario, incluyendo creación,
 * actualización, eliminación y seguimiento de movimientos de inventario.
 */
module.exports = createCoreService("api::item.item", ({ strapi }) => ({
  // ==================== FUNCIONES AUXILIARES PRIVADAS ====================

  /**
   * Busca un item por su ID
   * @private
   * @param {number} itemId - ID del item a buscar
   * @param {Object} trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Item encontrado
   */
  async _findItemById(itemId, trx = null) {
    return await strapi.entityService.findOne(
      ITEM_SERVICE,
      itemId,
      {
        populate: [
          "warehouse",
          "movements",
          "orderProducts",
          "orderProducts.order",
        ],
      },
      trx ? { transacting: trx } : {}
    );
  },

  /**
   * Busca un item por su código de barras (incluyendo virtual barcodes)
   * @private
   * @param {string} barcode - Código de barras a buscar
   * @param {boolean} justAvailableItems - Si solo se deben buscar items disponibles
   * @param {Object} trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Item encontrado
   */
  async _findItemByBarcode(barcode, justAvailableItems = false, trx = null) {
    // Buscar items con el barcode directo
    let items = await strapi.entityService.findMany(
      ITEM_SERVICE,
      {
        filters: {
          barcode: barcode,
          state: justAvailableItems
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
      trx ? { transacting: trx } : {}
    );

    if (items.length > 0) {
      return items[0];
    }

    // Si no se encuentra, buscar en barcode mappings (virtual barcodes)
    const mappings = await strapi.entityService.findMany(
      BARCODE_MAPPING_SERVICE,
      {
        filters: {
          realBarcode: barcode,
          used: false,
        },
        populate: ["item", "item.movements"],
      },
      trx ? { transacting: trx } : {}
    );

    if (mappings.length === 0) {
      throw new Error("No se ha encontrado ningún Item disponible");
    }

    // Marcar el mapping como usado
    await strapi.entityService.update(
      BARCODE_MAPPING_SERVICE,
      mappings[0].id,
      { data: { used: true } },
      trx ? { transacting: trx } : {}
    );

    return mappings[0].item;
  },

  /**
   * Busca un item por cantidad y producto (para escaneo manual)
   * @private
   * @param {number} quantity - Cantidad a buscar
   * @param {number} productId - ID del producto
   * @param {number|null} warehouseId - ID de la bodega (opcional)
   * @param {number|null} orderId - ID de la orden para crear virtual barcode
   * @param {boolean} justAvailableItems - Si solo se deben buscar items disponibles
   * @param {Object} trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Item encontrado con virtual barcode creado
   */
  async _findItemByQuantityAndProduct(
    quantity,
    productId,
    warehouseId = null,
    orderId = null,
    justAvailableItems = false,
    trx = null
  ) {
    // Determinar la bodega de búsqueda
    let warehouse;
    if (!warehouseId) {
      const warehouses = await strapi.entityService.findMany(
        WAREHOUSE_SERVICE,
        {
          filters: { isDefault: true },
        },
        trx ? { transacting: trx } : {}
      );

      if (warehouses.length > 0) {
        warehouse = warehouses[0];
      }
    } else {
      warehouse = await strapi.entityService.findOne(
        WAREHOUSE_SERVICE,
        warehouseId,
        {},
        trx ? { transacting: trx } : {}
      );
    }

    if (!warehouse) {
      throw new Error(
        "No se ha encontrado una bodega de origen para buscar el Item"
      );
    }

    // Buscar items con los criterios especificados
    const items = await strapi.entityService.findMany(
      ITEM_SERVICE,
      {
        filters: {
          product: productId,
          currentQuantity: Number(quantity),
          warehouse: warehouse.id,
          ...(justAvailableItems && { state: ITEM_STATES.AVAILABLE }),
        },
        populate: [
          "movements",
          "orderProducts",
          "orderProducts.order",
          "product",
          "warehouse",
        ],
      },
      trx ? { transacting: trx } : {}
    );

    if (items.length === 0) {
      throw new Error(
        "No se encontró ningún Item con los criterios especificados"
      );
    }

    const currentItem = items[0];

    // Crear virtual barcode para el item encontrado
    const vCode = setItemBarcode({
      productCode: currentItem.product.barcode,
      itemNumber: currentItem.itemNumber,
      lotNumber: currentItem.lotNumber,
      containerCode: null,
      isVirtual: true,
    });

    await strapi.entityService.create(
      BARCODE_MAPPING_SERVICE,
      {
        data: {
          itemId: String(currentItem.id),
          virtualBarcode: vCode,
          realBarcode: currentItem.barcode,
          type: "manual",
          createdFromOrder: orderId,
        },
      },
      trx ? { transacting: trx } : {}
    );

    return currentItem;
  },

  /**
   * Procesa cambios en la cantidad de un item
   * @private
   * @param {Object} currentItem - Item antes de la actualización
   * @param {Object} updatedItem - Item después de la actualización
   * @param {number} orderId - ID de la orden
   * @param {number} orderProductId - ID del orderProduct
   * @returns {Object|null} Datos del movimiento de ajuste o null si no hay cambios
   */
  _processQuantityChanges(currentItem, updatedItem, orderId, orderProductId) {
    if (currentItem.currentQuantity === updatedItem.currentQuantity) {
      return null;
    }

    return {
      type: ADJUSTMENT,
      item: updatedItem.id,
      quantity: updatedItem.currentQuantity - currentItem.currentQuantity,
      order: orderId,
      orderProduct: orderProductId,
      balanceBefore: currentItem.currentQuantity,
      balanceAfter: updatedItem.currentQuantity,
      reason: "Cambio en la cantidad actual del item por ajuste",
    };
  },

  /**
   * Procesa cambios en la bodega de un item
   * @private
   * @param {Object} currentItem - Item antes de la actualización
   * @param {Object} updatedItem - Item después de la actualización
   * @param {number} orderId - ID de la orden
   * @param {number} orderProductId - ID del orderProduct
   * @returns {Object|null} Datos del movimiento de transferencia o null si no hay cambios
   */
  _processWarehouseChanges(currentItem, updatedItem, orderId, orderProductId) {
    if (currentItem.warehouse?.id == updatedItem.warehouse?.id) {
      return null;
    }

    return {
      type: TRANSFER,
      item: updatedItem.id,
      quantity: updatedItem.currentQuantity,
      order: orderId,
      orderProduct: orderProductId,
      balanceBefore: updatedItem.currentQuantity,
      balanceAfter: updatedItem.currentQuantity,
      sourceWarehouse: currentItem.warehouse.id,
      destinationWarehouse: updatedItem.warehouse.id,
      reason: "Transferencia del item entre bodegas",
    };
  },

  /**
   * Procesa cambios de estado de un item según el tipo de orden
   * @private
   * @param {Object} currentItem - Item antes de la actualización
   * @param {Object} updatedItem - Item después de la actualización
   * @param {string} orderType - Tipo de orden (SALE, RETURN, OUT)
   * @param {boolean} reverse - Si es una reversión de la operación
   * @param {number} orderId - ID de la orden
   * @param {number} orderProductId - ID del orderProduct
   * @returns {Object|null} Datos del movimiento de estado o null si no hay cambios
   */
  _processItemStateChanges(
    currentItem,
    updatedItem,
    orderType,
    reverse,
    orderId,
    orderProductId
  ) {
    if (currentItem.state === updatedItem.state) {
      return null;
    }

    const baseMovement = {
      item: updatedItem.id,
      quantity: updatedItem.currentQuantity,
      order: orderId,
      orderProduct: orderProductId,
      balanceBefore: updatedItem.currentQuantity,
      balanceAfter: updatedItem.currentQuantity,
    };

    switch (orderType) {
      case ORDER_TYPES.SALE:
        if (reverse) {
          return {
            ...baseMovement,
            type: UNRESERVE,
            reason: "Cambio de estado a disponible por cancelación de reserva",
          };
        }
        return {
          ...baseMovement,
          type: updatedItem.state === ITEM_STATES.SOLD ? OUT : RESERVE,
          reason:
            updatedItem.state === ITEM_STATES.SOLD
              ? "Item vendido y despachado"
              : "Cambio de estado por orden de venta",
        };

      case ORDER_TYPES.RETURN:
        if (reverse) {
          return {
            ...baseMovement,
            type: OUT,
            reason: "Cambio de estado a vendido por cancelación de devolución",
          };
        }
        return {
          ...baseMovement,
          type: IN,
          reason: "Cambio de estado a retornado por orden de devolución",
        };

      case ORDER_TYPES.OUT:
        if (reverse) {
          return {
            ...baseMovement,
            type: IN,
            reason:
              "Cambio de estado a disponible por cancelación de orden de salida",
          };
        }
        return {
          ...baseMovement,
          type: OUT,
          reason: "Cambio de estado a desechado por orden de salida",
        };

      default:
        return null;
    }
  },

  /**
   * Elimina los barcode mappings creados para una orden específica
   * @private
   * @param {number} itemId - ID del item
   * @param {number} orderId - ID de la orden
   * @param {Object} trx - Transacción de base de datos (opcional)
   */
  async _cleanupBarcodeMappings(itemId, orderId, trx = null) {
    const barcodeMappingsToDelete = await strapi.entityService.findMany(
      BARCODE_MAPPING_SERVICE,
      {
        filters: {
          itemId: String(itemId),
          createdFromOrder: orderId,
        },
      },
      trx ? { transacting: trx } : {}
    );

    for (const mapping of barcodeMappingsToDelete) {
      await strapi.entityService.delete(
        BARCODE_MAPPING_SERVICE,
        mapping.id,
        trx ? { transacting: trx } : {}
      );
    }
  },

  /**
   * Encuentra un item usando múltiples estrategias de búsqueda
   * @private
   * @param {Object} searchCriteria - Criterios de búsqueda
   * @returns {Promise<Object>} Item encontrado
   */
  async _findItem(searchCriteria) {
    const {
      id,
      barcode,
      quantity,
      product,
      warehouse,
      order,
      justAvailableItems,
      trx,
    } = searchCriteria;

    // Estrategia 1: Búsqueda por ID
    if (id) {
      return await strapi.service(ITEM_SERVICE)._findItemById(id, trx);
    }

    // Estrategia 2: Búsqueda por código de barras
    if (barcode) {
      return await strapi
        .service(ITEM_SERVICE)
        ._findItemByBarcode(barcode, justAvailableItems, trx);
    }

    // Estrategia 3: Búsqueda por cantidad y producto (escaneo manual)
    if (quantity && product) {
      return await strapi
        .service(ITEM_SERVICE)
        ._findItemByQuantityAndProduct(
          quantity,
          product,
          warehouse,
          order,
          justAvailableItems,
          trx
        );
    }

    throw new Error("Se requieren los datos para identificar el Item");
  },

  // ==================== MÉTODOS PÚBLICOS ====================

  /**
   * Crea un nuevo item en el inventario
   *
   * Crea un item asociado a una orden, bodega, producto y orderProduct.
   * También genera automáticamente un movimiento de inventario de tipo IN.
   *
   * @param {Object} data - Datos para crear el item
   * @param {Object} data.product - Producto asociado al item
   * @param {number} data.quantity - Cantidad del item
   * @param {number} data.warehouse - ID de la bodega de destino
   * @param {number} data.sourceOrder - ID de la orden de origen
   * @param {number} data.orderProduct - ID del orderProduct
   * @param {string} data.lot - Número de lote
   * @param {number} data.itemNumber - Número de item
   * @param {string} data.containerCode - Código de contenedor
   * @param {Object} data.trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Item creado
   * @throws {Error} Si falla la creación del item o del movimiento
   */
  create: withValidation(CreateItemSchema, async (data) => {
    try {
      // Crear el item en la base de datos
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
            alternativeBarcode: generateAlternativeItemBarcode(
              data.product.code,
              data.quantity,
              data.containerCode
            ),
            itemNumber: data.itemNumber,
            state: ITEM_STATES.AVAILABLE,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );

      if (!newItem) {
        throw new Error("Error al crear el item");
      }

      // Crear el movimiento de inventario de entrada
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: newItem.id,
            quantity: data.quantity,
            order: data.sourceOrder,
            orderProduct: data.orderProduct,
            type: IN,
            reason: `Creación de Item ${data.product.name} con cantidad ${data.quantity}`,
            destinationWarehouse: data.warehouse,
            balanceBefore: 0,
            balanceAfter: data.quantity,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );

      return newItem;
    } catch (error) {
      throw error;
    }
  }),

  /**
   * Elimina un item del inventario
   *
   * IMPORTANTE: Este método debe utilizarse exclusivamente en órdenes de tipo
   * Purchase e In que estén en estado Draft. Crea un movimiento de inventario
   * de tipo ADJUSTMENT antes de eliminar el item.
   *
   * @param {Object} data - Datos para eliminar el item
   * @param {number} data.id - ID del item a eliminar
   * @param {number} data.order - ID de la orden asociada
   * @param {number} data.orderProduct - ID del orderProduct asociado
   * @param {Object} data.trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Objeto con el ID del item eliminado y estado
   * @throws {Error} Si falla la eliminación
   */
  delete: withValidation(DeleteItemSchema, async (data) => {
    try {
      // Obtener el item actual
      const item = await strapi.entityService.findOne(
        ITEM_SERVICE,
        data.id,
        data.trx ? { transacting: data.trx } : {}
      );

      // Crear movimiento de ajuste antes de eliminar
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: data.id,
            quantity: item.currentQuantity,
            order: data.order,
            orderProduct: data.orderProduct,
            type: ADJUSTMENT,
            reason: "Item eliminado por ajuste",
            balanceBefore: item.currentQuantity,
            balanceAfter: 0,
          },
        },
        data.trx ? { transacting: data.trx } : {}
      );

      // Eliminar el item
      await strapi.entityService.delete(
        ITEM_SERVICE,
        item.id,
        data.trx ? { transacting: data.trx } : {}
      );

      return {
        item: item.id,
        state: "Deleted",
      };
    } catch (error) {
      throw error;
    }
  }),

  /**
   * Actualiza un item y gestiona sus movimientos de inventario
   *
   * Este método es el más complejo del servicio. Permite actualizar items y
   * automáticamente crea los movimientos de inventario correspondientes según
   * los cambios detectados:
   * - Cambios en cantidad → Movimiento de ADJUSTMENT
   * - Cambios en bodega → Movimiento de TRANSFER
   * - Cambios en estado → Movimiento según tipo de orden (IN, OUT, RESERVE, etc.)
   *
   * Además, maneja la búsqueda de items por múltiples estrategias:
   * - Por ID del item
   * - Por código de barras (incluyendo virtual barcodes)
   * - Por cantidad y producto (para escaneo manual)
   *
   * @param {Object} data - Datos para actualizar el item
   * @param {number} data.id - ID del item (opcional, si se busca por ID)
   * @param {string} data.barcode - Código de barras (opcional, si se busca por barcode)
   * @param {number} data.quantity - Cantidad (opcional, para búsqueda manual)
   * @param {number} data.product - ID del producto (opcional, para búsqueda manual)
   * @param {number} data.warehouse - ID de la bodega (opcional)
   * @param {boolean} data.justAvailableItems - Si solo buscar items disponibles
   * @param {string} data.type - Tipo de orden (SALE, RETURN, OUT, etc.)
   * @param {boolean} data.reverse - Si es una reversión de la operación
   * @param {Object} data.update - Datos a actualizar en el item
   * @param {number} data.update.order - ID de la orden a asociar
   * @param {number} data.update.orderProduct - ID del orderProduct a asociar
   * @param {Array} data.populate - Campos a popular en la respuesta
   * @param {Object} data.trx - Transacción de base de datos (opcional)
   * @returns {Promise<Object>} Item actualizado con sus movimientos
   * @throws {Error} Si no se encuentra el item o falla la actualización
   */
  update: withValidation(UpdateItemSchema, async (data) => {
    try {
      const { type, reverse } = data;
      const { order, orderProduct, ...dataToUpdate } = data.update;

      // Preparar conexiones/desconexiones de relaciones
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

      // Buscar el item usando la estrategia apropiada
      const currentItem = await strapi.service(ITEM_SERVICE)._findItem({
        id: data.id,
        barcode: data.barcode,
        quantity: data.quantity,
        product: data.product,
        warehouse: data.warehouse,
        order,
        justAvailableItems: data.justAvailableItems,
        trx: data.trx,
      });

      if (!currentItem) {
        throw new Error("No se encontró ningún Item");
      }

      // Si es una reversión, limpiar barcode mappings creados para esta orden
      if (reverse && order) {
        await strapi
          .service(ITEM_SERVICE)
          ._cleanupBarcodeMappings(currentItem.id, order, data.trx);
      }

      // Actualizar el item
      const updatedItem = await strapi.entityService.update(
        ITEM_SERVICE,
        currentItem.id,
        {
          data: dataToUpdate,
          populate: data.populate ? data.populate : ["warehouse"],
        },
        data.trx ? { transacting: data.trx } : {}
      );

      // Detectar y procesar cambios para crear movimientos de inventario
      const changes = [];

      // Procesar cambio de cantidad
      const quantityChange = strapi
        .service(ITEM_SERVICE)
        ._processQuantityChanges(currentItem, updatedItem, order, orderProduct);
      if (quantityChange) {
        changes.push(quantityChange);
      }

      // Procesar cambio de bodega
      const warehouseChange = strapi
        .service(ITEM_SERVICE)
        ._processWarehouseChanges(
          currentItem,
          updatedItem,
          order,
          orderProduct
        );
      if (warehouseChange) {
        changes.push(warehouseChange);
      }

      // Procesar cambio de estado
      const stateChange = strapi
        .service(ITEM_SERVICE)
        ._processItemStateChanges(
          currentItem,
          updatedItem,
          type,
          reverse,
          order,
          orderProduct
        );
      if (stateChange) {
        changes.push(stateChange);
      }

      // Crear todos los movimientos de inventario en lote
      const movements = await runInBatches(changes, async (change) => {
        return await strapi.entityService.create(
          INVENTORY_MOVEMENT_SERVICE,
          { data: change },
          data.trx ? { transacting: data.trx } : {}
        );
      });

      return { ...updatedItem, movements };
    } catch (error) {
      throw error;
    }
  }),
}));
