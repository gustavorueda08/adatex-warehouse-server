/**
 * @fileoverview Strapi service name constants.
 *
 * Centralises the UID strings used to look up services via
 * `strapi.service(UID)`. Importing from here instead of inlining the strings
 * prevents typos and makes refactoring service names easier.
 *
 * Usage:
 *   const { ORDER_SERVICE } = require('../utils/services');
 *   const orderService = strapi.service(ORDER_SERVICE);
 */

const services = {
  WAREHOUSE_SERVICE: "api::warehouse.warehouse",
  ITEM_SERVICE: "api::item.item",
  ORDER_PRODUCT_SERVICE: "api::order-product.order-product",
  ORDER_SERVICE: "api::order.order",
  INVENTORY_SERVICE: "api::inventory.inventory",
  BARCODE_MAPPING_SERVICE: "api::barcode-mapping.barcode-mapping",
  INVENTORY_MOVEMENT_SERVICE: "api::inventory-movement.inventory-movement",
PRODUCT_SERVICE: "api::product.product",
  CUSTOMER_SERVICE: "api::customer.customer",
  SUPPLIER_SERVICE: "api::supplier.supplier",
  TAX_SERVICE: "api::tax.tax",
};

module.exports = services;
