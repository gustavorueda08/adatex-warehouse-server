/**
 * @fileoverview Order type constants.
 *
 * Each type drives which `ItemMovementStrategy` is selected and how items
 * are created, updated, and deleted when the order changes state.
 *
 * | Type            | Stock direction              | Invoices?                     |
 * |-----------------|------------------------------|-------------------------------|
 * | purchase        | IN  (supplier → wh)          | No                            |
 * | sale            | OUT (wh → customer)          | Yes if emitInvoice === true   |
 * | transfer        | OUT src / IN dst             | No                            |
 * | return          | IN  (customer → wh)          | No                            |
 * | adjustment      | IN or OUT                    | No                            |
 * | transform       | OUT src / IN dst unit        | No                            |
 * | out             | OUT (manual outflow)         | No                            |
 * | in              | IN  (manual inflow)          | No                            |
 * | partial-invoice | OUT (FIFO from sale)         | Always                        |
 * | nationalization | OUT zona franca / IN stock   | No                            |
 */

/** @enum {string} */
const ORDER_TYPES = {
  /** Goods received from a supplier into a warehouse. */
  PURCHASE: "purchase",

  /** Goods dispatched to a customer. May generate a Siigo invoice. */
  SALE: "sale",

  /** Stock moved from one warehouse to another. */
  TRANSFER: "transfer",

  /** Goods returned by a customer back into a warehouse. */
  RETURN: "return",

  /**
   * Manual stock correction (positive or negative).
   * Does not require a counterpart (supplier / customer).
   */
  ADJUSTMENT: "adjustment",

  /**
   * Unit transformation: source items (e.g. metres) are consumed and
   * a new item type (e.g. cut pieces) is produced using a transformation factor.
   */
  TRANSFORM: "transform",

  /** Manual outflow not tied to a sale (e.g. samples, waste). */
  OUT: "out",

  /** Manual inflow not tied to a purchase (e.g. found stock, returns from transit). */
  IN: "in",

  /**
   * Partial invoicing of a parent sale order.
   * Uses FIFO to select dispatched-but-uninvoiced items.
   * Always generates a Siigo invoice on completion.
   */
  PARTIAL_INVOICE: "partial-invoice",

  /**
   * Nationalization of goods from a free-trade-zone (zona franca) warehouse
   * to a regular stock warehouse.
   * Source warehouse must have type `freeTradeZone`.
   * Destination warehouse must have type `stock`.
   * Items in zona franca cannot be added to sale orders directly.
   */
  NATIONALIZATION: "nationalization",
};

module.exports = ORDER_TYPES;
