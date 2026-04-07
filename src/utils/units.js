/**
 * Mapeo de unidades de medida locales a códigos DIAN/Siigo.
 *
 * Siigo acepta los códigos de unidad según la tabla de unidades de medida DIAN.
 * Para obtener la lista completa disponible en tu cuenta: GET /v1/units-of-measure
 *
 * Cuando un producto tiene una unidad no listada aquí, el mapper usa "94" (Unidad)
 * como fallback.
 */
module.exports = [
  { code: "58", value: "kg" },   // Kilogramo
  { code: "LM", value: "m" },    // Metro lineal
  { code: "94", value: "unit" }, // Unidad (legacy — mantener para productos existentes)
  { code: "94", value: "und" },  // Unidad (usado en nuevos productos)
  { code: "PR", value: "par" },  // Par (código DIAN)
];
