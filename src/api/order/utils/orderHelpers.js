/**
 * Funciones auxiliares para el servicio de Order
 */

const ORDER_STATES = require("../../../utils/orderStates");
const ORDER_TYPES = require("../../../utils/orderTypes");

// Estados que permiten modificación de órdenes
const EDITABLE_STATES = [ORDER_STATES.DRAFT, ORDER_STATES.CONFIRMED];

/**
 * Valida que la orden pueda ser editada
 */
const validateOrderIsEditable = (order) => {
  if (
    !EDITABLE_STATES.includes(order.state) &&
    !(
      order.state === ORDER_STATES.COMPLETED &&
      (order.type === ORDER_TYPES.SALE || order.type === ORDER_TYPES.OUT)
    )
  ) {
    throw new Error(
      "Sólo las ordenes en borrador o confirmadas pueden ser modificadas",
    );
  }
};

/**
 * Genera el número de orden basado en el tipo
 */
const generateOrderNumber = async (strapi, type, trx) => {
  if (!type) {
    throw new Error("Order type is required to generate order number.");
  }

  const prefixMap = {
    purchase: "PO",
    sale: "SO",
    transfer: "TR",
    return: "RT",
    cutting: "CT",
    disposal: "DS",
    adjustment: "AJ",
    transform: "TF",
    out: "OUT",
    in: "IN",
    "partial-invoice": "PI",
    nationalization: "NA",
  };

  const prefix = prefixMap[type];

  if (!prefix) {
    throw new Error(`Invalid order type: ${type}`);
  }

  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const dateString = `${year}${month}${day}`;

  // Obtener la última orden del tipo específico con código que coincida con el patrón de hoy
  const orders = await strapi.entityService.findMany("api::order.order", {
    filters: {
      type: type,
      code: {
        $startsWith: `${prefix}-${dateString}-`,
      },
    },
    sort: { id: "desc" },
    limit: 1,
    fields: ["code"],
    ...(trx ? { transacting: trx } : {}),
  });

  let sequence = 1;

  if (orders && orders.length > 0) {
    const lastCode = orders[0].code;
    const parts = lastCode.split("-");
    if (parts.length === 3) {
      sequence = parseInt(parts[2], 10) + 1;
    }
  }

  return `${prefix}-${dateString}-${sequence}`;
};

/**
 * Obtiene la clave única de un item (ID o barcode)
 */
const getItemKey = (item) => item?.id ?? item?.barcode;

/**
 * Clasifica items en tres categorías: agregar, mantener, remover
 */
const classifyItems = (currentItems, requestedItems) => {
  const getKey = getItemKey;

  const currentKeys = new Set(currentItems.map(getKey));
  const requestKeys = new Set(requestedItems.map(getKey));

  return {
    itemsToRemove: currentItems.filter((i) => !requestKeys.has(getKey(i))),
    itemsToKeep: currentItems.filter((i) => requestKeys.has(getKey(i))),
    itemsToAdd: requestedItems.filter((i) => !currentKeys.has(getKey(i))),
  };
};

/**
 * Populates estándar para órdenes
 */
const ORDER_POPULATE = [
  "orderProducts",
  "orderProducts.items",
  "orderProducts.items.warehouse",
  "orderProducts.product",
  "orderProducts.product.parentProduct",
  "sourceWarehouse",
  "destinationWarehouse",
  "customer",
  "customer.taxes",
  "customer.prices",
  "customer.prices.product",
  "customerForInvoice",
  "customerForInvoice.taxes",
  "customerForInvoice.prices",
  "customerForInvoice.prices.product",
  "supplier",
  "generatedBy",
  "movements",
];

const ORDER_POPULATE_BASIC = [
  "destinationWarehouse",
  "sourceWarehouse",
  "customer",
  "customerForInvoice",
  "supplier",
  "generatedBy",
  "orderProducts",
];

// Importaciones adicionales para las funciones auxiliares
const runInBatches = require("../../../utils/runInBatches");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");
const INVENTORY_MOVEMENT_TYPES = require("../../../utils/inventoryMovementTypes");
const logger = require("../../../utils/logger");
const {
  ORDER_PRODUCT_SERVICE,
  PRODUCT_SERVICE,
  WAREHOUSE_SERVICE,
  ORDER_SERVICE,
} = require("../../../utils/services");

