'use strict';

/**
 * customer service
 */

const { createCoreService } = require('@strapi/strapi').factories;
const ORDER_TYPES = require("../../../utils/orderTypes");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const {
  ORDER_SERVICE,
  ITEM_SERVICE,
} = require("../../../utils/services");

module.exports = createCoreService('api::customer.customer', ({ strapi }) => ({
  /**
   * Obtiene el balance de inventario en remisión (despachado pero no facturado) para un cliente
   *
   * @param {Number} customerId - ID del cliente
   * @param {Object} filters - Filtros adicionales
   * @returns {Object} - Balance detallado por producto
   */
  async getConsignmentBalance(customerId, filters = {}) {
    const { productId } = filters;

    // Buscar todas las órdenes de venta completadas del cliente
    const salesOrders = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
        customer: customerId,
      },
      populate: [
        "orderProducts",
        "orderProducts.product",
        "orderProducts.items",
        "customer",
      ],
      sort: { actualDispatchDate: "desc" },
    });

    if (!salesOrders || salesOrders.length === 0) {
      return {
        customer: await strapi.entityService.findOne(
          "api::customer.customer",
          customerId,
          { fields: ["id", "name"] }
        ),
        products: [],
        summary: {
          totalDispatched: 0,
          totalInvoiced: 0,
          totalPending: 0,
        },
      };
    }

    // Agrupar items por producto
    const productStats = {};

    for (const order of salesOrders) {
      const isInvoiced = !!order.siigoId;

      for (const orderProduct of order.orderProducts || []) {
        const product = orderProduct.product;
        if (!product) continue;

        // Si se filtra por producto específico, saltar otros productos
        if (productId && product.id !== productId) {
          continue;
        }

        if (!productStats[product.id]) {
          productStats[product.id] = {
            product: {
              id: product.id,
              name: product.name,
              code: product.code,
              unit: product.unit,
            },
            totalDispatched: 0,
            totalInvoiced: 0,
            pendingBalance: 0,
            orders: [],
          };
        }

        // Calcular cantidades de items
        const itemsDispatched = (orderProduct.items || []).filter(
          (item) => item.state === ITEM_STATES.SOLD
        );

        const dispatchedQuantity = itemsDispatched.reduce(
          (sum, item) => sum + (item.currentQuantity || 0),
          0
        );

        const invoicedQuantity = itemsDispatched
          .filter((item) => item.isInvoiced)
          .reduce((sum, item) => sum + (item.currentQuantity || 0), 0);

        const pendingQuantity = dispatchedQuantity - invoicedQuantity;

        // Agregar a totales del producto
        productStats[product.id].totalDispatched += dispatchedQuantity;
        productStats[product.id].totalInvoiced += invoicedQuantity;
        productStats[product.id].pendingBalance += pendingQuantity;

        // Agregar detalle de la orden
        if (dispatchedQuantity > 0) {
          productStats[product.id].orders.push({
            orderId: order.id,
            orderCode: order.code,
            dispatchDate: order.actualDispatchDate,
            invoiced: isInvoiced,
            siigoId: order.siigoId,
            dispatched: dispatchedQuantity,
            invoicedQty: invoicedQuantity,
            pending: pendingQuantity,
          });
        }
      }
    }

    // Calcular resumen general
    const summary = Object.values(productStats).reduce(
      (acc, ps) => ({
        totalDispatched: acc.totalDispatched + ps.totalDispatched,
        totalInvoiced: acc.totalInvoiced + ps.totalInvoiced,
        totalPending: acc.totalPending + ps.pendingBalance,
      }),
      { totalDispatched: 0, totalInvoiced: 0, totalPending: 0 }
    );

    return {
      customer: salesOrders[0]?.customer
        ? { id: salesOrders[0].customer.id, name: salesOrders[0].customer.name }
        : null,
      products: Object.values(productStats),
      summary,
    };
  },

  /**
   * Obtiene el histórico de despachos y facturaciones para un cliente
   *
   * @param {Number} customerId - ID del cliente
   * @param {Object} options - Opciones de consulta
   * @returns {Array} - Historial de operaciones
   */
  async getConsignmentHistory(customerId, options = {}) {
    const { startDate, endDate, productId, limit = 50 } = options;

    const filters = {
      customer: customerId,
      $or: [
        { type: ORDER_TYPES.SALE, state: ORDER_STATES.COMPLETED },
        { type: ORDER_TYPES.PARTIAL_INVOICE },
      ],
    };

    if (startDate || endDate) {
      filters.actualDispatchDate = {};
      if (startDate) filters.actualDispatchDate.$gte = startDate;
      if (endDate) filters.actualDispatchDate.$lte = endDate;
    }

    const orders = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters,
      populate: [
        "orderProducts",
        "orderProducts.product",
        "orderProducts.items",
        "parentOrder",
      ],
      sort: { actualDispatchDate: "desc" },
      limit,
    });

    const history = [];

    for (const order of orders) {
      const orderType = order.type === ORDER_TYPES.SALE ? "dispatch" : "invoice";

      for (const orderProduct of order.orderProducts || []) {
        const product = orderProduct.product;
        if (!product) continue;

        // Filtrar por producto si se especifica
        if (productId && product.id !== productId) {
          continue;
        }

        const quantity = (orderProduct.items || []).reduce(
          (sum, item) => sum + (item.currentQuantity || 0),
          0
        );

        if (quantity > 0) {
          history.push({
            date: order.actualDispatchDate || order.completedDate || order.createdDate,
            type: orderType,
            orderId: order.id,
            orderCode: order.code,
            product: {
              id: product.id,
              name: product.name,
              code: product.code,
            },
            quantity,
            invoiced: !!order.siigoId,
            siigoId: order.siigoId,
            parentOrderId: order.parentOrder?.id,
            parentOrderCode: order.parentOrder?.code,
          });
        }
      }
    }

    return history;
  },
}));
