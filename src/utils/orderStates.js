/**
 * @fileoverview Order state constants.
 *
 * State machine (happy path):
 *   DRAFT → CONFIRMED → PROCESSING → COMPLETED
 *                                   → CANCELLED  (from any state)
 *
 * Invoicing note:
 *   - `completed` does NOT automatically trigger invoicing.
 *   - Invoicing happens when:
 *       - `type === "partial-invoice"` (always invoices on complete)
 *       - `type === "sale"` AND `emitInvoice === true`
 *     A sale with `emitInvoice === false` completes as a remisión (no invoice).
 */

/** @enum {string} */
const ORDER_STATES = {
  /** Order created but not yet reviewed. Default on creation. */
  DRAFT: "draft",

  /** Order reviewed and approved — ready to be processed. */
  CONFIRMED: "confirmed",

  /** Order is being actively processed (e.g. items being picked/shipped). */
  PROCESSING: "processing",

  /**
   * Operation fully completed (dispatch / receipt / transfer done).
   * May trigger invoicing depending on type and emitInvoice flag.
   */
  COMPLETED: "completed",

  /** Order cancelled — no stock movement was finalised. */
  CANCELLED: "cancelled",

  /**
   * Intermediate state used by some async flows (e.g. awaiting third-party
   * confirmation). Not part of the standard linear flow.
   */
  PENDING: "pending",
};

module.exports = ORDER_STATES;
