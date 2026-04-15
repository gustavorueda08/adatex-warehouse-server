"use strict";
const moment = require("moment-timezone");
const ORDER_TYPES = require("../../../utils/orderTypes");
const runInBatches = require("../../../utils/runInBatches");
const ORDER_STATES = require("../../../utils/orderStates");
const ITEM_STATES = require("../../../utils/itemStates");
const ITEM_MOVEMENT_TYPES = require("../../../utils/itemMovementTypes");
const logger = require("../../../utils/logger");

const WAREHOUSE_TYPES = require("../../../utils/warehouseTypes");
const {
  ORDER_PRODUCT_SERVICE,
  ITEM_SERVICE,
  PRODUCT_SERVICE,
  ORDER_SERVICE,
  CUSTOMER_SERVICE,
  WAREHOUSE_SERVICE,
} = require("../../../utils/services");

const { withValidation } = require("../../../validation/withValidation");
const {
  CreateOrderSchema,
  UpdateOrderSchema,
  DeleteOrderSchema,
  DoItemMovementSchema,
  AddItemToOrderSchema,
  RemoveItemFromOrderSchema,
} = require("../../../validation/schemas");

const {
  validateOrderIsEditable,
  generateOrderNumber,
  updateOrderProducts,
  updateExistingOrderProducts,
  syncOrderProducts,
  fastUnreserveSaleItem,
  bulkReserveSaleItems,
  bulkUnreserveFixedQtyItems,
  ORDER_POPULATE,
  ORDER_POPULATE_BASIC,
} = require("../utils/orderHelpers");

const {
  ItemMovementStrategyFactory,
} = require("../strategies/itemMovementStrategies");

const {
  validatePartialInvoiceOrder,
} = require("../utils/invoiceHelpers");

const COP_FMT = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

/**
 * Determina si una factura de Siigo está vencida aplicando la regla de plazo global:
 *
 *   días_efectivos = max(plazo_global_cliente, días_propios_de_la_factura)
 *
 * "días_propios_de_la_factura" se deriva de (due_date − date). Si la factura
 * tiene un plazo propio MAYOR al global, se usa el propio (favor del cliente).
 * Si el plazo propio es MENOR, prevalece el global.
 *
 * Si la factura no trae 'date', se cae en el due_date de Siigo como respaldo.
 *
 * @param {object} inv  Factura de Siigo { date?, due_date?, balance }
 * @param {number} globalPaymentTerms  Plazo global del cliente en días.
 * @returns {boolean}
 */
function isInvoiceOverdue(inv, globalPaymentTerms) {
  const todayMs = Date.now();

  if (!inv.date) {
    // Sin fecha de emisión: usar due_date de Siigo directamente
    return inv.due_date ? new Date(inv.due_date).getTime() < todayMs : false;
  }

  const invoiceDateMs = new Date(inv.date).getTime();
  const siigoDueDateMs = inv.due_date ? new Date(inv.due_date).getTime() : 0;

  // Plazo propio de la factura (días entre emisión y vencimiento en Siigo)
  const invoiceSpecificDays =
    siigoDueDateMs > invoiceDateMs
      ? Math.round((siigoDueDateMs - invoiceDateMs) / 86400000)
      : 0;

  // El plazo efectivo es el mayor: global del cliente o el propio de la factura
  const effectiveDays = Math.max(globalPaymentTerms || 0, invoiceSpecificDays);

  return todayMs > invoiceDateMs + effectiveDays * 86400000;
}

/**
 * Verifica si un cliente tiene el cupo bloqueado antes de confirmar o despachar.
 *
 * Reglas:
 *  1. isBlocked = true  → siempre bloqueado (sin llamar a Siigo).
 *  2. creditLimit = 0   → cliente de contado; nunca se bloquea.
 *  3. creditLimit > 0   → verificar en Siigo:
 *       a. Facturas vencidas según plazo GLOBAL del cliente (ver isInvoiceOverdue).
 *       b. (saldo_pendiente + orderValue) > creditLimit → bloquear.
 *  4. Si Siigo no responde → advertencia en log y se permite la operación
 *     (las fallas técnicas de Siigo no deben detener el negocio).
 *
 * @param {object} strapi
 * @param {number} customerId
 * @param {object} [opts]
 * @param {number} [opts.orderValue=0]  Valor de la orden en curso (para el chequeo en despacho).
 * @returns {Promise<{ blocked: boolean, reason?: string }>}
 */
async function checkCustomerCreditBlock(strapi, customerId, { orderValue = 0 } = {}) {
  const customer = await strapi.entityService.findOne(CUSTOMER_SERVICE, customerId, {
    fields: ["id", "name", "creditLimit", "identification", "isBlocked", "paymentTerms"],
  });

  if (!customer) {
    return { blocked: true, reason: "Cliente no encontrado." };
  }

  // Bloqueo manual — prioridad máxima, sin consulta a Siigo
  if (customer.isBlocked) {
    return {
      blocked: true,
      reason: `El cliente "${customer.name}" está bloqueado. Contacte el área de cartera.`,
    };
  }

  // creditLimit = 0 → cliente de contado, nunca se bloquea
  if (!customer.creditLimit || customer.creditLimit <= 0) {
    return { blocked: false };
  }

  // Cliente con cupo asignado: verificar cartera en Siigo
  try {
    const arService = strapi.service("api::siigo.accounts-receivable");
    const ar = await arService.getCustomerAccountsReceivable(customer.identification);

    const globalPaymentTerms = customer.paymentTerms || 0;

    // a) Facturas vencidas según plazo global del cliente
    const overdueInvoices = (ar.invoices || []).filter((inv) =>
      isInvoiceOverdue(inv, globalPaymentTerms),
    );

    if (overdueInvoices.length > 0) {
      const totalOverdue = overdueInvoices.reduce((sum, inv) => sum + (inv.balance || 0), 0);
      return {
        blocked: true,
        reason: `El cliente tiene ${overdueInvoices.length} factura(s) vencida(s) por ${COP_FMT.format(totalOverdue)}. Regularice la cartera para continuar.`,
      };
    }

    // b) Saldo actual + valor de la orden actual vs cupo
    const pendingBalance = ar.balance?.saldo_final || 0;
    const effectiveBalance = pendingBalance + orderValue;

    if (effectiveBalance > customer.creditLimit) {
      const detail =
        orderValue > 0
          ? `Saldo actual ${COP_FMT.format(pendingBalance)} + esta orden ${COP_FMT.format(orderValue)} = ${COP_FMT.format(effectiveBalance)} / Cupo: ${COP_FMT.format(customer.creditLimit)}.`
          : `Saldo pendiente: ${COP_FMT.format(pendingBalance)} / Cupo: ${COP_FMT.format(customer.creditLimit)}.`;
      return {
        blocked: true,
        reason: `El cliente superó su cupo de crédito. ${detail}`,
      };
    }

    return { blocked: false };
  } catch (err) {
    logger.warn(
      `No se pudo verificar cupo en Siigo para cliente ${customerId}: ${err.message}`,
    );
    return { blocked: false };
  }
}

/**
 * Order service - Versión optimizada y refactorizada
 */
