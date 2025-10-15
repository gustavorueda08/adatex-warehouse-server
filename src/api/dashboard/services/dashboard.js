"use strict";

const moment = require("moment-timezone");
const ORDER_TYPES = require("../../../utils/orderTypes");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const {
  ORDER_SERVICE,
  ITEM_SERVICE,
  CUSTOMER_SERVICE,
  PRODUCT_SERVICE,
} = require("../../../utils/services");

module.exports = ({ strapi }) => ({
  /**
   * Calcula el porcentaje de cambio entre dos valores
   */
  calculatePercentageChange(current, previous) {
    if (previous === 0) return current > 0 ? "+100%" : "0%";
    const change = ((current - previous) / previous) * 100;
    const sign = change >= 0 ? "+" : "";
    return `${sign}${change.toFixed(1)}%`;
  },

  /**
   * Obtiene el rango de fechas para el mes actual y anterior
   */
  getDateRanges() {
    moment.tz.setDefault("America/Bogota");
    const now = moment();

    return {
      currentMonth: {
        start: now.clone().startOf("month").toDate(),
        end: now.clone().endOf("month").toDate(),
      },
      previousMonth: {
        start: now.clone().subtract(1, "month").startOf("month").toDate(),
        end: now.clone().subtract(1, "month").endOf("month").toDate(),
      },
    };
  },

  /**
   * Calcula el total de una orden desde sus orderProducts
   * @param {Array} orderProducts - Array de orderProducts
   * @param {String} orderState - Estado de la orden (draft, confirmed, completed, etc.)
   */
  calculateOrderTotal(orderProducts, orderState) {
    if (!orderProducts || orderProducts.length === 0) return 0;

    return orderProducts.reduce((sum, op) => {
      // Determinar qué cantidad usar según el estado de la orden
      let quantity = 0;
      if (orderState === ORDER_STATES.COMPLETED) {
        quantity = parseFloat(op.deliveredQuantity || 0);
      } else if (
        orderState === ORDER_STATES.CONFIRMED ||
        orderState === ORDER_STATES.PROCESSING
      ) {
        quantity = parseFloat(op.confirmedQuantity || 0);
      } else if (orderState === ORDER_STATES.DRAFT) {
        quantity = parseFloat(op.requestedQuantity || 0);
      } else {
        // Por defecto usar deliveredQuantity
        quantity = parseFloat(op.deliveredQuantity || 0);
      }

      // Obtener el precio base
      let price = parseFloat(op.price || 0);

      // Si tiene IVA incluido, dividir el precio entre 1.19
      if (op.ivaIncluded === true) {
        price = price / 1.19;
      }

      // Calcular subtotal y redondear a 2 decimales
      const subtotal = Math.round(quantity * price * 100) / 100;

      return sum + subtotal;
    }, 0);
  },

  /**
   * Obtiene las estadísticas de ventas
   */
  async getSalesStats() {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Ventas del mes actual
    const currentSales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
        completedDate: {
          $gte: currentMonth.start,
          $lte: currentMonth.end,
        },
      },
      populate: {
        orderProducts: {
          fields: [
            "deliveredQuantity",
            "confirmedQuantity",
            "requestedQuantity",
            "price",
            "ivaIncluded",
          ],
        },
      },
      fields: ["id", "state"],
    });

    // Ventas del mes anterior
    const previousSales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
        completedDate: {
          $gte: previousMonth.start,
          $lte: previousMonth.end,
        },
      },
      populate: {
        orderProducts: {
          fields: [
            "deliveredQuantity",
            "confirmedQuantity",
            "requestedQuantity",
            "price",
            "ivaIncluded",
          ],
        },
      },
      fields: ["id", "state"],
    });

    // Calcular totales
    const currentTotal = currentSales.reduce((sum, order) => {
      const total = this.calculateOrderTotal(order.orderProducts, order.state);
      return sum + total;
    }, 0);

    const previousTotal = previousSales.reduce((sum, order) => {
      const total = this.calculateOrderTotal(order.orderProducts, order.state);
      return sum + total;
    }, 0);

    const change = this.calculatePercentageChange(currentTotal, previousTotal);
    const trend = currentTotal >= previousTotal ? "up" : "down";

    return {
      value: `$${currentTotal.toLocaleString("es-CO", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      change,
      trend,
      description: "Total de ventas del mes",
    };
  },

  /**
   * Obtiene las estadísticas de compras
   */
  async getPurchasesStats() {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Compras del mes actual
    const currentPurchases = await strapi.entityService.findMany(
      ORDER_SERVICE,
      {
        filters: {
          type: ORDER_TYPES.PURCHASE,
          state: ORDER_STATES.COMPLETED,
          completedDate: {
            $gte: currentMonth.start,
            $lte: currentMonth.end,
          },
        },
        populate: {
          orderProducts: {
            fields: [
              "deliveredQuantity",
              "confirmedQuantity",
              "requestedQuantity",
              "price",
              "ivaIncluded",
            ],
          },
        },
        fields: ["id", "state"],
      }
    );

    // Compras del mes anterior
    const previousPurchases = await strapi.entityService.findMany(
      ORDER_SERVICE,
      {
        filters: {
          type: ORDER_TYPES.PURCHASE,
          state: ORDER_STATES.COMPLETED,
          completedDate: {
            $gte: previousMonth.start,
            $lte: previousMonth.end,
          },
        },
        populate: {
          orderProducts: {
            fields: [
              "deliveredQuantity",
              "confirmedQuantity",
              "requestedQuantity",
              "price",
              "ivaIncluded",
            ],
          },
        },
        fields: ["id", "state"],
      }
    );

    // Calcular totales
    const currentTotal = currentPurchases.reduce((sum, order) => {
      const total = this.calculateOrderTotal(order.orderProducts, order.state);
      return sum + total;
    }, 0);

    const previousTotal = previousPurchases.reduce((sum, order) => {
      const total = this.calculateOrderTotal(order.orderProducts, order.state);
      return sum + total;
    }, 0);

    const change = this.calculatePercentageChange(currentTotal, previousTotal);
    const trend = currentTotal >= previousTotal ? "up" : "down";

    return {
      value: `$${currentTotal.toLocaleString("es-CO", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      change,
      trend,
      description: "Total de compras del mes",
    };
  },

  /**
   * Obtiene las estadísticas de inventario
   */
  async getInventoryStats() {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Items disponibles actualmente
    const currentItems = await strapi.entityService.count(ITEM_SERVICE, {
      filters: {
        state: ITEM_STATES.AVAILABLE,
      },
    });

    // Items disponibles al final del mes anterior
    const previousItems = await strapi.entityService.count(ITEM_SERVICE, {
      filters: {
        state: ITEM_STATES.AVAILABLE,
        createdAt: {
          $lte: previousMonth.end,
        },
      },
    });

    const change = this.calculatePercentageChange(currentItems, previousItems);
    const trend = currentItems >= previousItems ? "up" : "down";

    return {
      value: currentItems.toLocaleString("es-CO"),
      change,
      trend,
      description: "Productos en inventario",
    };
  },

  /**
   * Obtiene las estadísticas de órdenes pendientes
   */
  async getPendingOrdersStats() {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Órdenes pendientes actuales
    const currentPending = await strapi.entityService.count(ORDER_SERVICE, {
      filters: {
        state: {
          $in: [ORDER_STATES.DRAFT, ORDER_STATES.PROCESSING],
        },
      },
    });

    // Órdenes pendientes del mes anterior
    const previousPending = await strapi.entityService.count(ORDER_SERVICE, {
      filters: {
        state: {
          $in: [ORDER_STATES.DRAFT, ORDER_STATES.PROCESSING],
        },
        createdAt: {
          $lte: previousMonth.end,
        },
      },
    });

    const change = this.calculatePercentageChange(
      currentPending,
      previousPending
    );
    const trend = currentPending >= previousPending ? "up" : "down";

    return {
      value: currentPending.toString(),
      change,
      trend,
      description: "Órdenes pendientes",
    };
  },

  /**
   * Obtiene las ventas recientes (últimas 5)
   */
  async getRecentSales() {
    const sales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
      },
      sort: { completedDate: "desc" },
      limit: 5,
      populate: {
        customer: {
          fields: ["name"],
        },
        orderProducts: {
          fields: [
            "deliveredQuantity",
            "confirmedQuantity",
            "requestedQuantity",
            "price",
            "ivaIncluded",
          ],
        },
      },
      fields: ["id", "state", "completedDate"],
    });

    moment.tz.setDefault("America/Bogota");
    const now = moment();

    return sales.map((sale) => {
      const completedDate = moment(sale.completedDate);
      const daysAgo = now.diff(completedDate, "days");

      let dateLabel;
      if (daysAgo === 0) {
        dateLabel = "Hoy";
      } else if (daysAgo === 1) {
        dateLabel = "Ayer";
      } else {
        dateLabel = `Hace ${daysAgo} días`;
      }

      // Calcular el monto
      const amount = this.calculateOrderTotal(sale.orderProducts, sale.state);

      return {
        id: sale.id,
        customer: sale.customer?.name || "Cliente desconocido",
        amount: `$${amount.toLocaleString("es-CO", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
        date: dateLabel,
      };
    });
  },

  /**
   * Obtiene los productos más vendidos (top 5)
   */
  async getTopProducts() {
    const { currentMonth } = this.getDateRanges();

    // Obtener todas las órdenes de venta completadas del mes
    const sales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
        completedDate: {
          $gte: currentMonth.start,
          $lte: currentMonth.end,
        },
      },
      populate: {
        orderProducts: {
          populate: {
            product: {
              fields: ["name"],
            },
          },
          fields: [
            "deliveredQuantity",
            "confirmedQuantity",
            "requestedQuantity",
            "price",
            "ivaIncluded",
          ],
        },
      },
      fields: ["state"],
    });

    // Agrupar por producto y sumar cantidades y revenue
    const productStats = {};

    sales.forEach((sale) => {
      sale.orderProducts?.forEach((op) => {
        const productId = op.product?.id;
        const productName = op.product?.name || "Producto desconocido";

        // Determinar cantidad según el estado
        let quantity = 0;
        if (sale.state === ORDER_STATES.COMPLETED) {
          quantity = parseFloat(op.deliveredQuantity || 0);
        } else if (
          sale.state === ORDER_STATES.CONFIRMED ||
          sale.state === ORDER_STATES.PROCESSING
        ) {
          quantity = parseFloat(op.confirmedQuantity || 0);
        } else if (sale.state === ORDER_STATES.DRAFT) {
          quantity = parseFloat(op.requestedQuantity || 0);
        }

        // Calcular precio (con o sin IVA)
        let price = parseFloat(op.price || 0);
        if (op.ivaIncluded === true) {
          price = price / 1.19;
        }

        // Calcular revenue y redondear a 2 decimales
        const revenue = Math.round(quantity * price * 100) / 100;

        if (!productStats[productId]) {
          productStats[productId] = {
            name: productName,
            sales: 0,
            revenue: 0,
          };
        }

        productStats[productId].sales += quantity;
        productStats[productId].revenue += revenue;
      });
    });

    // Convertir a array y ordenar por ventas
    const topProducts = Object.values(productStats)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5)
      .map((product) => ({
        name: product.name,
        sales: Math.floor(product.sales),
        revenue: `$${product.revenue.toLocaleString("es-CO", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })}`,
      }));

    return topProducts;
  },

  /**
   * Obtiene todas las estadísticas del dashboard
   */
  async getDashboardStats() {
    const [
      totalSales,
      totalPurchases,
      inventory,
      pendingOrders,
      recentSales,
      topProducts,
    ] = await Promise.all([
      this.getSalesStats(),
      this.getPurchasesStats(),
      this.getInventoryStats(),
      this.getPendingOrdersStats(),
      this.getRecentSales(),
      this.getTopProducts(),
    ]);

    return {
      stats: {
        totalSales,
        totalPurchases,
        inventory,
        pendingOrders,
      },
      recentSales,
      topProducts,
    };
  },
});
