/**
 * @fileoverview Item movement operation constants.
 *
 * Used by `ItemMovementStrategyFactory` to select the correct strategy when
 * an order changes state. The strategy then determines how individual Items
 * are created, modified, or soft-deleted.
 *
 * | Type   | When used                                     |
 * |--------|-----------------------------------------------|
 * | CREATE | A new item is added to an order product       |
 * | UPDATE | The order state changes (e.g. draft→confirmed)|
 * | DELETE | An item or order product is removed           |
 */

/** @enum {string} */
const ITEM_MOVEMENT_TYPES = {
  /** Initial creation of an item within an order product. */
  CREATE: "create",

  /** Re-processing an item after an order state change. */
  UPDATE: "update",

  /** Removing an item from an order product (reverses stock effects). */
  DELETE: "delete",
};

module.exports = ITEM_MOVEMENT_TYPES;
