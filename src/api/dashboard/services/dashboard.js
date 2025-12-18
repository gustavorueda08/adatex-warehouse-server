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
  async getSalesStats(sellerId) {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Ventas del mes actual
    const currentFilters = {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
      completedDate: {
        $gte: currentMonth.start,
        $lte: currentMonth.end,
      },
      $or: [{ siigoIdTypeA: { $not: null } }, { siigoIdTypeB: { $not: null } }],
    };

    if (sellerId) {
      currentFilters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    const currentSales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: currentFilters,
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
    const previousFilters = {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
      completedDate: {
        $gte: previousMonth.start,
        $lte: previousMonth.end,
      },
      $or: [{ siigoIdTypeA: { $not: null } }, { siigoIdTypeB: { $not: null } }],
    };

    if (sellerId) {
      previousFilters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    const previousSales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: previousFilters,
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
  async getPendingOrdersStats(sellerId) {
    const { currentMonth, previousMonth } = this.getDateRanges();

    // Órdenes pendientes actuales
    const currentFilters = {
      state: {
        $in: [ORDER_STATES.DRAFT, ORDER_STATES.PROCESSING],
      },
    };

    if (sellerId) {
      currentFilters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    const currentPending = await strapi.entityService.count(ORDER_SERVICE, {
      filters: currentFilters,
    });

    // Órdenes pendientes del mes anterior
    const previousFilters = {
      state: {
        $in: [ORDER_STATES.DRAFT, ORDER_STATES.PROCESSING],
      },
      createdAt: {
        $lte: previousMonth.end,
      },
    };

    if (sellerId) {
      previousFilters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    const previousPending = await strapi.entityService.count(ORDER_SERVICE, {
      filters: previousFilters,
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
  async getRecentSales(sellerId) {
    const filters = {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
    };

    if (sellerId) {
      filters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    const sales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters,
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
  async getTopProducts(sellerId) {
    const { currentMonth } = this.getDateRanges();

    const filters = {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
      completedDate: {
        $gte: currentMonth.start,
        $lte: currentMonth.end,
      },
    };

    if (sellerId) {
      filters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    // Obtener todas las órdenes de venta completadas del mes
    const sales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters,
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
      .sort((a, b) => b.revenue - a.revenue)
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
   * Obtiene datos para gráficos de ventas (semanal, mensual, anual)
   */
  async getSalesChartData(sellerId) {
    moment.tz.setDefault("America/Bogota");
    const now = moment();

    const baseFilters = {
      type: ORDER_TYPES.SALE,
      state: ORDER_STATES.COMPLETED,
      $or: [{ siigoIdTypeA: { $not: null } }, { siigoIdTypeB: { $not: null } }],
    };

    if (sellerId) {
      baseFilters.customer = {
        seller: {
          id: sellerId,
        },
      };
    }

    // 1. Datos Semanales (últimas 12 semanas)
    const weeklyStart = now.clone().subtract(11, "weeks").startOf("week");
    const weeklyEnd = now.clone().endOf("week");

    const weeklySales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        ...baseFilters,
        completedDate: {
          $gte: weeklyStart.toDate(),
          $lte: weeklyEnd.toDate(),
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
      fields: ["state", "completedDate"],
    });

    // Agrupar por semana
    const weeklyData = [];
    let currentWeek = weeklyStart.clone();

    while (currentWeek.isSameOrBefore(weeklyEnd)) {
      const weekLabel = `Sem ${currentWeek.week()}`; // Semana del año
      const weekStart = currentWeek.clone().startOf("week");
      const weekEnd = currentWeek.clone().endOf("week");

      const salesInWeek = weeklySales.filter((sale) => {
        const saleDate = moment(sale.completedDate);
        return saleDate.isBetween(weekStart, weekEnd, undefined, "[]");
      });

      const total = salesInWeek.reduce((sum, order) => {
        return sum + this.calculateOrderTotal(order.orderProducts, order.state);
      }, 0);

      weeklyData.push({
        label: weekLabel,
        date: weekStart.format("DD/MM"),
        value: Math.round(total * 100) / 100,
      });

      currentWeek.add(1, "weeks");
    }

    // 2. Datos Mensuales (últimos 12 meses)
    const monthlyStart = now.clone().subtract(11, "months").startOf("month");
    const monthlyEnd = now.clone().endOf("month");

    const monthlySales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        ...baseFilters,
        completedDate: {
          $gte: monthlyStart.toDate(),
          $lte: monthlyEnd.toDate(),
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
      fields: ["state", "completedDate"],
    });

    const monthlyData = [];
    let currentMonth = monthlyStart.clone();

    while (currentMonth.isSameOrBefore(monthlyEnd)) {
      const monthLabel = currentMonth.format("MMM YYYY"); // Ene 2024
      const monthStart = currentMonth.clone().startOf("month");
      const monthEnd = currentMonth.clone().endOf("month");

      const salesInMonth = monthlySales.filter((sale) => {
        const saleDate = moment(sale.completedDate);
        return saleDate.isBetween(monthStart, monthEnd, undefined, "[]");
      });

      const total = salesInMonth.reduce((sum, order) => {
        return sum + this.calculateOrderTotal(order.orderProducts, order.state);
      }, 0);

      monthlyData.push({
        label: monthLabel,
        value: Math.round(total * 100) / 100,
      });

      currentMonth.add(1, "months");
    }

    // 3. Datos Anuales (últimos 5 años)
    const yearlyStart = now.clone().subtract(4, "years").startOf("year");
    const yearlyEnd = now.clone().endOf("year");

    const yearlySales = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        ...baseFilters,
        completedDate: {
          $gte: yearlyStart.toDate(),
          $lte: yearlyEnd.toDate(),
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
      fields: ["state", "completedDate"],
    });

    const yearlyData = [];
    let currentYear = yearlyStart.clone();

    while (currentYear.isSameOrBefore(yearlyEnd)) {
      const yearLabel = currentYear.format("YYYY");
      const yearStart = currentYear.clone().startOf("year");
      const yearEnd = currentYear.clone().endOf("year");

      const salesInYear = yearlySales.filter((sale) => {
        const saleDate = moment(sale.completedDate);
        return saleDate.isBetween(yearStart, yearEnd, undefined, "[]");
      });

      const total = salesInYear.reduce((sum, order) => {
        return sum + this.calculateOrderTotal(order.orderProducts, order.state);
      }, 0);

      yearlyData.push({
        label: yearLabel,
        value: Math.round(total * 100) / 100,
      });

      currentYear.add(1, "years");
    }

    return {
      weekly: weeklyData,
      monthly: monthlyData,
      yearly: yearlyData,
    };
  },

  /**
   * Obtiene todas las estadísticas del dashboard
   */
  async getDashboardStats(sellerId) {
    const [
      totalSales,
      totalPurchases, // No se filtra por seller
      inventory, // No se filtra por seller
      pendingOrders,
      recentSales,
      topProducts,
      salesChart,
    ] = await Promise.all([
      this.getSalesStats(sellerId),
      this.getPurchasesStats(),
      this.getInventoryStats(),
      this.getPendingOrdersStats(sellerId),
      this.getRecentSales(sellerId),
      this.getTopProducts(sellerId),
      this.getSalesChartData(sellerId),
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
      salesChart,
    };
  },
});