const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::order.order", ({ strapi }) => ({
  /**
   * Crea un Order, OrderProducts y asocia o crea Items al OrderProduct y al Order
   */
  create: withValidation(CreateOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        moment.tz.setDefault("America/Bogota");

        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const code = await generateOrderNumber(strapi, data.type, trx);
        const { products = [], ...orderData } = data;

        // Validaciones especiales para partial-invoice
        if (data.type === ORDER_TYPES.PARTIAL_INVOICE) {
          const validation = await validatePartialInvoiceOrder(data, { trx });

          if (!validation.valid) {
            throw new Error(
              `Orden partial-invoice inválida:\n- ${validation.errors.join("\n- ")}`,
            );
          }

          // Usar el customer de la orden padre si no se especifica
          if (!orderData.customer && validation.parentOrder?.customer) {
            orderData.customer = validation.parentOrder.customer.id;
          }

          // Usar customerForInvoice de la orden padre si no se especifica
          if (
            !orderData.customerForInvoice &&
            validation.parentOrder?.customerForInvoice
          ) {
            orderData.customerForInvoice =
              validation.parentOrder.customerForInvoice.id;
          }
        }

        // Verificación de cupo al crear una venta directamente como confirmada
        if (
          data.type === ORDER_TYPES.SALE &&
          data.customer &&
          data.state === ORDER_STATES.CONFIRMED
        ) {
          const creditCheck = await checkCustomerCreditBlock(strapi, data.customer);
          if (creditCheck.blocked) {
            throw new Error(`CREDIT_BLOCK:${creditCheck.reason}`);
          }
        }

        // Creación del Order
        let order = await strapi.entityService.create(ORDER_SERVICE, {
          data: {
            ...orderData,
            code,
            state: orderData.state || ORDER_STATES.DRAFT,
            createdDate: moment().toDate(),
          },
          populate: ORDER_POPULATE_BASIC,
          transacting: trx,
        });

        // Si hay products, crear OrderProducts e Items
        if (products.length > 0) {
          await runInBatches(
            products,
            async ({ items = [], ...productData }) => {
              // Creación del OrderProduct
              const orderProduct = await orderProductService.create({
                ...productData,
                order: order.id,
                trx,
              });

              const { product } = orderProduct;

              // Procesar Items
              if (items.length > 0) {
                await runInBatches(
                  items,
                  (item) =>
                    strapi.service(ORDER_SERVICE).doItemMovement({
                      movementType: ITEM_MOVEMENT_TYPES.CREATE,
                      item,
                      order,
                      orderProduct,
                      product,
                      orderState: order.state,
                      trx,
                    }),
                  5,
                );
              }

              // Actualización del OrderProduct con cantidades finales
              await orderProductService.update({
                id: orderProduct.id,
                orderState: order.state,
                trx,
              });
            },
          );

          // Obtención del Order totalmente actualizado con todos los populates
          const updatedOrder = await strapi.entityService.findOne(
            ORDER_SERVICE,
            order.id,
            { populate: ORDER_POPULATE, transacting: trx },
          );

          // Emitir evento WebSocket
          strapi.io
            ?.to(`order:${updatedOrder.id}`)
            .emit("order:created", updatedOrder);

          logger.info(`Order created successfully`, {
            orderId: updatedOrder.id,
            code,
          });

          return updatedOrder;
        }

        return order;
      } catch (error) {
        logger.error("Error creating order", error);
        throw error;
      }
    });
  }),

  /**
   * Actualiza un Order y crea, modifica o asocia OrderProducts y Items
   */
  update: withValidation(UpdateOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const { id, products = [], update = {} } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);

        // Obtención de la orden actual con todos los datos necesarios
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: {
              orderProducts: {
                populate: {
                  product: true,
                  // items omitted: loaded per-product via Knex in updateOrderProducts
                  // to avoid WHERE id IN (100k IDs) crash with large fixedQty orders
                },
              },
              destinationWarehouse: true,
              sourceWarehouse: true,
              customer: true,
            },
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden a actualizar no existe");
        }

        // Validar que la orden pueda ser editada
        validateOrderIsEditable(currentOrder);

        // Verificación de cupo al confirmar una orden de venta (DRAFT → CONFIRMED)
        if (
          update?.state === ORDER_STATES.CONFIRMED &&
          currentOrder.state === ORDER_STATES.DRAFT &&
          currentOrder.type === ORDER_TYPES.SALE &&
          currentOrder.customer?.id &&
          !currentOrder.creditBlockOverridden
        ) {
          const creditCheck = await checkCustomerCreditBlock(strapi, currentOrder.customer.id);
          if (creditCheck.blocked) {
            throw new Error(`CREDIT_BLOCK:${creditCheck.reason}`);
          }
        }

        // Verificación de cupo al despachar una orden de venta (→ COMPLETED)
        // addItem / removeItem no pasan por aquí, así que nunca se bloquean.
        if (
          update?.state === ORDER_STATES.COMPLETED &&
          currentOrder.state !== ORDER_STATES.COMPLETED &&
          currentOrder.type === ORDER_TYPES.SALE &&
          currentOrder.customer?.id &&
          !currentOrder.creditBlockOverridden
        ) {
          const orderValue = (currentOrder.orderProducts || []).reduce((sum, op) => {
            return sum + (parseFloat(op.price) || 0) * (parseFloat(op.confirmedQuantity) || 0);
          }, 0);
          const creditCheck = await checkCustomerCreditBlock(strapi, currentOrder.customer.id, {
            orderValue,
          });
          if (creditCheck.blocked) {
            throw new Error(`CREDIT_BLOCK:${creditCheck.reason}`);
          }
        }

        // Obtener el nuevo estado del Order si llega, o tomar el estado actual
        const orderState = update?.state || currentOrder.state;

        // Si vienen productos para actualizar (incluso array vacío)
        if (data.products) {
          await updateOrderProducts(
            strapi,
            currentOrder,
            products,
            orderState,
            orderProductService,
            trx,
            update.destinationWarehouse,
          );
        }

        // Sincronizar OrderProducts (actualizar y eliminar huérfanos)
        if (data.products) {
          await syncOrderProducts(
            strapi,
            currentOrder.id,
            products,
            orderState,
            orderProductService,
            trx,
          );
        }

        // Si el estado de la orden cambió, pero no se enviaron productos
        // Asegurar que los items existentes se actualicen (ej. para recibir destinationWarehouse)
        if (!data.products && currentOrder.state !== orderState) {
          await updateExistingOrderProducts(
            strapi,
            currentOrder,
            orderState,
            trx,
            update.destinationWarehouse,
          );
        }

        // Lógica para asociar facturas manuales (universal para sale y partial-invoice)
        // Se espera: manualInvoiceNumbers: ["123", "195"]
        if (
          update.manualInvoiceNumbers &&
          Array.isArray(update.manualInvoiceNumbers)
        ) {
          const siigoService = strapi.service("api::siigo.invoice");
          const foundInvoicesIds = [];

          for (const numStr of update.manualInvoiceNumbers) {
            const num = parseInt(numStr, 10);
            if (isNaN(num)) continue;

            try {
              const results = await siigoService.getInvoicesByNumber(num);
              // Results puede ser un array con coincidencias.
              // Siigo puede retornar varias si hay distintos prefijos con mismo número?
              // Por ahora tomamos el primero que coincida o todos.

              if (results && results.length > 0) {
                for (const invData of results) {
                  // Solo si coincide el número exactamente (por si la búsqueda fue laxa)
                  if (invData.number === num) {
                    const localInvoice =
                      await siigoService.syncLocalInvoice(invData);
                    foundInvoicesIds.push(localInvoice.id);
                  }
                }
              } else {
                logger.warn(
                  `No se encontró factura con número ${num} en Siigo`,
                );
              }
            } catch (err) {
              logger.warn(
                `Error buscando factura manual ${num}: ${err.message}`,
              );
            }
          }

          if (foundInvoicesIds.length > 0) {
            // Asociar a la orden vía 'invoices' relation
            // OJO: Queremos AGREGAR, no reemplazar? O reemplazar?
            // Usualmente si mando una lista, espero que esa sea LA lista.
            // Pero cuidado con no borrar historial si se edita.
            // Asumiremos que el frontend manda la lista acumulada o se reemplaza.
            // Para seguridad, hacemos merge con los que ya tenga?
            // Mejor reemplazar para permitir correcciones (quitar una factura erronea).

            update.invoices = foundInvoicesIds;

            // Si la orden NO tiene siigoId antiguo, le ponemos el de la primera factura para retrocompatibilidad visual
            // (aunque ya no deberíamos depender de eso, pero el frontend puede usarlo)
            const firstInv = await strapi.entityService.findOne(
              "api::invoice.invoice",
              foundInvoicesIds[0],
            );
            if (firstInv) {
              if (!update.invoiceNumber) update.invoiceNumber = firstInv.number;
              if (!update.siigoId) update.siigoId = firstInv.siigoId; // Deprecated field
            }
          }
        }

        // Lógica antigua de siigoId single para retrocompatibilidad (si frontend manda siigoId en vez de manualInvoiceNumbers)
        if (
          !update.manualInvoiceNumbers &&
          currentOrder.type === ORDER_TYPES.PARTIAL_INVOICE &&
          (update.siigoId || update.siigoIdTypeA)
        ) {
          const siigoId = update.siigoIdTypeA || update.siigoId;
          // ... (lógica existente que busca por ID y actualiza campos antiguos) ...
          // Podríamos aprovechar para crear el Invoice entity también aquí
          try {
            const siigoService = strapi.service("api::siigo.invoice");
            const invoiceData = await siigoService.getInvoice(siigoId);
            if (invoiceData) {
              const localInvoice =
                await siigoService.syncLocalInvoice(invoiceData);
              update.invoices = [localInvoice.id]; // Asociar nueva entidad

              // Retrocompatibilidad campos planos
              update.invoiceNumber = invoiceData.number;
              update.invoiceNumberTypeA = invoiceData.number;
              if (!update.actualDepositPaymentDate) {
                update.actualDepositPaymentDate = invoiceData.date;
              }
            }
          } catch (e) {
            /* ignore */
          }
        }

        // Actualizar y retornar la orden completa
        const updatedOrder = await strapi.entityService.update(
          ORDER_SERVICE,
          currentOrder.id,
          {
            data: update,
            populate: ORDER_POPULATE,
            transacting: trx,
          },
        );

        // Emitir evento WebSocket
        strapi.io
          ?.to(`order:${updatedOrder.id}`)
          .emit("order:updated", updatedOrder);

        logger.info(`Order updated successfully`, { orderId: updatedOrder.id });

        return updatedOrder;
      } catch (error) {
        logger.error("Error updating order", error);
        throw error;
      }
    });
  }),

  /**
   * Elimina un Order y sus OrderProducts, sólo en caso de que su estado sea borrador o confirmado
   */
  delete: withValidation(DeleteOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const { id } = data;
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const knexTrx = trx?.trx ?? trx ?? strapi.db.connection;

        // Load order WITHOUT items — avoids ORM crash for large fixedQty orders
        // (ORM would generate WHERE id IN (45000 values) exceeding SQLite variable limit)
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.product",
              "sourceWarehouse",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden a eliminar no existe");
        }

        // Validar que la orden pueda ser eliminada
        validateOrderIsEditable(currentOrder);

        const isSaleOrOut =
          currentOrder.type === ORDER_TYPES.SALE ||
          currentOrder.type === ORDER_TYPES.OUT;

        // Eliminación de OrderProducts y sus Items
        await runInBatches(currentOrder.orderProducts, async (orderProduct) => {
          const productType =
            orderProduct.product?.type ?? "variableQuantityPerItem";

          if (productType === "fixedQuantityPerItem" && isSaleOrOut) {
            // Bulk unreserve via subquery — no ID loading needed, handles 100k+ items
            // RESERVED → AVAILABLE + unlinks from order and orderProduct
            await bulkUnreserveFixedQtyItems(strapi, {
              orderProduct,
              currentOrder,
              trx,
            });
          } else if (productType === "cutItem") {
            // cutItem DELETE needs parentItem + movements to restore the source item.
            // Item counts are always small — safe to load via ORM.
            const opWithItems = await strapi.entityService.findOne(
              ORDER_PRODUCT_SERVICE,
              orderProduct.id,
              {
                populate: ["items", "items.movements", "items.parentItem"],
                transacting: trx,
              },
            );
            await runInBatches(
              opWithItems?.items ?? [],
              (item) =>
                strapi.service(ORDER_SERVICE).doItemMovement({
                  movementType: ITEM_MOVEMENT_TYPES.DELETE,
                  item,
                  order: currentOrder,
                  orderProduct,
                  product: orderProduct.product,
                  trx,
                }),
              1,
            );
          } else {
            // variableQty or fixedQty for non-sale/out types.
            // Load item IDs per orderProduct via Knex to stay within SQLite variable limits.
            const itemLinks = await knexTrx("items_order_products_lnk")
              .where("order_product_id", orderProduct.id)
              .select("item_id");
            const itemIds = itemLinks.map((r) => r.item_id);

            if (itemIds.length > 0) {
              const CHUNK = 500;
              for (let c = 0; c < itemIds.length; c += CHUNK) {
                const chunkIds = itemIds.slice(c, c + CHUNK);
                const items = await knexTrx("items")
                  .whereIn("id", chunkIds)
                  .select("id", "state", "document_id");
                await runInBatches(
                  items,
                  (item) =>
                    strapi.service(ORDER_SERVICE).doItemMovement({
                      movementType: ITEM_MOVEMENT_TYPES.DELETE,
                      item,
                      order: currentOrder,
                      orderProduct,
                      product: orderProduct.product,
                      trx,
                    }),
                  1,
                );
              }
            }
          }

          // Eliminar OrderProduct
          await orderProductService.delete({ id: orderProduct.id, trx });
        });

        // Eliminación del Order
        await strapi.entityService.delete(ORDER_SERVICE, currentOrder.id, {
          transacting: trx,
        });

        // Emitir evento WebSocket
        strapi.io
          ?.to(`order:${currentOrder.id}`)
          .emit("order:deleted", currentOrder.id);

        logger.info(`Order deleted successfully`, { orderId: currentOrder.id });

        return {
          order: currentOrder.id,
          state: "Deleted",
        };
      } catch (error) {
        logger.error("Error deleting order", error);
        throw error;
      }
    });
  }),

  /**
   * Realiza el movimiento del Item usando patrón Strategy
   */
  doItemMovement: withValidation(DoItemMovementSchema, async (data) => {
    try {
      const {
        movementType,
        item: itemData,
        order,
        orderProduct,
        product,
        trx,
        orderState,
      } = data;

      const itemService = strapi.service(ITEM_SERVICE);
      const { type: orderType } = order;
      const { parentItem, movements, ...item } = itemData;

      // Obtener la estrategia correcta según el tipo de orden
      const strategy = ItemMovementStrategyFactory.getStrategy(
        orderType,
        itemService,
      );

      // Ejecutar la operación correspondiente
      let result;

      switch (movementType) {
        case ITEM_MOVEMENT_TYPES.CREATE:
          result = await strategy.create({
            item,
            order,
            orderProduct,
            product,
            orderType,
            parentItem,
            trx,
          });
          break;

        case ITEM_MOVEMENT_TYPES.UPDATE:
          result = await strategy.update({
            item,
            order,
            orderProduct,
            product,
            orderState,
            orderType,
            trx,
          });
          break;

        case ITEM_MOVEMENT_TYPES.DELETE:
          if (product?.type === "cutItem") {
            // Los cutItems se eliminan siempre con la lógica de Transform
            // (necesitan restaurar el item fuente del que fueron cortados)
            const transformStrategy = ItemMovementStrategyFactory.getStrategy(
              ORDER_TYPES.TRANSFORM,
              itemService,
            );
            result = await transformStrategy.delete({
              item,
              order,
              orderProduct,
              orderType: ORDER_TYPES.TRANSFORM,
              parentItem,
              movements,
              trx,
            });
          } else {
            result = await strategy.delete({
              item,
              order,
              orderProduct,
              orderType,
              parentItem,
              movements,
              trx,
            });
          }
          break;

        default:
          throw new Error(`Invalid movement type: ${movementType}`);
      }

      return result;
    } catch (error) {
      logger.error("Error in doItemMovement", error);
      throw error;
    }
  }),

  /**
   * Agrega un Item al Order
   */
  addItem: withValidation(AddItemToOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item, product: productId } = data;

        // Obtención del Order actual (sin precios de cliente — se cargan lazy solo
        // si necesitamos crear un nuevo OrderProduct para este producto)
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: [
              "orderProducts",
              "orderProducts.product",
              "sourceWarehouse",
              "destinationWarehouse",
              "customerForInvoice",
              "customer",
            ],
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden no existe");
        }

        validateOrderIsEditable(currentOrder);

        // Guard: items from a zona franca warehouse cannot be added to sale orders.
        // They must first be nationalized to a regular stock warehouse.
        if (currentOrder.type === ORDER_TYPES.SALE) {
          const FTZ_ERROR =
            "No se pueden agregar items de una bodega zona franca a una orden de venta. " +
            "Primero debe nacionalizar la mercancía.";

          // Verificar por ID de bodega explícito (búsqueda por quantity+product)
          const itemWarehouseId = item?.warehouse || currentOrder.sourceWarehouse?.id;
          if (itemWarehouseId) {
            const wh = await strapi.entityService.findOne(WAREHOUSE_SERVICE, itemWarehouseId, {
              transacting: trx,
            });
            if (wh?.type === WAREHOUSE_TYPES.FREE_TRADE_ZONE) throw new Error(FTZ_ERROR);
          }

          // Verificar por ID de item (búsqueda directa por id/barcode)
          if (item?.id) {
            const existingItem = await strapi.entityService.findOne(ITEM_SERVICE, item.id, {
              populate: ["warehouse"],
              transacting: trx,
            });
            if (existingItem?.warehouse?.type === WAREHOUSE_TYPES.FREE_TRADE_ZONE) throw new Error(FTZ_ERROR);
          }
        }

        // Auto-transition DRAFT → CONFIRMED when items are added, regardless of order type.
        // addItem represents user intent to start filling the order.
        if (currentOrder.state === ORDER_STATES.DRAFT) {
          currentOrder.state = ORDER_STATES.CONFIRMED;
          await strapi.entityService.update(ORDER_SERVICE, currentOrder.id, {
            data: { state: currentOrder.state },
            transacting: trx,
          });
        }

        let orderProductData = currentOrder.orderProducts.find(
          (op) => op.product.id === productId,
        );

        // Lazy-load precios del cliente: solo necesarios al crear un OrderProduct nuevo
        // (primera vez que se agrega este producto a la orden). En el caso común
        // (producto ya listado) esta consulta se omite completamente.
        if (!orderProductData) {
          const customerToEnrich = currentOrder.customerForInvoice || currentOrder.customer;
          if (customerToEnrich?.id) {
            const enriched = await strapi.entityService.findOne(
              CUSTOMER_SERVICE,
              customerToEnrich.id,
              { populate: ["prices", "prices.product"], transacting: trx },
            );
            if (enriched) {
              if (currentOrder.customerForInvoice?.id === customerToEnrich.id) {
                currentOrder.customerForInvoice = enriched;
              } else {
                currentOrder.customer = enriched;
              }
            }
          }
        }

        // Siempre obtener el producto completo para tener las relaciones necesarias (parentProduct, transformationFactor)
        const product = await strapi.entityService.findOne(
          PRODUCT_SERVICE,
          productId,
          {
            populate: ["parentProduct", "transformationFactor"],
            transacting: trx,
          },
        );

        if (!product) {
          throw new Error("El producto no existe");
        }

        let orderProduct;
        if (!orderProductData) {
          let price = 0;
          let ivaIncluded = false;
          let invoicePercentage = 100;

          const customerToUse =
            currentOrder.customer || currentOrder.customerForInvoice;
          if (customerToUse && customerToUse.prices) {
            const specificPrice = customerToUse.prices.find((p) => {
              const pId = p.product?.id || p.product;
              return String(pId) === String(product.id);
            });

            if (specificPrice) {
              price =
                specificPrice.unitPrice !== undefined
                  ? specificPrice.unitPrice
                  : 0;
              if (specificPrice.ivaIncluded !== undefined) {
                ivaIncluded = specificPrice.ivaIncluded;
              }
              if (
                specificPrice.invoicePercentage !== undefined &&
                specificPrice.invoicePercentage !== null
              ) {
                invoicePercentage = specificPrice.invoicePercentage;
              }
            }
          }

          // Crear OrderProduct
          orderProduct = await orderProductService.create({
            product: product.id,
            order: currentOrder.id,
            requestedQuantity: 0,
            requestedPackages: 0,
            notes: "Producto agregado dinámicamente",
            price,
            ivaIncluded,
            invoicePercentage,
            trx,
          });
        } else {
          orderProduct = orderProductData;
        }

        let addedItemsList = [];

        if (product.type === "service") {
          // Service items have no physical tracking. We do not do a DB Item lookup nor movement.
          // They simply serve to attach to an OrderProduct.
          const pseudoServiceItem = {
            id: `service-${Date.now()}`,
            currentQuantity: item.count || item.quantity || 1,
            isService: true,
          };
          // Push a lightweight pseudo-object so the frontend gets an immediate sync hook via websockets
          addedItemsList.push(pseudoServiceItem);
        } else if (
          product.type === "fixedQuantityPerItem" &&
          item.count !== undefined
        ) {
          const resolveWarehouse = () => {
            return item.warehouse || currentOrder.sourceWarehouse?.id || null;
          };

          let filters = {
            product: product.id,
            state: ITEM_STATES.AVAILABLE,
          };
          const whId = resolveWarehouse();
          if (whId) filters.warehouse = whId;

          const availableItems = await strapi.entityService.findMany(
            ITEM_SERVICE,
            {
              filters,
              limit: item.count,
              transacting: trx,
            },
          );

          if (availableItems.length < item.count) {
            throw new Error(
              `No hay suficientes items disponibles para ${product.name}. Solicitados: ${item.count}, Disponibles: ${availableItems.length}`,
            );
          }

          // replace: true → unreserve all existing items first, then re-reserve with new count.
          // Allows "set quantity" UX: user types a number and the reservation is replaced atomically.
          if (item.replace) {
            await bulkUnreserveFixedQtyItems(strapi, { orderProduct, currentOrder, trx });
          }

          await bulkReserveSaleItems(strapi, {
            items: availableItems,
            currentOrder,
            orderProduct,
            trx,
          });

          await orderProductService.update({
            id: orderProduct.id,
            orderState: currentOrder.state,
            trx,
          });

          strapi.io
            ?.to(`order:${currentOrder.id}`)
            .emit("order:item-added", {
              bulkCount: availableItems.length,
              product: product.id,
              orderProductId: orderProduct.id,
            });

          logger.debug(`Bulk items reserved for sale order`, {
            orderId: currentOrder.id,
            count: availableItems.length,
            product: product.id,
          });

          return { count: availableItems.length, product: product.id };
        } else if (
          product.type === "cutItem" &&
          (item.quantity !== undefined || item.quantities !== undefined)
        ) {
          const quantities = Array.isArray(item.quantities)
            ? item.quantities
            : [item.quantity];

          if (!product.parentProduct) {
            throw new Error(
              `El producto ${product.name} es type cutItem pero no tiene parentProduct configurado.`,
            );
          }

          let factor = 1;
          let multiplySource = false;
          if (product.transformationFactor) {
            factor = parseFloat(product.transformationFactor.factor) || 1;
            // If the transformation rule is defined as: Child Unit -> Parent Unit
            // Example: 1 meter (cut) = 0.5 kg (parent). Factor = 0.5
            // Target is 10 meters. Consumed = 10 * 0.5 = 5kg.
            if (
              product.transformationFactor.sourceUnit === product.unit &&
              product.transformationFactor.destinationUnit ===
                product.parentProduct.unit
            ) {
              multiplySource = true;
            }
            // Otherwise, assume rule is Parent Unit -> Child Unit
            // Example: 1 kg (parent) = 2 meters (cut). Factor = 2
            // Target is 10 meters. Consumed = 10 / 2 = 5kg.
            else {
              multiplySource = false;
            }
          }

          let cutWarehouseFilter = { $in: ["smartCut", "printlab"] };
          if (product.cutWarehouseType === "smartCut") {
            cutWarehouseFilter = { $in: ["smartCut"] };
          } else if (product.cutWarehouseType === "printlab") {
            cutWarehouseFilter = { $in: ["printlab"] };
          }

          const smartCutWarehouses = await strapi.entityService.findMany(
            WAREHOUSE_SERVICE,
            {
              filters: {
                type: cutWarehouseFilter,
                isActive: true,
              },
              transacting: trx,
            },
          );

          if (smartCutWarehouses.length === 0) {
            throw new Error(
              `No hay bodegas configuradas como ${product.cutWarehouseType || "smartCut o printlab"}`,
            );
          }
          const smartCutWhIds = smartCutWarehouses.map((w) => w.id);

          for (const targetQty of quantities) {
            let sourceQuantityConsumed = parseFloat(targetQty);
            if (factor !== 1) {
              sourceQuantityConsumed = multiplySource
                ? sourceQuantityConsumed * factor
                : sourceQuantityConsumed / factor;
            }

            // Fetch enough available parent items to potentially fulfill the request
            const availableParentItems = await strapi.entityService.findMany(
              ITEM_SERVICE,
              {
                filters: {
                  product: product.parentProduct.id,
                  state: ITEM_STATES.AVAILABLE,
                  warehouse: { $in: smartCutWhIds },
                },
                sort: { currentQuantity: "desc" },
                limit: 50, // Fetch up to 50 parent rolls to ensure we have enough
                populate: ["warehouse", "product"],
                transacting: trx,
              },
            );

            if (availableParentItems.length === 0) {
              throw new Error(
                `No hay items de ${product.parentProduct.name} disponibles en bodegas ${product.cutWarehouseType || "smartCut o printlab"} para cortar.`,
              );
            }

            let remainingSourceQty = sourceQuantityConsumed;
            let parentItemIndex = 0;
            const sourceItemsConsumedMap = [];

            while (remainingSourceQty > 0) {
              const sourceItem = availableParentItems[parentItemIndex];

              if (!sourceItem) {
                // We ran out of available items. Apply negative stock to the last known item if confirmed
                const lastSourceItem =
                  availableParentItems[availableParentItems.length - 1];
                if (!item.confirmNegativeStock && !item.forceNegativeStock) {
                  throw new Error(
                    JSON.stringify({
                      code: "NEGATIVE_STOCK",
                      message: `No hay suficiente stock en los rollos disponibles. Faltan ${remainingSourceQty} ${lastSourceItem.unit}. ¿Desea forzar el corte negativo en el último rollo disponible?`,
                    }),
                  );
                }

                // If confirmed, just dump the rest of the negative debt onto the last item
                sourceItemsConsumedMap.push({
                  id: lastSourceItem.id,
                  quantity: remainingSourceQty,
                });

                // Force break the loop as we handled the remainder
                remainingSourceQty = 0;
                break;
              }

              const consumedFromThisItem = Math.min(
                sourceItem.currentQuantity,
                remainingSourceQty,
              );

              // If this item is empty (e.g., 0 quantity), skip it
              if (consumedFromThisItem <= 0) {
                parentItemIndex++;
                continue;
              }

              sourceItemsConsumedMap.push({
                id: sourceItem.id,
                quantity: consumedFromThisItem,
              });

              remainingSourceQty -= consumedFromThisItem;

              // Proceed to next parent item if we still need more
              parentItemIndex++;
            }

            // Create ONE cutItem for the entire requested targetQty, mapping the multiple consumed sources
            const transformStrategy = ItemMovementStrategyFactory.getStrategy(
              ORDER_TYPES.TRANSFORM,
              strapi.service(ITEM_SERVICE),
            );

            const newCutItem = await transformStrategy.create({
              item: {
                sourceItemsConsumed: sourceItemsConsumedMap,
                sourceQuantityConsumed: sourceQuantityConsumed,
                targetQuantity: targetQty,
                warehouse: item.warehouse || currentOrder.sourceWarehouse?.id,
                confirmNegativeStock: item.confirmNegativeStock,
                forceNegativeStock: item.forceNegativeStock,
              },
              order: currentOrder,
              orderProduct: orderProduct,
              trx,
              orderType: ORDER_TYPES.TRANSFORM,
              product: product,
              parentItem: null,
            });

            const addedItem = await strapi
              .service(ORDER_SERVICE)
              .doItemMovement({
                movementType: ITEM_MOVEMENT_TYPES.CREATE,
                item: newCutItem,
                order: currentOrder,
                orderProduct,
                product,
                orderState: currentOrder.state,
                trx,
              });

            addedItemsList.push(addedItem);
          }
        } else {
          const addedItem = await strapi.service(ORDER_SERVICE).doItemMovement({
            movementType: ITEM_MOVEMENT_TYPES.CREATE,
            item,
            order: currentOrder,
            orderProduct,
            product,
            orderState: currentOrder.state,
            trx,
          });
          addedItemsList.push(addedItem);
        }

        // Actualizar el OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });

        // Emitir evento WebSocket
        for (const addedItem of addedItemsList) {
          strapi.io
            ?.to(`order:${currentOrder.id}`)
            .emit("order:item-added", { ...addedItem, product });

          logger.debug(`Item added to order`, {
            orderId: currentOrder.id,
            itemId: addedItem?.id,
          });
        }

        return addedItemsList.length === 1
          ? { ...addedItemsList[0], product: product.id }
          : addedItemsList.map((i) => ({ ...i, product: product.id }));
      } catch (error) {
        logger.error("Error adding item to order", error);
        throw error;
      }
    });
  }),

  /**
   * Remueve un Item del Order
   */
  removeItem: withValidation(RemoveItemFromOrderSchema, async (data) => {
    return await strapi.db.transaction(async (trx) => {
      try {
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { id, item: itemId } = data;

        // Obtención del Order actual
        const currentOrder = await strapi.entityService.findOne(
          ORDER_SERVICE,
          id,
          {
            populate: {
              orderProducts: {
                populate: {
                  items: { fields: ["id", "state"] },
                  product: true,
                },
              },
            },
            transacting: trx,
          },
        );

        if (!currentOrder) {
          throw new Error("La orden no existe");
        }

        validateOrderIsEditable(currentOrder);

        // Obtención del Item
        const item = await strapi.entityService.findOne(ITEM_SERVICE, itemId, {
          populate: ["product", "orders"],
          transacting: trx,
        });

        if (!item) {
          throw new Error("El Item no pudo ser encontrado");
        }

        if (!item.orders?.find((o) => o.id === currentOrder.id)) {
          throw new Error("El Item no hace parte de esta orden");
        }

        // Obtención del OrderProduct que contiene el Item
        const orderProduct = currentOrder.orderProducts.find(
          (op) => op.product.id == item.product.id,
        );

        if (!orderProduct) {
          throw new Error("El OrderProduct no pudo ser encontrado");
        }

        // Remover el item — fast path para SALE/OUT con items RESERVED
        let removedItem;
        if (
          (currentOrder.type === ORDER_TYPES.SALE ||
            currentOrder.type === ORDER_TYPES.OUT) &&
          item.state === ITEM_STATES.RESERVED
        ) {
          removedItem = await fastUnreserveSaleItem(strapi, {
            item,
            currentOrder,
            orderProduct,
            trx,
          });
        } else {
          removedItem = await strapi.service(ORDER_SERVICE).doItemMovement({
            movementType: ITEM_MOVEMENT_TYPES.DELETE,
            item,
            order: currentOrder,
            orderProduct,
            product: orderProduct.product,
            orderState: currentOrder.state,
            trx,
          });
        }

        // Count remaining items across all orderProducts
        let totalItemsLeft = 0;
        for (const op of currentOrder.orderProducts) {
          const itemsLeft = op.items
            ? op.items.filter((i) => i.id !== removedItem.id).length
            : 0;
          totalItemsLeft += itemsLeft;
        }

        // Auto-transition CONFIRMED to DRAFT if order is now empty
        if (
          totalItemsLeft === 0 &&
          currentOrder.state === ORDER_STATES.CONFIRMED &&
          (currentOrder.type === ORDER_TYPES.SALE ||
            currentOrder.type === ORDER_TYPES.OUT)
        ) {
          currentOrder.state = ORDER_STATES.DRAFT;
          await strapi.entityService.update(ORDER_SERVICE, currentOrder.id, {
            data: { state: ORDER_STATES.DRAFT },
            transacting: trx,
          });
        }

        // Actualizar OrderProduct
        await orderProductService.update({
          id: orderProduct.id,
          orderState: currentOrder.state,
          trx,
        });

        // Emitir evento WebSocket
        strapi.io?.to(`order:${currentOrder.id}`).emit("order:item-removed", {
          ...removedItem,
          product: orderProduct.product,
        });

        logger.debug(`Item removed from order`, {
          orderId: currentOrder.id,
          itemId: removedItem?.id,
        });

        return { ...removedItem, product: orderProduct.product.id };
      } catch (error) {
        logger.error("Error removing item from order", error);
        throw error;
      }
    });
  }),

  /**
   * Descarga la factura asociada a la orden
   * @param {Number} orderId - ID de la orden
   * @param {String} type - Tipo de factura ('A', 'B' o 'ALL')
   * @returns {Object} - { buffer, mimeType, filename, type }
   */
  async downloadInvoice(orderId, type = "ALL") {
    try {
      // 1. Obtener la orden con customer
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: ["customer"],
      });

      if (!order) {
        throw new Error("Orden no encontrada");
      }

      const siigoInvoiceService = strapi.service("api::siigo.invoice");
      const archiver = require("archiver");
      const { Writable } = require("stream");
      const moment = require("moment");

      // Helper para nombre de cliente
      const getCustomerName = (customer) => {
        if (!customer) return "Unknown";
        const name = customer.name || "";
        const lastName = customer.lastName || "";
        return `${name} ${lastName}`.trim();
      };

      // Helper para fecha
      const getFormattedDate = (date) => {
        if (!date) return moment().format("DD-MM-YYYY");
        return moment(date).format("DD-MM-YYYY");
      };

      const customerName = getCustomerName(order.customer);
      const dateStr = getFormattedDate(order.actualDispatchDate);

      // Helper para generar nombres de archivo
      const getFilename = (invoiceType) => {
        if (invoiceType === "A") {
          const number = order.invoiceNumberTypeA || "SIN-NUMERO";
          return `ADTX-${number} - ${customerName} (${dateStr}).pdf`;
        }
        if (invoiceType === "B") {
          const number = order.invoiceNumberTypeB || "SIN-NUMERO";
          return `AD-${number} - ${customerName} (${dateStr}).pdf`;
        }
        return `invoice_${invoiceType}_${order.code || orderId}.pdf`;
      };

      // 2. Determinar IDs disponibles
      const idA = order.siigoIdTypeA || order.siigoId;
      const idB = order.siigoIdTypeB;

      // 3. Lógica para "ALL" (automático)
      if (type === "ALL") {
        // Caso 1: Ambas existen -> ZIP
        if (idA && idB) {
          const [pdfA, pdfB] = await Promise.all([
            siigoInvoiceService.downloadInvoicePdf(idA),
            siigoInvoiceService.downloadInvoicePdf(idB),
          ]);

          // Crear ZIP en memoria
          const chunks = [];
          const output = new Writable({
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          });

          return new Promise((resolve, reject) => {
            const archive = archiver("zip", { zlib: { level: 9 } });

            archive.on("error", (err) => reject(err));
            output.on("finish", () => {
              const buffer = Buffer.concat(chunks);
              const zipFilename = `Facturas - ${customerName} (${dateStr}).zip`;
              resolve({
                buffer,
                mimeType: "application/zip",
                filename: zipFilename,
                type: "zip",
              });
            });

            archive.pipe(output);
            archive.append(pdfA, { name: getFilename("A") });
            archive.append(pdfB, { name: getFilename("B") });
            archive.finalize();
          });
        }

        // Caso 2: Solo una existe -> PDF directo
        // Si hay A, devolvemos A. Si no hay A pero hay B (raro), devolvemos B.
        if (idA) {
          const pdfBuffer = await siigoInvoiceService.downloadInvoicePdf(idA);
          return {
            buffer: pdfBuffer,
            mimeType: "application/pdf",
            filename: getFilename("A"),
            type: "pdf",
          };
        }

        if (idB) {
          const pdfBuffer = await siigoInvoiceService.downloadInvoicePdf(idB);
          return {
            buffer: pdfBuffer,
            mimeType: "application/pdf",
            filename: getFilename("B"),
            type: "pdf",
          };
        }

        throw new Error("La orden no tiene facturas asociadas");
      }

      // 4. Lógica para tipos específicos ('A' o 'B')
      let siigoInvoiceId;
      let suffix; // Ya no se usa para el filename final, pero lo dejo por estructura

      if (type === "A") {
        siigoInvoiceId = idA;
        suffix = "A";
        if (!siigoInvoiceId) {
          throw new Error("La orden no tiene una factura Tipo A asociada");
        }
      } else if (type === "B") {
        siigoInvoiceId = idB;
        suffix = "B";
        if (!siigoInvoiceId) {
          throw new Error("La orden no tiene una factura Tipo B asociada");
        }
      } else {
        throw new Error("Tipo de factura inválido");
      }

      const pdfBuffer =
        await siigoInvoiceService.downloadInvoicePdf(siigoInvoiceId);

      return {
        buffer: pdfBuffer,
        mimeType: "application/pdf",
        filename: getFilename(type),
        type: "pdf",
      };
    } catch (error) {
      // Propagar error para que el controller lo maneje
      throw error;
    }
  },

  /**
   * Descarga el PDF de la nota crédito asociada a una orden de devolución.
   * @param {Number} orderId - ID de la orden de devolución
   * @param {String} type - 'A', 'B' o 'ALL' (por defecto ALL)
   * @returns {Object} - { buffer, mimeType, filename, type }
   */
  async downloadCreditNote(orderId, type = "ALL") {
    try {
      const order = await strapi.entityService.findOne(ORDER_SERVICE, orderId, {
        populate: ["customer", "parentOrder"],
      });

      if (!order) {
        throw new Error("Orden no encontrada");
      }

      const siigoInvoiceService = strapi.service("api::siigo.invoice");
      const moment = require("moment");

      const getCustomerName = (customer) => {
        if (!customer) return "Unknown";
        return `${customer.name || ""} ${customer.lastName || ""}`.trim();
      };
      const getFormattedDate = (date) =>
        date ? moment(date).format("DD-MM-YYYY") : moment().format("DD-MM-YYYY");

      // Obtener cliente desde parentOrder si no está en la orden propia
      const customer =
        order.customer || order.parentOrder?.customer || null;
      const customerName = getCustomerName(customer);
      const dateStr = getFormattedDate(order.completedDate);

      const getFilename = (ncType) => {
        if (ncType === "A") {
          const num = order.creditNoteNumberTypeA || "SIN-NUMERO";
          return `NC-${num} - ${customerName} (${dateStr}).pdf`;
        }
        if (ncType === "B") {
          const num = order.creditNoteNumberTypeB || "SIN-NUMERO";
          return `NC-${num} - ${customerName} (${dateStr}).pdf`;
        }
        return `nota-credito_${order.code || orderId}.pdf`;
      };

      const idA = order.creditNoteIdTypeA;
      const idB = order.creditNoteIdTypeB;

      if (!idA && !idB) {
        throw new Error(
          "La orden no tiene notas crédito emitidas en Siigo",
        );
      }

      if (type === "ALL") {
        if (idA && idB) {
          const archiver = require("archiver");
          const { Writable } = require("stream");
          const [pdfA, pdfB] = await Promise.all([
            siigoInvoiceService.downloadCreditNotePdf(idA),
            siigoInvoiceService.downloadCreditNotePdf(idB),
          ]);
          const chunks = [];
          const output = new Writable({
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          });
          return new Promise((resolve, reject) => {
            const archive = archiver("zip", { zlib: { level: 9 } });
            archive.on("error", reject);
            output.on("finish", () => {
              resolve({
                buffer: Buffer.concat(chunks),
                mimeType: "application/zip",
                filename: `Notas Credito - ${customerName} (${dateStr}).zip`,
                type: "zip",
              });
            });
            archive.pipe(output);
            archive.append(pdfA, { name: getFilename("A") });
            archive.append(pdfB, { name: getFilename("B") });
            archive.finalize();
          });
        }
        // Solo uno disponible: devolver PDF directamente
        const singleId = idA || idB;
        const singleType = idA ? "A" : "B";
        const pdfBuffer = await siigoInvoiceService.downloadCreditNotePdf(singleId);
        return {
          buffer: pdfBuffer,
          mimeType: "application/pdf",
          filename: getFilename(singleType),
          type: "pdf",
        };
      }

      // Tipo específico
      const siigoId = type === "A" ? idA : idB;
      if (!siigoId) {
        throw new Error(
          `La orden no tiene nota crédito Tipo ${type} asociada`,
        );
      }
      const pdfBuffer = await siigoInvoiceService.downloadCreditNotePdf(siigoId);
      return {
        buffer: pdfBuffer,
        mimeType: "application/pdf",
        filename: getFilename(type),
        type: "pdf",
      };
    } catch (error) {
      throw error;
    }
  },

  /**
   * Devuelve los items disponibles para nacionalizar de una orden de compra
   * que esté en una bodega de zona franca.
   *
   * @param {number|string} purchaseOrderId - ID de la orden de compra completada.
   * @returns {Promise<Array>} Lista de items AVAILABLE agrupados por producto.
   */
  async getNationalizableItems(purchaseOrderId) {
    const purchaseOrder = await strapi.entityService.findOne(
      ORDER_SERVICE,
      purchaseOrderId,
      {
        populate: [
          "destinationWarehouse",
          "orderProducts",
          "orderProducts.product",
        ],
      },
    );

    if (!purchaseOrder) {
      throw new Error("La orden de compra no existe");
    }

    if (purchaseOrder.type !== ORDER_TYPES.PURCHASE) {
      throw new Error("La orden no es una orden de compra");
    }

    if (purchaseOrder.state !== ORDER_STATES.COMPLETED) {
      throw new Error(
        "La orden de compra debe estar completada para poder nacionalizar",
      );
    }

    const warehouse = purchaseOrder.destinationWarehouse;
    if (!warehouse || warehouse.type !== WAREHOUSE_TYPES.FREE_TRADE_ZONE) {
      throw new Error(
        "La bodega destino de la orden de compra no es una zona franca",
      );
    }

    // Obtener todos los items AVAILABLE en la bodega zona franca para los
    // productos de esta orden de compra.
    const productIds = purchaseOrder.orderProducts.map((op) => op.product.id);

    const items = await strapi.entityService.findMany(ITEM_SERVICE, {
      filters: {
        warehouse: warehouse.id,
        state: ITEM_STATES.AVAILABLE,
        product: { id: { $in: productIds } },
      },
      populate: ["product", "warehouse"],
      sort: ["createdAt:asc"],
      limit: -1,
    });

    // Group by product
    const grouped = {};
    for (const item of items) {
      const pid = item.product.id;
      if (!grouped[pid]) {
        grouped[pid] = {
          product: item.product,
          items: [],
          totalAvailable: 0,
        };
      }
      grouped[pid].items.push(item);
      grouped[pid].totalAvailable += Number(item.currentQuantity) || 0;
    }
    return Object.values(grouped);
  },

  /**
   * Crea una orden de nacionalización a partir de una orden de compra en
   * zona franca. Selecciona items FIFO por producto hasta cubrir las
   * cantidades solicitadas y crea la orden de tipo `nationalization` en
   * estado CONFIRMED, lista para ser procesada y completada.
   *
   * @param {Object} data
   * @param {number|string} data.purchaseOrderId   - ID de la orden de compra origen.
   * @param {number|string} data.destinationWarehouseId - ID de la bodega stock destino.
   * @param {Array<{product: number, quantity: number}>} data.products - Productos y cantidades a nacionalizar.
   * @param {string} [data.notes] - Notas opcionales.
   * @returns {Promise<Object>} La orden de nacionalización creada.
   */
  async createNationalization({
    purchaseOrderId,
    destinationWarehouseId,
    products,
    notes,
  }) {
    return await strapi.db.transaction(async (trx) => {
      // 1. Validar la orden de compra origen
      const purchaseOrder = await strapi.entityService.findOne(
        ORDER_SERVICE,
        purchaseOrderId,
        {
          populate: ["destinationWarehouse", "orderProducts", "orderProducts.product"],
          transacting: trx,
        },
      );

      if (!purchaseOrder) {
        throw new Error("La orden de compra no existe");
      }
      if (purchaseOrder.type !== ORDER_TYPES.PURCHASE) {
        throw new Error("La orden origen debe ser una orden de compra");
      }
      if (purchaseOrder.state !== ORDER_STATES.COMPLETED) {
        throw new Error(
          "La orden de compra debe estar completada para nacionalizar",
        );
      }

      const sourceWarehouse = purchaseOrder.destinationWarehouse;
      if (!sourceWarehouse || sourceWarehouse.type !== WAREHOUSE_TYPES.FREE_TRADE_ZONE) {
        throw new Error(
          "La bodega de la orden de compra no es una zona franca",
        );
      }

      // 2. Validar la bodega destino
      const destinationWarehouse = await strapi.entityService.findOne(
        WAREHOUSE_SERVICE,
        destinationWarehouseId,
        { transacting: trx },
      );

      if (!destinationWarehouse) {
        throw new Error("La bodega destino no existe");
      }
      if (destinationWarehouse.type !== WAREHOUSE_TYPES.STOCK) {
        throw new Error(
          "La bodega destino debe ser de tipo stock",
        );
      }

      // 3. Para cada producto, seleccionar items FIFO en la bodega zona franca
      const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
      const itemsToNationalize = []; // [{ productId, items: [item] }]

      for (const { product: productId, quantity: requestedQty, itemIds } of products) {
        if (!productId) {
          throw new Error(`Producto inválido: falta el campo product`);
        }

        let selected = [];

        if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
          // Explicit item selection
          selected = await strapi.entityService.findMany(ITEM_SERVICE, {
            filters: {
              id: { $in: itemIds },
              product: productId,
              warehouse: sourceWarehouse.id,
              state: ITEM_STATES.AVAILABLE,
            },
            populate: ["product"],
            limit: -1,
            transacting: trx,
          });
          if (selected.length !== itemIds.length) {
            throw new Error(
              `Algunos items seleccionados no están disponibles para el producto ${productId}. ` +
                `Se solicitaron ${itemIds.length} y solo ${selected.length} están disponibles.`,
            );
          }
        } else if (requestedQty && requestedQty > 0) {
          // FIFO quantity selection
          const available = await strapi.entityService.findMany(ITEM_SERVICE, {
            filters: {
              product: productId,
              warehouse: sourceWarehouse.id,
              state: ITEM_STATES.AVAILABLE,
            },
            populate: ["product"],
            sort: ["createdAt:asc"],
            limit: -1,
            transacting: trx,
          });

          let remaining = requestedQty;
          for (const item of available) {
            if (remaining <= 0) break;
            selected.push(item);
            remaining -= item.currentQuantity;
          }

          if (remaining > 0.0001) {
            const found = requestedQty - remaining;
            throw new Error(
              `Stock insuficiente en zona franca para producto ${productId}. ` +
                `Se solicitaron ${requestedQty} y solo hay ${found} disponibles.`,
            );
          }
        } else {
          throw new Error(
            `Producto ${productId}: debe especificar una cantidad (quantity) o items seleccionados (itemIds)`,
          );
        }

        itemsToNationalize.push({ productId, items: selected });
      }

      // 4. Crear la orden de nacionalización
      const code = await generateOrderNumber(strapi, ORDER_TYPES.NATIONALIZATION, trx);
      const moment = require("moment-timezone");
      moment.tz.setDefault("America/Bogota");

      const order = await strapi.entityService.create(ORDER_SERVICE, {
        data: {
          type: ORDER_TYPES.NATIONALIZATION,
          code,
          state: ORDER_STATES.CONFIRMED,
          sourceWarehouse: sourceWarehouse.id,
          destinationWarehouse: destinationWarehouse.id,
          parentOrder: purchaseOrderId,
          notes: notes || `Nacionalización parcial de orden ${purchaseOrder.code}`,
          createdDate: moment().toDate(),
          confirmedDate: moment().toDate(),
        },
        populate: ORDER_POPULATE_BASIC,
        transacting: trx,
      });

      // 5. Crear OrderProducts e items para cada producto
      for (const { productId, items } of itemsToNationalize) {
        const product = await strapi.entityService.findOne(
          PRODUCT_SERVICE,
          productId,
          { transacting: trx },
        );

        const orderProduct = await orderProductService.create({
          product: productId,
          order: order.id,
          requestedQuantity: items.reduce((s, i) => s + i.currentQuantity, 0),
          requestedPackages: items.length,
          notes: `Nacionalización de ${items.length} item(s) de ${product?.name || productId}`,
          price: items[0]?.cost || 0,
          trx,
        });

        // Reservar cada item seleccionado usando la estrategia de nacionalización
        for (const item of items) {
          await strapi.service(ORDER_SERVICE).doItemMovement({
            movementType: ITEM_MOVEMENT_TYPES.CREATE,
            item: { id: item.id },
            order,
            orderProduct,
            product,
            orderState: order.state,
            trx,
          });
        }

        await orderProductService.update({
          id: orderProduct.id,
          orderState: order.state,
          trx,
        });
      }

      // 6. Retornar la orden completa
      const fullOrder = await strapi.entityService.findOne(ORDER_SERVICE, order.id, {
        populate: ORDER_POPULATE,
        transacting: trx,
      });

      strapi.io
        ?.to(`order:${fullOrder.id}`)
        .emit("order:created", fullOrder);

      logger.info("Nationalization order created", {
        orderId: fullOrder.id,
        code,
        purchaseOrderId,
        destinationWarehouseId,
        productCount: itemsToNationalize.length,
      });

      return fullOrder;
    });
  },
}));