/**
 * Mueve un conjunto de items a una nueva bodega en bulk.
 *
 * Strapi 5 guarda las relaciones en tablas de enlace (_lnk), no como columnas FK.
 * Por eso no podemos usar un UPDATE simple — necesitamos operar sobre esas tablas
 * directamente con Knex. Esto reemplaza N × (UPDATE item + INSERT movement) con
 * ~10 queries totales sin importar cuántos items haya.
 *
 * @param {object} strapi
 * @param {object[]} items        - Items actuales (con warehouse populado)
 * @param {object}  newWarehouse  - Entidad bodega destino
 * @param {object}  currentOrder  - Orden actual (con orderProducts.items)
 * @param {Map}     itemsCostMap  - Map<itemId, cost> o null
 * @param {object}  trx           - Objeto de transacción de Strapi ({ trx: knexTrx, ... })
 * @param {string}  orderState    - Estado al que transiciona la orden (e.g. "completed")
 */
const bulkMoveItemsToWarehouse = async (
  strapi,
  { items, newWarehouse, currentOrder, itemsCostMap, trx, orderState },
) => {
  if (!items.length || !newWarehouse) return;

  const ITEM_STATES = require("../../../utils/itemStates");

  // Strapi 5: strapi.db.transaction() pasa callbackParams = { trx: knexTrx, commit, rollback, ... }
  // El objeto Knex real (callable como query builder) está en trx.trx
  const knexTrx = trx?.trx ?? trx;
  const now = new Date();
  const newWarehouseId = Number(newWarehouse.id);

  // Nacionalización: items siempre disponibles (no se reservan, solo cambian de bodega).
  // Transferencia: RESERVED mientras está pendiente, AVAILABLE al completar/cancelar.
  // Purchase: los items ya son "available" desde su creación, no necesitan cambio de estado.
  let newItemState = null;
  if (currentOrder.type === ORDER_TYPES.NATIONALIZATION) {
    newItemState = ITEM_STATES.AVAILABLE;
  } else if (currentOrder.type === ORDER_TYPES.TRANSFER) {
    newItemState =
      orderState === ORDER_STATES.COMPLETED || orderState === ORDER_STATES.CANCELLED
        ? ITEM_STATES.AVAILABLE
        : ITEM_STATES.RESERVED;
  }

  const allItemIds = items.map((i) => i.id);
  const changing = items.filter(
    (i) => String(i.warehouse?.id) !== String(newWarehouseId),
  );

  // ── 1. Actualizar estado del item (transfer/nationalización) ──────────────
  // Se actualiza para TODOS los items, no solo los que cambian bodega
  if (newItemState) {
    await knexTrx("items")
      .whereIn("id", allItemIds)
      .update({ state: newItemState, updated_at: now });
  }

  // ── 2. Actualizar bodega via tabla de enlace ──────────────────────────────
  if (changing.length > 0) {
    const changingIds = changing.map((i) => i.id);

    // Eliminar los links actuales de bodega
    await knexTrx("items_warehouse_lnk").whereIn("item_id", changingIds).delete();

    // Insertar los nuevos links (en chunks para evitar límites de SQL)
    const CHUNK = 500;
    for (let i = 0; i < changing.length; i += CHUNK) {
      await knexTrx("items_warehouse_lnk").insert(
        changing.slice(i, i + CHUNK).map((item) => ({
          item_id: item.id,
          warehouse_id: newWarehouseId,
        })),
      );
    }

    // Si no se actualizó updated_at arriba (purchase), actualizarlo aquí solo para los que cambian
    if (!newItemState) {
      await knexTrx("items").whereIn("id", changingIds).update({ updated_at: now });
    }
  }

  // ── 3. Actualizar costo (columna directa en items) ────────────────────────
  if (itemsCostMap && itemsCostMap.size > 0) {
    // Agrupar por valor de costo para minimizar queries
    const byCost = new Map();
    for (const [itemId, cost] of itemsCostMap) {
      if (!byCost.has(cost)) byCost.set(cost, []);
      byCost.get(cost).push(itemId);
    }
    for (const [cost, ids] of byCost) {
      await knexTrx("items").whereIn("id", ids).update({ cost, updated_at: now });
    }
  }

  // ── 3. Crear movimientos TRANSFER via strapi.db.query + tablas de enlace ──
  if (changing.length > 0) {
    const opByItemId = new Map(
      currentOrder.orderProducts.flatMap((op) =>
        (op.items || []).map((item) => [item.id, op.id]),
      ),
    );

    // createMany usa el contexto de transacción automáticamente y devuelve los IDs
    const { ids: movementIds } = await strapi.db
      .query("api::inventory-movement.inventory-movement")
      .createMany({
        data: changing.map(() => ({
          type: INVENTORY_MOVEMENT_TYPES.TRANSFER,
          quantity: 0,
          balanceBefore: 0,
          balanceAfter: 0,
          reason: "Transferencia del item entre bodegas",
        })),
      });

    // Insertar las tablas de enlace de los movimientos (en chunks)
    const CHUNK = 500;
    for (let i = 0; i < movementIds.length; i += CHUNK) {
      const chunkMovIds = movementIds.slice(i, i + CHUNK);
      const chunkItems = changing.slice(i, i + CHUNK);

      // item_lnk
      await knexTrx("inventory_movements_item_lnk").insert(
        chunkMovIds.map((movId, j) => ({
          inventory_movement_id: movId,
          item_id: chunkItems[j].id,
        })),
      );

      // order_lnk
      await knexTrx("inventory_movements_order_lnk").insert(
        chunkMovIds.map((movId) => ({
          inventory_movement_id: movId,
          order_id: currentOrder.id,
        })),
      );

      // order_product_lnk (solo items que tienen orderProduct)
      const opRows = chunkMovIds
        .map((movId, j) => {
          const opId = opByItemId.get(chunkItems[j].id);
          return opId ? { inventory_movement_id: movId, order_product_id: opId } : null;
        })
        .filter(Boolean);
      if (opRows.length > 0) {
        await knexTrx("inventory_movements_order_product_lnk").insert(opRows);
      }

      // source_warehouse_lnk (bodega origen de cada item)
      const srcRows = chunkMovIds
        .map((movId, j) => {
          const srcId = chunkItems[j].warehouse?.id;
          return srcId ? { inventory_movement_id: movId, warehouse_id: srcId } : null;
        })
        .filter(Boolean);
      if (srcRows.length > 0) {
        await knexTrx("inventory_movements_source_warehouse_lnk").insert(srcRows);
      }

      // destination_warehouse_lnk
      await knexTrx("inventory_movements_destination_warehouse_lnk").insert(
        chunkMovIds.map((movId) => ({
          inventory_movement_id: movId,
          warehouse_id: newWarehouseId,
        })),
      );
    }
  }

  logger.debug("bulkMoveItemsToWarehouse completed", {
    orderId: currentOrder.id,
    total: items.length,
    warehouseChanged: changing.length,
    costsUpdated: itemsCostMap?.size ?? 0,
  });
};

