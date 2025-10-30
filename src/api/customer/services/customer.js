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
      // Obtención del Customer en Siigo
      let siigoCustomer = null;
      if (newCustomer.identification) {
        siigoCustomer =
          await customerSiigoService.searchInSiigoByIdentification(
            newCustomer.identification
          );
      }
      // Si no hay Customer en Siigo, entonces se crea
      if (!siigoCustomer) {
        siigoCustomer = await customerSiigoService.createInSiigo(
          newCustomer.id
        );
      }
      // Retornamos el customer con el siigoId actualizado
      return await strapi.entityService.update(
        CUSTOMER_SERVICE,
        newCustomer.id,
        {
          data: {
            siigoId: String(siigoCustomer.id) || null,
          },
        },
        { transacting: trx }
      );
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
        await strapi.entityService.create(
          "api::price.price",
          {
            data: {
              ...price,
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
