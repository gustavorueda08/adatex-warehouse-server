/**
 * Estrategias para movimiento de items basadas en el tipo de orden
 * Patrón Strategy para reducir complejidad del método doItemMovement
 */

const ORDER_TYPES = require("../../../utils/orderTypes");
const ITEM_STATES = require("../../../utils/itemStates");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");
const ORDER_STATES = require("../../../utils/orderStates");

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
    // NOTA: Esto soporta actualizaciones masivas (Batch).
    // Si llegan muchos items con ID/Barcode, se buscan y se actualizan a RESERVED aqui.
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
        "Se requiere id, barcode o quantity+product para buscar el item",
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

    if (itemState === ITEM_STATES.SOLD) {
      updateData.warehouse = null;
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
        warehouse: order.destinationWarehouse.id,
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
        "Se requiere id, barcode o quantity+product para buscar el item",
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
        order: order.id,
        orderProduct: orderProduct.id,
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
    orderState,
    parentItem,
    product,
  }) {
    // En addItem puede llegar: barcode, id, o quantity+product
    const updatePayload = {
      update: {
        state:
          order.state == ORDER_STATES.COMPLETED
            ? ITEM_STATES.DROPPED
            : ITEM_STATES.RESERVED,
        order: order.id,
        orderProduct: orderProduct.id,
        warehouse:
          order.state == ORDER_STATES.COMPLETED
            ? null
            : item.warehouse?.id || item.warehouse,
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
        "Se requiere id, barcode o quantity+product para buscar el item",
      );
    }
    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    const ORDER_STATES = require("../../../utils/orderStates");

    let itemState = ITEM_STATES.RESERVED;
    let itemWarehouse = item.warehouse?.id || item.warehouse;

    if (orderState === ORDER_STATES.COMPLETED) {
      itemState = ITEM_STATES.DROPPED;
      itemWarehouse = null;
    } else if (orderState === ORDER_STATES.CANCELLED) {
      itemState = ITEM_STATES.AVAILABLE;
    }

    return await this.itemService.update({
      id: item.id,
      update: {
        state: itemState,
        order: order.id,
        orderProduct: orderProduct.id,
        warehouse: itemWarehouse,
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
        warehouse: order.sourceWarehouse?.id,
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
        state: ITEM_STATES.RESERVED,
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
        "Se requiere id, barcode o quantity+product para buscar el item",
      );
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, trx, orderState, orderType }) {
    const ORDER_STATES = require("../../../utils/orderStates");

    let itemState = ITEM_STATES.RESERVED;
    let targetWarehouse =
      item.warehouse?.id || item.warehouse || order.sourceWarehouse?.id;

    if (orderState === ORDER_STATES.COMPLETED) {
      itemState = ITEM_STATES.AVAILABLE; // Unreserve when transfer is completed
      targetWarehouse =
        order.destinationWarehouse?.id || order.destinationWarehouse;
    } else if (orderState === ORDER_STATES.CANCELLED) {
      itemState = ITEM_STATES.AVAILABLE;
    }

    return await this.itemService.update({
      id: item.id,
      update: {
        state: itemState,
        warehouse: targetWarehouse,
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
      update: {
        state: ITEM_STATES.AVAILABLE,
        warehouse: order.sourceWarehouse?.id || order.sourceWarehouse,
        order: order.id,
        orderProduct: orderProduct.id,
      },
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
        "Se requiere id, barcode o quantity+product para buscar el item",
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

    const sourceItemsConsumedMap = item.sourceItemsConsumed || [];

    // Fallback in case old logic sends a single sourceItemId
    if (sourceItemsConsumedMap.length === 0 && item.sourceItemId) {
      sourceItemsConsumedMap.push({
        id: item.sourceItemId,
        quantity: item.sourceQuantityConsumed || item.quantity,
      });
    }

    if (sourceItemsConsumedMap.length === 0) {
      throw new Error(
        "Se requieren sourceItemsConsumed o sourceItemId para transformaciones",
      );
    }

    const totalSourceQuantityConsumed =
      item.sourceQuantityConsumed || item.quantity;
    const targetQuantity = item.targetQuantity || item.quantity;

    // Check and deduct from all source items securely
    const processedSourceData = [];

    for (const sourceConsumption of sourceItemsConsumedMap) {
      const sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
        where: { id: sourceConsumption.id },
        populate: ["product", "warehouse"],
        ...(trx ? { transacting: trx } : {}),
      });

      if (!sourceItem) {
        throw new Error(
          `Item origen con id ${sourceConsumption.id} no encontrado`,
        );
      }

      const ADJUSTMENT =
        require("../../../utils/inventoryMovementTypes").ADJUSTMENT;

      let missingQuantity = 0;
      if (sourceItem.currentQuantity < sourceConsumption.quantity) {
        if (!item.confirmNegativeStock && !item.forceNegativeStock) {
          throw new Error(
            `Item origen ${sourceItem.barcode} solo tiene ${sourceItem.currentQuantity} ${sourceItem.unit}, se requieren ${sourceConsumption.quantity}`,
          );
        } else {
          missingQuantity =
            sourceConsumption.quantity - sourceItem.currentQuantity;
        }
      }

      if (missingQuantity > 0) {
        const adjustedQuantity = sourceItem.currentQuantity + missingQuantity;

        // Make the adjustment
        await strapi.db.query(ITEM_SERVICE).update({
          where: { id: sourceItem.id },
          data: {
            currentQuantity: adjustedQuantity,
          },
          ...(trx ? { transacting: trx } : {}),
        });

        await strapi.entityService.create(
          INVENTORY_MOVEMENT_SERVICE,
          {
            data: {
              item: sourceItem.id,
              quantity: missingQuantity,
              order: order?.id,
              orderProduct: orderProduct?.id,
              type: ADJUSTMENT,
              reason: `Ajuste por corte de stock negativo: se encontraron ${missingQuantity} ${sourceItem.unit} adicionales físicamente.`,
              balanceBefore: sourceItem.currentQuantity,
              balanceAfter: adjustedQuantity,
              destinationWarehouse: sourceItem.warehouse?.id,
            },
          },
          { transacting: trx },
        );

        // Update the source item object for the next steps
        sourceItem.currentQuantity = adjustedQuantity;
      }

      const newSourceQuantity = Math.max(
        sourceItem.currentQuantity - sourceConsumption.quantity,
        0,
      );

      // Usar db.query update para asegurar escritura directa (ahora consume la cantidad ajustada)
      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: sourceItem.id },
        data: {
          currentQuantity: newSourceQuantity,
        },
        ...(trx ? { transacting: trx } : {}),
      });

      processedSourceData.push({
        sourceItem,
        consumedQuantity: sourceConsumption.quantity,
        newSourceQuantity,
      });
    }

    // The main sourceItem drives defaults like warehouse/lotNumber
    const primarySourceItem = processedSourceData[0].sourceItem;
    const isCut = primarySourceItem.product.id === product.id;

    // 2. Crear el nuevo item (transformado o particionado)
    const newItemData = {
      name: product.name,
      originalQuantity: targetQuantity,
      currentQuantity: targetQuantity,
      unit: product.unit,
      sourceQuantityConsumed: totalSourceQuantityConsumed,
      sourceItemsConsumed: sourceItemsConsumedMap, // Keep history of all consumed parent amounts
      warehouse:
        item.warehouse ||
        primarySourceItem.warehouse?.id ||
        order.destinationWarehouse?.id,
      sourceOrder: order.id,
      orders: { connect: [order.id] },
      orderProducts: { connect: [orderProduct.id] },
      product: product.id,
      lotNumber: item.lotNumber || primarySourceItem.lotNumber,
      itemNumber: item.itemNumber,
      state: ITEM_STATES.AVAILABLE,
      // Generar barcode basado en el primer lote encontrado si aplica
      barcode: require("../../../utils/generateCodes").generateItemBarcode(
        product,
        targetQuantity,
        item.lotNumber || primarySourceItem.lotNumber,
        item.itemNumber,
        order.containerCode,
      ),
    };

    // Establecer relaciones legacy con el primaryItem por compatibilidad o búsquedas simples
    if (isCut) {
      newItemData.parentItem = primarySourceItem.id;
      newItemData.isPartition = true;
    } else {
      newItemData.transformedFromItem = primarySourceItem.id;
    }

    const newItem = await strapi.entityService.create(
      ITEM_SERVICE,
      {
        data: newItemData,
      },
      { transacting: trx },
    );

    // 3. Crear ItemMovements para trazabilidad

    // Crear un Movement OUT/TRANSFORM para cada item origen afectado
    for (const processedData of processedSourceData) {
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: processedData.sourceItem.id,
            quantity: -processedData.consumedQuantity,
            order: order.id,
            orderProduct: orderProduct.id,
            type: TRANSFORM,
            reason: isCut
              ? `Partición de ${processedData.consumedQuantity} ${processedData.sourceItem.unit} del item ${processedData.sourceItem.barcode}`
              : `Transformación de ${processedData.consumedQuantity} ${processedData.sourceItem.unit} de ${processedData.sourceItem.product.name} a ${product.name}`,
            balanceBefore: processedData.sourceItem.currentQuantity,
            balanceAfter: processedData.newSourceQuantity,
            sourceWarehouse: processedData.sourceItem.warehouse?.id,
          },
        },
        { transacting: trx },
      );
    }

    // Movement IN/TRANSFORM del nuevo item fusionado
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
            ? `Creación de item particionado consolidado con ${targetQuantity} ${product.unit}`
            : `Creación de item transformado consolidado: ${targetQuantity} ${product.unit} de ${product.name}`,
          destinationWarehouse: newItemData.warehouse,
          balanceBefore: 0,
          balanceAfter: targetQuantity,
        },
      },
      { transacting: trx },
    );

    return newItem;
  }

  async update({ item, order, orderProduct, trx, orderType }) {
    const { TRANSFORM } = require("../../../utils/inventoryMovementTypes");
    const {
      ITEM_SERVICE,
      INVENTORY_MOVEMENT_SERVICE,
    } = require("../../../utils/services");

    // 1. Obtener el item actual de la base de datos (fullItem) para comparar
    const fullItem = await strapi.db.query(ITEM_SERVICE).findOne({
      where: { id: item.id },
      populate: ["parentItem", "transformedFromItem", "product"],
      ...(trx ? { transacting: trx } : {}),
    });

    if (!fullItem) {
      throw new Error(`Item con id ${item.id} no encontrado`);
    }

    // 2. Determinar el item origen (sourceItem)
    const sourceItemId =
      fullItem.parentItem?.id || fullItem.transformedFromItem?.id;

    // Si no tiene sourceItem (ej. migración antigua), solo actualizamos datos básicos
    // Pero si es una transformación válida, debe tener sourceItem
    let sourceItem = null;
    if (sourceItemId) {
      sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
        where: { id: sourceItemId },
        populate: ["product", "warehouse"],
        ...(trx ? { transacting: trx } : {}),
      });

      if (!sourceItem) {
        throw new Error(
          `Item origen con id ${sourceItemId} no encontrado para actualización`,
        );
      }
    }

    // 3. Calcular diferencia de cantidad
    // item.currentQuantity viene del payload con el nuevo valor
    // fullItem.currentQuantity es el valor actual en BD
    const newQuantity = parseFloat(item.currentQuantity);
    const oldQuantity = parseFloat(fullItem.currentQuantity);
    const quantityDifference = newQuantity - oldQuantity;

    // Si hay diferencia y tenemos sourceItem, ajustar sourceItem
    if (Math.abs(quantityDifference) > 0.0001 && sourceItem) {
      // Si la diferencia es positiva (el hijo crece), necesitamos restar al padre
      // Si la diferencia es negativa (el hijo decrece), sumamos al padre
      // Validar disponibilidad en sourceItem si vamos a consumir más
      if (quantityDifference > 0) {
        if (sourceItem.currentQuantity < quantityDifference) {
          throw new Error(
            `Item origen solo tiene ${sourceItem.currentQuantity} ${sourceItem.unit}, se requieren ${quantityDifference} adicionales`,
          );
        }
      }

      // Actualizar sourceItem
      const newSourceQuantity =
        parseFloat(sourceItem.currentQuantity) - quantityDifference;

      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: sourceItem.id },
        data: {
          currentQuantity: newSourceQuantity,
        },
        ...(trx ? { transacting: trx } : {}),
      });

      // Registrar movimiento en sourceItem (negativo del difference)
      const isCut = !!fullItem.parentItem;
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: sourceItem.id,
            quantity: -quantityDifference,
            order: order.id,
            orderProduct: orderProduct.id,
            type: TRANSFORM,
            reason: isCut
              ? `Ajuste de partición: ${quantityDifference > 0 ? "consumo adicional" : "devolución"} de ${Math.abs(quantityDifference)} ${sourceItem.unit}`
              : `Ajuste de transformación: ${quantityDifference > 0 ? "consumo adicional" : "devolución"} de ${Math.abs(quantityDifference)} ${sourceItem.unit}`,
            balanceBefore: sourceItem.currentQuantity,
            balanceAfter: newSourceQuantity,
            sourceWarehouse: sourceItem.warehouse?.id,
          },
        },
        { transacting: trx },
      );
    }

    // 4. Registrar movimiento en el item transformado si hubo cambio
    // NOTA: ItemService.update NO crea movimiento de TRANSFORM, crea ADJUSTMENT si detecta cambio
    // Pero como estamos dentro de una estrategia de Transform, deberíamos controlar nosotros el movimiento
    // o dejar que ItemService lo haga como Adjustment?
    // Mejor hacerlo explícito como TRANSFORM para consistencia.
    // Sin embargo, ItemService.update forzará un Adjustment si le pasamos currentQuantity diferente.
    // Podemos evitar pasar currentQuantity a ItemService.update y actualizarlo nosotros manualmente
    // O dejar que ItemService lo haga y tener un Adjustment en el historial del hijo (aceptable).
    // PERO, para tener trazabilidad limpia de "Transformación", mejor hacerlo manual aquí y pasar a ItemService solo otros campos.

    // Decisión: Actualizar cantidad manualmente aquí con db.query y crear movimiento TRANSFORM en el hijo.
    // Luego llamar a ItemService.update SIN currentQuantity para actualizar resto de campos (warehouse, relaciones).

    if (Math.abs(quantityDifference) > 0.0001) {
      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: fullItem.id },
        data: {
          currentQuantity: newQuantity,
          originalQuantity: newQuantity, // Actualizamos también original si es un setup inicial/corrección
        },
        ...(trx ? { transacting: trx } : {}),
      });

      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: fullItem.id,
            quantity: quantityDifference,
            order: order.id,
            orderProduct: orderProduct.id,
            type: TRANSFORM,
            reason: `Ajuste de cantidad en transformación: ${quantityDifference > 0 ? "+" : ""}${quantityDifference}`,
            balanceBefore: oldQuantity,
            balanceAfter: newQuantity,
          },
        },
        { transacting: trx },
      );
    }

    // 5. Llamar a ItemService para actualizar otros campos (warehouse, relaciones)
    // Excluimos currentQuantity del objeto update para evitar doble movimiento/actualización
    const { currentQuantity, ...updateData } = item.update || {}; // item ya viene procesado, pero item.id es top level

    // item en argumento es: { id, warehouse, currentQuantity, ... }
    // Preparamos update data para ItemService
    const itemUpdateData = {
      order: order.id,
      orderProduct: orderProduct.id,
      warehouse: item.warehouse || fullItem.warehouse?.id,
      // Si hay cambio de warehouse, ItemService lo manejará (TRANSFER)
    };

    return await this.itemService.update({
      id: item.id,
      update: itemUpdateData,
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

    // Obtener el item con sus relaciones usando query builder para datos frescos
    const fullItem = await strapi.db.query(ITEM_SERVICE).findOne({
      where: { id: item.id },
      populate: ["parentItem", "transformedFromItem", "product"],
      ...(trx ? { transacting: trx } : {}),
    });

    if (!fullItem) {
      throw new Error(`Item con id ${item.id} no encontrado`);
    }

    // Prefer new array-based source tracking, fallback to legacy relationships
    const sourceItemsConsumedMap = fullItem.sourceItemsConsumed || [];
    const isCut = !!fullItem.parentItem;

    // Check if we need to use legacy fallback math logic
    if (sourceItemsConsumedMap.length === 0) {
      const sourceItemId =
        fullItem.parentItem?.id || fullItem.transformedFromItem?.id;

      if (!sourceItemId) {
        throw new Error(
          "No se encontró el item origen para revertir la transformación",
        );
      }

      let quantityToRestore = fullItem.sourceQuantityConsumed;

      if (!quantityToRestore) {
        quantityToRestore =
          fullItem.currentQuantity || fullItem.originalQuantity;

        let factor = 1;
        let multiplySource = false;
        if (fullItem.product?.transformationFactor) {
          factor =
            parseFloat(fullItem.product.transformationFactor.factor) || 1;
          if (
            fullItem.product.transformationFactor.sourceUnit ===
              fullItem.product?.unit &&
            fullItem.product.transformationFactor.destinationUnit ===
              fullItem.parentItem?.product?.unit
          ) {
            multiplySource = true;
          } else {
            multiplySource = false;
          }
        }

        if (factor !== 1) {
          quantityToRestore = multiplySource
            ? quantityToRestore * factor
            : quantityToRestore / factor;
        }
      } else {
        if (
          fullItem.originalQuantity &&
          fullItem.currentQuantity !== fullItem.originalQuantity
        ) {
          const ratio = fullItem.currentQuantity / fullItem.originalQuantity;
          quantityToRestore = quantityToRestore * ratio;
        }
      }

      sourceItemsConsumedMap.push({
        id: sourceItemId,
        quantity: quantityToRestore,
      });
    }

    // 1 & 2. Restaurar cantidades y crear movimientos
    for (const sourceConsumption of sourceItemsConsumedMap) {
      const sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
        where: { id: sourceConsumption.id },
        populate: ["warehouse", "product"],
        ...(trx ? { transacting: trx } : {}),
      });

      if (!sourceItem) {
        throw new Error(
          `Item origen con id ${sourceConsumption.id} no encontrado durante reversión`,
        );
      }

      const restoredQuantity =
        parseFloat(sourceItem.currentQuantity) +
        parseFloat(sourceConsumption.quantity);

      // Actualizar sourceItem
      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: sourceItem.id },
        data: {
          currentQuantity: restoredQuantity,
        },
        ...(trx ? { transacting: trx } : {}),
      });

      // Movement reversión del consumo
      await strapi.entityService.create(
        INVENTORY_MOVEMENT_SERVICE,
        {
          data: {
            item: sourceItem.id,
            quantity: sourceConsumption.quantity,
            order: order?.id,
            orderProduct: orderProduct?.id,
            type: TRANSFORM,
            reason: isCut
              ? `Reversión de partición consolidada: restaurando ${sourceConsumption.quantity} ${sourceItem.unit}`
              : `Reversión de transformación consolidada: restaurando ${sourceConsumption.quantity} ${sourceItem.unit}`,
            balanceBefore: sourceItem.currentQuantity,
            balanceAfter: restoredQuantity,
            destinationWarehouse: sourceItem.warehouse?.id,
          },
        },
        { transacting: trx },
      );

      // Check for any ADJUSTMENT movement created during the forced negative stock
      const { ADJUSTMENT } = require("../../../utils/inventoryMovementTypes");
      const adjustmentMovements = await strapi.entityService.findMany(
        INVENTORY_MOVEMENT_SERVICE,
        {
          filters: {
            item: sourceItem.id,
            order: order?.id,
            orderProduct: orderProduct?.id,
            type: ADJUSTMENT,
          },
          ...(trx ? { transacting: trx } : {}),
        },
      );

      // Revertir the adjustment if one was found
      let currentItemQuantity = restoredQuantity;
      for (const adjMovement of adjustmentMovements) {
        if (adjMovement.quantity > 0) {
          const revertQuantity = -adjMovement.quantity;
          currentItemQuantity = currentItemQuantity + revertQuantity;

          await strapi.db.query(ITEM_SERVICE).update({
            where: { id: sourceItem.id },
            data: {
              currentQuantity: currentItemQuantity,
            },
            ...(trx ? { transacting: trx } : {}),
          });

          await strapi.entityService.create(
            INVENTORY_MOVEMENT_SERVICE,
            {
              data: {
                item: sourceItem.id,
                quantity: revertQuantity,
                order: order?.id,
                orderProduct: orderProduct?.id,
                type: ADJUSTMENT,
                reason: `Reversión de ajuste por stock negativo: removiendo ${adjMovement.quantity} ${sourceItem.unit}`,
                balanceBefore: currentItemQuantity - revertQuantity,
                balanceAfter: currentItemQuantity,
                destinationWarehouse: sourceItem.warehouse?.id,
              },
            },
            { transacting: trx },
          );
        }
      }
    }

    // 3. Crear movement de reversión para el item transformado (antes de eliminarlo)
    await strapi.entityService.create(
      INVENTORY_MOVEMENT_SERVICE,
      {
        data: {
          item: fullItem.id,
          quantity: -fullItem.currentQuantity,
          order: order?.id,
          orderProduct: orderProduct?.id,
          type: TRANSFORM,
          reason: `Reversión: eliminación de item consolidado ${isCut ? "particionado" : "transformado"}`,
          balanceBefore: fullItem.currentQuantity,
          balanceAfter: 0,
        },
      },
      { transacting: trx },
    );

    // 4. Eliminar el item transformado/particionado DIRECTAMENTE
    await strapi.db.query(ITEM_SERVICE).delete({
      where: { id: fullItem.id },
      ...(trx ? { transacting: trx } : {}),
    });

    return true;
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
        },
      );

      if (!existingItem) {
        throw new Error(`Item ${item.id} no encontrado`);
      }

      if (existingItem.isInvoiced) {
        throw new Error(`Item ${item.id} ya está facturado`);
      }

      if (existingItem.state !== ITEM_STATES.SOLD) {
        throw new Error(
          `Item ${item.id} debe estar en estado 'sold' para ser facturado`,
        );
      }

      // IMPORTANTE: Aquí podríamos validar nuevamente que el item pertenezca al customer de la orden
      // pero esa validación ya se hizo (idealmente) en el validatePartialInvoiceOrder o en los servicios base.

      // Asociar el item a la orden y al orderProduct (relaciones many-to-many)
      const currentOrders = existingItem.orders?.map((o) => o.id) || [];
      const currentOrderProducts =
        existingItem.orderProducts?.map((op) => op.id) || [];

      // Evitar duplicados
      const nextOrders = currentOrders.includes(order.id)
        ? currentOrders
        : [...currentOrders, order.id];
      const nextOrderProducts = currentOrderProducts.includes(orderProduct.id)
        ? currentOrderProducts
        : [...currentOrderProducts, orderProduct.id];

      await strapi.entityService.update(ITEM_SERVICE, item.id, {
        data: {
          orders: nextOrders,
          orderProducts: nextOrderProducts,
        },
        transacting: trx,
      });

      return existingItem;
    }
    // Si se proporciona producto + cantidad, buscar items automáticamente
    else if (item.quantity && product) {
      const customerId = order.customer?.id || order.parentOrder?.customer?.id;

      if (!customerId) {
        throw new Error(
          "Se requiere customer explícito o en parentOrder para buscar items por cantidad",
        );
      }

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

        // Re-fetch para asegurar relaciones actualizadas si es necesario,
        // aunque findInvoiceableItemsByQuantity ya debería traer lo necesario,
        // pero para evitar race conditions en updates masivos, mejor hacer push correcto.
        // Aquí asumimos carga fresca o merge array.
        const currentOrders = existingItem.orders?.map((o) => o.id) || [];
        const currentOrderProducts =
          existingItem.orderProducts?.map((op) => op.id) || [];

        const nextOrders = currentOrders.includes(order.id)
          ? currentOrders
          : [...currentOrders, order.id];
        const nextOrderProducts = currentOrderProducts.includes(orderProduct.id)
          ? currentOrderProducts
          : [...currentOrderProducts, orderProduct.id];

        await strapi.service(ITEM_SERVICE).update({
          id: existingItem.id,
          type: "partial-invoice", // Required by UpdateItemSchema
          update: {
            orders: nextOrders,
            orderProducts: nextOrderProducts,
          },
          trx,
        });
      }

      // Retornar información de los items seleccionados
      return {
        itemsSelected: selectedItems.length,
        totalQuantity: selectedItems.reduce(
          (sum, si) => sum + si.quantityToInvoice,
          0,
        ),
        items: selectedItems.map((si) => ({
          id: si.item.id,
          quantity: si.quantityToInvoice,
          sourceOrder: si.sourceOrder,
        })),
        // Hack: Para que el frontend/controlador sepa qué items se agarraron
        // aunque usualmente esto devuelve el 'item' actualizado.
      };
    } else {
      throw new Error(
        "Se requiere id de item o quantity+product para facturación parcial",
      );
    }
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    const ORDER_STATES = require("../../../utils/orderStates");
    const { markItemsAsInvoiced } = require("../utils/invoiceHelpers");

    // Lógica para FACTURACIÓN MANUAL al completar la orden
    if (orderState === ORDER_STATES.COMPLETED) {
      // Verificar si viene información de factura manual en el update del Order.
      // OJO: Strapi 'update' lifecycle/service a veces no pasa el payload completo aquí,
      // sino el objeto order ya actualizado.
      // La estrategia recibe 'order' que es el objeto DE BASE DE DATOS actual o ya actualizado.
      // Pero para capturar datos "extra" como siigoId manual que vienen en la petición,
      // necesitamos que el servicio de order los haya guardado o los tengamos disponibles.

      // Asumimos que el controller/service ya guardó el siigoId en la orden si venía en el body,
      // O que vamos a validar aquí si tiene siigoId y obtener datos de Siigo.

      // 2. Marcar items como facturados
      // Obtener todos los items de esta orden
      const orderWithItems = await strapi.entityService.findOne(
        "api::order.order",
        order.id,
        {
          populate: ["items"],
          transacting: trx,
        },
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
      },
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
 * Estrategia para órdenes de nacionalización (zona franca → bodega stock).
 *
 * Idéntica a TransferStrategy en comportamiento:
 * - CREATE: reserva items en la bodega zona franca (sourceWarehouse)
 * - UPDATE (COMPLETED): mueve items a la bodega stock (destinationWarehouse)
 * - UPDATE (CANCELLED): revierte a la bodega zona franca
 * - DELETE: devuelve items a la bodega zona franca y los deja AVAILABLE
 *
 * La validación de que sourceWarehouse.type === "freeTradeZone" y
 * destinationWarehouse.type === "stock" ocurre en el servicio de orden,
 * no aquí.
 */
class NationalizationStrategy extends TransferStrategy {}

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
      [ORDER_TYPES.NATIONALIZATION]: NationalizationStrategy,
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