/**
 * Actualiza el estado de los items en bulk para órdenes SALE/OUT.
 *
 * Para estas órdenes los items no cambian de bodega — solo cambian de estado
 * (available → reserved → sold). Esto reemplaza N × doItemMovement con ~10
 * queries totales independientemente del número de items.
 *
 * Optimización clave: si los items ya están en el estado correcto (caso más
 * común: orden en draft/confirmed con items RESERVED) la función devuelve
 * inmediatamente sin tocar la base de datos.
 *
 * @param {object} strapi
 * @param {object[]} items       - Items actuales (con state y warehouse populados)
 * @param {object}  currentOrder - Orden con orderProducts.items
 * @param {string}  orderState   - Estado de la orden tras la actualización
 * @param {object}  trx          - Transacción de Strapi ({ trx: knexTrx, ... })
 */
const bulkUpdateSaleItems = async (
  strapi,
  { items, currentOrder, orderState, trx },
) => {
  if (!items.length) return;

  const ITEM_STATES = require("../../../utils/itemStates");
  const knexTrx = trx?.trx ?? trx;
  const now = new Date();

  // Determinar estado destino según el estado de la orden
  let newItemState;
  if (orderState === ORDER_STATES.COMPLETED) {
    newItemState = ITEM_STATES.SOLD;
  } else if (orderState === ORDER_STATES.CANCELLED) {
    newItemState = ITEM_STATES.AVAILABLE;
  } else {
    newItemState = ITEM_STATES.RESERVED;
  }

  // Items que realmente necesitan cambio de estado
  const changing = items.filter((i) => i.state !== newItemState);

  // Caso más común: orden en draft/confirmed, items ya RESERVED → nada que hacer
  if (changing.length === 0) {
    logger.debug("bulkUpdateSaleItems: no state changes needed", {
      orderId: currentOrder.id,
      total: items.length,
    });
    return;
  }

  const changingIds = changing.map((i) => i.id);

  // ── 1. Bulk update de estado ──────────────────────────────────────────────
  await knexTrx("items")
    .whereIn("id", changingIds)
    .update({ state: newItemState, updated_at: now });

  // ── 2. Para SOLD: limpiar bodega (items vendidos no tienen ubicación física) ─
  if (newItemState === ITEM_STATES.SOLD) {
    await knexTrx("items_warehouse_lnk")
      .whereIn("item_id", changingIds)
      .delete();
  }

  // ── 3. Tipo de movimiento de inventario según la transición ───────────────
  let movementType;
  if (newItemState === ITEM_STATES.SOLD) {
    movementType = INVENTORY_MOVEMENT_TYPES.OUT;
  } else if (newItemState === ITEM_STATES.AVAILABLE) {
    movementType = INVENTORY_MOVEMENT_TYPES.UNRESERVE;
  } else {
    movementType = INVENTORY_MOVEMENT_TYPES.RESERVE;
  }

  const opByItemId = new Map(
    currentOrder.orderProducts.flatMap((op) =>
      (op.items || []).map((item) => [item.id, op.id]),
    ),
  );

  // ── 4. Crear movimientos en bulk ─────────────────────────────────────────
  const { ids: movementIds } = await strapi.db
    .query("api::inventory-movement.inventory-movement")
    .createMany({
      data: changing.map((item) => ({
        type: movementType,
        quantity: item.currentQuantity || 0,
        balanceBefore: item.currentQuantity || 0,
        balanceAfter:
          newItemState === ITEM_STATES.SOLD ? 0 : item.currentQuantity || 0,
        reason: `Cambio de estado a ${newItemState} por orden ${currentOrder.type}`,
      })),
    });

  // ── 5. Link tables en chunks ──────────────────────────────────────────────
  const CHUNK = 500;
  for (let i = 0; i < movementIds.length; i += CHUNK) {
    const chunkMovIds = movementIds.slice(i, i + CHUNK);
    const chunkItems = changing.slice(i, i + CHUNK);

    await knexTrx("inventory_movements_item_lnk").insert(
      chunkMovIds.map((movId, j) => ({
        inventory_movement_id: movId,
        item_id: chunkItems[j].id,
      })),
    );

    await knexTrx("inventory_movements_order_lnk").insert(
      chunkMovIds.map((movId) => ({
        inventory_movement_id: movId,
        order_id: currentOrder.id,
      })),
    );

    const opRows = chunkMovIds
      .map((movId, j) => {
        const opId = opByItemId.get(chunkItems[j].id);
        return opId
          ? { inventory_movement_id: movId, order_product_id: opId }
          : null;
      })
      .filter(Boolean);
    if (opRows.length > 0) {
      await knexTrx("inventory_movements_order_product_lnk").insert(opRows);
    }

    // Para OUT (SOLD): registrar bodega origen
    if (movementType === INVENTORY_MOVEMENT_TYPES.OUT) {
      const srcRows = chunkMovIds
        .map((movId, j) => {
          const srcId = chunkItems[j].warehouse?.id;
          return srcId
            ? { inventory_movement_id: movId, warehouse_id: srcId }
            : null;
        })
        .filter(Boolean);
      if (srcRows.length > 0) {
        await knexTrx("inventory_movements_source_warehouse_lnk").insert(
          srcRows,
        );
      }
    }
  }

  logger.debug("bulkUpdateSaleItems completed", {
    orderId: currentOrder.id,
    total: items.length,
    changed: changing.length,
    newState: newItemState,
  });
};

