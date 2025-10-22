/**
 * Estrategias para movimiento de items basadas en el tipo de orden
 * Patrón Strategy para reducir complejidad del método doItemMovement
 */

const ORDER_TYPES = require("../../../utils/orderTypes");
const ITEM_STATES = require("../../../utils/itemStates");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");

/**
 * Estrategia base para movimientos de items
 */
class ItemMovementStrategy {
  constructor(itemService) {
    this.itemService = itemService;
  }

  async create(data) {
    throw new Error("Create method must be implemented");
  }

  async update(data) {
    throw new Error("Update method must be implemented");
  }

  async delete(data) {
    throw new Error("Delete method must be implemented");
  }
}

/**
 * Estrategia para órdenes de compra e ingreso
 */
class PurchaseInStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    product,
    trx,
    parentItem,
    orderType,
  }) {
    return await this.itemService.create({
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
      warehouse: order.destinationWarehouse.id,
      containerCode: order.containerCode,
      cost: orderProduct?.price || 0,
      trx,
    });
  }

  async update({
    item,
    order,
    orderProduct,
    product,
    orderType,
    orderState,
    trx,
  }) {
    const updateData = {
      orderProduct: orderProduct.id,
      order: order.id,
      cost: item?.price || item?.cost || 0,
    };

    if (item.warehouse) {
      updateData.warehouse = item.warehouse.id;
    }

    return await this.itemService.update({
      id: item.id,
      update: updateData,
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    order,
    orderProduct,
    orderType,
    parentItem,
    movements,
    trx,
  }) {
    return await this.itemService.delete({
      id: item.id,
      order: order.id,
      orderProduct: orderProduct.id,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de venta
 */
class SaleStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        state: ITEM_STATES.RESERVED,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
      justAvailableItems: true, // Solo buscar items disponibles
    };

    console.log(item, "ITEM");

    // Determinar cómo buscar el item
    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity = item.quantity;
      updatePayload.product = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error(
        "Se requiere id, barcode o quantity+product para buscar el item"
      );
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    const ORDER_STATES = require("../../../utils/orderStates");

    let itemState = ITEM_STATES.RESERVED;
    if (orderState === ORDER_STATES.COMPLETED) {
      itemState = ITEM_STATES.SOLD;
    } else if (orderState === ORDER_STATES.CANCELLED) {
      itemState = ITEM_STATES.AVAILABLE;
    }

    const updateData = {
      state: itemState,
      order: order.id,
      orderProduct: orderProduct.id,
    };

    if (item.warehouse) {
      updateData.warehouse = item.warehouse.id;
    }

    return await this.itemService.update({
      id: item.id,
      update: updateData,
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    movements,
  }) {
    return await this.itemService.update({
      id: item.id,
      reverse: true,
      update: {
        state: ITEM_STATES.AVAILABLE,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de devolución
 */
class ReturnStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        state: ITEM_STATES.AVAILABLE,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    };

    // Determinar cómo buscar el item (usualmente por id en returns)
    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity = item.quantity;
      updatePayload.product = product.id;
      updatePayload.warehouse = item.warehouse;
    } else {
      throw new Error(
        "Se requiere id, barcode o quantity+product para buscar el item"
      );
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        state: ITEM_STATES.AVAILABLE,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    trx,
    order,
    orderProduct,
    orderType,
    parentItem,
    movements,
  }) {
    return await this.itemService.update({
      id: item.id,
      reverse: true,
      update: {
        state: ITEM_STATES.SOLD,
        warehouse: null,
      },
      type: orderType,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de salida (OUT)
 */
class OutStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        state: ITEM_STATES.DROPPED,
        order: order.id,
        orderProduct: orderProduct.id,
        warehouse: null,
      },
      type: orderType,
      trx,
      justAvailableItems: true,
    };

    // Determinar cómo buscar el item
    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity = item.quantity;
      updatePayload.product = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error(
        "Se requiere id, barcode o quantity+product para buscar el item"
      );
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        state: ITEM_STATES.DROPPED,
        order: order.id,
        orderProduct: orderProduct.id,
        warehouse: null,
      },
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    movements,
  }) {
    return await this.itemService.update({
      id: item.id,
      reverse: true,
      update: {
        state: ITEM_STATES.AVAILABLE,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de transferencia
 */
class TransferStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        warehouse: order.destinationWarehouse.id,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
      justAvailableItems: true,
    };

    // Determinar cómo buscar el item
    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity = item.quantity;
      updatePayload.product = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error(
        "Se requiere id, barcode o quantity+product para buscar el item"
      );
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        warehouse: order.destinationWarehouse.id,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    order,
    trx,
    orderProduct,
    orderType,
    parentItem,
    movements,
  }) {
    return await this.itemService.update({
      id: item.id,
      reverse: true,
      update: { warehouse: order.sourceWarehouse.id },
      type: orderType,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de ajuste
 */
class AdjustmentStrategy extends ItemMovementStrategy {
  async create({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    };

    // Determinar cómo buscar el item
    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity = item.quantity;
      updatePayload.product = product.id;
      updatePayload.warehouse =
        item.warehouse || order.destinationWarehouse?.id;
    } else {
      throw new Error(
        "Se requiere id, barcode o quantity+product para buscar el item"
      );
    }

    // Si hay cambio de cantidad en el update payload del item
    if (item.currentQuantity !== undefined) {
      updatePayload.update.currentQuantity = item.currentQuantity;
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    movements,
    trx,
    order,
    orderProduct,
    orderType,
    parentItem,
  }) {
    const lastMovement = movements?.at(-1);
    if (!lastMovement) {
      throw new Error("No hay movimientos de este Item");
    }

    return await this.itemService.update({
      id: item.id,
      reverse: true,
      update: {
        currentQuantity: lastMovement.balanceBefore,
      },
      type: orderType,
      trx,
    });
  }
}

/**
 * Estrategia para órdenes de transformación y corte
 * Maneja tanto transformaciones entre productos diferentes como particiones del mismo producto
 */
class TransformStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, trx, orderType, product }) {
    const {
      IN,
      OUT,
      TRANSFORM,
    } = require("../../../utils/inventoryMovementTypes");
    const {
      ITEM_SERVICE,
      INVENTORY_MOVEMENT_SERVICE,
    } = require("../../../utils/services");

    // Obtener el item origen (sourceItem)
    let sourceItem;
    if (item.sourceItemId) {
      sourceItem = await strapi.entityService.findOne(
        ITEM_SERVICE,
        item.sourceItemId,
        {
          populate: ["product", "warehouse"],
          transacting: trx,
        }
      );

      if (!sourceItem) {
        throw new Error(
          `Item origen con id ${item.sourceItemId} no encontrado`
        );
      }
    } else {
      throw new Error("Se requiere sourceItemId para transformaciones");
    }

    const sourceQuantityConsumed = item.sourceQuantityConsumed || item.quantity;
    const targetQuantity = item.targetQuantity || item.quantity;

    // Validar que hay suficiente cantidad en el item origen
    if (sourceItem.currentQuantity < sourceQuantityConsumed) {
      throw new Error(
        `Item origen solo tiene ${sourceItem.currentQuantity} ${sourceItem.unit}, se requieren ${sourceQuantityConsumed}`
      );
    }

    // Detectar si es una partición (mismo producto) o transformación (producto diferente)
    const isCut = sourceItem.product.id === product.id;

    // 1. Reducir la cantidad del item origen
    const newSourceQuantity = Math.max(
      sourceItem.currentQuantity - sourceQuantityConsumed,
      0
    );

    await this.itemService.update({
      id: sourceItem.id,
      update: {
        currentQuantity: newSourceQuantity,
      },
      type: orderType,
      trx,
    });

    // 2. Crear el nuevo item (transformado o particionado)
    const newItemData = {
      name: product.name,
      originalQuantity: targetQuantity,
      currentQuantity: targetQuantity,
      unit: product.unit,
      warehouse:
        item.warehouse ||
        sourceItem.warehouse?.id ||
        order.destinationWarehouse?.id,
      sourceOrder: order.id,
      orderProduct: orderProduct.id,
      product: product.id,
      lotNumber: item.lotNumber || sourceItem.lotNumber,
      itemNumber: item.itemNumber,
      state: ITEM_STATES.AVAILABLE,
    };

    // Establecer la relación correcta según el tipo de operación
    if (isCut) {
      // Es un corte/partición: mismo producto
      newItemData.parentItem = sourceItem.id;
      newItemData.isPartition = true;
    } else {
      // Es una transformación: producto diferente
      newItemData.transformedFromItem = sourceItem.id;
    }

    const newItem = await strapi.entityService.create(
      ITEM_SERVICE,
      {
        data: newItemData,
      },
      { transacting: trx }
    );

    // 3. Crear ItemMovements para trazabilidad

    // Movement OUT/TRANSFORM del item origen (consumo)
    await strapi.entityService.create(
      INVENTORY_MOVEMENT_SERVICE,
      {
        data: {
          item: sourceItem.id,
          quantity: -sourceQuantityConsumed,
          order: order.id,
          orderProduct: orderProduct.id,
          type: TRANSFORM,
          reason: isCut
            ? `Partición de ${sourceQuantityConsumed} ${sourceItem.unit} del item ${sourceItem.barcode}`
            : `Transformación de ${sourceQuantityConsumed} ${sourceItem.unit} de ${sourceItem.product.name} a ${product.name}`,
          balanceBefore: sourceItem.currentQuantity,
          balanceAfter: newSourceQuantity,
          sourceWarehouse: sourceItem.warehouse?.id,
        },
      },
      { transacting: trx }
    );

    // Movement IN/TRANSFORM del nuevo item (creación)
    await strapi.entityService.create(
      INVENTORY_MOVEMENT_SERVICE,
      {
        data: {
          item: newItem.id,
          quantity: targetQuantity,
          order: order.id,
          orderProduct: orderProduct.id,
          type: TRANSFORM,
          reason: isCut
            ? `Creación de item particionado con ${targetQuantity} ${product.unit}`
            : `Creación de item transformado: ${targetQuantity} ${product.unit} de ${product.name}`,
          destinationWarehouse: newItemData.warehouse,
          balanceBefore: 0,
          balanceAfter: targetQuantity,
        },
      },
      { transacting: trx }
    );

    return newItem;
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({
    item,
    order,
    orderProduct,
    trx,
    orderType,
    parentItem,
    movements,
  }) {
    const { TRANSFORM } = require("../../../utils/inventoryMovementTypes");
    const {
      ITEM_SERVICE,
      INVENTORY_MOVEMENT_SERVICE,
    } = require("../../../utils/services");

    // Obtener el item con sus relaciones para determinar si es corte o transformación
    const fullItem = await strapi.entityService.findOne(ITEM_SERVICE, item.id, {
      populate: ["parentItem", "transformedFromItem", "product"],
      transacting: trx,
    });

    if (!fullItem) {
      throw new Error(`Item con id ${item.id} no encontrado`);
    }

    // Determinar el item origen (puede ser parentItem o transformedFromItem)
    const sourceItem = fullItem.parentItem || fullItem.transformedFromItem;

    if (!sourceItem) {
      throw new Error(
        "No se encontró el item origen para revertir la transformación"
      );
    }

    const isCut = !!fullItem.parentItem;
    const quantityToRestore =
      fullItem.currentQuantity || fullItem.originalQuantity;

    // 1. Restaurar la cantidad al item origen
    const restoredQuantity = sourceItem.currentQuantity + quantityToRestore;

    await this.itemService.update({
      id: sourceItem.id,
      reverse: true,
      update: {
        currentQuantity: restoredQuantity,
      },
      type: orderType,
      trx,
    });

    // 2. Crear movement de reversión para el item origen
    await strapi.entityService.create(
      INVENTORY_MOVEMENT_SERVICE,
      {
        data: {
          item: sourceItem.id,
          quantity: quantityToRestore,
          order: order.id,
          orderProduct: orderProduct.id,
          type: TRANSFORM,
          reason: isCut
            ? `Reversión de partición: restaurando ${quantityToRestore} ${sourceItem.unit}`
            : `Reversión de transformación: restaurando ${quantityToRestore} ${sourceItem.unit}`,
          balanceBefore: sourceItem.currentQuantity,
          balanceAfter: restoredQuantity,
        },
      },
      { transacting: trx }
    );

    // 3. Crear movement de reversión para el item transformado (antes de eliminarlo)
    await strapi.entityService.create(
      INVENTORY_MOVEMENT_SERVICE,
      {
        data: {
          item: fullItem.id,
          quantity: -quantityToRestore,
          order: order.id,
          orderProduct: orderProduct.id,
          type: TRANSFORM,
          reason: `Reversión: eliminación de item ${isCut ? "particionado" : "transformado"}`,
          balanceBefore: quantityToRestore,
          balanceAfter: 0,
        },
      },
      { transacting: trx }
    );

    // 4. Eliminar el item transformado/particionado
    await this.itemService.delete({
      id: fullItem.id,
      order: order.id,
      orderProduct: orderProduct.id,
      trx,
    });

    return sourceItem;
  }
}

/**
 * Estrategia para órdenes de facturación parcial
 * NO mueve inventario, solo asocia items existentes para facturación
 */
class PartialInvoiceStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, trx, orderType, product }) {
    const {
      findInvoiceableItemsByQuantity,
    } = require("../utils/invoiceHelpers");
    const { ITEM_SERVICE } = require("../../../utils/services");

    // Si se proporciona un ID de item específico, usar ese item
    if (item.id) {
      // Validar que el item esté disponible para facturación
      const existingItem = await strapi.entityService.findOne(
        ITEM_SERVICE,
        item.id,
        {
          populate: ["orders", "orderProducts", "product"],
          transacting: trx,
        }
      );

      if (!existingItem) {
        throw new Error(`Item ${item.id} no encontrado`);
      }

      if (existingItem.isInvoiced) {
        throw new Error(`Item ${item.id} ya está facturado`);
      }

      if (existingItem.state !== ITEM_STATES.SOLD) {
        throw new Error(
          `Item ${item.id} debe estar en estado 'sold' para ser facturado`
        );
      }

      // Asociar el item a la orden y al orderProduct (relaciones many-to-many)
      const currentOrders = existingItem.orders?.map((o) => o.id) || [];
      const currentOrderProducts =
        existingItem.orderProducts?.map((op) => op.id) || [];
      await strapi.entityService.update(ITEM_SERVICE, item.id, {
        data: {
          orders: [...currentOrders, order.id],
          orderProducts: [...currentOrderProducts, orderProduct.id],
        },
        transacting: trx,
      });

      return existingItem;
    }
    // Si se proporciona producto + cantidad, buscar items automáticamente
    else if (item.quantity && product) {
      if (!order.customer?.id && !order.parentOrder?.customer?.id) {
        throw new Error("Se requiere customer para buscar items por cantidad");
      }

      const customerId = order.customer?.id || order.parentOrder?.customer?.id;

      // Buscar items disponibles con FIFO
      const selectedItems = await findInvoiceableItemsByQuantity({
        customerId,
        productId: product.id,
        quantity: item.quantity,
        options: { trx },
      });

      // Asociar todos los items seleccionados a la orden y al orderProduct
      for (const selectedItem of selectedItems) {
        const existingItem = selectedItem.item;
        const currentOrders = existingItem.orders?.map((o) => o.id) || [];
        const currentOrderProducts =
          existingItem.orderProducts?.map((op) => op.id) || [];

        await strapi.entityService.update(ITEM_SERVICE, existingItem.id, {
          data: {
            orders: [...currentOrders, order.id],
            orderProducts: [...currentOrderProducts, orderProduct.id],
          },
          transacting: trx,
        });
      }

      // Retornar información de los items seleccionados
      return {
        itemsSelected: selectedItems.length,
        totalQuantity: selectedItems.reduce(
          (sum, si) => sum + si.quantityToInvoice,
          0
        ),
        items: selectedItems.map((si) => ({
          id: si.item.id,
          quantity: si.quantityToInvoice,
          sourceOrder: si.sourceOrder,
        })),
      };
    } else {
      throw new Error(
        "Se requiere id de item o quantity+product para facturación parcial"
      );
    }
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    const ORDER_STATES = require("../../../utils/orderStates");
    const { markItemsAsInvoiced } = require("../utils/invoiceHelpers");

    // Si la orden se completa, marcar items como facturados
    if (orderState === ORDER_STATES.COMPLETED) {
      // Obtener todos los items de esta orden
      const orderWithItems = await strapi.entityService.findOne(
        "api::order.order",
        order.id,
        {
          populate: ["items"],
          transacting: trx,
        }
      );

      const itemIds = orderWithItems.items?.map((i) => i.id) || [];

      if (itemIds.length > 0) {
        await markItemsAsInvoiced(itemIds, { trx });
      }
    }

    // No hay cambios en el item en sí, solo actualizamos la relación
    return item;
  }

  async delete({ item, order, orderProduct, trx, orderType }) {
    const { unmarkItemsAsInvoiced } = require("../utils/invoiceHelpers");
    const { ITEM_SERVICE } = require("../../../utils/services");

    // Obtener el item con sus órdenes y orderProducts
    const existingItem = await strapi.entityService.findOne(
      ITEM_SERVICE,
      item.id,
      {
        populate: ["orders", "orderProducts"],
        transacting: trx,
      }
    );

    if (!existingItem) {
      return item;
    }

    // Desasociar el item de esta orden y orderProduct (mantener otras relaciones)
    const updatedOrders = (existingItem.orders || [])
      .filter((o) => o.id !== order.id)
      .map((o) => o.id);

    const updatedOrderProducts = (existingItem.orderProducts || [])
      .filter((op) => op.id !== orderProduct.id)
      .map((op) => op.id);

    await strapi.entityService.update(ITEM_SERVICE, item.id, {
      data: {
        orders: updatedOrders,
        orderProducts: updatedOrderProducts,
      },
      transacting: trx,
    });

    // Revertir estado de facturación
    await unmarkItemsAsInvoiced([item.id], { trx });

    return existingItem;
  }
}

/**
 * Factory para obtener la estrategia correcta según el tipo de orden
 */
class ItemMovementStrategyFactory {
  static getStrategy(orderType, itemService) {
    const strategies = {
      [ORDER_TYPES.PURCHASE]: PurchaseInStrategy,
      [ORDER_TYPES.IN]: PurchaseInStrategy,
      [ORDER_TYPES.SALE]: SaleStrategy,
      [ORDER_TYPES.RETURN]: ReturnStrategy,
      [ORDER_TYPES.OUT]: OutStrategy,
      [ORDER_TYPES.TRANSFER]: TransferStrategy,
      [ORDER_TYPES.ADJUSTMENT]: AdjustmentStrategy,
      [ORDER_TYPES.TRANSFORM]: TransformStrategy,
      [ORDER_TYPES.PARTIAL_INVOICE]: PartialInvoiceStrategy,
    };

    const StrategyClass = strategies[orderType];

    if (!StrategyClass) {
      throw new Error(`No strategy found for order type: ${orderType}`);
    }

    return new StrategyClass(itemService);
  }
}

module.exports = {
  ItemMovementStrategyFactory,
};
