"use strict";

const moment = require("moment-timezone");
const runInBatches = require("../../../utils/runInBatches");
const {
  validateRequiredFields,
  validateFields,
} = require("../../../utils/validateRequiredFields");
const {
  ORDER_PRODUCT_SERVICE,
  PRODUCT_SERVICE,
  ORDER_SERVICE,
} = require("../../../utils/services");
const { withValidation } = require("../../../validation/withValidation");
const {
  CreateOrderProductSchema,
  UpdateOrderProductSchema,
  DeleteOrderProductSchema,
} = require("../../../validation/schemas");
const ITEM_STATES = require("../../../utils/itemStates");
const ORDER_TYPES = require("../../../utils/orderTypes");
const ORDER_STATES = require("../../../utils/orderStates");
const ORDER_PRODUCT_STATES = require("../../../utils/orderProductStates");

/**
 * order-product service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService(
  "api::order-product.order-product",
  ({ strapi }) => ({
    // Crea un OrderProduct
    create: withValidation(CreateOrderProductSchema, async (data) => {
      try {
        // Datos
        const {
          product: productId,
          order: orderId,
          ...orderProductData
        } = data;
        // Obtención del Producto

        const product = await strapi.entityService.findOne(
          PRODUCT_SERVICE,
          productId,
          data.trx ? { transacting: data.trx } : {}
        );
        // Obtención de la Orden
        const order = await strapi.entityService.findOne(
          ORDER_SERVICE,
          orderId,
          data.trx ? { transacting: data.trx } : {}
        );

        // Creación y retorno del OrderProduct
        return await strapi.entityService.create(
          ORDER_PRODUCT_SERVICE,
          {
            data: {
              ...orderProductData,
              product: product.id,
              requestedPackages: orderProductData.confirmedPackages
                ? 0
                : Math.round(
                    orderProductData.requestedQuantity / product.unitsPerPackage
                  ),
              confirmedPackages: orderProductData.confirmedPackages || 0,
              confirmedQuantity: orderProductData.confirmedQuantity || 0,
              requestedQuantity:
                orderProductData.requestedQuantity ||
                orderProductData.quantity ||
                0,
              order: order.id,
              unit: product.unit,
              name: product.name,
              price: orderProductData.price,
            },
            populate: ["product", "items", "movements"],
            ...(data.trx ? { transacting: data.trx } : {})
          }
        );
      } catch (error) {
        throw error;
      }
    }),
    // Actualiza el OrderProduct
    update: withValidation(UpdateOrderProductSchema, async (data) => {
      try {
        // Obtención de variables
        const { id, orderState } = data;
        const { items, ...dataToUpdate } = data.update;
        // Obtención del OrderProduct a modificar
        const currentOrderProduct = await strapi.entityService.findOne(
          ORDER_PRODUCT_SERVICE,
          id,
          {
            populate: ["items"],
            ...(data.trx ? { transacting: data.trx } : {})
          }
        );
        // Cantidades a modificar
        let quantities = {};
        // Modificación de cantidades según los Items del OrderProduct
        if (!items) {
          // Si no vienen los Items, entonces modificamos con las cantidades del OrderProduct con sus Items asociados
          quantities = currentOrderProduct.items.reduce(
            (acc, item) => {
              if (orderState === ORDER_STATES.COMPLETED) {
                acc.deliveredQuantity += item.currentQuantity;
                acc.deliveredPackages += 1;
                dataToUpdate.state = ORDER_PRODUCT_STATES.COMPLETED;
              }
              acc.confirmedQuantity += item.currentQuantity;
              acc.confirmedPackages += 1;
              return acc;
            },
            {
              confirmedQuantity: 0,
              confirmedPackages: 0,
              deliveredQuantity: 0,
              deliveredPackages: 0,
            }
          );
        } else if (items.length > 0) {
          // Si vienen los Items y no están vacíos, entonces modificamos las cantidades del OrderProduct con estos
          quantities = items.reduce(
            (acc, item) => {
              if (orderState === ORDER_STATES.COMPLETED) {
                acc.deliveredQuantity += item.currentQuantity;
                acc.deliveredPackages += 1;
              }
              acc.confirmedQuantity += item.currentQuantity;
              acc.confirmedPackages += 1;
              return acc;
            },
            {
              confirmedQuantity: 0,
              confirmedPackages: 0,
              deliveredQuantity: 0,
              deliveredPackages: 0,
            }
          );
        }
        // Actualizamos y retornamos el OrderProduct
        return await strapi.entityService.update(
          ORDER_PRODUCT_SERVICE,
          currentOrderProduct.id,
          {
            data: {
              ...dataToUpdate,
              ...quantities,
            },
            populate: data.populate,
            ...(data.trx ? { transacting: data.trx } : {})
          }
        );
      } catch (error) {
        throw error;
      }
    }),
    // Elimina el OrderProduct
    delete: withValidation(DeleteOrderProductSchema, async (data) => {
      try {
        // Eliminamos el Item
        await strapi.entityService.delete(
          ORDER_PRODUCT_SERVICE,
          data.id,
          data.trx ? { transacting: data.trx } : {}
        );
        // Retornamos respuesta
        return { orderProduct: data.id, state: "Deleted" };
      } catch (error) {
        throw error;
      }
    }),
  })
);
