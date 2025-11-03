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
      remainingQuantity
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
      `No hay suficiente inventario en remisión. Solicitado: ${quantity}, Disponible: ${quantity - remainingQuantity}`
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

  // Verificar que tenga parentOrder
  if (!orderData.parentOrder) {
    errors.push(
      "Las órdenes de tipo partial-invoice deben tener un parentOrder"
    );
    return { valid: false, errors };
  }

  // Obtener la orden padre
  const parentOrder = await strapi.entityService.findOne(
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
    }
  );

  if (!parentOrder) {
    errors.push("La orden padre no existe");
    return { valid: false, errors };
  }

  // Validar que la orden padre sea de tipo sale
  if (parentOrder.type !== ORDER_TYPES.SALE) {
    errors.push("La orden padre debe ser de tipo 'sale'");
  }

  // Validar que la orden padre esté completada
  if (parentOrder.state !== ORDER_STATES.COMPLETED) {
    errors.push("La orden padre debe estar en estado 'completed'");
  }

  // Validar que la orden padre NO esté facturada (debe ser remisión)
  if (parentOrder.siigoId) {
    errors.push("La orden padre ya está facturada (tiene siigoId)");
  }

  // Validar que la orden padre NO tenga emitInvoice: true
  // (si tiene emitInvoice: true, debería facturarse completa al completarse, no parcialmente)
  if (parentOrder.emitInvoice === true) {
    errors.push(
      "La orden padre tiene emitInvoice: true, no se puede facturar parcialmente. Debe facturarse completa al completarse."
    );
  }

  // Si se especifican items por ID, validar que pertenezcan a la orden padre
  if (orderData.products && Array.isArray(orderData.products)) {
    for (const productData of orderData.products) {
      if (productData.items && Array.isArray(productData.items)) {
        for (const itemData of productData.items) {
          if (itemData.id) {
            // Buscar el item en la orden padre
            const itemInParent = parentOrder.orderProducts
              ?.flatMap((op) => op.items || [])
              .find((item) => item.id === itemData.id);

            if (!itemInParent) {
              errors.push(
                `El item ${itemData.id} no pertenece a la orden padre`
              );
            } else if (itemInParent.isInvoiced) {
              errors.push(
                `El item ${itemData.id} ya fue facturado previamente`
              );
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    parentOrder,
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
      (item) => item.state === ITEM_STATES.SOLD && !item.isInvoiced
    );

    if (invoiceableItems.length === 0) continue;

    const totalQuantity = invoiceableItems.reduce(
      (sum, item) => sum + (item.currentQuantity || 0),
      0
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
        0
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

  // Actualizar todos los items en batch
  await Promise.all(
    itemIds.map((itemId) =>
      strapi.entityService.update(ITEM_SERVICE, itemId, {
        data: {
          isInvoiced: true,
          invoicedDate: moment(invoicedDate).toDate(),
          warehouse: null, // Remover warehouse cuando se factura (salida definitiva)
        },
        transacting: trx,
      })
    )
  );
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

  // Actualizar todos los items en batch
  await Promise.all(
    itemIds.map((itemId) =>
      strapi.entityService.update(ITEM_SERVICE, itemId, {
        data: {
          isInvoiced: false,
          invoicedDate: null,
        },
        transacting: trx,
      })
    )
  );
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
                100
            ) / 100,
        };
        const restOrderProduct = {
          ...orderProduct,
          deliveredQuantity:
            Math.round(
              (orderProduct.deliveredQuantity -
                legalOrderProduct.deliveredQuantity) *
                100
            ) / 100,
        };
        acc.legalOrderProducts.push(legalOrderProduct);
        acc.orderProducts.push(restOrderProduct);
      }
    },
    {
      legalOrderProducts: [],
      orderProducts: [],
    }
  );
  return [
    { ...order, orderProducts: splittedOrderProducts.legalOrderProducts },
    { ...order, orderProducts: splittedOrderProducts.orderProducts },
  ];
}

module.exports = {
  findInvoiceableItemsByQuantity,
  validatePartialInvoiceOrder,
  getInvoiceableItemsFromOrder,
  markItemsAsInvoiced,
  unmarkItemsAsInvoiced,
  splitOrderForInvoices,
};
