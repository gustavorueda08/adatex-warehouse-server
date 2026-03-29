"use strict";

/**
 * customer service
 */

const { createCoreService } = require("@strapi/strapi").factories;
const ORDER_TYPES = require("../../../utils/orderTypes");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const {
  ORDER_SERVICE,
  ITEM_SERVICE,
  CUSTOMER_SERVICE,
  TAX_SERVICE,
} = require("../../../utils/services");
const compareRelationArrays = require("../../../utils/compareRelationArrays");
const detectPriceOperations = require("../../../utils/detectPriceOperations");

module.exports = createCoreService("api::customer.customer", ({ strapi }) => ({
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
      const orderType =
        order.type === ORDER_TYPES.SALE ? "dispatch" : "invoice";

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
            date:
              order.actualDispatchDate ||
              order.completedDate ||
              order.createdDate,
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
  async create(data) {
    return strapi.db.transaction(async (trx) => {
      const { taxes = [], parties = [], ...rest } = data;
      const customerSiigoService = strapi.service("api::siigo.customer");
      // Datos del Create
      const createData = {
        ...rest,
      };
      // Conección de los Taxex
      if (taxes.length > 0) {
        createData.taxes = { connect: taxes };
      } else {
        // Si no hay taxes, agregamos IVA
        const taxes = await strapi.entityService.findMany(TAX_SERVICE, {
          filters: { name: "IVA - 19%" },
        });
        const tax = taxes.length > 0 ? taxes[0] : null;
        if (tax) {
          createData.taxes = { connect: [tax.id] };
        }
      }
      // Si vienen parties los conectamos
      if (parties.length > 0) {
        createData.parties = { connect: parties };
      }
      // Creación del Customer
      const newCustomer = await strapi.entityService.create(
        CUSTOMER_SERVICE,
        {
          data: createData,
        },
        { transacting: trx }
      );

      return newCustomer;
    });
  },
  /**
   * Actualiza un customer y sus relaciones (taxes, parties y prices)
   *
   * @param {Number} id - ID del customer a actualizar
   * @param {Object} data - Datos a actualizar
   * @param {Array<number>} data.taxes - Array de IDs de taxes
   * @param {Array<number>} data.parties - Array de IDs de parties (customers relacionados)
   * @param {Array<Object>} data.prices - Array de objetos price con sus datos completos.
   *   Los prices con 'id' se actualizan, sin 'id' se crean, y los no incluidos se eliminan.
   *   Ejemplo: [{ id: 'uuid', product: 1, unitPrice: 15000, ivaIncluded: true }, { product: 2, unitPrice: 20000 }]
   * @returns {Object} Customer actualizado con relaciones populadas
   */
  async update(id, data) {
    const { taxes = [], parties = [], prices = [], ...rest } = data;

    // Filter out null values for email and lastName to avoid validation errors
    if (rest.email === null) delete rest.email;
    if (rest.lastName === null) delete rest.lastName;

    return strapi.db.transaction(async (trx) => {
      // Obtener customer actual con relaciones
      const currentCustomer = await strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        id,
        {
          populate: ["taxes", "parties", "prices"],
        },
        { transacting: trx }
      );

      if (!currentCustomer) {
        throw new Error(`Customer con ID ${id} no encontrado`);
      }

      // Procesar taxes (many-to-many)
      const currentTaxes = currentCustomer.taxes?.map((tax) => tax.id) || [];
      const { toAdd: taxesToAdd, toRemove: taxesToRemove } =
        compareRelationArrays(currentTaxes, taxes);

      // Procesar parties (one-to-many)
      // Las parties que se van a remover necesitan desvincularse del mainParty
      const currentParties =
        currentCustomer.parties?.map((party) => party.id) || [];
      const { toAdd: partiesToAdd, toRemove: partiesToRemove } =
        compareRelationArrays(currentParties, parties);

      // Procesar prices (one-to-many con objetos completos)
      const currentPrices = currentCustomer.prices || [];
      const { toCreate, toUpdate, toDelete } = detectPriceOperations(
        currentPrices,
        prices
      );

      // Eliminar prices que ya no están en el array
      for (const price of toDelete) {
        await strapi.entityService.delete("api::price.price", price.id, {
          transacting: trx,
        });
      }

      // Actualizar prices existentes con nuevos valores
      for (const price of toUpdate) {
        const { id: priceId, ...priceData } = price;
        await strapi.entityService.update(
          "api::price.price",
          priceId,
          {
            data: priceData,
          },
          { transacting: trx }
        );
      }

      // Crear nuevos prices vinculándolos al customer
      for (const price of toCreate) {
        const { id, ...priceData } = price; // Eliminar id si viene null/undefined
        await strapi.entityService.create(
          "api::price.price",
          {
            data: {
              ...priceData,
              customer: currentCustomer.id,
            },
          },
          { transacting: trx }
        );
      }

      // Actualizar el customer con taxes y resto de campos
      await strapi.entityService.update(
        CUSTOMER_SERVICE,
        id,
        {
          data: {
            ...rest,
            taxes: {
              connect: taxesToAdd,
              disconnect: taxesToRemove,
            },
            parties: {
              connect: partiesToAdd,
              disconnect: partiesToRemove,
            },
          },
        },
        { transacting: trx }
      );

      // Retornar con relaciones populadas
      return strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        id,
        {
          populate: [
            "taxes",
            "parties",
            "territory",
            "prices",
            "prices.product",
          ],
        },
        { transacting: trx }
      );
    });
  },
  /**
   * Obtiene items despachados (SOLD) pero no facturados para un cliente, agrupados por producto.
   * @param {Number} customerId
   */
  async getInvoiceableItems(customerId) {
    // 1. Buscar órdenes de venta completadas
    const orders = await strapi.entityService.findMany(ORDER_SERVICE, {
      filters: {
        customer: customerId,
        type: ORDER_TYPES.SALE,
        state: ORDER_STATES.COMPLETED,
      },
      populate: [
        "orderProducts",
        "orderProducts.product",
        "orderProducts.items",
        "orderProducts.items.product",
      ],
    });

    const productMap = {};

    // 2. Iterar y filtrar items
    for (const order of orders) {
      for (const op of order.orderProducts || []) {
        const product = op.product;
        if (!product) continue;

        if (!productMap[product.id]) {
          productMap[product.id] = {
            product: {
              id: product.id,
              name: product.name,
              code: product.code,
              unit: product.unit,
            },
            items: [],
            totalQuantity: 0,
          };
        }

        // Filtrar items: Estado SOLD y isInvoiced false
        const validItems = (op.items || []).filter(
          (item) => item.state === ITEM_STATES.SOLD && !item.isInvoiced
        );

        for (const item of validItems) {
          productMap[product.id].items.push({
            id: item.id,
            barcode: item.barcode,
            currentQuantity: item.currentQuantity,
            originalQuantity: item.originalQuantity,
            sourceOrder: {
              id: order.id,
              code: order.code,
              date: order.actualDepositPaymentDate || order.updatedAt,
            },
          });
          productMap[product.id].totalQuantity += Number(
            item.currentQuantity || 0
          );
        }
      }
    }

    // 3. Retornar array (filtrando productos sin items)
    return Object.values(productMap).filter((group) => group.items.length > 0);
  },

  /**
   * Calculates monthly volume, moving averages, churn risk,
   * current-month volume, and seasonal projected volume for all customers.
   */
  async calculateAnalytics() {
    const moment = require("moment-timezone");
    const { ORDER_SERVICE } = require("../../../utils/services");
    const ORDER_TYPES = require("../../../utils/orderTypes");
    const ORDER_STATES = require("../../../utils/orderStates");
    
    const churnThreshold = 0.5; // 50% drop signifies churn risk

    // Date boundaries
    const now = moment();
    const ninetyDaysAgo = moment().subtract(90, 'days').startOf('day');
    const startOfCurrentMonth = moment().startOf('month');
    const currentDayOfMonth = now.date();
    const daysInMonth = now.daysInMonth();

    // Historical boundaries for seasonal model
    const startOfSameMonthLastYear = moment().subtract(1, 'year').startOf('month');
    const endOfSameMonthLastYear = moment().subtract(1, 'year').endOf('month');
    const historical90Start = moment(startOfSameMonthLastYear).subtract(90, 'days').startOf('day');

    const customers = await strapi.entityService.findMany("api::customer.customer", {
      fields: ["id", "status"],
      limit: -1,
    });

    for (const customer of customers) {
      // --- Fetch RECENT orders (last 90 days) ---
      const recentOrders = await strapi.entityService.findMany(ORDER_SERVICE, {
        filters: {
          customer: customer.id,
          type: { $in: [ORDER_TYPES.SALE, ORDER_TYPES.PARTIAL_INVOICE] },
          state: { $in: [ORDER_STATES.COMPLETED, ORDER_STATES.PROCESSING] },
          $or: [
            { createdDate: { $gte: ninetyDaysAgo.toDate() } },
            { createdAt: { $gte: ninetyDaysAgo.toDate() } },
            { completedDate: { $gte: ninetyDaysAgo.toDate() } }
          ]
        },
        populate: ["orderProducts", "orderProducts.product"]
      });

      // --- Fetch HISTORICAL orders (same month last year + 90 days prior) ---
      const historicalOrders = await strapi.entityService.findMany(ORDER_SERVICE, {
        filters: {
          customer: customer.id,
          type: { $in: [ORDER_TYPES.SALE, ORDER_TYPES.PARTIAL_INVOICE] },
          state: { $in: [ORDER_STATES.COMPLETED, ORDER_STATES.PROCESSING] },
          $or: [
            { createdDate: { $gte: historical90Start.toDate(), $lte: endOfSameMonthLastYear.toDate() } },
            { createdAt: { $gte: historical90Start.toDate(), $lte: endOfSameMonthLastYear.toDate() } },
            { completedDate: { $gte: historical90Start.toDate(), $lte: endOfSameMonthLastYear.toDate() } }
          ]
        },
        populate: ["orderProducts", "orderProducts.product"]
      });

      let monthlyVolume = 0;       // last 30 days
      let month2Volume = 0;        // 31-60 days ago
      let month3Volume = 0;        // 61-90 days ago
      let currentMonthVolume = 0;  // since 1st of current month
      let lastPurchaseDate = null;
      let productStats = {};

      // Recent 90 day totals
      let recent90Volume = 0;

      for (const order of recentOrders) {
        const dateInput = order.createdDate || order.completedDate || order.createdAt;
        const orderDate = moment(dateInput);
        if (!lastPurchaseDate || orderDate.isAfter(lastPurchaseDate)) {
          lastPurchaseDate = orderDate.toDate();
        }

        let orderTotal = 0;
        for (const op of order.orderProducts || []) {
          // Use confirmedQuantity as primary (set from actual items on completion);
          // fall back to requestedQuantity for orders still in processing.
          // partial-invoice orders have requestedQuantity=0 but confirmedQuantity set.
          const qty = op.confirmedQuantity || op.requestedQuantity || 0;
          const price = op.price || 0;
          const lineTotal = (qty * price);
          orderTotal += lineTotal;

          if (op.product) {
            const pId = op.product.id;
            if (!productStats[pId]) {
              productStats[pId] = {
                id: pId,
                name: op.product.name,
                code: op.product.code,
                unit: op.product.unit,
                quantity: 0,
                volume: 0
              };
            }
            productStats[pId].quantity += qty;
            productStats[pId].volume += lineTotal;
          }
        }

        // Bucket into 30-day periods
        const daysAgo = moment().diff(orderDate, 'days');
        if (daysAgo <= 30) {
          monthlyVolume += orderTotal;
        } else if (daysAgo <= 60) {
          month2Volume += orderTotal;
        } else {
          month3Volume += orderTotal;
        }

        // Current calendar month total
        if (orderDate.isSameOrAfter(startOfCurrentMonth)) {
          currentMonthVolume += orderTotal;
        }

        recent90Volume += orderTotal;
      }

      // --- Historical aggregation ---
      let historicalSameMonthVolume = 0;
      let historical90Volume = 0;

      for (const order of historicalOrders) {
        const dateInput = order.createdDate || order.completedDate || order.createdAt;
        const orderDate = moment(dateInput);

        let orderTotal = 0;
        for (const op of order.orderProducts || []) {
          const qty = op.confirmedQuantity || op.requestedQuantity || 0;
          const price = op.price || 0;
          orderTotal += (qty * price);
        }

        if (orderDate.isBetween(startOfSameMonthLastYear, endOfSameMonthLastYear, null, '[]')) {
          historicalSameMonthVolume += orderTotal;
        }
        if (orderDate.isBetween(historical90Start, startOfSameMonthLastYear, null, '[)')) {
          historical90Volume += orderTotal;
        }
      }

      // --- Calculate 3-month average FIRST (needed for fallback projection) ---
      const total90Days = monthlyVolume + month2Volume + month3Volume;
      const threeMonthAverage = total90Days / 3;

      // --- Seasonal Projection ---
      let trendGrowthRate = 0;
      if (historical90Volume > 0) {
        trendGrowthRate = (recent90Volume - historical90Volume) / historical90Volume;
        // Cap extreme trends to avoid unrealistic projections
        if (trendGrowthRate > 3) trendGrowthRate = 3;       // max +300%
        if (trendGrowthRate < -0.8) trendGrowthRate = -0.8;  // max -80%
      }

      let projectedVolume = 0;

      if (historicalSameMonthVolume > 0) {
        // Seasonal model: history-based adjusted by trend
        const expectedFromHistory = historicalSameMonthVolume * (1 + trendGrowthRate);

        // Linear pace from what we've sold so far this month
        let linearPace = 0;
        if (currentDayOfMonth > 0) {
          linearPace = (currentMonthVolume / currentDayOfMonth) * daysInMonth;
        }

        // Blend: the deeper we are in the month, the more we trust actual data
        const monthProgress = currentDayOfMonth / daysInMonth;
        projectedVolume = (linearPace * monthProgress) + (expectedFromHistory * (1 - monthProgress));
      } else if (currentMonthVolume > 0 && currentDayOfMonth > 0) {
        // No historical base but customer has bought this month → linear projection
        projectedVolume = (currentMonthVolume / currentDayOfMonth) * daysInMonth;
      } else if (threeMonthAverage > 0) {
        // No historical base, no current-month sales, but has recent 90-day activity
        // Use their average monthly consumption as the projection
        projectedVolume = threeMonthAverage;
      }

      let isChurnRisk = false;
      if (threeMonthAverage > 0 && monthlyVolume < (threeMonthAverage * (1 - churnThreshold))) {
        isChurnRisk = true;
      }

      const topProducts = Object.values(productStats)
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 5);

      const updateData = {
        monthlyVolume,
        threeMonthAverage,
        isChurnRisk,
        topProducts,
        currentMonthVolume,
        projectedVolume: Math.round(projectedVolume),
      };
      
      if (lastPurchaseDate) {
        updateData.lastPurchaseDate = lastPurchaseDate;
      }

      // ── Status transitions ────────────────────────────────────────────────
      //
      // Rule 1: Customer bought in last 30 days → active (or at_risk if churn signal)
      //         Applies to ALL statuses, including null and prospect.
      if (monthlyVolume > 0) {
        updateData.status = isChurnRisk ? 'at_risk' : 'active';

      // Rule 2: Prospect with no recent purchases → never auto-change downward
      //         (Rule 1 above handles the prospect→active promotion when they do buy)
      } else if (customer.status === 'prospect') {
        // no change

      // Rule 3: Was active, no purchases in last 30 days
      } else if (customer.status === 'active') {
        if (month2Volume > 0 || month3Volume > 0) {
          // Bought 31–90 days ago → at_risk (not churned yet)
          updateData.status = 'at_risk';
        } else {
          // Zero purchases in 90 days → churned
          updateData.status = 'churned';
        }

      // Rule 4: Was at_risk, still no purchase this month
      } else if (customer.status === 'at_risk') {
        if (month2Volume === 0 && month3Volume === 0) {
          // No activity in 90 days → churned
          updateData.status = 'churned';
        }
        // else: still had some activity in 31–90 days → keep at_risk

      // Rule 5: Unclassified (null) or already churned — only reclassify if
      //         there's recent-ish activity (31–90 days ago).
      } else if (!customer.status || customer.status === 'churned') {
        if (month2Volume > 0 || month3Volume > 0) {
          updateData.status = 'at_risk';
        }
        // else: no activity at all → leave unchanged
      }

      await strapi.db.query("api::customer.customer").update({
        where: { id: customer.id },
        data: {
          ...updateData,
          skipSiigoSync: true
        }
      });
    }
  },

  async delete(id) {
    const deletedCustomer = await strapi.entityService.delete(
      CUSTOMER_SERVICE,
      id
    );
    if (deletedCustomer) {
      return deletedCustomer;
    }
    throw new Error("Error eliminando el cliente, servicio no disponible");
  },
}));
