"use strict";

const ORDER_TYPES = require("../../../utils/orderTypes");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const { ORDER_SERVICE, ITEM_SERVICE } = require("../../../utils/services");

/**
 * Busca items despachados pero no facturados para un cliente específico
 * Aplica FIFO (First In, First Out) basado en la fecha de despacho
 *
 * @param {Object} params - Parámetros de búsqueda
 * @param {Number} params.customerId - ID del cliente
 * @param {Number} params.productId - ID del producto
 * @param {Number} params.quantity - Cantidad requerida
 * @param {Object} params.options - Opciones adicionales
 * @returns {Array} - Array de items con cantidad a facturar
 */
async function findInvoiceableItemsByQuantity({
  customerId,
  productId,
  quantity,
  options = {},
}) {
  const { trx } = options;

  // Buscar todas las órdenes de venta completadas del cliente sin facturar (sin siigoId)
  const salesOrders = await strapi.entityService.findMany(ORDER_SERVICE, {
    filters: {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
      customer: customerId,
      siigoId: { $null: true },
    },
    populate: [
      "orderProducts",
      "orderProducts.product",
      "orderProducts.items",
      "orderProducts.items.orders",
      "orderProducts.items.orderProducts",
    ],
    sort: { actualDispatchDate: "asc" }, // FIFO: más antiguos primero
    transacting: trx,
  });

  if (!salesOrders || salesOrders.length === 0) {
    return [];
  }

  // Recolectar items del producto específico que no estén facturados
  const availableItems = [];

  for (const order of salesOrders) {
    for (const orderProduct of order.orderProducts || []) {
      // Verificar que sea el producto correcto
      if (orderProduct.product?.id !== productId) {
        continue;
      }

      // Agregar items que:
      // 1. Estén en estado SOLD (despachados)
      // 2. NO estén marcados como facturados (isInvoiced = false)
      for (const item of orderProduct.items || []) {
        if (item.state === ITEM_STATES.SOLD && !item.isInvoiced) {
          availableItems.push({
            item,
            sourceOrder: {
              id: order.id,
              code: order.code,
              dispatchDate: order.actualDispatchDate,
            },
            availableQuantity: item.currentQuantity,
          });
        }
      }
    }
  }

  if (availableItems.length === 0) {
    return [];
  }

  // Seleccionar items hasta cubrir la cantidad requerida (FIFO)
  let remainingQuantity = quantity;
  const selectedItems = [];

  for (const itemInfo of availableItems) {
    if (remainingQuantity <= 0) {
      break;
    }

    const quantityToTake = Math.min(
      itemInfo.availableQuantity,
      remainingQuantity,
    );

    selectedItems.push({
      item: itemInfo.item,
      quantityToInvoice: quantityToTake,
      sourceOrder: itemInfo.sourceOrder,
    });

    remainingQuantity -= quantityToTake;
  }

  if (remainingQuantity > 0) {
    throw new Error(
      `No hay suficiente inventario en remisión. Solicitado: ${quantity}, Disponible: ${quantity - remainingQuantity}`,
    );
  }

  return selectedItems;
}

/**
 * Valida que una orden pueda ser convertida en partial-invoice
 *
 * @param {Object} orderData - Datos de la orden a crear
 * @param {Object} options - Opciones adicionales
 * @returns {Object} - { valid: boolean, errors: [] }
 */
