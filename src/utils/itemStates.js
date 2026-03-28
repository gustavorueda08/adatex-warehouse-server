/**
 * @fileoverview Physical item state constants.
 *
 * An Item represents a physical unit of a Product in a Warehouse.
 * Its state tracks where it is in the fulfilment lifecycle.
 *
 * State transitions:
 *   AVAILABLE → RESERVED  (order confirmed)
 *   RESERVED  → AVAILABLE (order cancelled / item removed from order)
 *   RESERVED  → SOLD      (order completed with emitInvoice)
 *   RESERVED  → DROPPED   (order completed without invoicing, e.g. transfer)
 *   AVAILABLE → DROPPED   (adjustment outflow)
 */

/** @enum {string} */
const ITEM_STATES = {
  /** Item is in stock and can be allocated to new orders. */
  AVAILABLE: "available",

  /** Item has been allocated to a confirmed order and is not available for others. */
  RESERVED: "reserved",

  /** Item was dispatched and invoiced to a customer. Terminal state. */
  SOLD: "sold",

  /**
   * Item was removed from inventory without being sold
   * (e.g. transferred, adjusted out, transformed). Terminal state.
   */
  DROPPED: "dropped",
};

module.exports = ITEM_STATES;
