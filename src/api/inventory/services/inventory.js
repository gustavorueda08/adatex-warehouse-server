const ITEM_STATES = require("../../../utils/itemStates");
const ORDER_PRODUCT_STATES = require("../../../utils/orderProductStates");
const ORDER_STATES = require("../../../utils/orderStates");
const ORDER_TYPES = require("../../../utils/orderTypes");
const runInBatches = require("../../../utils/runInBatches");
const {
  WAREHOUSE_SERVICE,
  ORDER_PRODUCT_SERVICE,
  INVENTORY_MOVEMENT_SERVICE,
  PRODUCT_SERVICE,
  ORDER_SERVICE,
} = require("../../../utils/services");
const WAREHOUSE_TYPES = require("../../../utils/warehouseTypes");
const {
  InventoryByWarehouseSchema,
  InventoryByProductSchema,
} = require("../../../validation/schemas");
const { withValidation } = require("../../../validation/withValidation");

module.exports = ({ strapi }) => ({
  inventoryByWarehouse: withValidation(
    InventoryByWarehouseSchema,
    async (data) => {
      try {
        return await strapi.db.transaction(async (trx) => {
          // Obtención de variables
          const { warehouses: warehouseIds } = data;
          const filters = {
            isActive: data.isActive,
          };
          // Creación del Array de Warehouses
          let warehouses = [];
          // Comprobar si sólo se pide una o varias bodegas especificas
          if (warehouseIds.length > 0) {
            // Obtener las bodegas especificas
            await runInBatches(warehouseIds, async (id) => {
              const warehouse = await strapi.entityService.findOne(
                WAREHOUSE_SERVICE,
                id,
                {
                  populate: ["items", "items.product", "items.sourceOrder"],
                },
                { transacting: trx }
              );
              if (!warehouse)
                throw new Error(`La bodega con id ${id} no existe`);
              warehouses.push(warehouse);
            });
          } else {
            // Obtener todas las bodegas existenes
            warehouses = await strapi.entityService.findMany(
              WAREHOUSE_SERVICE,
              {
                filters,
                populate: ["items", "items.product", "items.sourceOrder"],
              },
              { transacting: trx }
            );
          }
          // Creación del inventoryByWarehoyse
          const inventoryByWarehouse = Object.values(
            // Reducción de warehouses para agrupar Products con sus Items en cada Warehouse
            warehouses.reduce((acc, warehouse) => {
              if (!acc[warehouse.id]) {
                // Objeto inicial
                acc[warehouse.id] = {
                  id: warehouse.id,
                  name: warehouse.name,
                  type: warehouse.type,
                  products: {},
                };
                const items = warehouse.items;
                // Agrupación de Items por Product
                const groupedProducts = items.reduce(
                  (accItem, { product, ...item }) => {
                    const { id } = product;
                    if (!accItem[id]) {
                      accItem[id] = {
                        id,
                        name: product.name,
                        unit: product.unit,
                        quantity: 0,
                        packages: 0,
                        items: [],
                      };
                    }
                    accItem[id].items.push(item);
                    accItem[id].quantity += item.currentQuantity;
                    accItem[id].packages += 1;
                    return accItem;
                  },
                  {}
                );
                Object.entries(groupedProducts).forEach(
                  ([productId, product]) => {
                    if (!acc[warehouse.id].products[productId]) {
                      acc[warehouse.id].products[productId] = product;
                    } else {
                      const items = product.items;
                      acc[warehouse.id].products[productId].items.push(
                        ...items
                      );
                      items.forEach((item) => {
                        acc[warehouse.id].products[productId].quantity +=
                          item.currentQuantity;
                        acc[warehouse.id].products[productId].packages += 1;
                      });
                    }
                  }
                );
              }
              acc[warehouse.id].products = Object.values(
                acc[warehouse.id].products
              );
              return acc;
            }, {})
          );
          return inventoryByWarehouse;
        });
      } catch (error) {
        throw error;
      }
    }
  ),
  inventoryByProduct: withValidation(InventoryByProductSchema, async (data) => {
    try {
      return strapi.db.transaction(async (trx) => {
        // Obtención de variables
        const { products: productIds } = data;
        let products;
        // Si llegan productIds entonces buscamos sólo los productos seleccionados
        if (productIds.length > 0) {
          products = await runInBatches(productIds, (id) =>
            strapi.entityService.findOne(
              PRODUCT_SERVICE,
              id,
              {
                populate: ["items", "items.warehouse"],
              },
              { transacting: trx }
            )
          );
        } else {
          // Si no llegan productIds entonces traemos todos los productos
          products = await strapi.entityService.findMany(
            PRODUCT_SERVICE,
            {
              populate: ["items", "items.warehouse"],
            },
            { transacting: trx }
          );
        }
        if (!products) throw new Error("Error al obtener los productos");
        // Obtenemos todos los OrderProducts que pertenezcan a Purchase o Out Orders que aún no tenga Items asociados
        const inOrderProducts = await strapi.entityService.findMany(
          ORDER_PRODUCT_SERVICE,
          {
            filters: {
              state: ORDER_PRODUCT_STATES.PENDING,
              order: {
                type: [ORDER_TYPES.PURCHASE, ORDER_TYPES.IN],
                state: ORDER_STATES.DRAFT,
              },
              items: { id: { $null: true } },
            },
            populate: ["product"],
          },
          { transacting: trx }
        );
        if (!inOrderProducts)
          throw new Error("Error al obtener los productos de compras");
        // Agrupamos los OrderProducts de Purchase y In por su Product, obteniendo el requesteQuantity y el requestedPackages
        const groupedInOrderProducts = inOrderProducts.reduce((acc, inOP) => {
          const { id } = inOP.product;
          if (!acc[id]) {
            acc[id] = {
              id,
              requestedQuantity: 0,
              requestedPackages: 0,
            };
          }
          acc[id].requestedQuantity += inOP.requestedQuantity;
          acc[id].requestedPackages += 1;
          return acc;
        }, {});

        // Obtenemos todos los OrderProducts que pertenezcan a Sale o Out Orders que aún no tenga Items asociados
        const outOrderProducts = await strapi.entityService.findMany(
          ORDER_PRODUCT_SERVICE,
          {
            filters: {
              state: ORDER_PRODUCT_STATES.PENDING,
              order: {
                type: [ORDER_TYPES.SALE, ORDER_TYPES.OUT],
                state: ORDER_STATES.DRAFT,
              },
              items: { id: { $null: true } },
            },
            populate: ["product"],
          },
          { transacting: trx }
        );
        console.log(outOrderProducts);

        if (!outOrderProducts)
          throw new Error("Error al obtener los productos de ventas");
        // Agrupamos los OrderProducts de Sale y Out por su Product, obteniendo el requesteQuantity y el requestedPackages
        const groupedOutOrderProducts = outOrderProducts.reduce(
          (acc, outOP) => {
            const { id } = outOP.product;
            if (!acc[id]) {
              acc[id] = {
                id,
                requestedQuantity: 0,
                requestedPackages: 0,
              };
            }
            acc[id].requestedQuantity += outOP.requestedQuantity;
            acc[id].requestedPackages += 1;
            return acc;
          },
          {}
        );
        console.log(groupedOutOrderProducts);

        // Creación de Helper para filtrar items por estado y bodega
        const filterHelper = (items = [], state, warehouseType) => {
          const filteredItems = items.filter(
            (item) =>
              item.state === state && item.warehouse?.type === warehouseType
          );
          const totalQuantity = filteredItems.reduce(
            (acc, item) => acc + item.currentQuantity,
            0
          );
          return {
            items: filteredItems,
            totalQuantity,
            totalPackages: filteredItems.length,
          };
        };

        // Retornamos un Array de los productos agrupando sus Items por tipo de bodega, adicionando cantidades requeridas de entrada y cantidades requeridas de salidas
        return Object.values(
          products.reduce((acc, product) => {
            //Obtenemos variables
            const { id, items, ...productData } = product;
            const requestedInProduct = groupedInOrderProducts[id];
            const requestedOutProduct = groupedOutOrderProducts[id];
            // Arme del objeto
            if (!acc[id]) {
              acc[id] = {
                ...productData,
                printLab: [],
                available: [],
                reserved: [],
                inTransit: [],
                inProduction: [],
                totalQuantity: 0,
                totalPackages: 0,
                totalRequestedInQuantity: 0,
                totalRequestedInPackages: 0,
                totalRequestedOutQuantity: 0,
                totalRequestedOutPackages: 0,
              };
            }
            // Si hay requestedInProduct entonces se agregan sus datos
            if (requestedInProduct) {
              acc[id].totalRequestedInQuantity +=
                requestedInProduct.requestedQuantity;
              acc[id].totalRequestedInPackages +=
                requestedInProduct.requestedPackages;
            }
            // Si hay requestedOutProduct entonces se agregan sus datos
            if (requestedOutProduct) {
              acc[id].totalRequestedOutQuantity +=
                requestedOutProduct.requestedQuantity;
              acc[id].totalRequestedOutPackages +=
                requestedOutProduct.requestedPackages;
            }

            //Filtros por estado del Item y tipo de bodega
            const printLabData = filterHelper(
              items,
              ITEM_STATES.AVAILABLE,
              WAREHOUSE_TYPES.PRINT_LAB
            );
            acc[id].printLab.push(...printLabData.items);
            const availableData = filterHelper(
              items,
              ITEM_STATES.AVAILABLE,
              WAREHOUSE_TYPES.STOCK
            );
            acc[id].available.push(...availableData.items);
            const reservedData = filterHelper(
              items,
              ITEM_STATES.RESERVED,
              WAREHOUSE_TYPES.STOCK
            );
            acc[id].reserved.push(...reservedData.items);
            const inTransitData = filterHelper(
              items,
              ITEM_STATES.AVAILABLE,
              WAREHOUSE_TYPES.TRANSIT
            );
            acc[id].inTransit.push(...inTransitData.items);
            const inProductionData = filterHelper(
              items,
              ITEM_STATES.AVAILABLE,
              WAREHOUSE_TYPES.PRODUCTION
            );
            // Agregación de todos los datos al objeto
            acc[id].inProduction.push(...inProductionData.items);
            acc[id].totalQuantity +=
              printLabData.totalQuantity +
              availableData.totalQuantity +
              reservedData.totalQuantity +
              inTransitData.totalQuantity +
              inProductionData.totalQuantity;
            acc[id].totalPackages +=
              printLabData.totalPackages +
              availableData.totalPackages +
              reservedData.totalPackages +
              inTransitData.totalPackages +
              inProductionData.totalPackages;
            return acc;
          }, {})
        );
      });
    } catch (error) {
      throw error;
    }
  }),
  async getInventoryByWarehouse(filters) {
    try {
      return await strapi.db.transaction(async (trx) => {
        const warehouseService = strapi.service(WAREHOUSE_SERVICE);
        const orderProductService = strapi.service(ORDER_PRODUCT_SERVICE);
        const { warehouseId = null } = filters;

        // 1. Construir filtros base
        const warehouseFilters = { isActive: true };

        if (warehouseId) {
          warehouseFilters.id = warehouseId;
        }

        // 2. Obtener bodegas
        const warehouses = await warehouseService.findMany({
          filters: warehouseFilters,
          populate: ["items", "items.product"],
          trx,
        });

        const orderProducts = await orderProductService.findMany({
          filters: {
            state: "pending",
          },
          populate: [
            "product",
            "order",
            "order.sourceWarehouse",
            "order.destinationWarehouse",
          ],
          trx,
        });

        const inventoryBywarehouse = [];
        warehouses.forEach(({ items = [], ...warehouseData }) => {
          //OrderProducts que son de entradas para saber el requested
          const inOrderProducts = orderProducts.filter(
            (orderProduct) =>
              orderProduct.order?.destinationWarehouse?.id === warehouseData.id
          );
          const itemsGroupedByProduct = Object.values(
            items.reduce((acc, item) => {
              const productId = item.product.id;
              if (!productId)
                throw new Error("El id del producto es requerido");
              if (!acc[productId]) {
                const summary = {
                  totalQuantity: 0,
                  totalItems: 0,
                  totalAvailableQuantity: 0,
                  totalAvailableItems: 0,
                  totalReservedQuantity: 0,
                  totalReservedItems: 0,
                  totalInRequestedQuantity: 0,
                  totalInRequestedItems: 0,
                  totalOutRequestedQuantity: 0,
                  totalOutRequestedItems: 0,
                };
                acc[productId] = { ...item.product, items: [], summary };
              }
              const { product, ...itemData } = item;
              acc[productId].items.push(itemData);
              acc[productId].summary.totalQuantity += item.currentQuantity;
              acc[productId].summary.totalItems += 1;
              acc[productId].summary.totalAvailableQuantity +=
                item.state === ITEM_STATES.AVAILABLE ? item.currentQuantity : 0;
              acc[productId].summary.totalAvailableItems +=
                item.state === ITEM_STATES.AVAILABLE ? 1 : 0;
              acc[productId].summary.totalReservedQuantity +=
                item.state === ITEM_STATES.RESERVED ? item.currentQuantity : 0;
              acc[productId].summary.totalReservedItems +=
                item.state === ITEM_STATES.RESERVED ? 1 : 0;

              const saleOrderProduct = orderProducts.find(
                (op) =>
                  op.product.id === productId &&
                  op.order.sourceWarehouse?.id === warehouseData.id
              );
              if (saleOrderProduct) {
                acc[productId].summary.totalOutRequestedQuantity += Math.max(
                  saleOrderProduct.requestedQuantity -
                    saleOrderProduct.confirmedQuantity,
                  0
                );
                acc[productId].summary.totalOutRequestedItems += Math.max(
                  saleOrderProduct.requestedPackages -
                    saleOrderProduct.confirmedPackages
                );
              }
              return acc;
            }, {})
          );
          const inOrderProductsByProduct = Object.values(
            inOrderProducts.reduce((acc, orderProduct) => {
              const productId = orderProduct.product.id;
              if (!productId)
                throw new Error("El id del producto es requerido");
              if (!acc[productId]) {
                const summary = {
                  totalInRequestedQuantity: 0,
                  totalInRequestedItems: 0,
                };
                acc[productId] = {
                  ...orderProduct.product,
                  summary,
                };
              }
              acc[productId].summary.totalInRequestedQuantity +=
                orderProduct.requestedQuantity;
              acc[productId].summary.totalInRequestedItems +=
                orderProduct.requestedPackages;
              return acc;
            }, {})
          );
          inOrderProductsByProduct.forEach((product) => {
            const productFromItemsGroup = itemsGroupedByProduct.find(
              (p) => p.id === product.id
            );
            if (productFromItemsGroup) {
              productFromItemsGroup.summary.totalOutRequestedQuantity +=
                product.summary.totalOutRequestedQuantity;
              productFromItemsGroup.summary.totalOutRequestedItems +=
                product.summary.totalOutRequestedItems;
            } else {
              itemsGroupedByProduct.push(product);
            }
          });
          console.log(
            "PRODUCTOS TIPO IN PARA INSERTAR",
            inOrderProductsByProduct
          );

          const productsHaveSameUnit =
            itemsGroupedByProduct.length > 0 &&
            itemsGroupedByProduct.every(
              (product) => product.unit === itemsGroupedByProduct[0].unit
            );
          const summaryData = {
            totalQuantity: 0,
            totalItems: 0,
            totalAvailableQuantity: 0,
            totalAvailableItems: 0,
            totalReservedQuantity: 0,
            totalReservedItems: 0,
            totalInRequestedQuantity: 0,
            totalInRequestedItems: 0,
            totalOutRequestedQuantity: 0,
            totalOutRequestedItems: 0,
          };
          const data = {
            warehouse: { ...warehouseData },
            products: itemsGroupedByProduct,
            summary: itemsGroupedByProduct.reduce((acc, product) => {
              acc.totalQuantity += productsHaveSameUnit
                ? product.summary.totalQuantity
                : null;
              acc.totalItems += product.summary.totalItems;
              acc.totalAvailableQuantity += productsHaveSameUnit
                ? product.summary.totalAvailableQuantity
                : null;
              acc.totalAvailableItems += product.summary.totalAvailableItems;
              acc.totalReservedQuantity += productsHaveSameUnit
                ? product.summary.totalReservedQuantity
                : null;
              acc.totalReservedItems += product.summary.totalReservedItems;
              acc.totalInRequestedQuantity += productsHaveSameUnit
                ? product.summary?.totalInRequestedQuantity
                : null;
              acc.totalInRequestedItems +=
                product.summary.totalInRequestedItems;
              acc.totalOutRequestedQuantity += productsHaveSameUnit
                ? product.summary?.totalOutRequestedQuantity
                : null;
              acc.totalOutRequestedItems +=
                product.summary?.totalOutRequestedItems;
              return acc;
            }, summaryData),
          };
          inventoryBywarehouse.push(data);
        });
        return inventoryBywarehouse;
      });
    } catch (error) {
      console.error("Error getting inventory by warehouse:", error);
      throw error;
    }
  },
  async getMovements(filters) {
    try {
      const inventoryMovementService = strapi.service(
        INVENTORY_MOVEMENT_SERVICE
      );
      const inventoryMovements =
        await inventoryMovementService.findMany(filters);
      return inventoryMovements;
    } catch (error) {
      throw error;
    }
  },
  async getMovementsByProduct({ filters }) {
    try {
      const inventoryMovementService = strapi.service(
        INVENTORY_MOVEMENT_SERVICE
      );
      const inventoryMovements = await inventoryMovementService.findMany({
        filters,
        populate: [
          "item",
          "item.product",
          "destinationWarehouse",
          "sourceWarehouse",
          "order",
        ],
      });
      const products = Object.values(
        inventoryMovements.reduce((acc, invMovement) => {
          const productId = invMovement.item.product.id;
          if (!acc[productId]) {
            acc[productId] = {
              ...invMovement.item.product,
              in: [],
              out: [],
              transfer: [],
              adjust: [],
              summary: {
                totalIn: 0,
                totalOut: 0,
                totalTransfer: 0,
                totalAdjust: 0,
                totalQuantity: 0,
                totalItems: 0,
              },
            };
            const {
              type,
              quantity,
              balanceAfter,
              balanceBefore,
              createdAt,
              destinationWarehouse,
              sourceWarehouse,
              reason,
            } = invMovement;
            switch (type) {
              case "in":
                acc[productId].in.push({
                  quantity,
                  balanceAfter,
                  balanceBefore,
                  type,
                  destinationWarehouse,
                  reason,
                  date: createdAt,
                });
                acc[productId].summary.totalIn += quantity;
                acc[productId].summary.totalQuantity += quantity;
                break;
              case "out":
                acc[productId].out.push({
                  quantity,
                  balanceAfter,
                  balanceBefore,
                  type,
                  sourceWarehouse,
                  reason,
                  date: createdAt,
                });
                acc[productId].summary.totalOut += quantity;
                acc[productId].summary.totalQuantity -= quantity;
                break;
              case "transfer":
                acc[productId].transfer.push({
                  quantity,
                  balanceAfter,
                  balanceBefore,
                  type,
                  destinationWarehouse,
                  sourceWarehouse,
                  reason,
                  date: createdAt,
                });
                acc[productId].summary.totalTransfer += quantity;
                acc[productId].summary.totalQuantity += quantity;
                break;
              case "adjustment":
                acc[productId].adjustment.push({
                  quantity,
                  balanceAfter,
                  balanceBefore,
                  type,
                  destinationWarehouse,
                  sourceWarehouse,
                  reason,
                  date: createdAt,
                });
                acc[productId].summary.totalAdjust += quantity;
                acc[productId].summary.totalQuantity += quantity;
                break;
              default:
                break;
            }
          }
          return acc;
        }, {})
      );
      return products;
    } catch (error) {
      throw error;
    }
  },
  //TODO: Trazabilidad del Item
  async getMovementsByItem() {
    try {
    } catch (error) {
      throw error;
    }
  },
  /**
   *
   * Obtener reservas activas
   */
  async getActiveReservations(filters = {}) {
    try {
      const { warehouseId, productId, customerId } = filters;

      const itemFilters = {
        status: "reserved",
        currentQuantity: { $gt: 0 },
      };

      if (warehouseId) itemFilters.warehouse = warehouseId;
      if (productId) itemFilters.product = productId;

      const reservedItems = await strapi.entityService.findMany(
        "api::item.item",
        {
          filters: itemFilters,
          populate: [
            "product",
            "warehouse",
            "orderProducts",
            "orderProducts.order",
            "orderProducts.order.customer",
          ],
          limit: -1,
        }
      );

      const reservations = [];

      for (const item of reservedItems) {
        if (item.orderProducts && item.orderProducts.length > 0) {
          for (const orderProduct of item.orderProducts) {
            if (
              orderProduct.order &&
              orderProduct.order.status !== "cancelled"
            ) {
              // Filtrar por cliente si se especifica
              if (
                customerId &&
                orderProduct.order.customer?.id !== customerId
              ) {
                continue;
              }

              reservations.push({
                id: `${item.id}-${orderProduct.id}`,
                item: {
                  id: item.id,
                  barcode: item.barcode,
                  quantity: item.currentQuantity,
                },
                product: {
                  id: item.product.id,
                  name: item.product.name,
                  sku: item.product.sku,
                  unit: item.product.unit,
                },
                warehouse: {
                  id: item.warehouse.id,
                  name: item.warehouse.name,
                  type: item.warehouse.type,
                },
                order: {
                  id: orderProduct.order.id,
                  orderNumber: orderProduct.order.orderNumber,
                  type: orderProduct.order.type,
                  status: orderProduct.order.status,
                  createdDate: orderProduct.order.createdDate,
                },
                customer: orderProduct.order.customer
                  ? {
                      id: orderProduct.order.customer.id,
                      name: orderProduct.order.customer.name,
                      code: orderProduct.order.customer.code,
                    }
                  : null,
                reservedDate: orderProduct.createdAt,
                expectedDispatchDate: orderProduct.order.estimatedWarehouseDate,
              });
            }
          }
        }
      }

      return {
        total: reservations.length,
        reservations,
        summary: {
          byProduct: this.groupReservationsByProduct(reservations),
          byCustomer: this.groupReservationsByCustomer(reservations),
          byWarehouse: this.groupReservationsByWarehouse(reservations),
        },
      };
    } catch (error) {
      console.error("Error getting active reservations:", error);
      throw error;
    }
  },

  /**
   * Obtener disponibilidad de un producto específico
   */
  async getProductAvailability(productId, warehouseId = null) {
    try {
      const filters = {
        product: productId,
        currentQuantity: { $gt: 0 },
      };

      if (warehouseId) {
        filters.warehouse = warehouseId;
      }

      const items = await strapi.entityService.findMany("api::item.item", {
        filters,
        populate: ["warehouse", "product"],
        limit: -1,
      });

      const availability = {
        product: null,
        totalQuantity: 0,
        availableQuantity: 0,
        reservedQuantity: 0,
        defectiveQuantity: 0,
        inTransitQuantity: 0,
        byWarehouse: {},
        availableItems: [],
        reservedItems: [],
        nearExpiryItems: [],
      };

      if (items.length === 0) {
        return availability;
      }

      // Obtener información del producto
      availability.product = {
        id: items[0].product.id,
        name: items[0].product.name,
        sku: items[0].product.sku,
        unit: items[0].product.unit,
      };

      // Procesar items
      for (const item of items) {
        const warehouseKey = item.warehouse.id;

        if (!availability.byWarehouse[warehouseKey]) {
          availability.byWarehouse[warehouseKey] = {
            warehouse: {
              id: item.warehouse.id,
              name: item.warehouse.name,
              type: item.warehouse.type,
            },
            available: 0,
            reserved: 0,
            defective: 0,
            inTransit: 0,
            total: 0,
            items: [],
          };
        }

        const quantity = parseFloat(item.currentQuantity);
        availability.totalQuantity += quantity;

        switch (item.status) {
          case "available":
            availability.availableQuantity += quantity;
            availability.byWarehouse[warehouseKey].available += quantity;
            availability.availableItems.push({
              id: item.id,
              barcode: item.barcode,
              quantity: item.currentQuantity,
              location: item.location,
              warehouse: item.warehouse.name,
              expirationDate: item.expirationDate,
            });
            break;
          case "reserved":
            availability.reservedQuantity += quantity;
            availability.byWarehouse[warehouseKey].reserved += quantity;
            availability.reservedItems.push({
              id: item.id,
              barcode: item.barcode,
              quantity: item.currentQuantity,
              warehouse: item.warehouse.name,
            });
            break;
          case "defective":
            availability.defectiveQuantity += quantity;
            availability.byWarehouse[warehouseKey].defective += quantity;
            break;
          case "transferred":
            availability.inTransitQuantity += quantity;
            availability.byWarehouse[warehouseKey].inTransit += quantity;
            break;
        }

        availability.byWarehouse[warehouseKey].total += quantity;
        availability.byWarehouse[warehouseKey].items.push({
          id: item.id,
          barcode: item.barcode,
          quantity: item.currentQuantity,
          status: item.status,
        });

        // Verificar items próximos a vencer
        if (item.expirationDate) {
          const daysUntilExpiry = Math.floor(
            (new Date(item.expirationDate) - new Date()) / (1000 * 60 * 60 * 24)
          );

          if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
            availability.nearExpiryItems.push({
              id: item.id,
              barcode: item.barcode,
              quantity: item.currentQuantity,
              expirationDate: item.expirationDate,
              daysUntilExpiry,
              warehouse: item.warehouse.name,
            });
          }
        }
      }

      // Ordenar items disponibles por FIFO
      availability.availableItems.sort((a, b) => a.id - b.id);

      return availability;
    } catch (error) {
      console.error("Error getting product availability:", error);
      throw error;
    }
  },

  // Funciones auxiliares
  groupReservationsByProduct(reservations) {
    const grouped = {};
    for (const reservation of reservations) {
      const productId = reservation.product.id;
      if (!grouped[productId]) {
        grouped[productId] = {
          product: reservation.product,
          totalQuantity: 0,
          reservations: [],
        };
      }
      grouped[productId].totalQuantity += parseFloat(reservation.item.quantity);
      grouped[productId].reservations.push(reservation);
    }
    return grouped;
  },

  groupReservationsByCustomer(reservations) {
    const grouped = {};
    for (const reservation of reservations) {
      if (reservation.customer) {
        const customerId = reservation.customer.id;
        if (!grouped[customerId]) {
          grouped[customerId] = {
            customer: reservation.customer,
            totalReservations: 0,
            products: {},
          };
        }
        grouped[customerId].totalReservations += 1;

        const productId = reservation.product.id;
        if (!grouped[customerId].products[productId]) {
          grouped[customerId].products[productId] = {
            product: reservation.product,
            quantity: 0,
          };
        }
        grouped[customerId].products[productId].quantity += parseFloat(
          reservation.item.quantity
        );
      }
    }
    return grouped;
  },

  groupReservationsByWarehouse(reservations) {
    const grouped = {};
    for (const reservation of reservations) {
      const warehouseId = reservation.warehouse.id;
      if (!grouped[warehouseId]) {
        grouped[warehouseId] = {
          warehouse: reservation.warehouse,
          totalReservations: 0,
          totalQuantity: 0,
        };
      }
      grouped[warehouseId].totalReservations += 1;
      grouped[warehouseId].totalQuantity += parseFloat(
        reservation.item.quantity
      );
    }
    return grouped;
  },
});
