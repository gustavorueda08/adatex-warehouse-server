/**
 * @fileoverview Estrategias de movimiento de items por tipo de orden.
 *
 * Patrón Strategy: cada tipo de orden tiene una clase que implementa
 * tres operaciones sobre Items:
 *   - create  → cuando se agrega un item a la orden
 *   - update  → cuando cambia el estado de la orden (o de un item)
 *   - delete  → cuando se retira un item de la orden (reversión)
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  TABLA DE TRANSICIONES DE ESTADO POR TIPO DE ORDEN
 * ─────────────────────────────────────────────────────────────────────────
 *  Tipo         │ create             │ update→completed   │ delete (reversión)
 * ─────────────────────────────────────────────────────────────────────────
 *  purchase/in  │ crea item AVAILABLE│ (sin cambio estado)│ elimina el item
 *  sale         │ AVAILABLE→RESERVED │ RESERVED→SOLD      │ RESERVED→AVAILABLE
 *  transfer     │ AVAILABLE→RESERVED │ RESERVED→AVAILABLE │ RESERVED→AVAILABLE
 *               │                    │ + mueve a destino  │ + restaura bodega
 *  return       │ (any)→AVAILABLE    │ AVAILABLE          │ AVAILABLE→SOLD
 *               │ + mueve a destino  │                    │
 *  out          │ AVAILABLE→RESERVED │ RESERVED→DROPPED   │ RESERVED→AVAILABLE
 *               │ (DROPPED si ya     │ + bodega = null    │ + restaura bodega
 *               │  completada)       │                    │
 *  adjustment   │ sin cambio estado  │ sin cambio estado  │ revierte cantidad
 *  transform    │ consume fuentes    │ ajusta fuentes     │ restaura fuentes
 *               │ + crea item nuevo  │ + ajusta item nuevo│ + elimina item nuevo
 *  partial-inv. │ asocia items SOLD  │ marca isInvoiced   │ desmarca isInvoiced
 *               │ (FIFO sin inv.)    │ = true             │
 *  nationalization│ AVAILABLE        │ AVAILABLE          │ restaura bodega origen
 *               │ (nunca RESERVED)   │ + mueve a destino  │
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  NOTA DE RENDIMIENTO (operaciones masivas):
 *  Para órdenes con muchos items (p.ej. 10k camisas fixedQuantityPerItem),
 *  las estrategias individuales NO se llaman en bucle. En su lugar,
 *  `orderHelpers.js` usa funciones bulk (bulkCreatePurchaseItems,
 *  bulkUpdateSaleItems, bulkMoveItemsToWarehouse, etc.) que operan
 *  directamente sobre Knex para evitar el límite de variables de SQLite
 *  y el problema de SQLITE_BUSY con múltiples conexiones.
 *  Las estrategias de este archivo se usan para operaciones individuales
 *  (addItem / removeItem) y para tipos de producto variableQuantityPerItem.
 */

"use strict";

const ORDER_TYPES   = require("../../../utils/orderTypes");
const ORDER_STATES  = require("../../../utils/orderStates");
const ITEM_STATES   = require("../../../utils/itemStates");
const {
  IN,
  OUT,
  TRANSFORM,
  ADJUSTMENT,
} = require("../../../utils/inventoryMovementTypes");
const {
  ITEM_SERVICE,
  INVENTORY_MOVEMENT_SERVICE,
} = require("../../../utils/services");
const {
  findInvoiceableItemsByQuantity,
  markItemsAsInvoiced,
  unmarkItemsAsInvoiced,
} = require("../utils/invoiceHelpers");
const {
  generateItemBarcode,
} = require("../../../utils/generateCodes");

// ─────────────────────────────────────────────────────────────────────────────
//  CLASE BASE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia base — define la interfaz que todas las estrategias deben implementar.
 */
class ItemMovementStrategy {
  constructor(itemService) {
    this.itemService = itemService;
  }

  async create(data) { throw new Error("create() must be implemented"); }
  async update(data) { throw new Error("update() must be implemented"); }
  async delete(data) { throw new Error("delete() must be implemented"); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PURCHASE / IN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para órdenes de compra (purchase) e ingreso manual (in).
 *
 * CREATE  → crea un item nuevo en AVAILABLE dentro de destinationWarehouse.
 * UPDATE  → actualiza costo y asocia a orderProduct; sin cambio de estado.
 * DELETE  → elimina el item (solo válido en borradores).
 */
class PurchaseInStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, trx, orderType }) {
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

