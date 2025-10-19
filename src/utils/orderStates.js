/**
 * Estados de una orden
 *
 * NOTA: El estado "completed" NO implica facturación automática.
 * Para facturar automáticamente al completar:
 * - type: "partial-invoice" → SIEMPRE factura al completarse
 * - type: "sale" + emitInvoice: true → Factura al completarse
 * - type: "sale" + emitInvoice: false → Remisión (NO factura)
 */
const ORDER_STATES = {
  DRAFT: "draft",
  CONFIRMED: "confirmed",
  PROCESSING: "processing",
  COMPLETED: "completed", // Operación completada (despacho/ingreso/etc)
  CANCELLED: "cancelled",
  PENDING: "pending",
};

module.exports = ORDER_STATES;
