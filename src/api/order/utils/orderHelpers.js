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
 * Populates estándar para órdenes.
 *
 * IMPORTANT: Uses object format (not array) so that `items` is loaded with
 * scalar `fields` only and NO `populate` sub-key. This prevents Strapi from
 * running `WHERE item_id IN (all IDs)` for warehouse/product sub-relations,
 * which crashes SQLite when an order has >999 items.
 *
 * Array format like `["orderProducts.items"]` silently sets `items: true`
 * which auto-loads ALL direct sub-relations of Item — that is the root cause
 * of the "too many SQL variables" error with 50k+ items.
 */
const ORDER_POPULATE = {
  orderProducts: {
    populate: {
      items: {
        fields: [
          "id",
          "state",
          "currentQuantity",
          "unit",
          "lotNumber",
          "itemNumber",
          "barcode",
          "alternativeBarcode",
          "cost",
          "isInvoiced",
          "cbm",
          "weight",
          "isPartition",
          "partitionNumber",
          "qualityStatus",
          "qualityNotes",
          "receiptDate",
        ],
      },
      product: {
        populate: { parentProduct: true },
      },
    },
  },
  sourceWarehouse: true,
  destinationWarehouse: true,
  customer: {
    populate: {
      taxes: true,
      prices: { populate: { product: true } },
    },
  },
  customerForInvoice: {
    populate: {
      taxes: true,
      prices: { populate: { product: true } },
    },
  },
  supplier: true,
  generatedBy: true,
  // movements: SE OMITE INTENCIONALMENTE
  //
  // order.movements es una relación oneToMany hacia inventory_movements (todas las
  // entradas del log de inventario vinculadas a esta orden). Con órdenes grandes
  // (p. ej. 50k items fixedQuantityPerItem) cada item genera 1 movimiento → la
  // orden acumula 50k+ movimientos en inventory_movements_order_lnk.
  //
  // Incluirlos en ORDER_POPULATE significaría cargar y serializar 50k filas en
  // CADA respuesta de API (create, update, findOne, WebSocket emit). Eso:
  //   1. Añade segundos de latencia por serialización
  //   2. Aumenta el payload de red en megabytes innecesarios
  //   3. No rompe nada: ningún consumer del resultado (frontend, estrategias,
  //      facturas Siigo) lee order.movements de la respuesta de API.
  //
  // Si en el futuro se necesita el historial de movimientos de una orden, se debe
  // cargar bajo demanda en un endpoint propio (GET /orders/:id/movements) con
  // paginación, no en el populate estándar.
};

