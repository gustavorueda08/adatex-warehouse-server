function convertCode(str) {
  // busca el patrón ADX seguido de 2 dígitos, guion, y año de 4 dígitos
  const match = str.match(/^ADX(\d{2})-(\d{2})(\d{2})$/);
  if (match) {
    return match[1] + match[3]; // junta los dos dígitos después de ADX + los últimos 2 del año
  }
  // Si no cumple el formato, genera un número random de 4 dígitos
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = convertCode;
