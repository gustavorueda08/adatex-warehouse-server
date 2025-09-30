/**
 * Verifica que un objeto tenga todos los campos requeridos
 * @param {Object} obj - El objeto a validar
 * @param {string[]} requiredFields - Lista de campos requeridos
 * @returns {string[]} - Array con los campos faltantes (vacío si todo está ok)
 */
function validateRequiredFields(obj, requiredFields) {
  if (!obj || typeof obj !== "object") {
    throw new Error("El primer parámetro debe ser un objeto válido");
  }

  const missing = requiredFields.filter((field) => {
    const value = obj[field];
    return value === undefined || value === null || value === "";
  });

  return missing;
}

function validateFields(obj = {}, requireFields = [], message = null) {
  const missingFields = validateRequiredFields(obj, requireFields);
  if (missingFields.length > 0)
    throw new Error(
      `${message ? message : "Faltan datos obligatorios:"} ${missingFields.join(
        ", "
      )}`
    );
}
module.exports = {
  validateRequiredFields,
  validateFields,
};