const ORDER_POPULATE_BASIC = {
  destinationWarehouse: true,
  sourceWarehouse: true,
  customer: true,
  customerForInvoice: true,
  supplier: true,
  generatedBy: true,
  orderProducts: true,
};

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

  // If items were not populated with their current warehouse (e.g. because the ORM
  // would have generated WHERE item_id IN (50k IDs) crashing SQLite), load the
  // warehouse ids via chunked knex queries (max 500 per query).
  const itemsWithoutWarehouse = items.filter((i) => i.warehouse == null);
  if (itemsWithoutWarehouse.length > 0) {
    const WCHUNK = 500;
    const warehouseMap = new Map();
    for (let c = 0; c < itemsWithoutWarehouse.length; c += WCHUNK) {
      const chunk = itemsWithoutWarehouse.slice(c, c + WCHUNK).map((i) => i.id);
      const rows = await knexTrx("items_warehouse_lnk")
        .whereIn("item_id", chunk)
        .select("item_id", "warehouse_id");
      rows.forEach((r) => warehouseMap.set(r.item_id, r.warehouse_id));
    }
    itemsWithoutWarehouse.forEach((item) => {
      const wId = warehouseMap.get(item.id);
      if (wId) item.warehouse = { id: wId };
    });
  }

  const changing = items.filter(
    (i) => String(i.warehouse?.id) !== String(newWarehouseId),
  );

  const CHUNK = 500;

  // ── 1. Actualizar estado del item (transfer/nationalización) ──────────────
  // Se actualiza para TODOS los items, no solo los que cambian bodega.
  // En chunks para no exceder el límite de variables de SQLite (32.766).
  if (newItemState) {
    for (let c = 0; c < allItemIds.length; c += CHUNK) {
      await knexTrx("items")
        .whereIn("id", allItemIds.slice(c, c + CHUNK))
        .update({ state: newItemState, updated_at: now });
    }
  }

  // ── 2. Actualizar bodega via tabla de enlace ──────────────────────────────
  if (changing.length > 0) {
    const changingIds = changing.map((i) => i.id);

    // Eliminar los links actuales de bodega — en chunks para no exceder el límite
    for (let c = 0; c < changingIds.length; c += CHUNK) {
      await knexTrx("items_warehouse_lnk")
        .whereIn("item_id", changingIds.slice(c, c + CHUNK))
        .delete();
    }

    // Insertar los nuevos links (en chunks)
    for (let i = 0; i < changing.length; i += CHUNK) {
      await knexTrx("items_warehouse_lnk").insert(
        changing.slice(i, i + CHUNK).map((item) => ({
          item_id: item.id,
          warehouse_id: newWarehouseId,
        })),
      );
    }

    // Si no se actualizó updated_at arriba (purchase), actualizarlo solo para los que cambian
    if (!newItemState) {
      for (let c = 0; c < changingIds.length; c += CHUNK) {
        await knexTrx("items")
          .whereIn("id", changingIds.slice(c, c + CHUNK))
          .update({ updated_at: now });
      }
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
      for (let c = 0; c < ids.length; c += CHUNK) {
        await knexTrx("items")
          .whereIn("id", ids.slice(c, c + CHUNK))
          .update({ cost, updated_at: now });
      }
    }
  }

  // ── 3. Crear movimientos TRANSFER via strapi.db.query + tablas de enlace ──
  if (changing.length > 0) {
    // Build itemId → orderProductId map via Knex (op.items is no longer ORM-populated).
    const opByItemId = new Map();
    const OPCHUNK = 500;
    for (let c = 0; c < changing.length; c += OPCHUNK) {
      const chunkIds = changing.slice(c, c + OPCHUNK).map((i) => i.id);
      // @ts-ignore
      const opRows = await knexTrx("items_order_products_lnk")
        .whereIn("item_id", chunkIds)
        .select("item_id", "order_product_id");
      // @ts-ignore
      opRows.forEach((r) => opByItemId.set(r.item_id, r.order_product_id));
    }

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
  const CHUNK = 500;

  // ── 1. Bulk update de estado — en chunks para no exceder el límite de variables
  // de SQLite (32.766 por query; 1 columna × CHUNK filas = CHUNK vars).
  for (let c = 0; c < changingIds.length; c += CHUNK) {
    await knexTrx("items")
      .whereIn("id", changingIds.slice(c, c + CHUNK))
      .update({ state: newItemState, updated_at: now });
  }

  // ── 2. Para SOLD: limpiar bodega (items vendidos no tienen ubicación física) ─
  if (newItemState === ITEM_STATES.SOLD) {
    for (let c = 0; c < changingIds.length; c += CHUNK) {
      await knexTrx("items_warehouse_lnk")
        .whereIn("item_id", changingIds.slice(c, c + CHUNK))
        .delete();
    }
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

  // Build itemId → orderProductId via Knex (op.items no longer ORM-populated).
  const opByItemId = new Map();
  {
    const OPCHUNK = 500;
    // @ts-ignore
    const knexOpTrx = trx?.trx ?? trx ?? strapi.db.connection;
    for (let c = 0; c < items.length; c += OPCHUNK) {
      // @ts-ignore
      const chunkIds = items.slice(c, c + OPCHUNK).map((i) => i.id);
      // @ts-ignore
      const opRows = await knexOpTrx("items_order_products_lnk")
        .whereIn("item_id", chunkIds)
        .select("item_id", "order_product_id");
      // @ts-ignore
      opRows.forEach((r) => opByItemId.set(r.item_id, r.order_product_id));
    }
  }

  // ── 4. Crear movimientos en bulk ─────────────────────────────────────────
  //
  // POR QUÉ usamos Knex puro en lugar de strapi.db.query().createMany():
  //
  // strapi.db.query(uid).createMany() llama internamente a
  //   entityManager.getRepository(uid).createMany()
  // que usa `this.createQueryBuilder(uid).insert(data).execute()`.
  // Este query builder NO acepta la opción `transacting` y obtiene una conexión
  // distinta del pool de conexiones de Knex (fuera de la transacción activa).
  //
  // SQLite solo permite un escritor a la vez. Si la transacción ya tiene el write
  // lock, una segunda conexión intentando escribir falla con:
  //   SQLITE_BUSY: database is locked
  //
  // La solución es hacer los inserts directamente sobre knexTrx (la misma conexión
  // de la transacción activa) usando snake_case para los nombres de columna.
  //
  // Columnas requeridas para inventory_movements (además de las escalares):
  //   - document_id : ID único de "documento" en Strapi 5 (cuid2 de 24 chars)
  //   - created_at / updated_at : timestamps que el ORM añadiría automáticamente
  //
  // balance_before / balance_after son los nombres de columna en la BD (snake_case)
  // aunque en el ORM se llaman balanceBefore / balanceAfter (camelCase).
  //
  // INSERT ... RETURNING "id" funciona en:
  //   - PostgreSQL (siempre)
  //   - SQLite ≥ 3.35 con Knex 3.x y better-sqlite3 (confirmado: 3.46.1 / 11.3.0)
  // Devuelve [{ id: 1 }, { id: 2 }, ...] en ambos motores.
  // ── 4. Crear movimientos en bulk — en chunks para no exceder el límite
  // de variables de SQLite (32.766 por query; 8 columnas × CHUNK filas = 4.000 vars).
  const { createId } = require("@paralleldrive/cuid2");
  const movNow = new Date();
  const movementIds = [];
  for (let c = 0; c < changing.length; c += CHUNK) {
    const chunkChanging = changing.slice(c, c + CHUNK);
    const movRows = await knexTrx("inventory_movements")
      .insert(
        chunkChanging.map((item) => ({
          document_id: createId(),
          type: movementType,
          quantity: item.currentQuantity || 0,
          balance_before: item.currentQuantity || 0,
          balance_after:
            newItemState === ITEM_STATES.SOLD ? 0 : item.currentQuantity || 0,
          reason: `Cambio de estado a ${newItemState} por orden ${currentOrder.type}`,
          created_at: movNow,
          updated_at: movNow,
        })),
      )
      .returning("id");
    movRows.forEach((r) => movementIds.push(r.id));
  }

  // ── 5. Link tables en chunks ──────────────────────────────────────────────
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
 * Reserva N items en masa para una orden de venta/salida.
 * Reemplaza N llamadas individuales a SaleStrategy.create (doItemMovement RESERVE).
 * Solo aplica cuando los items ya existen en BD y están en estado AVAILABLE.
 */
const bulkReserveSaleItems = async (
  strapi,
  { items, currentOrder, orderProduct, trx },
) => {
  if (!items.length) return;

  const ITEM_STATES = require("../../../utils/itemStates");
  const itemIds = items.map((i) => i.id);
  const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;
  const now = new Date();
  const CHUNK = 500;

  // 1. Cambiar estado de items a RESERVED — en chunks para no exceder el límite
  // de variables de SQLite (32.766 por query; 1 columna × CHUNK filas = CHUNK vars).
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    await knexTrx("items")
      .whereIn("id", itemIds.slice(c, c + CHUNK))
      .update({ state: ITEM_STATES.RESERVED, updated_at: now });
  }

  // 2. Vincular items a la orden (items_orders_lnk)
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    await knexTrx("items_orders_lnk").insert(
      itemIds.slice(c, c + CHUNK).map((id) => ({
        item_id: id,
        order_id: currentOrder.id,
      })),
    );
  }

  // 3. Vincular items al orderProduct (items_order_products_lnk)
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    await knexTrx("items_order_products_lnk").insert(
      itemIds.slice(c, c + CHUNK).map((id) => ({
        item_id: id,
        order_product_id: orderProduct.id,
      })),
    );
  }

  // 4. Crear movimientos RESERVE en bulk — en chunks para no exceder el límite
  // de variables de SQLite (32.766 por query; 8 columnas × CHUNK filas = 4.000 vars).
  // El INSERT original sin chunks fallaba con "too many SQL variables" para órdenes
  // con miles de items fixedQuantityPerItem.
  const { createId } = require("@paralleldrive/cuid2");
  const movNow = new Date();
  const movementIds = [];
  for (let c = 0; c < items.length; c += CHUNK) {
    const chunkItems = items.slice(c, c + CHUNK);
    const movRows = await knexTrx("inventory_movements")
      .insert(
        chunkItems.map((item) => ({
          document_id: createId(),
          type: INVENTORY_MOVEMENT_TYPES.RESERVE,
          quantity: item.currentQuantity || 1,
          balance_before: item.currentQuantity || 1,
          balance_after: item.currentQuantity || 1,
          reason: `Reserva masiva para orden ${currentOrder.id}`,
          created_at: movNow,
          updated_at: movNow,
        })),
      )
      .returning("id");
    movRows.forEach((r) => movementIds.push(r.id));
  }

  // 5. Vincular movimientos a items, orden y orderProduct
  for (let c = 0; c < movementIds.length; c += CHUNK) {
    const slice = movementIds.slice(c, c + CHUNK);
    const itemSlice = itemIds.slice(c, c + CHUNK);

    await knexTrx("inventory_movements_item_lnk").insert(
      slice.map((movId, j) => ({
        inventory_movement_id: movId,
        item_id: itemSlice[j],
      })),
    );
    await knexTrx("inventory_movements_order_lnk").insert(
      slice.map((movId) => ({
        inventory_movement_id: movId,
        order_id: currentOrder.id,
      })),
    );
    await knexTrx("inventory_movements_order_product_lnk").insert(
      slice.map((movId) => ({
        inventory_movement_id: movId,
        order_product_id: orderProduct.id,
      })),
    );
  }

  logger.debug("bulkReserveSaleItems completed", {
    orderId: currentOrder.id,
    reserved: itemIds.length,
  });
};