  async update({ item, order, orderProduct, orderType, trx }) {
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

  async delete({ item, order, orderProduct, orderType, trx }) {
    return await this.itemService.delete({
      id: item.id,
      order: order.id,
      orderProduct: orderProduct.id,
      trx,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SALE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para órdenes de venta.
 *
 * CREATE  → busca item AVAILABLE (por id, barcode o quantity+product)
 *           y lo marca RESERVED.
 * UPDATE  → DRAFT/CONFIRMED → RESERVED
 *           COMPLETED → SOLD (bodega = null)
 *           CANCELLED → AVAILABLE
 * DELETE  → RESERVED → AVAILABLE (UNRESERVE movement).
 */
class SaleStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
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

    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity  = item.quantity;
      updatePayload.product   = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error("Se requiere id, barcode o quantity+product para buscar el item");
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
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

    // Los items vendidos no tienen ubicación física en bodega
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

  async delete({ item, order, orderProduct, orderType, trx }) {
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

// ─────────────────────────────────────────────────────────────────────────────
//  RETURN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para devoluciones de clientes.
 *
 * CREATE  → busca el item (usualmente SOLD) y lo pone AVAILABLE
 *           en destinationWarehouse (bodega de recepción).
 * UPDATE  → AVAILABLE en cualquier estado excepto CANCELLED.
 *           CANCELLED → SOLD (reversión de la devolución).
 * DELETE  → revierte a SOLD (el item vuelve a ser "vendido").
 */
class ReturnStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
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

    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity  = item.quantity;
      updatePayload.product   = product.id;
      updatePayload.warehouse = item.warehouse;
    } else {
      throw new Error("Se requiere id, barcode o quantity+product para buscar el item");
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    // Si la devolución se cancela, el item vuelve a SOLD.
    // En cualquier otro estado (draft/confirmed/completed) queda AVAILABLE.
    const itemState = orderState === ORDER_STATES.CANCELLED
      ? ITEM_STATES.SOLD
      : ITEM_STATES.AVAILABLE;

    return await this.itemService.update({
      id: item.id,
      update: {
        state: itemState,
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({ item, order, orderProduct, orderType, trx }) {
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

// ─────────────────────────────────────────────────────────────────────────────
//  OUT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para órdenes de salida manual (muestras, merma, pérdida, etc.).
 *
 * CREATE  → AVAILABLE → RESERVED (si la orden está en draft/confirmed).
 *           Si la orden ya está COMPLETED → AVAILABLE → DROPPED directamente.
 * UPDATE  → COMPLETED → RESERVED/AVAILABLE → DROPPED + bodega = null.
 *           CANCELLED → AVAILABLE.
 * DELETE  → revierte a AVAILABLE restaurando la bodega origen.
 */
class OutStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
    const isAlreadyCompleted = order.state === ORDER_STATES.COMPLETED;

    const updatePayload = {
      update: {
        state: isAlreadyCompleted ? ITEM_STATES.DROPPED : ITEM_STATES.RESERVED,
        order: order.id,
        orderProduct: orderProduct.id,
        warehouse: isAlreadyCompleted
          ? null
          : item.warehouse?.id || item.warehouse,
      },
      type: orderType,
      trx,
      justAvailableItems: true,
    };

    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity  = item.quantity;
      updatePayload.product   = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error("Se requiere id, barcode o quantity+product para buscar el item");
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    let itemState     = ITEM_STATES.RESERVED;
    let itemWarehouse = item.warehouse?.id || item.warehouse;

    if (orderState === ORDER_STATES.COMPLETED) {
      itemState     = ITEM_STATES.DROPPED;
      itemWarehouse = null; // los items de salida no tienen ubicación física
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

  async delete({ item, order, orderProduct, orderType, trx }) {
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

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSFER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para traslados entre bodegas.
 *
 * CREATE  → AVAILABLE → RESERVED en sourceWarehouse.
 * UPDATE  → COMPLETED → AVAILABLE en destinationWarehouse (la bodega cambia).
 *           CANCELLED → AVAILABLE (permanece en sourceWarehouse).
 * DELETE  → RESERVED → AVAILABLE restaurando sourceWarehouse.
 *
 * NOTA: el cambio masivo de bodega para todos los items se hace en
 * `bulkMoveItemsToWarehouse` (orderHelpers.js), no aquí.
 * Esta estrategia cubre el caso de addItem/removeItem individuales.
 */
class TransferStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
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

    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity  = item.quantity;
      updatePayload.product   = product.id;
      updatePayload.warehouse = item.warehouse || order.sourceWarehouse?.id;
    } else {
      throw new Error("Se requiere id, barcode o quantity+product para buscar el item");
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderState, orderType, trx }) {
    let itemState        = ITEM_STATES.RESERVED;
    let targetWarehouse  = item.warehouse?.id || item.warehouse || order.sourceWarehouse?.id;

    if (orderState === ORDER_STATES.COMPLETED) {
      // Transferencia completada: el item llega a la bodega destino y queda disponible
      itemState       = ITEM_STATES.AVAILABLE;
      targetWarehouse = order.destinationWarehouse?.id || order.destinationWarehouse;
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

  async delete({ item, order, orderProduct, orderType, trx }) {
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

// ─────────────────────────────────────────────────────────────────────────────
//  ADJUSTMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para ajustes manuales de inventario.
 *
 * No cambia el estado del item — solo asocia el item a la orden y
 * permite actualizar currentQuantity. ItemService detecta el cambio de
 * cantidad y genera automáticamente un movimiento ADJUSTMENT.
 *
 * CREATE  → asocia item a la orden; aplica currentQuantity si se envía.
 * UPDATE  → solo actualiza la relación con orden/orderProduct.
 * DELETE  → revierte la cantidad al valor anterior (usando balanceBefore del último movimiento).
 */
class AdjustmentStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
    const updatePayload = {
      update: {
        order: order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    };

    if (item.id) {
      updatePayload.id = item.id;
    } else if (item.barcode) {
      updatePayload.barcode = item.barcode;
    } else if (item.quantity && product) {
      updatePayload.quantity  = item.quantity;
      updatePayload.product   = product.id;
      updatePayload.warehouse = item.warehouse || order.destinationWarehouse?.id;
    } else {
      throw new Error("Se requiere id, barcode o quantity+product para buscar el item");
    }

    if (item.currentQuantity !== undefined) {
      updatePayload.update.currentQuantity = item.currentQuantity;
    }

    return await this.itemService.update(updatePayload);
  }

  async update({ item, order, orderProduct, orderType, trx }) {
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

  async delete({ item, order, orderProduct, orderType, movements, trx }) {
    // Recuperar la cantidad previa desde el último movimiento de este item
    const lastMovement = movements?.at(-1);
    if (!lastMovement) {
      throw new Error("No hay movimientos registrados para este Item");
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

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSFORM — helpers privados
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa el consumo de un item fuente durante una transformación.
 *
 * Si el item fuente tiene stock insuficiente y se indica confirmNegativeStock,
 * se crea un ajuste previo que añade la cantidad faltante (representa stock
 * físico encontrado en el conteo).
 *
 * @returns {{ sourceItem, consumedQuantity, newSourceQuantity }}
 */
async function _processOneSourceConsumption(
  sourceConsumption,
  { order, orderProduct, confirmNegativeStock, trx },
) {
  const sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
    where: { id: sourceConsumption.id },
    populate: ["product", "warehouse"],
    ...(trx ? { transacting: trx } : {}),
  });

  if (!sourceItem) {
    throw new Error(`Item fuente con id ${sourceConsumption.id} no encontrado`);
  }

  // ── Manejo de stock insuficiente ─────────────────────────────────────────
  if (sourceItem.currentQuantity < sourceConsumption.quantity) {
    if (!confirmNegativeStock) {
      throw new Error(
        `Item fuente ${sourceItem.barcode} solo tiene ${sourceItem.currentQuantity} ${sourceItem.unit}, ` +
        `se requieren ${sourceConsumption.quantity}`,
      );
    }

    // El operario confirmó que hay más stock físico del registrado.
    // Creamos un ajuste para cuadrar la diferencia antes de consumir.
    const missingQty    = sourceConsumption.quantity - sourceItem.currentQuantity;
    const adjustedQty   = sourceItem.currentQuantity + missingQty;

    await strapi.db.query(ITEM_SERVICE).update({
      where: { id: sourceItem.id },
      data:  { currentQuantity: adjustedQty },
      ...(trx ? { transacting: trx } : {}),
    });

    await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
      data: {
        item:                 sourceItem.id,
        quantity:             missingQty,
        order:                order?.id,
        orderProduct:         orderProduct?.id,
        type:                 ADJUSTMENT,
        reason:               `Ajuste por transformación con stock negativo: +${missingQty} ${sourceItem.unit} encontrados físicamente.`,
        balanceBefore:        sourceItem.currentQuantity,
        balanceAfter:         adjustedQty,
        destinationWarehouse: sourceItem.warehouse?.id,
      },
    }, { transacting: trx });

    sourceItem.currentQuantity = adjustedQty;
  }

  // ── Deducir la cantidad consumida ────────────────────────────────────────
  const newSourceQuantity = Math.max(sourceItem.currentQuantity - sourceConsumption.quantity, 0);

  await strapi.db.query(ITEM_SERVICE).update({
    where: { id: sourceItem.id },
    data:  { currentQuantity: newSourceQuantity },
    ...(trx ? { transacting: trx } : {}),
  });

  return { sourceItem, consumedQuantity: sourceConsumption.quantity, newSourceQuantity };
}

/**
 * Crea los movimientos de inventario TRANSFORM para todos los items procesados.
 *
 * @param {Array}  processedSources  - Resultado de _processOneSourceConsumption[]
 * @param {Object} newItem           - Item transformado recién creado
 * @param {Object} product           - Producto del item nuevo
 * @param {Object} order
 * @param {Object} orderProduct
 * @param {boolean} isCut            - true si es partición del mismo producto
 * @param {*}      trx
 */
async function _createTransformMovements(
  processedSources,
  newItem,
  product,
  order,
  orderProduct,
  isCut,
  trx,
) {
  // Movimiento OUT/TRANSFORM por cada item fuente consumido
  for (const { sourceItem, consumedQuantity, newSourceQuantity } of processedSources) {
    await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
      data: {
        item:            sourceItem.id,
        quantity:        -consumedQuantity,
        order:           order.id,
        orderProduct:    orderProduct.id,
        type:            TRANSFORM,
        reason: isCut
          ? `Partición: consumidos ${consumedQuantity} ${sourceItem.unit} del item ${sourceItem.barcode}`
          : `Transformación: consumidos ${consumedQuantity} ${sourceItem.unit} de ${sourceItem.product.name} a ${product.name}`,
        balanceBefore:   sourceItem.currentQuantity, // valor antes de la deducción (ya descontado arriba)
        balanceAfter:    newSourceQuantity,
        sourceWarehouse: sourceItem.warehouse?.id,
      },
    }, { transacting: trx });
  }

  // Movimiento IN/TRANSFORM para el item nuevo creado
  await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
    data: {
      item:                 newItem.id,
      quantity:             newItem.currentQuantity,
      order:                order.id,
      orderProduct:         orderProduct.id,
      type:                 TRANSFORM,
      reason: isCut
        ? `Partición creada: ${newItem.currentQuantity} ${product.unit}`
        : `Transformación creada: ${newItem.currentQuantity} ${product.unit} de ${product.name}`,
      balanceBefore:        0,
      balanceAfter:         newItem.currentQuantity,
      destinationWarehouse: newItem.warehouse,
    },
  }, { transacting: trx });
}

/**
 * Restaura las cantidades de los items fuente durante la reversión de una transformación.
 * También revierte cualquier ajuste de stock negativo que se haya creado.
 *
 * @param {Array}  sourceItemsMap  - Array de { id, quantity }
 * @param {Object} order
 * @param {Object} orderProduct
 * @param {boolean} isCut
 * @param {*}      trx
 */
async function _restoreSourceItems(sourceItemsMap, order, orderProduct, isCut, trx) {
  // Pre-cargar en una sola query los adjustments creados durante la transformación
  // para revertirlos también (evitar N+1).
  const sourceIds = sourceItemsMap.map((sc) => sc.id).filter(Boolean);
  const adjustmentMovements = sourceIds.length > 0
    ? await strapi.entityService.findMany(INVENTORY_MOVEMENT_SERVICE, {
        filters: {
          item:         { id: { $in: sourceIds } },
          order:        order?.id,
          orderProduct: orderProduct?.id,
          type:         ADJUSTMENT,
        },
        ...(trx ? { transacting: trx } : {}),
      })
    : [];

  for (const sourceConsumption of sourceItemsMap) {
    const sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
      where:    { id: sourceConsumption.id },
      populate: ["warehouse", "product"],
      ...(trx ? { transacting: trx } : {}),
    });

    if (!sourceItem) {
      throw new Error(`Item fuente ${sourceConsumption.id} no encontrado durante reversión`);
    }

    // ── Restaurar cantidad consumida ─────────────────────────────────────
    const restoredQty = parseFloat(sourceItem.currentQuantity) + parseFloat(sourceConsumption.quantity);

    await strapi.db.query(ITEM_SERVICE).update({
      where: { id: sourceItem.id },
      data:  { currentQuantity: restoredQty },
      ...(trx ? { transacting: trx } : {}),
    });

    await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
      data: {
        item:                 sourceItem.id,
        quantity:             sourceConsumption.quantity,
        order:                order?.id,
        orderProduct:         orderProduct?.id,
        type:                 TRANSFORM,
        reason: isCut
          ? `Reversión de partición: restaurando ${sourceConsumption.quantity} ${sourceItem.unit}`
          : `Reversión de transformación: restaurando ${sourceConsumption.quantity} ${sourceItem.unit}`,
        balanceBefore:        sourceItem.currentQuantity,
        balanceAfter:         restoredQty,
        destinationWarehouse: sourceItem.warehouse?.id,
      },
    }, { transacting: trx });

    // ── Revertir ajustes de stock negativo asociados ─────────────────────
    const itemAdjustments = adjustmentMovements.filter(
      (m) => (m.item?.id ?? m.item) === sourceItem.id,
    );

    let currentQty = restoredQty;
    for (const adj of itemAdjustments) {
      if (adj.quantity > 0) {
        currentQty -= adj.quantity;

        await strapi.db.query(ITEM_SERVICE).update({
          where: { id: sourceItem.id },
          data:  { currentQuantity: currentQty },
          ...(trx ? { transacting: trx } : {}),
        });

        await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
          data: {
            item:                 sourceItem.id,
            quantity:             -adj.quantity,
            order:                order?.id,
            orderProduct:         orderProduct?.id,
            type:                 ADJUSTMENT,
            reason:               `Reversión de ajuste por stock negativo: -${adj.quantity} ${sourceItem.unit}`,
            balanceBefore:        currentQty + adj.quantity,
            balanceAfter:         currentQty,
            destinationWarehouse: sourceItem.warehouse?.id,
          },
        }, { transacting: trx });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para transformaciones y cortes de materiales.
 *
 * Soporta dos casos:
 *   - Partición (isCut = true): el fuente y el resultado son del mismo producto
 *     (p.ej. cortar un rollo de tela en piezas del mismo producto).
 *   - Transformación (isCut = false): se consume un producto y se produce otro
 *     (p.ej. rollo de tela → piezas de 1 metro de "tela cortada").
 *
 * Un item puede tener MÚLTIPLES fuentes (sourceItemsConsumed array).
 *
 * CREATE  → consume cantidades de los items fuente → crea item nuevo en destino.
 * UPDATE  → ajusta la cantidad del item transformado y las fuentes proporcionalmente.
 * DELETE  → restaura las cantidades de los items fuente → elimina el item transformado.
 */
class TransformStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
    // Normalizar sourceItemsConsumed al formato moderno: [{ id, quantity }, ...]
    const sourceItemsMap = [...(item.sourceItemsConsumed || [])];

    // Retrocompatibilidad: el payload antiguo usaba sourceItemId + sourceQuantityConsumed
    if (sourceItemsMap.length === 0 && item.sourceItemId) {
      sourceItemsMap.push({
        id:       item.sourceItemId,
        quantity: item.sourceQuantityConsumed || item.quantity,
      });
    }

    if (sourceItemsMap.length === 0) {
      throw new Error("Se requiere sourceItemsConsumed (o sourceItemId) para transformaciones");
    }

    const targetQuantity = item.targetQuantity || item.quantity;

    // 1. Consumir todos los items fuente
    const processedSources = [];
    for (const sourceConsumption of sourceItemsMap) {
      const result = await _processOneSourceConsumption(sourceConsumption, {
        order,
        orderProduct,
        confirmNegativeStock: item.confirmNegativeStock || item.forceNegativeStock,
        trx,
      });
      processedSources.push(result);
    }

    const primarySource = processedSources[0].sourceItem;
    const isCut         = primarySource.product.id === product.id;

    // 2. Crear el item transformado / particionado
    const newItemData = {
      name:                  product.name,
      originalQuantity:      targetQuantity,
      currentQuantity:       targetQuantity,
      unit:                  product.unit,
      sourceQuantityConsumed: item.sourceQuantityConsumed || item.quantity,
      sourceItemsConsumed:   sourceItemsMap,
      warehouse:             item.warehouse || primarySource.warehouse?.id || order.destinationWarehouse?.id,
      sourceOrder:           order.id,
      orders:                { connect: [order.id] },
      orderProducts:         { connect: [orderProduct.id] },
      product:               product.id,
      lotNumber:             item.lotNumber || primarySource.lotNumber,
      itemNumber:            item.itemNumber,
      state:                 ITEM_STATES.AVAILABLE,
      barcode:               generateItemBarcode(
        product,
        targetQuantity,
        item.lotNumber || primarySource.lotNumber,
        item.itemNumber,
        order.containerCode,
      ),
    };

    // Establecer relación de linaje con el item fuente principal
    if (isCut) {
      newItemData.parentItem   = primarySource.id;
      newItemData.isPartition  = true;
    } else {
      newItemData.transformedFromItem = primarySource.id;
    }

    const newItem = await strapi.entityService.create(
      ITEM_SERVICE,
      { data: newItemData },
      { transacting: trx },
    );

    // 3. Crear movimientos de trazabilidad
    await _createTransformMovements(processedSources, newItem, product, order, orderProduct, isCut, trx);

    return newItem;
  }

  async update({ item, order, orderProduct, orderType, trx }) {
    // Cargar el item transformado actual para comparar cantidades
    const fullItem = await strapi.db.query(ITEM_SERVICE).findOne({
      where:    { id: item.id },
      populate: ["parentItem", "transformedFromItem", "product"],
      ...(trx ? { transacting: trx } : {}),
    });

    if (!fullItem) {
      throw new Error(`Item con id ${item.id} no encontrado`);
    }

    const sourceItemId = fullItem.parentItem?.id || fullItem.transformedFromItem?.id;
    let sourceItem = null;

    if (sourceItemId) {
      sourceItem = await strapi.db.query(ITEM_SERVICE).findOne({
        where:    { id: sourceItemId },
        populate: ["product", "warehouse"],
        ...(trx ? { transacting: trx } : {}),
      });

      if (!sourceItem) {
        throw new Error(`Item fuente ${sourceItemId} no encontrado para actualización`);
      }
    }

    const newQty        = parseFloat(item.currentQuantity);
    const oldQty        = parseFloat(fullItem.currentQuantity);
    const quantityDelta = newQty - oldQty;

    // Ajustar el item fuente proporcionalmente al cambio de cantidad
    if (Math.abs(quantityDelta) > 0.0001 && sourceItem) {
      if (quantityDelta > 0 && sourceItem.currentQuantity < quantityDelta) {
        throw new Error(
          `Item fuente solo tiene ${sourceItem.currentQuantity} ${sourceItem.unit}, ` +
          `se requieren ${quantityDelta} adicionales`,
        );
      }

      const newSourceQty = parseFloat(sourceItem.currentQuantity) - quantityDelta;
      const isCut        = !!fullItem.parentItem;

      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: sourceItem.id },
        data:  { currentQuantity: newSourceQty },
        ...(trx ? { transacting: trx } : {}),
      });

      await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
        data: {
          item:            sourceItem.id,
          quantity:        -quantityDelta,
          order:           order.id,
          orderProduct:    orderProduct.id,
          type:            TRANSFORM,
          reason: isCut
            ? `Ajuste de partición: ${quantityDelta > 0 ? "+consumo" : "devolución"} de ${Math.abs(quantityDelta)} ${sourceItem.unit}`
            : `Ajuste de transformación: ${quantityDelta > 0 ? "+consumo" : "devolución"} de ${Math.abs(quantityDelta)} ${sourceItem.unit}`,
          balanceBefore:   sourceItem.currentQuantity,
          balanceAfter:    newSourceQty,
          sourceWarehouse: sourceItem.warehouse?.id,
        },
      }, { transacting: trx });

      // Actualizar cantidad del item transformado directamente (evitar doble movimiento)
      await strapi.db.query(ITEM_SERVICE).update({
        where: { id: fullItem.id },
        data:  { currentQuantity: newQty, originalQuantity: newQty },
        ...(trx ? { transacting: trx } : {}),
      });

      await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
        data: {
          item:          fullItem.id,
          quantity:      quantityDelta,
          order:         order.id,
          orderProduct:  orderProduct.id,
          type:          TRANSFORM,
          reason:        `Ajuste de cantidad en transformación: ${quantityDelta > 0 ? "+" : ""}${quantityDelta}`,
          balanceBefore: oldQty,
          balanceAfter:  newQty,
        },
      }, { transacting: trx });
    }

    // Actualizar relaciones y bodega (sin re-enviar currentQuantity para evitar doble movimiento)
    return await this.itemService.update({
      id:     item.id,
      update: {
        order:        order.id,
        orderProduct: orderProduct.id,
        warehouse:    item.warehouse || fullItem.warehouse?.id,
      },
      type: orderType,
      trx,
    });
  }

  async delete({ item, order, orderProduct, orderType, trx }) {
    // Cargar el item transformado con sus relaciones de linaje
    const fullItem = await strapi.db.query(ITEM_SERVICE).findOne({
      where:    { id: item.id },
      populate: ["parentItem", "transformedFromItem", "product"],
      ...(trx ? { transacting: trx } : {}),
    });

    if (!fullItem) {
      throw new Error(`Item con id ${item.id} no encontrado`);
    }

    const isCut = !!fullItem.parentItem;

    // Normalizar sourceItemsConsumed — retrocompatibilidad con items antiguos
    // que no tenían el array y solo tenían parentItem/transformedFromItem.
    let sourceItemsMap = fullItem.sourceItemsConsumed || [];

    if (sourceItemsMap.length === 0) {
      const legacySourceId = fullItem.parentItem?.id || fullItem.transformedFromItem?.id;
      if (!legacySourceId) {
        throw new Error("No se encontró el item fuente para revertir la transformación");
      }

      // Calcular cantidad a restaurar considerando factor de transformación si existe
      let quantityToRestore = fullItem.sourceQuantityConsumed || fullItem.currentQuantity || fullItem.originalQuantity;

      if (!fullItem.sourceQuantityConsumed && fullItem.product?.transformationFactor) {
        const factor = parseFloat(fullItem.product.transformationFactor.factor) || 1;
        const multiplySource =
          fullItem.product.transformationFactor.sourceUnit === fullItem.product?.unit;
        quantityToRestore = multiplySource
          ? quantityToRestore * factor
          : quantityToRestore / factor;
      } else if (!fullItem.sourceQuantityConsumed && fullItem.originalQuantity && fullItem.currentQuantity !== fullItem.originalQuantity) {
        const ratio = fullItem.currentQuantity / fullItem.originalQuantity;
        quantityToRestore = quantityToRestore * ratio;
      }

      sourceItemsMap = [{ id: legacySourceId, quantity: quantityToRestore }];
    }

    // 1. Registrar movimiento OUT del item transformado (antes de eliminarlo)
    await strapi.entityService.create(INVENTORY_MOVEMENT_SERVICE, {
      data: {
        item:          fullItem.id,
        quantity:      -fullItem.currentQuantity,
        order:         order?.id,
        orderProduct:  orderProduct?.id,
        type:          TRANSFORM,
        reason:        `Reversión: eliminación de item ${isCut ? "particionado" : "transformado"}`,
        balanceBefore: fullItem.currentQuantity,
        balanceAfter:  0,
      },
    }, { transacting: trx });

    // 2. Restaurar los items fuente
    await _restoreSourceItems(sourceItemsMap, order, orderProduct, isCut, trx);

    // 3. Eliminar el item transformado
    await strapi.db.query(ITEM_SERVICE).delete({
      where: { id: fullItem.id },
      ...(trx ? { transacting: trx } : {}),
    });

    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARTIAL INVOICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para facturación parcial de ventas.
 *
 * NO mueve inventario ni cambia estados de items.
 * Solo asocia items ya despachados (SOLD, sin facturar) a esta orden de factura.
 *
 * CREATE  → asocia items SOLD+uninvoiced a la orden.
 *           Por id: valida que el item exista y sea facturable.
 *           Por quantity+product: búsqueda FIFO por fecha de despacho.
 * UPDATE  → COMPLETED → marca los items asociados como isInvoiced = true.
 * DELETE  → desmarca isInvoiced = false y desasocia el item de la orden.
 */
class PartialInvoiceStrategy extends ItemMovementStrategy {
  async create({ item, order, orderProduct, product, orderType, trx }) {
    // ── Caso 1: item específico por ID ────────────────────────────────────
    if (item.id) {
      const existingItem = await strapi.entityService.findOne(
        ITEM_SERVICE,
        item.id,
        { populate: ["orders", "orderProducts", "product"], transacting: trx },
      );

      if (!existingItem) {
        throw new Error(`Item ${item.id} no encontrado`);
      }
      if (existingItem.isInvoiced) {
        throw new Error(`Item ${item.id} ya está facturado`);
      }
      if (existingItem.state !== ITEM_STATES.SOLD) {
        throw new Error(`Item ${item.id} debe estar en estado 'sold' para ser facturado`);
      }

      const currentOrders        = existingItem.orders?.map((o) => o.id) || [];
      const currentOrderProducts = existingItem.orderProducts?.map((op) => op.id) || [];

      await strapi.entityService.update(ITEM_SERVICE, item.id, {
        data: {
          orders:        currentOrders.includes(order.id)        ? currentOrders        : [...currentOrders, order.id],
          orderProducts: currentOrderProducts.includes(orderProduct.id) ? currentOrderProducts : [...currentOrderProducts, orderProduct.id],
        },
        transacting: trx,
      });

      return existingItem;
    }

    // ── Caso 2: búsqueda FIFO por quantity + product ──────────────────────
    if (item.quantity && product) {
      const customerId = order.customer?.id || order.parentOrder?.customer?.id;

      if (!customerId) {
        throw new Error("Se requiere customer para buscar items por cantidad en facturación parcial");
      }

      const selectedItems = await findInvoiceableItemsByQuantity({
        customerId,
        productId: product.id,
        quantity:  item.quantity,
        options:   { trx },
      });

      for (const { item: selectedItem } of selectedItems) {
        const currentOrders        = selectedItem.orders?.map((o) => o.id) || [];
        const currentOrderProducts = selectedItem.orderProducts?.map((op) => op.id) || [];

        await this.itemService.update({
          id:   selectedItem.id,
          type: ORDER_TYPES.PARTIAL_INVOICE,
          update: {
            orders:        currentOrders.includes(order.id)        ? currentOrders        : [...currentOrders, order.id],
            orderProducts: currentOrderProducts.includes(orderProduct.id) ? currentOrderProducts : [...currentOrderProducts, orderProduct.id],
          },
          trx,
        });
      }

      return {
        itemsSelected:  selectedItems.length,
        totalQuantity:  selectedItems.reduce((sum, si) => sum + si.quantityToInvoice, 0),
        items:          selectedItems.map((si) => ({
          id:          si.item.id,
          quantity:    si.quantityToInvoice,
          sourceOrder: si.sourceOrder,
        })),
      };
    }

    throw new Error("Se requiere id de item o quantity+product para facturación parcial");
  }

  async update({ item, order, orderState, trx }) {
    if (orderState !== ORDER_STATES.COMPLETED) {
      return item; // Sin cambios hasta completar
    }

    // Al completar la orden: marcar todos los items asociados como facturados
    const orderWithItems = await strapi.entityService.findOne(
      "api::order.order",
      order.id,
      { populate: ["items"], transacting: trx },
    );

    const itemIds = orderWithItems.items?.map((i) => i.id) || [];
    if (itemIds.length > 0) {
      await markItemsAsInvoiced(itemIds, { trx });
    }

    return item;
  }

  async delete({ item, order, orderProduct, trx }) {
    const existingItem = await strapi.entityService.findOne(
      ITEM_SERVICE,
      item.id,
      { populate: ["orders", "orderProducts"], transacting: trx },
    );

    if (!existingItem) return item;

    await strapi.entityService.update(ITEM_SERVICE, item.id, {
      data: {
        orders:        (existingItem.orders || []).filter((o) => o.id !== order.id).map((o) => o.id),
        orderProducts: (existingItem.orderProducts || []).filter((op) => op.id !== orderProduct.id).map((op) => op.id),
      },
      transacting: trx,
    });

    await unmarkItemsAsInvoiced([item.id], { trx });

    return existingItem;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NATIONALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estrategia para nacionalización de mercancía (zona franca → bodega stock).
 *
 * Idéntica a TransferStrategy con una diferencia clave:
 * los items NUNCA se reservan — permanecen AVAILABLE en todo momento.
 * Solo cambian de bodega al completar la orden.
 *
 * CREATE  → AVAILABLE (sin cambio de estado) + asocia a orden/orderProduct.
 * UPDATE  → AVAILABLE siempre (independientemente del estado de la orden).
 *           El cambio de bodega lo hace bulkMoveItemsToWarehouse.
 * DELETE  → heredado de TransferStrategy: restaura sourceWarehouse + AVAILABLE.
 */
class NationalizationStrategy extends TransferStrategy {
  async create({ item, order, orderProduct, orderType, trx }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        state:        ITEM_STATES.AVAILABLE,
        order:        order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }

  async update({ item, order, orderProduct, orderType, trx }) {
    return await this.itemService.update({
      id: item.id,
      update: {
        state:        ITEM_STATES.AVAILABLE,
        order:        order.id,
        orderProduct: orderProduct.id,
      },
      type: orderType,
      trx,
    });
  }
  // delete() heredado de TransferStrategy — correcto.
}

// ─────────────────────────────────────────────────────────────────────────────
//  FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna la estrategia correcta para el tipo de orden dado.
 *
 * @throws {Error} Si el tipo de orden no tiene estrategia registrada.
 */
class ItemMovementStrategyFactory {
  static getStrategy(orderType, itemService) {
    const strategies = {
      [ORDER_TYPES.PURCHASE]:        PurchaseInStrategy,
      [ORDER_TYPES.IN]:              PurchaseInStrategy,
      [ORDER_TYPES.SALE]:            SaleStrategy,
      [ORDER_TYPES.RETURN]:          ReturnStrategy,
      [ORDER_TYPES.OUT]:             OutStrategy,
      [ORDER_TYPES.TRANSFER]:        TransferStrategy,
      [ORDER_TYPES.ADJUSTMENT]:      AdjustmentStrategy,
      [ORDER_TYPES.TRANSFORM]:       TransformStrategy,
      [ORDER_TYPES.PARTIAL_INVOICE]: PartialInvoiceStrategy,
      [ORDER_TYPES.NATIONALIZATION]: NationalizationStrategy,
    };

    const StrategyClass = strategies[orderType];

    if (!StrategyClass) {
      throw new Error(`No hay estrategia registrada para el tipo de orden: ${orderType}`);
    }

    return new StrategyClass(itemService);
  }
}

module.exports = { ItemMovementStrategyFactory };