/**
 * Actualiza los productos de una orden
 */
const updateOrderProducts = async (
  strapi,
  currentOrder,
  products,
  orderState,
  orderProductService,
  trx,
  newDestinationWarehouseId = null,
) => {
  // Obtener todos los Items actuales y requeridos
  const currentItems = currentOrder.orderProducts
    .map((orderProduct) => orderProduct.items)
    .flat();

  const { ITEM_SERVICE } = require("../../../utils/services");
  const ITEM_STATES = require("../../../utils/itemStates");

  const itemsFromRequest = [];
  for (const productReq of products) {
    const {
      product: productId,
      items = [],
      count,
      ivaIncluded,
      price,
    } = productReq;

    const fetchedProduct = await strapi.entityService.findOne(
      PRODUCT_SERVICE,
      productId,
      { transacting: trx },
    );
    if (!fetchedProduct)
      throw new Error(`El producto con ID ${productId} no existe`);

    let finalItems = items;

    if (fetchedProduct.type === "service") {
      // Services don't handle physical items
      finalItems = [];
    } else if (
      fetchedProduct.type === "fixedQuantityPerItem" &&
      count !== undefined
    ) {
      const currentItemsForProduct =
        currentOrder.orderProducts.find((op) => op.product.id === productId)
          ?.items || [];
      const currentCount = currentItemsForProduct.length;

      if (count === currentCount) {
        finalItems = currentItemsForProduct;
      } else if (count > currentCount) {
        const diff = count - currentCount;
        const availableItems = await strapi.entityService.findMany(
          ITEM_SERVICE,
          {
            filters: {
              product: productId,
              state: ITEM_STATES.AVAILABLE,
              ...(currentOrder.sourceWarehouse && {
                warehouse: currentOrder.sourceWarehouse.id,
              }),
            },
            limit: diff,
            transacting: trx,
          },
        );

        if (availableItems.length < diff) {
          throw new Error(
            `No hay suficientes items disponibles para ${fetchedProduct.name}. Faltan ${diff}, pero solo hay ${availableItems.length}.`,
          );
        }

        finalItems = [...currentItemsForProduct, ...availableItems];
      } else {
        finalItems = currentItemsForProduct.slice(0, count);
      }
    }

    // Auto-generation is disabled for cutItem/variableQuantityPerItem.
    // The frontend's explicit items array determines the order items.

    for (const item of finalItems) {
      itemsFromRequest.push({
        ...item,
        product: productId,
        ivaIncluded,
        price: parseFloat(price) || 0,
      });
    }
  }

  // Cache de orderProducts por producto para reutilizarlos si se crean en esta ejecución
  const orderProductsByProductId = new Map(
    currentOrder.orderProducts.map((orderProduct) => [
      orderProduct.product.id,
      orderProduct,
    ]),
  );
  const pendingOrderProductCreations = new Map();

  // Asegurar que existan OrderProducts para todos los productos solicitados
  // Esto cubre el caso donde se envía un producto sin items (items: [])
  await runInBatches(products, async (productData) => {
    const productId = productData.product;
    let orderProduct = orderProductsByProductId.get(productId);

    if (!orderProduct) {
      const fetchedProduct = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId,
        { transacting: trx },
      );

      if (!fetchedProduct) {
        throw new Error(`El producto con ID ${productId} no existe`);
      }

      const createdOrderProduct = await orderProductService.create({
        product: fetchedProduct.id,
        order: currentOrder.id,
        requestedQuantity: productData.requestedQuantity || 0,
        requestedPackages:
          productData.requestedPackages ||
          Math.round(
            (productData.requestedQuantity || 0) /
              (fetchedProduct.unitsPerPackage || 1),
          ) ||
          0,
        notes:
          productData.notes || "Producto agregado en actualización de orden",
        price: parseFloat(productData.price) || 0,
        ivaIncluded: productData.ivaIncluded || false,
        invoicePercentage:
          typeof productData.invoicePercentage === "number"
            ? productData.invoicePercentage
            : 100,
        trx,
      });

      const orderProductWithProduct = {
        ...createdOrderProduct,
        product: fetchedProduct,
        items: [], // Inicializar items vacío para evitar errores posteriores
      };

      orderProductsByProductId.set(productId, orderProductWithProduct);
    }
  });

  // Clasificar items
  const { itemsToRemove, itemsToKeep, itemsToAdd } = classifyItems(
    currentItems,
    itemsFromRequest,
  );

  logger.debug("Items classification", {
    toRemove: itemsToRemove.length,
    toKeep: itemsToKeep.length,
    toAdd: itemsToAdd.length,
  });

  // Remover items
  await runInBatches(
    itemsToRemove,
    async (item) => {
      const orderProduct = currentOrder.orderProducts.find(
        (op) => op.product.id == item.product.id,
      );

      await strapi.service(ORDER_SERVICE).doItemMovement({
        movementType: ITEM_MOVEMENT_TYPES.DELETE,
        item,
        order: currentOrder,
        orderProduct,
        product: orderProduct.product,
        orderState,
        trx,
      });
    },
    10,
  );

  // Agregar nuevos items
  await runInBatches(
    itemsToAdd,
    async (itemData) => {
      const {
        product: productId,
        // id, // Removed from destructuring to preserve it in 'item'
        sourceWarehouse,
        parentItem,
        ...item
      } = itemData;

      // Ensure ID is passed if present (for existing items)
      if (itemData.id) {
        item.id = itemData.id;
      }

      let orderProduct = orderProductsByProductId.get(productId);

      if (!orderProduct) {
        // Esto no debería suceder gracias al paso previo de aseguramiento
        throw new Error(
          `OrderProduct no encontrado para el producto ${productId}`,
        );
      }

      // Agregar el item
      // Agregar el item
      // IMPORTANTE: Para productos como cutItem que no tienen un ID asignado todavía y requieren lógica compleja (como TransformationStrategy),
      // debemos usar `addItem` en lugar de llamar a `doItemMovement` directamente, ya que `addItem` contiene la lógica de negocio
      // necesaria para buscar el rollo padre y realizar el corte.
      if (!item.id && orderProduct.product?.type === "cutItem") {
        await strapi.service(ORDER_SERVICE).addItem({
          id: currentOrder.id,
          item: item,
          product: productId,
        });
      } else {
        await strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.CREATE,
          item,
          order: currentOrder,
          orderProduct: orderProduct,
          product: orderProduct.product,
          orderState,
          trx,
        });
      }
    },
    10,
  );

  // ── Fast path SALE/OUT: bulk state update ────────────────────────────────
  // Para órdenes de venta/salida los items no cambian de bodega; solo cambian
  // de estado. Usamos bulkUpdateSaleItems en lugar de N llamadas a doItemMovement.
  if (
    (currentOrder.type === ORDER_TYPES.SALE ||
      currentOrder.type === ORDER_TYPES.OUT) &&
    itemsToKeep.length > 0
  ) {
    await bulkUpdateSaleItems(strapi, {
      items: itemsToKeep,
      currentOrder,
      orderState,
      trx,
    });
    return;
  }

  // Fetch the new destination warehouse entity if an ID was provided
  let newDestinationWarehouseEntity = null;
  if (newDestinationWarehouseId) {
    newDestinationWarehouseEntity = await strapi.entityService.findOne(
      WAREHOUSE_SERVICE,
      newDestinationWarehouseId,
      { transacting: trx },
    );
  }

  // ── Fast path: bulk update cuando todos los items van a la misma bodega ──
  // Condición: existe bodega destino a nivel de orden y ningún item del request
  // tiene override de bodega individual. Cubre el caso más común (purchase/transfer).
  const hasPerItemWarehouseOverride = itemsToKeep.some((item) => {
    const reqItem = itemsFromRequest.find((i) => i?.id == item.id);
    return reqItem?.warehouse != null;
  });

  const bulkWarehouse =
    !hasPerItemWarehouseOverride && newDestinationWarehouseEntity
      ? newDestinationWarehouseEntity
      : !hasPerItemWarehouseOverride && currentOrder.destinationWarehouse
        ? currentOrder.destinationWarehouse
        : null;

  if (bulkWarehouse && itemsToKeep.length > 0) {
    // Construir mapa de costos: itemId → cost
    const itemsCostMap = new Map();
    for (const item of itemsToKeep) {
      const reqItem = itemsFromRequest.find((i) => i?.id == item.id);
      const cost = parseFloat(reqItem?.price ?? item.price ?? item.cost) || 0;
      itemsCostMap.set(item.id, cost);
    }

    await bulkMoveItemsToWarehouse(strapi, {
      items: itemsToKeep,
      newWarehouse: bulkWarehouse,
      currentOrder,
      itemsCostMap,
      trx,
      orderState,
    });
    return;
  }

  // ── Slow path: per-item warehouse override o sin bodega destino ──
  // Cache de warehouses para evitar N+1 queries
  const warehouseCache = new Map();
  const getWarehouseCached = async (id) => {
    const key = String(id);
    if (!warehouseCache.has(key)) {
      const wh = await strapi.entityService.findOne(WAREHOUSE_SERVICE, id, {
        transacting: trx,
      });
      warehouseCache.set(key, wh);
    }
    return warehouseCache.get(key);
  };

  await runInBatches(
    itemsToKeep,
    async (item) => {
      const newItemData = itemsFromRequest.find((i) => i?.id == item.id);

      if (!newItemData) {
        throw new Error("Error al actualizar item existente");
      }

      const orderProduct = currentOrder.orderProducts.find((op) =>
        op.items.find((i) => i.id === item.id),
      );

      if (!orderProduct) {
        throw new Error("El OrderProduct del Item no ha sido encontrado");
      }

      const { product, ...itemData } = item;

      let warehouseToUse = null;

      if (newItemData.warehouse) {
        const destinationWarehouseId =
          newItemData.warehouse?.id || newItemData.warehouse;
        const destinationWarehouse =
          await getWarehouseCached(destinationWarehouseId);

        if (!destinationWarehouse) {
          throw new Error("La bodega de destino no existe");
        }

        warehouseToUse = destinationWarehouse;
      } else if (newDestinationWarehouseEntity) {
        warehouseToUse = newDestinationWarehouseEntity;
      } else if (currentOrder.destinationWarehouse) {
        warehouseToUse = currentOrder.destinationWarehouse;
      } else {
        warehouseToUse = itemData.warehouse;
      }

      await strapi.service(ORDER_SERVICE).doItemMovement({
        movementType: ITEM_MOVEMENT_TYPES.UPDATE,
        item: {
          ...itemData,
          warehouse: warehouseToUse,
          currentQuantity:
            newItemData.quantity ||
            newItemData.currentQuantity ||
            itemData.currentQuantity ||
            itemData.quantity,
          price: parseFloat(newItemData.price || itemData.price) || 0,
          ivaIncluded: newItemData.ivaIncluded || itemData.ivaIncluded || false,
        },
        order: currentOrder,
        orderState,
        product,
        orderProduct,
        trx,
      });
    },
    10,
  );
};