/**
 * Revierte en masa la reserva de todos los items de un orderProduct (RESERVED → AVAILABLE).
 * Operación inversa a bulkReserveSaleItems, usada para el flujo "reemplazar reserva" en
 * productos fixedQuantityPerItem de ventas/salidas.
 *
 * Usa SQL puro con subqueries para soportar 100k+ items sin cargar IDs en memoria JS.
 * No crea movimientos de inventario: la operación es parte de un reemplazo atómico;
 * el bulkReserveSaleItems posterior creará los movimientos de la nueva reserva.
 */
const bulkUnreserveFixedQtyItems = async (
  strapi,
  { orderProduct, currentOrder, trx },
) => {
  const ITEM_STATES = require("../../../utils/itemStates");
  const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;
  const now = new Date();
  const opId = orderProduct.id;
  const orderId = currentOrder.id;

  // 1. Revertir estado RESERVED → AVAILABLE (subquery — sin cargar IDs en JS)
  // @ts-ignore
  await knexTrx("items")
    .whereIn(
      "id",
      knexTrx("items_order_products_lnk").where("order_product_id", opId).select("item_id"),
    )
    .update({ state: ITEM_STATES.AVAILABLE, updated_at: now });

  // 2. Desvincular items de la orden (items_orders_lnk)
  // @ts-ignore
  await knexTrx("items_orders_lnk")
    .whereIn(
      "item_id",
      knexTrx("items_order_products_lnk").where("order_product_id", opId).select("item_id"),
    )
    .where("order_id", orderId)
    .delete();

  // 3. Desvincular items del orderProduct (items_order_products_lnk)
  // @ts-ignore
  await knexTrx("items_order_products_lnk")
    .where("order_product_id", opId)
    .delete();
};