async function validatePartialInvoiceOrder(orderData, options = {}) {
  const { trx } = options;
  const errors = [];

  // Validar que tenga customer
  if (!orderData.customer) {
    if (orderData.parentOrder) {
      // Si tiene parentOrder pero no customer, se tomarán del parentOrder (lógica en service create),
      // pero validamos que el parentOrder exista para asegurar consistencia.
      // (Esta validación ya se hace abajo si hay parentOrder)
    } else {
      errors.push(
        "Las órdenes de tipo partial-invoice deben tener un customer asociado",
      );
      // Retornamos de una vez porque sin cliente no podemos validar mucho más
      return { valid: false, errors };
    }
  }

  let parentOrder = null;

  // Si tiene parentOrder, validamos las reglas antiguas (opcional)
  if (orderData.parentOrder) {
    parentOrder = await strapi.entityService.findOne(
      ORDER_SERVICE,
      orderData.parentOrder,
      {
        populate: [
          "customer",
          "orderProducts",
          "orderProducts.items",
          "orderProducts.product",
        ],
        transacting: trx,
      },
    );

    if (!parentOrder) {
      errors.push("La orden padre no existe");
    } else {
      // Validar tipo y estado de la orden padre
      if (parentOrder.type !== ORDER_TYPES.SALE) {
        errors.push("La orden padre debe ser de tipo 'sale'");
      }
      if (parentOrder.state !== ORDER_STATES.COMPLETED) {
        errors.push("La orden padre debe estar en estado 'completed'");
      }
      if (parentOrder.siigoId) {
        errors.push("La orden padre ya está facturada (tiene siigoId)");
      }
      if (parentOrder.emitInvoice === true) {
        errors.push(
          "La orden padre tiene emitInvoice: true. Debe facturarse completa al completarse.",
        );
      }
    }
  }

  // Validar items si vienen en el payload
  if (orderData.products && Array.isArray(orderData.products)) {
    const customerId = orderData.customer || parentOrder?.customer?.id;

    if (!customerId) {
      errors.push("No se pudo determinar el cliente para validar los items");
    } else {
      // Fetch de todos los items en una sola consulta para evitar N+1
      const allItemIds = orderData.products
        .flatMap((p) => (p.items || []).map((i) => i.id))
        .filter(Boolean);
      const itemsById = new Map();
      if (allItemIds.length > 0) {
        const fetchedItems = await strapi.entityService.findMany(ITEM_SERVICE, {
          filters: { id: { $in: allItemIds } },
          populate: ["orders", "orders.customer"],
          transacting: trx,
        });
        fetchedItems.forEach((item) => itemsById.set(item.id, item));
      }

      for (const productData of orderData.products) {
        if (productData.items && Array.isArray(productData.items)) {
          for (const itemData of productData.items) {
            if (itemData.id) {
              const item = itemsById.get(itemData.id);

              if (!item) {
                errors.push(`El item ${itemData.id} no existe`);
                continue;
              }

              if (item.isInvoiced) {
                errors.push(
                  `El item ${itemData.id} ya fue facturado previamente`,
                );
                continue;
              }

              if (item.state !== ITEM_STATES.SOLD) {
                errors.push(
                  `El item ${itemData.id} debe estar en estado 'sold' para facturarse`,
                );
                continue;
              }

              // Validar que el item pertenezca a alguna orden de este cliente
              // Buscamos si alguna de las órdenes del item tiene el mismo cliente
              const belongsToCustomer = item.orders?.some(
                (o) => o.customer?.id === customerId,
              );

              if (!belongsToCustomer) {
                // Nota: Podría ser que la orden no tenga customer directo pero sea hija de una que sÍ,
                // pero asumimos que las órdenes de venta (SALE) tienen customer.
                // Si es un item antiguo, podría ser complicado.
                // Relajamos un poco: si tenemos parentOrder, validamos contra esa.
                if (parentOrder) {
                  const inParent = parentOrder.orderProducts
                    ?.flatMap((op) => op.items || [])
                    .find((i) => i.id === item.id);
                  if (!inParent) {
                    errors.push(
                      `El item ${itemData.id} no pertenece al cliente especificado (ni a la orden padre)`,
                    );
                  }
                } else {
                  errors.push(
                    `El item ${itemData.id} no parece pertenecer a ninguna orden del cliente ${customerId}`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    parentOrder, // Se retorna por compatibilidad, puede ser null
  };
}

/**
 * Obtiene los items facturables de una orden de venta completada sin facturar
 *
 * @param {Number} orderId - ID de la orden
 * @param {Object} options - Opciones adicionales
 * @returns {Object} - Items agrupados por producto
 */
async function getInvoiceableItemsFromOrder(orderId, options = {}) {
  const { trx } = options;

  const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
    populate: [
      "orderProducts",
      "orderProducts.product",
      "orderProducts.items",
      "customer",
    ],
    transacting: trx,
  });

  if (!order) {
    throw new Error(`Orden ${orderId} no encontrada`);
  }

  if (order.type !== ORDER_TYPES.SALE) {
    throw new Error("Solo las órdenes de tipo 'sale' tienen items facturables");
  }

  if (order.state !== ORDER_STATES.COMPLETED) {
    throw new Error("Solo las órdenes completadas tienen items facturables");
  }

  if (order.siigoId) {
    throw new Error("Esta orden ya está facturada");
  }

  // Agrupar items por producto
  const productGroups = {};

  for (const orderProduct of order.orderProducts || []) {
    const product = orderProduct.product;
    if (!product) continue;

    const invoiceableItems = (orderProduct.items || []).filter(
      (item) => item.state === ITEM_STATES.SOLD && !item.isInvoiced,
    );

    if (invoiceableItems.length === 0) continue;

    const totalQuantity = invoiceableItems.reduce(
      (sum, item) => sum + (item.currentQuantity || 0),
      0,
    );

    productGroups[product.id] = {
      product: {
        id: product.id,
        name: product.name,
        code: product.code,
        unit: product.unit,
      },
      price: orderProduct.price || 0,
      ivaIncluded: orderProduct.ivaIncluded || false,
      totalQuantity,
      itemCount: invoiceableItems.length,
      items: invoiceableItems.map((item) => ({
        id: item.id,
        barcode: item.barcode,
        quantity: item.currentQuantity,
        lotNumber: item.lotNumber,
        state: item.state,
      })),
    };
  }

  return {
    order: {
      id: order.id,
      code: order.code,
      dispatchDate: order.actualDispatchDate,
      customer: order.customer
        ? { id: order.customer.id, name: order.customer.name }
        : null,
    },
    products: Object.values(productGroups),
    summary: {
      totalProducts: Object.keys(productGroups).length,
      totalItems: Object.values(productGroups).reduce(
        (sum, pg) => sum + pg.itemCount,
        0,
      ),
    },
  };
}

/**
 * Marca items como facturados
 *
 * @param {Array} itemIds - Array de IDs de items
 * @param {Object} options - Opciones adicionales
 */
async function markItemsAsInvoiced(itemIds, options = {}) {
  const { trx, invoicedDate = new Date() } = options;

  if (!itemIds || itemIds.length === 0) {
    return;
  }

  const moment = require("moment-timezone");
  moment.tz.setDefault("America/Bogota");
  const invoicedDateVal = moment(invoicedDate).toDate();
  const now = new Date();

  if (trx) {
    // Con transacción explícita: bulk Knex para evitar N+1
    // Strapi 5 pasa callbackParams { trx: knexTrx, ... }; extraer la instancia Knex real
    const knex = trx?.trx ?? trx;
    await knex("items")
      .whereIn("id", itemIds)
      .update({ is_invoiced: true, invoiced_date: invoicedDateVal, updated_at: now });
    // Remover warehouse cuando se factura (salida definitiva)
    await knex("items_warehouse_lnk").whereIn("item_id", itemIds).delete();
  } else {
    // Sin transacción explícita: entityService respeta el contexto async de Strapi
    // (necesario cuando se llama desde afterUpdate lifecycle para evitar deadlock en SQLite)
    await Promise.all(
      itemIds.map((itemId) =>
        strapi.entityService.update(ITEM_SERVICE, itemId, {
          data: { isInvoiced: true, invoicedDate: invoicedDateVal, warehouse: null },
        }),
      ),
    );
  }
}

/**
 * Revierte el estado de facturación de items
 *
 * @param {Array} itemIds - Array de IDs de items
 * @param {Object} options - Opciones adicionales
 */
async function unmarkItemsAsInvoiced(itemIds, options = {}) {
  const { trx } = options;

  if (!itemIds || itemIds.length === 0) {
    return;
  }

  if (trx) {
    // Con transacción explícita: bulk Knex para evitar N+1
    const knex = trx?.trx ?? trx;
    await knex("items")
      .whereIn("id", itemIds)
      .update({ is_invoiced: false, invoiced_date: null, updated_at: new Date() });
  } else {
    // Sin transacción explícita: entityService respeta el contexto async de Strapi
    await Promise.all(
      itemIds.map((itemId) =>
        strapi.entityService.update(ITEM_SERVICE, itemId, {
          data: { isInvoiced: false, invoicedDate: null },
        }),
      ),
    );
  }
}

async function splitOrderForInvoices(order) {
  const { orderProducts = [] } = order;
  const splittedOrderProducts = orderProducts.reduce(
    (acc, orderProduct) => {
      if (orderProduct.invoicePercentage === 100) {
        acc.legalOrderProducts.push({
          ...orderProduct,
          deliveredQuantity:
            Math.round(orderProduct.deliveredQuantity * 100) / 100,
        });
      } else {
        const legalOrderProduct = {
          ...orderProduct,
          deliveredQuantity:
            Math.round(
              orderProduct.deliveredQuantity *
                (orderProduct.invoicePercentage / 100) *
                100,
            ) / 100,
        };
        const restOrderProduct = {
          ...orderProduct,
          deliveredQuantity:
            Math.round(
              (orderProduct.deliveredQuantity -
                legalOrderProduct.deliveredQuantity) *
                100,
            ) / 100,
        };
        acc.legalOrderProducts.push(legalOrderProduct);
        acc.orderProducts.push(restOrderProduct);
      }
    },
    {
      legalOrderProducts: [],
      orderProducts: [],
    },
  );
  return [
    { ...order, orderProducts: splittedOrderProducts.legalOrderProducts },
    { ...order, orderProducts: splittedOrderProducts.orderProducts },
  ];
}

/**
 * Divide los orderProducts en dos grupos para facturación dual (Tipo A y Tipo B)
 * Tipo A (electrónica): contiene el porcentaje especificado de cada producto
 * Tipo B (normal): contiene el porcentaje restante (solo productos con < 100%)
 *
 * @param {Object} order - Orden con orderProducts
 * @returns {Object} - { needsSplit: boolean, typeAProducts: [], typeBProducts: [] }
 */
function splitOrderProductsForDualInvoices(order) {
  const { orderProducts = [] } = order;

  // Inicializar arrays para ambos tipos de factura
  const typeAProducts = [];
  const typeBProducts = [];

  // Procesar cada orderProduct
  for (const orderProduct of orderProducts) {
    // Ignorar productos que son regalos (sin precio o precio 0)
    let basePrice = parseFloat(orderProduct.price);
    if (isNaN(basePrice) || basePrice <= 0) {
      continue;
    }

    const invoicePercentage =
      typeof orderProduct.invoicePercentage === "number"
        ? orderProduct.invoicePercentage
        : 100;
    const confirmedQty = orderProduct.confirmedQuantity || 0;

    // Calcular cantidad para factura tipo A (porcentaje especificado)
    const typeAQuantity =
      Math.round(((confirmedQty * invoicePercentage) / 100) * 100) / 100;

    // Solo agregar a tipo A si la cantidad es mayor a 0
    if (typeAQuantity > 0) {
      typeAProducts.push({
        ...orderProduct,
        confirmedQuantity: typeAQuantity,
      });
    }

    // Si el porcentaje es menor a 100%, calcular la cantidad restante para tipo B
    if (invoicePercentage < 100) {
      const typeBQuantity =
        Math.round((confirmedQty - typeAQuantity) * 100) / 100;

      typeBProducts.push({
        ...orderProduct,
        confirmedQuantity: typeBQuantity,
      });
    }
  }

  // Determinar si necesita split (hay al menos un producto en tipo B)
  const needsSplit = typeBProducts.length > 0;

  return {
    needsSplit,
    typeAProducts,
    typeBProducts,
  };
}

module.exports = {
  findInvoiceableItemsByQuantity,
  validatePartialInvoiceOrder,
  getInvoiceableItemsFromOrder,
  markItemsAsInvoiced,
  unmarkItemsAsInvoiced,
  splitOrderForInvoices,
  splitOrderProductsForDualInvoices,
};
