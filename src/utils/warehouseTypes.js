/**
 * @fileoverview Warehouse type constants.
 *
 * Warehouse type affects which orders can target it and how inventory rules
 * are applied.
 *
 * | Type            | Description                                              |
 * |-----------------|----------------------------------------------------------|
 * | STOCK           | General-purpose storage. Default for most operations.    |
 * | PRODUCTION      | In-progress goods (raw materials being worked on).       |
 * | PRINT_LAB       | Specialised lab warehouse for printing/finishing.        |
 * | TRANSIT         | Temporary holding while goods are in transport.          |
 * | FREE_TRADE_ZONE | Customs bonded zone. Items here cannot be added to sale  |
 * |                 | orders directly; they must first be nationalized to a    |
 * |                 | STOCK warehouse via a nationalization order.             |
 */

/** @enum {string} */
const WAREHOUSE_TYPES = {
  STOCK: "stock",
  PRODUCTION: "production",
  PRINT_LAB: "printlab",
  TRANSIT: "transit",
  /** Customs bonded / free-trade zone. Requires nationalization to move items to stock. */
  FREE_TRADE_ZONE: "freeTradeZone",
};

module.exports = WAREHOUSE_TYPES;