/**
 * Revierte en masa la reserva de un subconjunto específico de items (RESERVED → AVAILABLE).
 * A diferencia de bulkUnreserveFixedQtyItems (que revierte TODO el orderProduct via subquery),
 * esta función acepta una lista de items concretos — útil para reducciones parciales de
 * cantidad en órdenes fixedQuantityPerItem de venta/salida.
 *
 * Operaciones:
 *   1. RESERVED → AVAILABLE en los items indicados
 *   2. Desvincula items de la orden (items_orders_lnk)
 *   3. Desvincula items del orderProduct (items_order_products_lnk)
 *   4. Crea movimientos UNRESERVE para trazabilidad
 *
 * @param {object}   strapi
 * @param {object[]} items        - Items a liberar (deben tener { id })
 * @param {object}   currentOrder - Orden actual
 * @param {object}   orderProduct - OrderProduct al que pertenecen los items
 * @param {object}   trx          - Transacción Knex
 */
const bulkUnreserveSpecificSaleItems = async (
  strapi,
  { items, currentOrder, orderProduct, trx },
) => {
  if (!items.length) return;

  const ITEM_STATES = require("../../../utils/itemStates");
  const { createId } = require("@paralleldrive/cuid2");
  const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;
  const now = new Date();
  const itemIds = items.map((i) => i.id);
  const CHUNK = 500;

  // 1. RESERVED → AVAILABLE
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    // @ts-ignore
    await knexTrx("items")
      .whereIn("id", itemIds.slice(c, c + CHUNK))
      .update({ state: ITEM_STATES.AVAILABLE, updated_at: now });
  }

  // 2. Desvincular de la orden
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    // @ts-ignore
    await knexTrx("items_orders_lnk")
      .whereIn("item_id", itemIds.slice(c, c + CHUNK))
      .where("order_id", currentOrder.id)
      .delete();
  }

  // 3. Desvincular del orderProduct
  for (let c = 0; c < itemIds.length; c += CHUNK) {
    // @ts-ignore
    await knexTrx("items_order_products_lnk")
      .whereIn("item_id", itemIds.slice(c, c + CHUNK))
      .where("order_product_id", orderProduct.id)
      .delete();
  }

  // 4. Crear movimientos UNRESERVE en bulk
  const movNow = new Date();
  const movementIds = [];
  for (let c = 0; c < items.length; c += CHUNK) {
    const chunkItems = items.slice(c, c + CHUNK);
    // @ts-ignore
    const movRows = await knexTrx("inventory_movements")
      .insert(
        chunkItems.map((item) => ({
          document_id: createId(),
          type: INVENTORY_MOVEMENT_TYPES.UNRESERVE,
          quantity: item.currentQuantity || 1,
          balance_before: item.currentQuantity || 1,
          balance_after: item.currentQuantity || 1,
          reason: `Devolución de reserva por reducción de cantidad en orden ${currentOrder.id}`,
          created_at: movNow,
          updated_at: movNow,
        })),
      )
      .returning("id");
    movRows.forEach((r) => movementIds.push(r.id));
  }

  // 5. Link tables de movimientos
  for (let c = 0; c < movementIds.length; c += CHUNK) {
    const slice = movementIds.slice(c, c + CHUNK);
    const itemSlice = itemIds.slice(c, c + CHUNK);

    // @ts-ignore
    await knexTrx("inventory_movements_item_lnk").insert(
      slice.map((movId, j) => ({
        inventory_movement_id: movId,
        item_id: itemSlice[j],
      })),
    );
    // @ts-ignore
    await knexTrx("inventory_movements_order_lnk").insert(
      slice.map((movId) => ({
        inventory_movement_id: movId,
        order_id: currentOrder.id,
      })),
    );
    // @ts-ignore
    await knexTrx("inventory_movements_order_product_lnk").insert(
      slice.map((movId) => ({
        inventory_movement_id: movId,
        order_product_id: orderProduct.id,
      })),
    );
  }

  logger.debug("bulkUnreserveSpecificSaleItems completed", {
    orderId: currentOrder.id,
    unreserved: itemIds.length,
  });
};

/**
 * Elimina los items excedentes de un producto fixedQuantityPerItem en una orden de compra/ingreso.
 * Usa DELETE directos en SQL para evitar N llamadas a doItemMovement(DELETE).
 *
 * No carga los items en memoria — usa Knex para obtener los IDs excedentes directamente.
 * Esto es esencial para órdenes con 100k+ items donde WHERE id IN (...) crashearía SQLite.
 */
const bulkDeletePurchaseItems = async (
  strapi,
  { orderProductId, targetCount, trx },
) => {
  const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;

  // Count current items for this orderProduct without loading them
  const countRow = await knexTrx("items_order_products_lnk")
    .where("order_product_id", orderProductId)
    .count("item_id as cnt")
    .first();
  const total = parseInt(countRow?.cnt || 0, 10);
  const excess = total - targetCount;
  if (excess <= 0) return;

  // Get IDs of the excess items (last `excess` by item_id descending)
  const rows = await knexTrx("items_order_products_lnk")
    .where("order_product_id", orderProductId)
    .orderBy("item_id", "desc")
    .limit(excess)
    .select("item_id");
  const deleteIds = rows.map((r) => r.item_id);

  const CHUNK = 500;
  for (let c = 0; c < deleteIds.length; c += CHUNK) {
    const chunk = deleteIds.slice(c, c + CHUNK);
    await knexTrx("items_orders_lnk").whereIn("item_id", chunk).delete();
    await knexTrx("items_order_products_lnk").whereIn("item_id", chunk).delete();
    await knexTrx("items_warehouse_lnk").whereIn("item_id", chunk).delete();
    await knexTrx("items_product_lnk").whereIn("item_id", chunk).delete();
    await knexTrx("items_source_order_lnk").whereIn("item_id", chunk).delete();
    await knexTrx("items").whereIn("id", chunk).delete();
  }

  logger.debug("bulkDeletePurchaseItems completed", {
    deleted: deleteIds.length,
  });
};