/**
 * Actualiza OrderProducts existentes sin cambios de items.
 * Usa bulk queries para órdenes con muchos items (evita N queries serializadas
 * por la transacción única de Knex).
 */
const updateExistingOrderProducts = async (
  strapi,
  currentOrder,
  orderState,
  trx,
  newDestinationWarehouseId = null,
) => {
  const { orderProducts } = currentOrder;

  let resolvedDestinationWarehouse = currentOrder.destinationWarehouse;
  if (newDestinationWarehouseId) {
    resolvedDestinationWarehouse = await strapi.entityService.findOne(
      WAREHOUSE_SERVICE,
      newDestinationWarehouseId,
      { transacting: trx },
    );
  }

  if (!resolvedDestinationWarehouse) return;

  const allItems = orderProducts.flatMap((op) => op.items);
  if (allItems.length === 0) return;

  await bulkMoveItemsToWarehouse(strapi, {
    items: allItems,
    newWarehouse: resolvedDestinationWarehouse,
    currentOrder,
    itemsCostMap: null,
    trx,
    orderState,
  });
};

/**
 * Sincroniza los OrderProducts: actualiza cantidades y elimina los que no están en la request
 */
const syncOrderProducts = async (
  strapi,
  orderId,
  products,
  orderState,
  orderProductService,
  trx,
) => {
  const orderProducts = await strapi.entityService.findMany(
    ORDER_PRODUCT_SERVICE,
    {
      filters: { order: orderId },
      populate: ["product"],
      transacting: trx,
    },
  );

  if (!orderProducts) return;

  await runInBatches(orderProducts, async (orderProduct) => {
    const { product } = orderProduct;
    const dataFromRequest = products.find((p) => p.product === product.id);

    // Si el producto no está en la request, eliminar el OrderProduct
    if (!dataFromRequest) {
      await orderProductService.delete({
        id: orderProduct.id,
        trx,
      });
      return;
    }

    // Si está, actualizarlo
    const {
      items,
      orderProduct: _,
      product: p,
      ...updateData
    } = dataFromRequest;

    if (updateData.requestedQuantity) {
      updateData.requestedPackages =
        Math.round(
          updateData.requestedQuantity / (product.unitsPerPackage || 1),
        ) || 0;
    }

    if (updateData.price !== undefined) {
      updateData.price = parseFloat(updateData.price) || 0;
    }

    await orderProductService.update({
      id: orderProduct.id,
      update: updateData,
      orderState,
      trx,
    });
  });
};

