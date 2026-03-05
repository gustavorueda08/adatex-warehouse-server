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
  "customerForInvoice",
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

    if (fetchedProduct.type === "fixedQuantityPerItem" && count !== undefined) {
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
    } else if (
      fetchedProduct.type === "cutItem" ||
      fetchedProduct.type === "variableQuantityPerItem"
    ) {
      // For cutItem or variableQuantityPerItem, the frontend often just sends the requested array of items directly.
      // E.g items: [{ quantity: 15 }, { quantity: 10 }]
      // If they passed `requestedQuantity` but no explicit items, we can infer they want 1 piece of that quantity
      // or we just trust the items array. Let's make sure things aren't dropped if they just sent requestedQuantity.
      if (items.length === 0 && productReq.requestedQuantity) {
        // Only do this auto-generation if the order state is DRAFT or CONFIRMED where items are editable
        // Wait, if it's an update, they might just be syncing quantities.
        // Actually, for cutItems, we typically need explicit items to generate cuts.
        // But if the frontend just passed requestedQuantity and items=[], it will delete the existing items!
        // The best approach is to check if it's cutItem and they requested a quantity, we create a pseudo-item to trigger the cut logic.
        // Wait, what if they just didn't modify the items? If they pass `items: []`, it means delete all items.
        // Let's rely on the frontend explicitly passing `items` or `quantities` for cut item.
        // Actually, if they pass `requestedQuantity` and NO `items`, and the product is cutItem, let's auto-generate a pseudo-item
        // that will be processed by doItemMovement as an addition if the current items are empty.
        // Wait, if the frontend just sends `requestedQuantity: 100`, we should translate that to an `item: { quantity: 100 }`.

        // If there are existing items, they should ideally be passed back from the frontend to preserve their IDs.
        // If frontend didn't pass items back, they get deleted. Let's provide a fallback: just map the requestedQuantity to a single item.
        if (
          fetchedProduct.type === "cutItem" &&
          currentOrder.orderProducts.find((op) => op.product.id === productId)
            ?.items?.length > 0
        ) {
          // If they already have items, we don't auto-generate to avoid re-cutting. Frontend should send the items array.
          finalItems = items;
        } else if (fetchedProduct.type === "cutItem") {
          finalItems = [{ quantity: productReq.requestedQuantity }];
        }
      }
    }

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
    1,
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
    1,
  );

  // Fetch the new destination warehouse entity if an ID was provided
  let newDestinationWarehouseEntity = null;
  if (newDestinationWarehouseId) {
    newDestinationWarehouseEntity = await strapi.entityService.findOne(
      WAREHOUSE_SERVICE,
      newDestinationWarehouseId,
      { transacting: trx },
    );
  }

  // Actualizar items que se mantienen
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

      // Determinar el warehouse a usar
      let warehouseToUse = null;

      if (newItemData.warehouse) {
        // Si viene warehouse explícitamente en el item request, validar que existe
        const destinationWarehouse = await strapi.entityService.findOne(
          WAREHOUSE_SERVICE,
          newItemData.warehouse,
          { transacting: trx },
        );

        if (!destinationWarehouse) {
          throw new Error("La bodega de destino no existe");
        }

        warehouseToUse = destinationWarehouse;
      } else if (newDestinationWarehouseEntity) {
        // Si se está actualizando la bodega de destino a nivel de orden
        warehouseToUse = newDestinationWarehouseEntity;
      } else if (currentOrder.destinationWarehouse) {
        // Si no viene warehouse en el item ni se actualiza a nivel de orden, usar el current destinationWarehouse de la orden
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
    1,
  );
};

/**
 * Actualiza OrderProducts existentes sin cambios de items
 * Asegura que los items reciban el destinationWarehouse del order
 */
const updateExistingOrderProducts = async (
  strapi,
  currentOrder,
  orderState,
  trx,
  newDestinationWarehouseId = null,
) => {
  const { orderProducts } = currentOrder;

  // Usar la nueva bodega si viene, sino usar la de la orden
  let resolvedDestinationWarehouse = currentOrder.destinationWarehouse;
  if (newDestinationWarehouseId) {
    resolvedDestinationWarehouse = await strapi.entityService.findOne(
      WAREHOUSE_SERVICE,
      newDestinationWarehouseId,
      { transacting: trx },
    );
  }

  for (const orderProduct of orderProducts) {
    if (orderProduct.items.length > 0) {
      const { items, product, ...orderProductData } = orderProduct;

      await runInBatches(
        items,
        (item) => {
          // Preparar el item con el warehouse correcto
          const itemWithWarehouse = {
            ...item,
            // Si el order tiene destinationWarehouse válido, asignárselo al item
            ...(resolvedDestinationWarehouse && {
              warehouse: resolvedDestinationWarehouse,
            }),
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
        },
        1,
      );
    }
  }
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

module.exports = {
  validateOrderIsEditable,
  generateOrderNumber,
  getItemKey,
  classifyItems,
  updateOrderProducts,
  updateExistingOrderProducts,
  syncOrderProducts,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
  EDITABLE_STATES,
};