/**
 * Crea N items en masa para un producto fixedQuantityPerItem en una orden de compra/ingreso.
 * Usa inserciones SQL directas para máximo rendimiento con grandes volúmenes (p.ej. 50k items).
 */
// @ts-ignore — plain JS file; TS strict mode flags untyped destructuring params
const bulkCreatePurchaseItems = async (
  strapi,
  { fetchedProduct, existingCount, maxItemNumber, targetCount, currentOrder, orderProductId, trx },
) => {
  const countToAdd = targetCount - existingCount;
  if (countToAdd <= 0) return;

  const {
    generateItemBarcode,
    generateAlternativeItemBarcode,
  } = require("../../../utils/generateCodes");
  const ITEM_STATES = require("../../../utils/itemStates");

  const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;
  const CHUNK = 500;

  for (let offset = 0; offset < countToAdd; offset += CHUNK) {
    const size = Math.min(CHUNK, countToAdd - offset);

    // ── Construir datos de items en snake_case ───────────────────────────────
    //
    // Los nombres de columna en la BD son snake_case aunque el ORM los expone
    // en camelCase. Al insertar con Knex directo debemos usar snake_case.
    //
    // Campos obligatorios adicionales al bypasear el ORM:
    //   - document_id : identificador único de "documento" en Strapi 5 (cuid2).
    //     Strapi lo genera automáticamente en el ORM; aquí lo generamos con
    //     @paralleldrive/cuid2, que es la misma librería que usa internamente.
    //   - created_at / updated_at : timestamps que el ORM añade automáticamente.
    const { createId } = require("@paralleldrive/cuid2");
    const now = new Date();

    const itemRows = Array.from({ length: size }, (_, i) => {
      const itemNum = maxItemNumber + offset + i + 1;
      return {
        // ── Columnas de "documento" Strapi 5 ──────────────────────────────
        document_id: createId(),          // cuid2 único (24 chars)
        created_at: now,
        updated_at: now,
        // ── Escalares del contenido (ORM camelCase → BD snake_case) ───────
        name: fetchedProduct.name,
        barcode: generateItemBarcode(
          fetchedProduct,
          1,
          "1",
          itemNum,
          currentOrder.containerCode,
        ),
        alternative_barcode: generateAlternativeItemBarcode(
          fetchedProduct.code,
          1,
          currentOrder.containerCode,
        ),
        original_quantity: 1,
        current_quantity: 1,
        unit: fetchedProduct.unit,
        state: ITEM_STATES.AVAILABLE,
        lot_number: "1",
        item_number: String(itemNum),
        cost: 0,
        is_partition: false,
        quality_status: "approved",
        cbm: 0,
        weight: 1,
        is_invoiced: false,
        source_quantity_consumed: 0,
      };
    });

    // ── Insertar items con INSERT ... RETURNING id ───────────────────────────
    //
    // POR QUÉ Knex puro en lugar de strapi.db.query("api::item.item").createMany():
    //
    //   strapi.db.query(uid) devuelve entityManager.getRepository(uid).
    //   Su método createMany() usa internamente `this.createQueryBuilder(uid)`
    //   que abre una conexión NUEVA desde el pool de Knex — fuera de la transacción
    //   activa. En SQLite (single-writer), eso causa:
    //     SQLITE_BUSY: database is locked
    //   porque la transacción principal ya tiene el write lock.
    //
    //   La solución es usar knexTrx directamente: todas las escrituras van por la
    //   misma conexión de la transacción → un solo escritor, sin conflicto.
    //
    // INSERT ... RETURNING "id":
    //   - PostgreSQL: soportado nativamente siempre.
    //   - SQLite: soportado desde SQLite 3.35 (este proyecto usa 3.46.1).
    //     Knex 3.x + better-sqlite3 retorna [{ id: 1 }, { id: 2 }, ...].
    const itemDbRows = await knexTrx("items").insert(itemRows).returning("id");
    const itemIds = itemDbRows.map((r) => r.id);

    // ── Tablas de enlace: item → order, orderProduct, warehouse, product, sourceOrder
    //
    // En Strapi 5 TODAS las relaciones (incluso manyToOne) se almacenan en tablas
    // de enlace separadas (_lnk). No hay columnas FK directas en la tabla principal.
    // Insertamos en chunks de CHUNK filas para mantenernos bajo el límite de
    // variables de SQLite (999) cuando hay muchos items.

    // Link items to order (many-to-many: items ↔ orders)
    for (let c = 0; c < itemIds.length; c += CHUNK) {
      await knexTrx("items_orders_lnk").insert(
        itemIds.slice(c, c + CHUNK).map((id) => ({
          item_id: id,
          order_id: currentOrder.id,
        })),
      );
    }
    // Link items to orderProduct (many-to-many: items ↔ order_products)
    for (let c = 0; c < itemIds.length; c += CHUNK) {
      await knexTrx("items_order_products_lnk").insert(
        itemIds.slice(c, c + CHUNK).map((id) => ({
          item_id: id,
          order_product_id: orderProductId,
        })),
      );
    }
    // Link items to warehouse (manyToOne via link table)
    for (let c = 0; c < itemIds.length; c += CHUNK) {
      await knexTrx("items_warehouse_lnk").insert(
        itemIds.slice(c, c + CHUNK).map((id) => ({
          item_id: id,
          warehouse_id: currentOrder.destinationWarehouse.id,
        })),
      );
    }
    // Link items to product (manyToOne via link table)
    for (let c = 0; c < itemIds.length; c += CHUNK) {
      await knexTrx("items_product_lnk").insert(
        itemIds.slice(c, c + CHUNK).map((id) => ({
          item_id: id,
          product_id: fetchedProduct.id,
        })),
      );
    }
    // Link items to sourceOrder (manyToOne via link table — "de qué orden proviene el item")
    for (let c = 0; c < itemIds.length; c += CHUNK) {
      await knexTrx("items_source_order_lnk").insert(
        itemIds.slice(c, c + CHUNK).map((id) => ({
          item_id: id,
          order_id: currentOrder.id,
        })),
      );
    }

    // ── Crear movimientos de inventario IN para los nuevos items ────────────
    //
    // Cada item creado genera un movimiento de tipo IN (ingreso) que queda
    // registrado en inventory_movements. Nuevamente usamos Knex puro por la
    // misma razón: evitar la segunda conexión que causaría SQLITE_BUSY.
    //
    // Reuse `now` del bloque de items para que created_at sea consistente.
    const movRows = await knexTrx("inventory_movements")
      .insert(
        itemIds.map(() => ({
          document_id: createId(),
          type: INVENTORY_MOVEMENT_TYPES.IN,
          quantity: 1,
          balance_before: 0,   // antes del ingreso: 0 unidades
          balance_after: 1,    // después: 1 unidad disponible
          reason: `Creación masiva: ${fetchedProduct.name}`,
          created_at: now,
          updated_at: now,
        })),
      )
      .returning("id");
    const movementIds = movRows.map((r) => r.id);

    for (let c = 0; c < movementIds.length; c += CHUNK) {
      const slice = movementIds.slice(c, c + CHUNK);
      const itemSlice = itemIds.slice(c, c + CHUNK);
      await knexTrx("inventory_movements_item_lnk").insert(
        slice.map((movId, j) => ({
          inventory_movement_id: movId,
          item_id: itemSlice[j],
        })),
      );
      await knexTrx("inventory_movements_order_lnk").insert(
        slice.map((movId) => ({
          inventory_movement_id: movId,
          order_id: currentOrder.id,
        })),
      );
      await knexTrx("inventory_movements_order_product_lnk").insert(
        slice.map((movId) => ({
          inventory_movement_id: movId,
          order_product_id: orderProductId,
        })),
      );
      await knexTrx("inventory_movements_destination_warehouse_lnk").insert(
        slice.map((movId) => ({
          inventory_movement_id: movId,
          warehouse_id: currentOrder.destinationWarehouse.id,
        })),
      );
    }
  }

  logger.debug("bulkCreatePurchaseItems completed", {
    orderId: currentOrder.id,
    product: fetchedProduct.name,
    created: countToAdd,
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
  // currentItems and itemIdToOrderProduct are built incrementally per-product
  // using Knex queries. This avoids the ORM populate that generates
  // WHERE id IN (100k IDs) — which crashes SQLite for large fixedQty orders.
  const currentItems = [];
  // @ts-ignore
  const itemIdToOrderProduct = new Map();

  const { ITEM_SERVICE } = require("../../../utils/services");
  const ITEM_STATES = require("../../../utils/itemStates");

  // Knex connection for direct SQL without ORM overhead
  // @ts-ignore
  const knexMain = trx?.trx ?? trx ?? strapi.db.connection;

  const itemsFromRequest = [];
  const pendingBulkCreations = [];
  // fixedQty SALE/OUT: collected here, processed in bulk after orderProducts are created
  const pendingFixedQtySaleOps = [];

  for (const productReq of products) {
    // Distinguish between:
    //   items: []        → frontend explicitly wants zero items (delete all)
    //   items: null      → frontend didn't load items yet; preserve existing DB items
    //   items: undefined → same as null (key absent) — also preserve
    // The default `= []` in destructuring would silently treat null as [] (data loss).
    const {
      product: productId,
      items: rawItems,
      count,
      ivaIncluded,
      price,
    } = productReq;

    const itemsNotLoaded = rawItems == null;

    const fetchedProduct = await strapi.entityService.findOne(
      PRODUCT_SERVICE,
      productId,
      { transacting: trx },
    );
    if (!fetchedProduct)
      throw new Error(`El producto con ID ${productId} no existe`);

    // @ts-ignore — plain JS file; TS strict mode flags untyped arrow params here
    const currentOrderProductForProduct = currentOrder.orderProducts.find(
      (op) => op.product.id === productId,
    );
    const opId = currentOrderProductForProduct?.id;

    // ── Service products: no physical items ──────────────────────────────────
    if (fetchedProduct.type === "service") {
      // Services don't have items — still push empty so syncOrderProducts can
      // update metadata (price, confirmedQuantity) for this product.
      continue;
    }

    // ── fixedQuantityPerItem purchase/in with count ───────────────────────────
    // These orders can have 100k+ items. Never load them into memory.
    // Bulk SQL operations handle all create/delete without going through classifyItems.
    if (fetchedProduct.type === "fixedQuantityPerItem" && count !== undefined) {
      const isPurchaseOrIn =
        currentOrder.type === ORDER_TYPES.PURCHASE ||
        currentOrder.type === ORDER_TYPES.IN;

      if (isPurchaseOrIn) {
        // Get current item count via Knex — no array in memory
        // @ts-ignore
        const countRow = await knexMain("items_order_products_lnk")
          .where("order_product_id", opId || 0)
          .count("item_id as cnt")
          .first();
        const currentCount = parseInt(countRow?.cnt || 0, 10);

        if (count < currentCount) {
          await bulkDeletePurchaseItems(strapi, {
            orderProductId: opId,
            targetCount: count,
            trx,
          });
        } else if (count > currentCount) {
          // Get MAX(item_number) for sequential numbering in bulk create
          // @ts-ignore
          const maxRow = opId
            ? await knexMain("items as i")
                .join("items_order_products_lnk as lnk", "i.id", "lnk.item_id")
                .where("lnk.order_product_id", opId)
                .max("i.item_number as maxNum")
                .first()
            : null;
          const maxItemNumber = parseInt(maxRow?.maxNum || 0, 10) || 0;

          pendingBulkCreations.push({
            fetchedProduct,
            existingCount: currentCount,
            maxItemNumber,
            targetCount: count,
            productId,
          });
        }

        // ── Sincronizar bodega de items existentes ──────────────────────────────
        // BUG FIX: bulkCreatePurchaseItems asigna destinationWarehouse a los items
        // NUEVOS, pero los items YA EXISTENTES nunca tenían su bodega actualizada
        // cuando el usuario cambiaba destinationWarehouse en una orden existente.
        //
        // IMPORTANTE: currentOrder se carga ANTES de aplicar el update, así que
        // currentOrder.destinationWarehouse es la bodega VIEJA. La bodega NUEVA
        // llega como newDestinationWarehouseId (prioridad) y hay que usarla aquí,
        // igual que hace el fast path de itemsToKeep (líneas ~1411-1416).
        //
        // Usamos SQL puro (sin cargar IDs en JS) para evitar el límite de variables
        // de SQLite con órdenes de 100k+ items:
        //   1. Borrar links de bodega incorrectos via subquery WHERE item_id IN (SELECT ...)
        //   2. Reinsertar links faltantes via INSERT ... SELECT (LEFT JOIN para detectar ausentes)
        const effectiveDestId = newDestinationWarehouseId
          ? Number(newDestinationWarehouseId)
          : Number(currentOrder.destinationWarehouse?.id);
        if (opId && effectiveDestId) {
          const destId = effectiveDestId;

          // 1. Eliminar links cuya bodega ≠ destinationWarehouse
          // @ts-ignore
          await knexMain("items_warehouse_lnk")
            .whereIn(
              "item_id",
              knexMain("items_order_products_lnk")
                .where("order_product_id", opId)
                .select("item_id"),
            )
            .whereNot("warehouse_id", destId)
            .delete();

          // 2. Insertar links faltantes (items que quedaron sin bodega tras el delete)
          // @ts-ignore
          await knexMain.raw(
            `INSERT INTO items_warehouse_lnk (item_id, warehouse_id)
             SELECT lnk.item_id, ?
             FROM items_order_products_lnk lnk
             LEFT JOIN items_warehouse_lnk iwl ON iwl.item_id = lnk.item_id
             WHERE lnk.order_product_id = ?
               AND iwl.item_id IS NULL`,
            [destId, opId],
          );
        }

        // fixedQty purchase/in items are handled entirely via bulk ops.
        // Skip classifyItems for this product — adding to currentItems or
        // itemsFromRequest would require loading 100k IDs into memory.
        continue;
      }

      // ── fixedQuantityPerItem sale/out ────────────────────────────────────────
      // WHY deferred: para 50k+ items, N llamadas a doItemMovement(CREATE) causan
      // timeout y SQLITE_BUSY (cada ORM call abre conexión nueva). En su lugar,
      // recopilamos los items aquí y ejecutamos bulkReserveSaleItems /
      // bulkUnreserveSpecificSaleItems en la Fase 3, después de que los
      // orderProducts estén creados.
      //
      // Los finalItems se agregan a currentItems e itemsFromRequest en la Fase 3
      // para que classifyItems los ponga en itemsToKeep y bulkUpdateSaleItems
      // los procese correctamente en la completación de la orden.
      // @ts-ignore
      const existingItems = opId
        ? await knexMain("items as i")
            .join("items_order_products_lnk as lnk", "i.id", "lnk.item_id")
            .where("lnk.order_product_id", opId)
            .select("i.id", "i.state")
        : [];
      const currentCount = existingItems.length;

      let saleAvailableItems = [];
      let saleRemovedItems = [];
      let saleFinalItems;

      if (count === currentCount) {
        saleFinalItems = existingItems;
      } else if (count > currentCount) {
        const diff = count - currentCount;
        const queriedItems = await strapi.entityService.findMany(
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

        if (queriedItems.length < diff) {
          throw new Error(
            `No hay suficientes items disponibles para ${fetchedProduct.name}. Faltan ${diff}, pero solo hay ${queriedItems.length}.`,
          );
        }

        saleAvailableItems = queriedItems;
        saleFinalItems = [...existingItems, ...saleAvailableItems];
      } else {
        saleFinalItems = existingItems.slice(0, count);
        saleRemovedItems = existingItems.slice(count);
      }

      pendingFixedQtySaleOps.push({
        productId,
        finalItems: saleFinalItems,
        availableItems: saleAvailableItems,
        removedItems: saleRemovedItems,
        ivaIncluded,
        price,
      });
      continue;
    }

    // ── Variable / cutItem products ───────────────────────────────────────────
    // Load current items from DB via Knex for this orderProduct.
    // Variable products have manageable item counts (tens to hundreds).
    // @ts-ignore
    const currentProductItems = opId
      ? await knexMain("items as i")
          .join("items_order_products_lnk as lnk", "i.id", "lnk.item_id")
          .where("lnk.order_product_id", opId)
          .select(
            "i.id",
            "i.state",
            "i.current_quantity as currentQuantity",
            "i.lot_number as lotNumber",
            "i.item_number as itemNumber",
            "i.barcode",
            "i.alternative_barcode as alternativeBarcode",
          )
      : [];

    for (const item of currentProductItems) {
      currentItems.push(item);
      itemIdToOrderProduct.set(item.id, currentOrderProductForProduct);
    }

    // Sentinel: items were not sent (null/undefined) → preserve existing DB items.
    // An explicit empty array `[]` IS meaningful — it means "delete all items".
    const finalItems = itemsNotLoaded
      ? currentProductItems
      : (rawItems || []);

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

  // ── Fase 3: Bulk reserve/unreserve para fixedQty SALE/OUT ───────────────────
  // Ahora que los orderProducts existen en BD, ejecutamos las operaciones bulk.
  //
  // Tabla de transiciones:
  //   availableItems (nuevos)  → bulkReserveSaleItems  → AVAILABLE → RESERVED
  //   removedItems  (exceso)   → bulkUnreserveSpecificSaleItems → RESERVED → AVAILABLE
  //   finalItems    (todos)    → currentItems + itemsFromRequest → itemsToKeep
  //
  // Los items recién reservados (availableItems) se marcan como RESERVED en el
  // array local para que bulkUpdateSaleItems no cree movimientos duplicados al
  // verificar qué estado tienen vs. el estado destino.
  for (const {
    productId: fixedQtyProductId,
    finalItems,
    availableItems,
    removedItems,
    ivaIncluded: fixedIva,
    price: fixedPrice,
  } of pendingFixedQtySaleOps) {
    const fixedOrderProduct = orderProductsByProductId.get(fixedQtyProductId);

    // Bulk reservar items nuevos (AVAILABLE → RESERVED + vincular + movimientos)
    if (availableItems.length > 0 && fixedOrderProduct) {
      await bulkReserveSaleItems(strapi, {
        items: availableItems,
        currentOrder,
        orderProduct: fixedOrderProduct,
        trx,
      });
    }

    // Bulk liberar items removidos (RESERVED → AVAILABLE + desvincular + movimientos)
    if (removedItems.length > 0 && fixedOrderProduct) {
      await bulkUnreserveSpecificSaleItems(strapi, {
        items: removedItems,
        currentOrder,
        orderProduct: fixedOrderProduct,
        trx,
      });
    }

    // Agregar finalItems a currentItems e itemsFromRequest con estado corregido.
    // Los items de availableItems ya fueron reservados → su estado real es RESERVED.
    const newlyReservedIds = new Set(availableItems.map((i) => i.id));
    for (const item of finalItems) {
      const correctedState = newlyReservedIds.has(item.id)
        ? ITEM_STATES.RESERVED
        : item.state;
      currentItems.push({ ...item, state: correctedState });
      itemsFromRequest.push({
        ...item,
        state: correctedState,
        product: fixedQtyProductId,
        ivaIncluded: fixedIva,
        price: parseFloat(fixedPrice) || 0,
      });
    }
  }

  // Classify items. currentItems and itemIdToOrderProduct were built per-product
  // in the loop above. fixedQty purchase/in and fixedQty SALE/OUT items are
  // excluded from the per-product loop and handled via bulk ops above.
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
      const orderProduct = itemIdToOrderProduct.get(item.id);
      if (!orderProduct) {
        throw new Error(`OrderProduct no encontrado para el item ${item.id}`);
      }

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

  // ── Bulk create for fixedQuantityPerItem purchase/in orders ──────────────
  for (const bulk of pendingBulkCreations) {
    const orderProductEntry = orderProductsByProductId.get(bulk.productId);
    if (orderProductEntry) {
      await bulkCreatePurchaseItems(strapi, {
        fetchedProduct: bulk.fetchedProduct,
        existingCount: bulk.existingCount,
        maxItemNumber: bulk.maxItemNumber,
        targetCount: bulk.targetCount,
        currentOrder,
        orderProductId: orderProductEntry.id,
        trx,
      });
    }
  }

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

      const orderProduct = itemIdToOrderProduct.get(item.id);

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

  // Load item IDs via Knex — avoids ORM populate that would generate
  // WHERE id IN (100k IDs) and crash SQLite for large fixedQty orders.
  // bulkMoveItemsToWarehouse only needs { id } and loads warehouse data itself.
  // @ts-ignore
  const knexTrxEx = trx?.trx ?? trx ?? strapi.db.connection;
  // @ts-ignore
  const opIds = orderProducts.map((op) => op.id).filter(Boolean);
  if (opIds.length === 0) return;
  // @ts-ignore
  const itemRows = await knexTrxEx("items_order_products_lnk")
    .whereIn("order_product_id", opIds)
    .select("item_id");
  // @ts-ignore
  const allItems = itemRows.map((r) => ({ id: r.item_id }));
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
  bulkReserveSaleItems,
  bulkUnreserveFixedQtyItems,
  bulkUnreserveSpecificSaleItems,
  fastUnreserveSaleItem,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
  EDITABLE_STATES,
};