/**
 * Remueve un item RESERVED de una orden SALE/OUT usando Knex directo.
 *
 * Evita el doble-fetch que ocurre con doItemMovement → itemService.update → _findItem,
 * y esquiva el entityService.update con disconnect (que hace SELECT antes de cada DELETE).
 *
 * Solo aplica cuando item.state === RESERVED. Para items SOLD (orden completada),
 * se sigue usando el flujo normal vía doItemMovement.
 *
 * @param {object} strapi
 * @param {object} item         - Entidad item ya cargada (con currentQuantity)
 * @param {object} currentOrder - Orden actual (con id y type)
 * @param {object} orderProduct - OrderProduct que contiene el item (con id)
 * @param {object} trx          - Transacción de Strapi ({ trx: knexTrx, ... })
 * @returns {{id, state, currentQuantity}} Objeto mínimo del item removido
 */
const fastUnreserveSaleItem = async (
  strapi,
  { item, currentOrder, orderProduct, trx },
) => {
  const ITEM_STATES = require("../../../utils/itemStates");
  const knexTrx = trx?.trx ?? trx;
  const now = new Date();

  // ── 1. Cambiar estado a AVAILABLE ─────────────────────────────────────────
  await knexTrx("items")
    .where("id", item.id)
    .update({ state: ITEM_STATES.AVAILABLE, updated_at: now });

  // ── 2. Desconectar de la orden y del orderProduct ─────────────────────────
  await knexTrx("items_orders_lnk")
    .where({ item_id: item.id, order_id: currentOrder.id })
    .delete();

  await knexTrx("items_order_products_lnk")
    .where({ item_id: item.id, order_product_id: orderProduct.id })
    .delete();

  // ── 3. Crear movimiento UNRESERVE ─────────────────────────────────────────
  const qty = item.currentQuantity || 0;

  const { ids: movementIds } = await strapi.db
    .query("api::inventory-movement.inventory-movement")
    .createMany({
      data: [
        {
          type: INVENTORY_MOVEMENT_TYPES.UNRESERVE,
          quantity: qty,
          balanceBefore: qty,
          balanceAfter: qty,
          reason: `Ítem removido de orden de ${currentOrder.type}`,
        },
      ],
    });

  const movId = movementIds[0];
  await knexTrx("inventory_movements_item_lnk").insert({
    inventory_movement_id: movId,
    item_id: item.id,
  });
  await knexTrx("inventory_movements_order_lnk").insert({
    inventory_movement_id: movId,
    order_id: currentOrder.id,
  });
  if (orderProduct?.id) {
    await knexTrx("inventory_movements_order_product_lnk").insert({
      inventory_movement_id: movId,
      order_product_id: orderProduct.id,
    });
  }

  logger.debug("fastUnreserveSaleItem completed", {
    orderId: currentOrder.id,
    itemId: item.id,
    qty,
  });

  return { id: item.id, state: ITEM_STATES.AVAILABLE, currentQuantity: qty };
};

module.exports = {
  validateOrderIsEditable,
  generateOrderNumber,
  getItemKey,
  classifyItems,
  updateOrderProducts,
  updateExistingOrderProducts,
  syncOrderProducts,
  bulkUpdateSaleItems,
  fastUnreserveSaleItem,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
  EDITABLE_STATES,
};
