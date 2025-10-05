function convertCode(str) {
  // busca el patrón ADX seguido de 2 dígitos, guion, "20" y 2 dígitos
  const match = str.match(/^ADX(\d{2})-20(\d{2})$/);
  if (match) {
    return match[1] + match[2]; // junta los dos pares
  }
  return null; // si no cumple formato
}

module.exports = convertCode;
