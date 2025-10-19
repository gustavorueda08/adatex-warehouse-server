/**
 * Funciones auxiliares para el servicio de Order
 */

const ORDER_STATES = require("../../../utils/orderStates");

// Estados que permiten modificación de órdenes
const EDITABLE_STATES = [ORDER_STATES.DRAFT, ORDER_STATES.CONFIRMED];

/**
 * Valida que la orden pueda ser editada
 */
const validateOrderIsEditable = (order) => {
  if (!EDITABLE_STATES.includes(order.state)) {
    throw new Error(
      "Sólo las ordenes en borrador o confirmadas pueden ser modificadas"
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
  "sourceWarehouse",
  "destinationWarehouse",
  "customer",
  "supplier",
  "generatedBy",
  "movements",
];

const ORDER_POPULATE_BASIC = [
  "destinationWarehouse",
  "sourceWarehouse",
  "customer",
  "supplier",
  "generatedBy",
  "orderProducts",
];

// Importaciones adicionales para las funciones auxiliares
const runInBatches = require("../../../utils/runInBatches");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");
const logger = require("../../../utils/logger");
const {
  ORDER_PRODUCT_SERVICE,
  PRODUCT_SERVICE,
  WAREHOUSE_SERVICE,
  ORDER_SERVICE,
} = require("../../../utils/services");

/**
 * Actualiza los productos de una orden
 */
const updateOrderProducts = async (
  strapi,
  currentOrder,
  products,
  orderState,
  orderProductService,
  trx
) => {
  // Obtener todos los Items actuales y requeridos
  const currentItems = currentOrder.orderProducts
    .map((orderProduct) => orderProduct.items)
    .flat();

  const itemsFromRequest = products
    .map(({ product, items, ivaIncluded, price }) =>
      items.map((item) => ({
        ...item,
        product,
        ivaIncluded,
        price,
      }))
    )
    .flat();

  // Clasificar items
  const { itemsToRemove, itemsToKeep, itemsToAdd } = classifyItems(
    currentItems,
    itemsFromRequest
  );

  logger.debug("Items classification", {
    toRemove: itemsToRemove.length,
    toKeep: itemsToKeep.length,
    toAdd: itemsToAdd.length,
  });

  // Remover items
  await runInBatches(itemsToRemove, async (item) => {
    const orderProduct = currentOrder.orderProducts.find(
      (op) => op.product.id == item.product.id
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
  });

  // Agregar nuevos items
  await runInBatches(itemsToAdd, async (itemData) => {
    const {
      product: productId,
      id,
      sourceWarehouse,
      parentItem,
      ...item
    } = itemData;

    let product;
    let orderProduct = currentOrder.orderProducts.find(
      ({ product }) => product.id == productId
    );

    // Si no existe el OrderProduct, crearlo
    if (!orderProduct) {
      product = await strapi.entityService.findOne(PRODUCT_SERVICE, productId, {
        transacting: trx,
      });

      if (!product) {
        throw new Error("El producto no existe");
      }

      orderProduct = await orderProductService.create({
        product: product.id,
        order: currentOrder.id,
        requestedQuantity: 0,
        requestedPackages: 0,
        notes: "Producto agregado en actualización de orden",
        trx,
      });
    } else {
      product = orderProduct.product;
    }

    // Agregar el item
    await strapi.service(ORDER_SERVICE).doItemMovement({
      movementType: ITEM_MOVEMENT_TYPES.CREATE,
      item,
      order: currentOrder,
      orderProduct: orderProduct,
      product: product,
      orderState,
      trx,
    });
  });

  // Actualizar items que se mantienen
  await runInBatches(itemsToKeep, async (item) => {
    const newItemData = itemsFromRequest.find((i) => i?.id == item.id);

    if (!newItemData) {
      throw new Error("Error al actualizar item existente");
    }

    const orderProduct = currentOrder.orderProducts.find((op) =>
      op.items.find((i) => i.id === item.id)
    );

    if (!orderProduct) {
      throw new Error("El OrderProduct del Item no ha sido encontrado");
    }

    const { product, ...itemData } = item;

    // Determinar el warehouse a usar
    let warehouseToUse = null;

    if (newItemData.warehouse) {
      // Si viene warehouse en la request, validar que existe
      const destinationWarehouse = await strapi.entityService.findOne(
        WAREHOUSE_SERVICE,
        newItemData.warehouse,
        { transacting: trx }
      );

      if (!destinationWarehouse) {
        throw new Error("La bodega de destino no existe");
      }

      warehouseToUse = destinationWarehouse;
    } else if (currentOrder.destinationWarehouse) {
      // Si no viene warehouse, usar el destinationWarehouse del order
      warehouseToUse = currentOrder.destinationWarehouse;
    } else {
      // Fallback al warehouse actual del item
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
        price: newItemData.price || itemData.price || 0,
        ivaIncluded: newItemData.ivaIncluded || itemData.ivaIncluded || false,
      },
      order: currentOrder,
      orderState,
      product,
      orderProduct,
      trx,
    });
  });
};

/**
 * Actualiza OrderProducts existentes sin cambios de items
 * Asegura que los items reciban el destinationWarehouse del order
 */
const updateExistingOrderProducts = async (
  strapi,
  currentOrder,
  orderState,
  trx
) => {
  const { orderProducts, destinationWarehouse } = currentOrder;

  for (const orderProduct of orderProducts) {
    if (orderProduct.items.length > 0) {
      const { items, product, ...orderProductData } = orderProduct;

      await runInBatches(items, (item) => {
        // Preparar el item con el warehouse correcto
        const itemWithWarehouse = {
          ...item,
          // Si el order tiene destinationWarehouse, usarlo para el item
          ...(destinationWarehouse && { warehouse: destinationWarehouse }),
        };

        return strapi.service(ORDER_SERVICE).doItemMovement({
          movementType: ITEM_MOVEMENT_TYPES.UPDATE,
          item: itemWithWarehouse,
          order: currentOrder,
          orderState,
          product,
          orderProduct: orderProductData,
          trx,
        });
      });
    }
  }
};

/**
 * Recalcula las cantidades de OrderProducts
 */
const recalculateOrderProducts = async (
  strapi,
  orderId,
  products,
  orderState,
  orderProductService,
  trx
) => {
  const orderProducts = await strapi.entityService.findMany(
    ORDER_PRODUCT_SERVICE,
    {
      filters: { order: orderId },
      populate: ["product"],
      transacting: trx,
    }
  );

  if (!orderProducts || orderProducts.length === 0) {
    throw new Error("La orden no tiene productos asociados");
  }

  await runInBatches(orderProducts, async (orderProduct) => {
    const { product } = orderProduct;
    const dataFromRequest = products.find((p) => p.product === product.id);
    if (!dataFromRequest) return;
    console.log(orderProducts, "DATOS DEL REQUEST", products);

    const {
      items,
      orderProduct: _,
      product: p,
      ...updateData
    } = dataFromRequest;
    if (updateData.requestedQuantity) {
      updateData.requestedPackages = Math.round(
        updateData.requestedQuantity / product.unitsPerPackage
      );
    }
    await orderProductService.update({
      id: orderProduct.id,
      update: updateData,
      orderState,
      trx,
    });
  });
};

module.exports = {
  validateOrderIsEditable,
  generateOrderNumber,
  getItemKey,
  classifyItems,
  updateOrderProducts,
  updateExistingOrderProducts,
  recalculateOrderProducts,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
  EDITABLE_STATES,
};
