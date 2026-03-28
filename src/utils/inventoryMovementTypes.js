/**
 * @fileoverview Inventory movement type constants.
 *
 * Every change to stock is recorded as an InventoryMovement with one of these
 * types. Together they provide a full audit trail of all stock changes.
 *
 * | Type       | Effect on quantity | Description                              |
 * |------------|--------------------|------------------------------------------|
 * | IN         | +                  | Stock received (purchase, inflow)        |
 * | RETURN     | +                  | Customer return added back to stock      |
 * | OUT        | -                  | Stock removed (sale, outflow)            |
 * | TRANSFER   | - src / + dst      | Stock moved between warehouses           |
 * | ADJUSTMENT | + or -             | Manual correction                        |
 * | RESERVE    | - (virtual)        | Stock allocated to a confirmed order     |
 * | UNRESERVE  | + (virtual)        | Reservation released (order cancelled)   |
 * | TRANSFORM  | - src / + dst unit | Unit transformation (cut items)          |
 */

/** @enum {string} */
const INVENTORY_MOVEMENT_TYPES = {
  IN: "in",
  RETURN: "return",
  OUT: "out",
  TRANSFER: "transfer",
  ADJUSTMENT: "adjustment",
  RESERVE: "reserve",
  UNRESERVE: "unreserve",
  TRANSFORM: "transform",
};

module.exports = INVENTORY_MOVEMENT_TYPES;
